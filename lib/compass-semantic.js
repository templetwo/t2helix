'use strict';

// Semantic predicate evaluation over Action IR (Compass V2).
// v0.12 migrates two families: rm* and credential-paste.
// All other legacy rules remain under the string classifier until later phases.

const path = require('path');
const secrets = require('./secrets');
const { parseToIR, PARSER_VERSION, summarizeIR } = require('./action-ir');

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
      u.code === 'nested-executable'
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
    documentation_only: ir ? isDocumentationOnly(ir) : false
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
  // also scan raw flags
  for (const f of seg.flags || []) {
    if (f.startsWith('--')) continue;
    for (const ch of f.replace(/^-/, '')) set.add(ch);
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
      const { stripFlags, expandClusterFlags } = require('./action-ir/bash');
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
    const recursive = hasFlag(seg, ['r', 'R']);
    const force = hasFlag(seg, ['f']);
    if (!recursive) return null;
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

      if (recursive && force) {
        return decision({
          classification: 'WITNESS',
          rule_id: 'rm-rf-wildcard',
          predicate_id: 'recursive-force-wildcard',
          reason: 'Recursive force delete with wildcard. Verify the target before proceeding.',
          evidence: {
            segment: segmentIndex,
            executable: 'rm',
            flags: seg.flags,
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
function mergeDecisions(legacy, semantic, mode) {
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

  // Legacy gated on a migrated family — semantic OPEN fixes the false positive
  if (isMigratedRuleId(legacy.rule_id)) {
    return {
      active: {
        classification: 'OPEN',
        rule_id: null,
        reason: null,
        normalized_action_hash: semantic.normalized_action_hash,
        parser_version: semantic.parser_version,
        semantic: true,
        false_positive_cleared: legacy.rule_id
      },
      legacy,
      semantic,
      mode
    };
  }

  // Quoted documentation (echo "rm -rf / && git push --force") trips legacy
  // string rules even when no dangerous executable is invoked. Action IR proves
  // documentation-only → clear the false positive even for non-migrated rules.
  if (semantic.documentation_only) {
    return {
      active: {
        classification: 'OPEN',
        rule_id: null,
        reason: null,
        normalized_action_hash: semantic.normalized_action_hash,
        parser_version: semantic.parser_version,
        semantic: true,
        false_positive_cleared: legacy.rule_id,
        documentation_only: true
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
