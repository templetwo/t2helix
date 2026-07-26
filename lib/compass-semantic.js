'use strict';

// Semantic predicate evaluation over Action IR (Compass V2).
// v0.12 migrates two families: rm* and credential-paste.
// All other legacy rules remain under the string classifier until later phases.

const path = require('path');
const secrets = require('./secrets');
const { parseToIR, PARSER_VERSION, summarizeIR } = require('./action-ir');
const { stripFlags, expandClusterFlags, LONG_FLAG_LETTERS } = require('./action-ir/bash');

const MIGRATED_FAMILIES = {
  rm: new Set([
    'rm-rf-wildcard',
    'rm-rf-root',
    'rm-wildcard',
    'rm-recursive-absolute',
    'rm-single-file'
  ]),
  credential: new Set(['credential-paste'])
};

const ALL_MIGRATED_RULE_IDS = new Set([
  ...MIGRATED_FAMILIES.rm,
  ...MIGRATED_FAMILIES.credential
]);

function isMigratedRuleId(ruleId) {
  return ruleId != null && ALL_MIGRATED_RULE_IDS.has(ruleId);
}

/** Which migrated family a legacy rule id belongs to, or null. */
function migratedFamilyOf(ruleId) {
  if (ruleId == null) return null;
  for (const [family, ids] of Object.entries(MIGRATED_FAMILIES)) {
    if (ids.has(ruleId)) return family;
  }
  return null;
}

const FAMILY_EXECUTABLES = { rm: new Set(['rm', 'unlink', 'rmdir']) };

// NOTE: this file already defines walkSegments(segments, visit) further down —
// a find-style walker that short-circuits on the first truthy visit result and
// descends through interpreter boundaries and xargs synthetics. Reuse it. An
// earlier revision of this guard declared a second walkSegments(ir, visit) here;
// function declarations hoist and the LAST wins, so the duplicate was silently
// overwritten and every call passed `ir` where the real function expected
// `ir.segments` — the walk iterated nothing, the guard saw no rm anywhere, and it
// refused to clear every legitimate delete. Caught only because the July 21
// false-positive tests failed. Do not re-introduce a second definition.

/**
 * Did the parser AFFIRMATIVELY see the family it is about to clear?
 *
 * The bug this guards (2026-07-26): a semantic OPEN was treated as license to
 * clear a legacy WITNESS for any migrated family. But `sudo rm -rf /` produces
 * NO rm predicate — action-ir/bash.js does not unwrap exec wrappers, so
 * seg.executable is `sudo` and the rm rules never fire. The OPEN meant "I did
 * not find an rm", not "this rm is safe", and the merge could not tell those
 * apart. Same for `echo $(rm -rf ...)`, where the executable is `echo` while
 * command substitution genuinely executes the delete.
 *
 * Absence of evidence is not evidence of safety. If the parser never located
 * the family, the legacy verdict stands.
 */
function semanticSawFamily(ir, family) {
  const names = FAMILY_EXECUTABLES[family];
  if (!names) return true; // families without an executable signature keep prior behaviour
  if (!ir || !Array.isArray(ir.segments)) return false;

  // walkSegments is find-style: returning truthy short-circuits the walk.
  return Boolean(walkSegments(ir.segments, seg => (names.has(baseName(seg.executable)) ? true : undefined)));
}

/** True if any segment carries unresolved, potentially-executable text
 *  (command substitution, backticks, a nested executable). Such text is not
 *  something the parser evaluated — it is something it could not read. */
function hasUnresolvedExecutableText(ir) {
  if (!ir || !Array.isArray(ir.segments)) return false;
  const CODES = new Set([
    'backtick-command-sub',
    'command-substitution',
    'subst-executable',
    'nested-executable',
    'xargs-executable',
    // $( ) inside double quotes — expands and executes; see isDocumentationOnly.
    'expansion-in-quotes'
  ]);
  return Boolean(walkSegments(ir.segments, seg => {
    for (const t of seg.tokens || []) {
      if (t && t.potentially_executable) return true;
    }
    for (const u of seg.uncertainty || []) {
      if (u && CODES.has(u.code)) return true;
    }
    return undefined;
  }));
}

/** True when every top-level segment is a non-executing documentation command
 *  (echo/printf/:) with no nested interpreter that would actually run a payload. */
function isDocumentationOnly(ir) {
  const safe = new Set(['echo', 'printf', ':', 'true', 'false']);
  const segs = (ir && ir.segments) || [];
  if (!segs.length) return false;
  return segs.every(seg => {
    const b = baseName(seg.executable);
    if (!safe.has(b)) return false;
    if (seg.interpreter_boundary) {
      const nested = seg.interpreter_boundary.nested_segments || [];
      if (nested.length) return false;
      if (seg.interpreter_boundary.nested_executable) return false;
    }
    // backtick / command-sub uncertainty on the segment means it may execute
    if ((seg.uncertainty || []).some(u =>
      u.code === 'backtick-command-sub' ||
      u.code === 'command-substitution' ||
      u.code === 'subst-executable' ||
      u.code === 'nested-executable' ||
      // A $( ) inside DOUBLE quotes still expands and still executes. The
      // tokenizer reports it as 'expansion-in-quotes' rather than
      // 'command-substitution' (lib/action-ir/bash.js:119), and that code was
      // missing here — so `echo "$(rm -rf /)"` was certified documentation-only
      // and cleared. Because the documentation_only branch of mergeDecisions
      // clears NON-migrated rules too, that made it a universal enforce bypass:
      // `echo "$(git push --force origin main)"` was allowed as well. Found by
      // adversarial review 2026-07-26; pre-dates the escalate-only guard.
      u.code === 'expansion-in-quotes'
    )) return false;
    return true;
  });
}

function openDecision(ir, note) {
  return {
    classification: 'OPEN',
    rule_id: null,
    predicate_id: null,
    reason: note || null,
    evidence: null,
    normalized_action_hash: ir ? ir.normalized_action_hash : null,
    parser_version: ir ? ir.parser_version : PARSER_VERSION,
    semantic: true,
    documentation_only: ir ? isDocumentationOnly(ir) : false,
    // Surfaced for the merge audit trail: an echo that redirects writes a file.
    ir_redirections: ir
      ? (ir.segments || []).flatMap(s => s.redirections || [])
      : []
  };
}

function decision({ classification, rule_id, predicate_id, reason, evidence, ir }) {
  return {
    classification,
    rule_id,
    predicate_id,
    reason,
    evidence: evidence || null,
    normalized_action_hash: ir.normalized_action_hash,
    parser_version: ir.parser_version,
    semantic: true
  };
}

function baseName(exe) {
  if (!exe) return '';
  return String(exe).split('/').pop().toLowerCase();
}

function hasFlag(seg, letters) {
  const set = new Set(seg.flag_set || []);
  // also scan raw flags — flag_set may be absent on synthetic segments
  for (const f of seg.flags || []) {
    const base = f.split('=')[0];
    if (base.startsWith('--')) {
      const letter = LONG_FLAG_LETTERS[base];
      if (letter) set.add(letter);
      continue;
    }
    for (const ch of base.replace(/^-/, '')) set.add(ch);
  }
  return letters.some(l => set.has(l));
}

function isTempPath(target) {
  if (!target) return false;
  const t = String(target);
  // session-ish temp cleanup paths
  if (t === '/tmp' || t === '/tmp/' || t === '/var/tmp' || t === '/var/tmp/') return true;
  if (t.startsWith('/tmp/') || t.startsWith('/var/tmp/')) return true;
  if (t.startsWith('/private/tmp/')) return true;
  // os.tmpdir() patterns without wildcard
  if (/^\/(?:var\/)?folders\/[^/]+\/[^/]+\/T\//.test(t)) return true;
  return false;
}

function isRootPath(target) {
  return target === '/' || target === '/*';
}

function isHomeOrAbsoluteRisky(target) {
  if (!target) return false;
  const t = String(target);
  if (t === '~' || t.startsWith('~/') || t.startsWith('~')) return true;
  // absolute path that is NOT a temp path
  if (t.startsWith('/') && !isTempPath(t)) return true;
  return false;
}

function insideActiveRepository(target, context = {}) {
  if (!target) return false;
  const t = String(target);
  // wildcards in relative paths are repo-relative by default
  if (!t.startsWith('/') && !t.startsWith('~')) return true;
  const cwd = context.cwd || process.cwd();
  try {
    const abs = path.isAbsolute(t.replace(/[*?].*$/, ''))
      ? t.replace(/[*?].*$/, '')
      : path.resolve(cwd, t.replace(/[*?].*$/, ''));
    // If target resolves under cwd, treat as active repository tree
    const rel = path.relative(cwd, abs);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return true; // conservative
  }
}

function walkSegments(segments, visit) {
  for (let i = 0; i < (segments || []).length; i++) {
    const seg = segments[i];
    const res = visit(seg, i);
    if (res) return res;
    if (seg.interpreter_boundary && seg.interpreter_boundary.nested_segments) {
      const nested = walkSegments(seg.interpreter_boundary.nested_segments, visit);
      if (nested) return nested;
    }
    // xargs-style
    if (seg.interpreter_boundary && seg.interpreter_boundary.nested_executable) {
      const synthetic = {
        executable: seg.interpreter_boundary.nested_executable,
        argv: seg.interpreter_boundary.nested_argv || [],
        flags: [],
        flag_set: [],
        operands: seg.interpreter_boundary.nested_argv || [],
        wildcard_operands: (seg.interpreter_boundary.nested_argv || [])
          .map((a, idx) => (/[*?]/.test(a) ? idx : -1))
          .filter(x => x >= 0),
        uncertainty: [{ code: 'from-xargs' }]
      };
      const { flags, operands } = stripFlags(synthetic.argv);
      synthetic.flags = flags;
      synthetic.operands = operands;
      synthetic.flag_set = [...expandClusterFlags(flags)];
      const res2 = visit(synthetic, i);
      if (res2) return res2;
    }
  }
  return null;
}

// ── rm family ──────────────────────────────────────────────────────────────

function evaluateRmRoot(ir, context) {
  return walkSegments(ir.segments, (seg, segmentIndex) => {
    if (baseName(seg.executable) !== 'rm') return null;
    if (!hasFlag(seg, ['r', 'R'])) return null;
    for (const target of seg.operands || []) {
      if (isRootPath(target)) {
        return decision({
          classification: 'WITNESS',
          rule_id: 'rm-rf-root',
          predicate_id: 'rm-root-path',
          reason: 'rm -rf / detected. Refusing without explicit human confirmation.',
          evidence: {
            segment: segmentIndex,
            executable: 'rm',
            flags: seg.flags,
            target,
            target_scope: 'root'
          },
          ir
        });
      }
    }
    return null;
  });
}

function evaluateRmWildcard(ir, context) {
  return walkSegments(ir.segments, (seg, segmentIndex) => {
    if (baseName(seg.executable) !== 'rm') return null;
    const recursive = hasFlag(seg, ['r', 'R']);
    const force = hasFlag(seg, ['f']);

    // Wildcard operands
    for (const operandIndex of seg.wildcard_operands || []) {
      const target = seg.argv[operandIndex];
      if (target == null) continue;
      // Skip if this argv slot was a pure flag (shouldn't be in wildcard_operands)
      if (String(target).startsWith('-') && !/[*?]/.test(target)) continue;

      // Recursion is what makes a wildcard delete unbounded; -f only suppresses
      // the prompt. `rm -r <glob>` and `rm -rf <glob>` destroy the same trees, so
      // both stay on the WITNESS floor legacy put them on. The v0.12 softening is
      // for NON-recursive wildcards (the July 21 false-positive class), which
      // fall through to PAUSE below.
      if (recursive) {
        return decision({
          classification: 'WITNESS',
          rule_id: 'rm-rf-wildcard',
          predicate_id: force ? 'recursive-force-wildcard' : 'recursive-wildcard',
          reason: 'Recursive delete with wildcard. Verify the target before proceeding.',
          evidence: {
            segment: segmentIndex,
            executable: 'rm',
            flags: seg.flags,
            force,
            target,
            target_scope: insideActiveRepository(target, context) ? 'active_repository' : 'path'
          },
          ir
        });
      }

      // Non-recursive wildcard in active repository → PAUSE (not WITNESS)
      if (insideActiveRepository(target, context)) {
        return decision({
          classification: 'PAUSE',
          rule_id: 'rm-wildcard',
          predicate_id: 'wildcard-target',
          reason: 'Wildcard deletion targets files inside the active repository tree. You cannot enumerate matches in advance.',
          evidence: {
            segment: segmentIndex,
            executable: 'rm',
            flags: seg.flags,
            target,
            target_scope: 'active_repository'
          },
          ir
        });
      }

      return decision({
        classification: 'PAUSE',
        rule_id: 'rm-wildcard',
        predicate_id: 'wildcard-target',
        reason: 'Wildcard deletion expands to an unbounded file set. Confirm the match set before proceeding.',
        evidence: {
          segment: segmentIndex,
          executable: 'rm',
          flags: seg.flags,
          target,
          target_scope: 'path'
        },
        ir
      });
    }
    return null;
  });
}

function evaluateRmRecursiveAbsolute(ir, context) {
  return walkSegments(ir.segments, (seg, segmentIndex) => {
    if (baseName(seg.executable) !== 'rm') return null;
    const recursive = hasFlag(seg, ['r', 'R']);
    if (!recursive) return null;

    for (const target of seg.operands || []) {
      // Session-created temp cleanup is low-friction (OPEN)
      if (isTempPath(target) && !/[*?]/.test(target)) {
        continue;
      }
      if (isRootPath(target)) continue; // handled by root rule
      if (isHomeOrAbsoluteRisky(target) || /[*?]/.test(target)) {
        return decision({
          classification: 'WITNESS',
          rule_id: 'rm-rf-wildcard',
          predicate_id: 'recursive-absolute-or-home',
          reason: 'Recursive force delete with absolute/home path. Verify the target before proceeding.',
          evidence: {
            segment: segmentIndex,
            executable: 'rm',
            flags: seg.flags,
            target,
            target_scope: isTempPath(target) ? 'temp' : 'absolute_or_home'
          },
          ir
        });
      }
    }
    return null;
  });
}

// ── credential family ──────────────────────────────────────────────────────

function collectCredentialHaystacks(ir) {
  // Only scan executable-adjacent text that is NOT inert quoted prose for
  // non-interpreter contexts. Still scan:
  //  - unquoted argv tokens
  //  - argv to export/env assignments
  //  - nested interpreter command strings (they ARE executable)
  // Do NOT scan:
  //  - git commit -m / -F message bodies as credential execution context
  //    when they are clearly message payloads (still scan for real key shapes)
  const haystacks = [];

  walkSegments(ir.segments, (seg) => {
    const base = baseName(seg.executable);

    // Nested interpreter bodies are executable
    if (seg.interpreter_boundary && seg.interpreter_boundary.nested_segments) {
      for (const ns of seg.interpreter_boundary.nested_segments) {
        haystacks.push({
          text: [ns.executable, ...(ns.argv || [])].join(' '),
          inert: false,
          source: 'nested-interpreter'
        });
      }
    }

    // git commit messages: only flag high-confidence key shapes, not URLs
    if (base === 'git' && (seg.argv[0] === 'commit' || seg.argv[0] === 'tag')) {
      for (let i = 0; i < seg.argv.length; i++) {
        const a = seg.argv[i];
        if (a === '-m' || a === '-F' || a === '--message' || a === '--file') {
          const msg = seg.argv[i + 1];
          if (msg) {
            haystacks.push({ text: msg, inert: false, source: 'git-message', message_payload: true });
          }
        }
      }
      // also flags may carry -mfoo
      return null;
    }

    // echo/printf of keys into files is still a credential surface
    for (let i = 0; i < (seg.argv || []).length; i++) {
      const a = seg.argv[i];
      const isQuoted = (seg.quoted_literals || []).includes(i);
      // Quoted args to echo/cat that look like documentation of a command —
      // still scan; secrets.DETECTION_REGEX is specific enough.
      haystacks.push({
        text: a,
        inert: false,
        source: 'argv',
        quoted: isQuoted
      });
    }

    // full_argv reconstruction for export FOO=secret
    if (seg.full_argv) {
      haystacks.push({ text: seg.full_argv.join(' '), inert: false, source: 'full-argv' });
    } else {
      haystacks.push({
        text: [seg.executable, ...(seg.argv || [])].join(' '),
        inert: false,
        source: 'segment'
      });
    }
    return null;
  });

  return haystacks;
}

function looksLikeSessionTrailerOnly(text) {
  // Claude-Session / session URL trailers are NOT credentials.
  if (/claude-session/i.test(text) && !secrets.DETECTION_REGEX.test(text.replace(/https?:\/\/\S+/gi, ''))) {
    return true;
  }
  // URL-only content without key shapes
  const stripped = String(text).replace(/https?:\/\/[^\s]+/gi, '').trim();
  if (!stripped || stripped.length < 8) return true;
  return false;
}

function evaluateCredentialPaste(ir, context) {
  const haystacks = collectCredentialHaystacks(ir);
  for (const h of haystacks) {
    if (!h.text) continue;
    if (h.message_payload && looksLikeSessionTrailerOnly(h.text)) continue;

    // For git messages, require a stronger match than mere "token" labels in prose
    if (h.message_payload) {
      // Only high-confidence patterns: private keys, sk-, ghp_, AKIA, etc.
      // Re-use DETECTION_REGEX but reject pure URL/session trailers first.
      if (!secrets.DETECTION_REGEX.test(h.text)) continue;
      // If the only matches are inside URLs, skip
      const withoutUrls = String(h.text).replace(/https?:\/\/[^\s]+/gi, '');
      if (!secrets.DETECTION_REGEX.test(withoutUrls)) continue;
    } else {
      if (!secrets.DETECTION_REGEX.test(h.text)) continue;
    }

    return decision({
      classification: 'PAUSE',
      rule_id: 'credential-paste',
      predicate_id: 'credential-shaped-token',
      reason: 'Possible credential in command. It is redacted on the way into the chronicle (v0.2), but confirm it isn\'t being written elsewhere in cleartext.',
      evidence: {
        source: h.source,
        sample_kind: 'credential-shaped',
        quoted: !!h.quoted
      },
      ir
    });
  }
  return null;
}

// ── Grok high-risk (structured) — keep WITNESS parity ──────────────────────

function evaluateGrokMutate(ir) {
  if (ir.tool !== 'Grok') return null;
  return walkSegments(ir.segments, (seg, segmentIndex) => {
    const text = [seg.executable, ...(seg.argv || [])].join(' ');
    if (/(?:raw-mutate|direct-write|force-apply|override-compass|bypass-chronicle)/i.test(text)) {
      return decision({
        classification: 'WITNESS',
        rule_id: 'grok-direct-mutate',
        predicate_id: 'grok-high-risk-action',
        reason: 'Grok-specific high-risk direct mutation. Grok is equal peer but still passes through the same WITNESS floor as Claude.',
        evidence: { segment: segmentIndex, sample: text.slice(0, 120) },
        ir
      });
    }
    return null;
  });
}

/**
 * Evaluate semantic predicates for migrated families.
 * Returns a decision object (OPEN if no predicate matches).
 */
function classifySemantic(tool_name, tool_input, context = {}) {
  let ir;
  try {
    ir = context.ir || parseToIR(tool_name, tool_input, context);
  } catch (e) {
    return {
      classification: 'PAUSE',
      rule_id: 'parser-degraded',
      predicate_id: 'parser-exception',
      reason: `Action parser failed closed-soft: ${e.message}. Treat as needing review.`,
      evidence: { error: e.message },
      normalized_action_hash: null,
      parser_version: PARSER_VERSION,
      semantic: true,
      degraded: true
    };
  }

  if (ir.error) {
    // Parser exception — only escalate when a destructive executable is visible
    const hasDestructive = (ir.segments || []).some(s =>
      ['rm', 'git', 'kubectl', 'dd', 'mkfs'].includes(baseName(s.executable))
    );
    if (hasDestructive) {
      return decision({
        classification: 'PAUSE',
        rule_id: 'parser-degraded',
        predicate_id: 'parser-exception-destructive',
        reason: 'Parser could not fully understand a potentially destructive action. Review before proceeding.',
        evidence: { error: ir.error, uncertainty: ir.uncertainty },
        ir
      });
    }
  }

  // Predicate order: strongest first
  const predicates = [
    evaluateRmRoot,
    evaluateRmWildcard,
    evaluateRmRecursiveAbsolute,
    evaluateCredentialPaste,
    evaluateGrokMutate
  ];

  for (const pred of predicates) {
    const hit = pred(ir, context);
    if (hit) return hit;
  }

  return openDecision(ir);
}

/**
 * Merge legacy + semantic under family migration rules.
 * - shadow/off: caller uses legacy as active
 * - enforce: migrated-family legacy hits yield to semantic; non-migrated legacy stands;
 *            semantic non-OPEN always surfaces (may strengthen)
 */
/**
 * @param ir  The parsed Action IR. Required for the escalate-only guard below to
 *            distinguish "parser evaluated this and found it safe" from "parser
 *            never located the family". decision() does not carry the IR on its
 *            result object, so it must be threaded in from classifyV2. When it is
 *            absent the guard cannot evaluate, and a safety gate must then hold
 *            the legacy floor rather than clear it.
 */
function mergeDecisions(legacy, semantic, mode, ir) {
  if (ir === undefined && semantic && semantic.ir) ir = semantic.ir;
  if (mode !== 'enforce') {
    return {
      active: legacy,
      legacy,
      semantic,
      mode
    };
  }

  // Semantic non-OPEN always wins for its families (and may catch nested cases legacy missed)
  if (semantic && semantic.classification !== 'OPEN') {
    // Never let semantic PAUSE override a non-migrated WITNESS from legacy
    if (
      legacy.classification === 'WITNESS' &&
      !isMigratedRuleId(legacy.rule_id) &&
      semantic.classification === 'PAUSE'
    ) {
      return {
        active: {
          ...legacy,
          normalized_action_hash: semantic.normalized_action_hash,
          parser_version: semantic.parser_version,
          semantic_shadow: semantic
        },
        legacy,
        semantic,
        mode
      };
    }
    return { active: semantic, legacy, semantic, mode };
  }

  // Semantic OPEN
  if (legacy.classification === 'OPEN') {
    return {
      active: {
        ...legacy,
        normalized_action_hash: semantic.normalized_action_hash,
        parser_version: semantic.parser_version
      },
      legacy,
      semantic,
      mode
    };
  }

  // Legacy gated on a migrated family — semantic OPEN fixes the false positive.
  // Evidence is carried so compass_log.evidence_json records WHAT was cleared;
  // otherwise a cleared WITNESS is indistinguishable from an action that never
  // tripped a rule at all.
  if (isMigratedRuleId(legacy.rule_id)) {
    // ESCALATE-ONLY GUARD (2026-07-26). A semantic OPEN may clear a legacy
    // WITNESS only when the parser AFFIRMATIVELY located the family it is
    // clearing. If it never found the executable, or the command carries
    // unresolved executable text (command substitution / backticks), the OPEN
    // means "I did not see it" — not "it is safe" — and the legacy floor holds.
    //
    // Without this, `sudo rm -rf /` and `echo $(rm -rf ...)` were ALLOWED under
    // enforce while DENIED under shadow, and the clear was logged as
    // false_positive_cleared/migrated-family — the audit trail recorded the
    // failure as the migration working. Turning enforce on weakened the gate.
    // documentation_only is exempt because it is an AFFIRMATIVE finding that
    // nothing executes, and NOT exempting it breaks the July 21 prose false
    // positives this layer exists to fix.
    //
    // The exemption is only as sound as isDocumentationOnly() is. An earlier
    // version of this comment claimed the exemption "cannot reopen the
    // substitution hole" — that was WRONG: isDocumentationOnly did not reject
    // 'expansion-in-quotes', so `echo "$(rm -rf /)"` was certified as prose and
    // cleared. That code is now in its reject list. Any NEW uncertainty code the
    // tokenizer learns to emit for something that can execute must be added
    // there too, or this exemption silently becomes a bypass again.
    const family = migratedFamilyOf(legacy.rule_id);
    const blind =
      !semantic.documentation_only &&
      (!semanticSawFamily(ir, family) || hasUnresolvedExecutableText(ir));
    if (blind) {
      return {
        active: {
          ...legacy,
          normalized_action_hash: semantic.normalized_action_hash,
          parser_version: semantic.parser_version,
          semantic_shadow: semantic,
          evidence: {
            clear_refused: legacy.rule_id,
            basis: 'semantic-did-not-see-family',
            family
          }
        },
        legacy,
        semantic,
        mode
      };
    }
    return {
      active: {
        classification: 'OPEN',
        rule_id: null,
        reason: null,
        normalized_action_hash: semantic.normalized_action_hash,
        parser_version: semantic.parser_version,
        semantic: true,
        false_positive_cleared: legacy.rule_id,
        evidence: { false_positive_cleared: legacy.rule_id, basis: 'migrated-family' }
      },
      legacy,
      semantic,
      mode
    };
  }

  // Quoted documentation (echo of a dangerous command as prose) trips legacy
  // string rules even when no dangerous executable is invoked. Action IR proves
  // documentation-only → clear the false positive even for non-migrated rules.
  //
  // This DOES clear non-migrated WITNESS rules — the one place a semantic verdict
  // overrides a rule it was not migrated to reason about. It is deliberate: an
  // echo/printf executes nothing, and when it redirects to a file it is a write,
  // which the Write/Edit tools perform ungated anyway. Gating it here would buy
  // no safety and would re-break the July 21 documentation false positives. The
  // redirect target is recorded so a cleared floor rule stays auditable.
  if (semantic.documentation_only) {
    const redirected = ((semantic.ir_redirections || []).length > 0) || undefined;
    return {
      active: {
        classification: 'OPEN',
        rule_id: null,
        reason: null,
        normalized_action_hash: semantic.normalized_action_hash,
        parser_version: semantic.parser_version,
        semantic: true,
        false_positive_cleared: legacy.rule_id,
        documentation_only: true,
        evidence: {
          false_positive_cleared: legacy.rule_id,
          basis: 'documentation-only',
          redirections: semantic.ir_redirections || [],
          redirected
        }
      },
      legacy,
      semantic,
      mode
    };
  }

  // Non-migrated legacy rule stands (force-push, drop-table, deploy-prod, ...)
  return {
    active: {
      ...legacy,
      normalized_action_hash: semantic.normalized_action_hash,
      parser_version: semantic.parser_version
    },
    legacy,
    semantic,
    mode
  };
}

function severity(c) {
  if (c === 'WITNESS') return 2;
  if (c === 'PAUSE') return 1;
  return 0;
}

module.exports = {
  classifySemantic,
  mergeDecisions,
  isMigratedRuleId,
  isDocumentationOnly,
  MIGRATED_FAMILIES,
  ALL_MIGRATED_RULE_IDS,
  evaluateRmWildcard,
  evaluateRmRoot,
  evaluateRmRecursiveAbsolute,
  evaluateCredentialPaste,
  PARSER_VERSION,
  summarizeIR
};
