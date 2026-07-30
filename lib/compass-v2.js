'use strict';

// Compass V2 orchestrator: legacy classify + Action IR semantic, shadow or enforce.
//
// Mode via T2HELIX_COMPASS_V2:
//   off      — legacy only (no parse, no shadow)
//   shadow   — legacy authoritative; semantic computed and compared (DEFAULT)
//   enforce  — family-migrated merge (rm + credential semantic; other rules legacy)

const legacyCompass = require('./compass');
const { parseToIR, summarizeIR, PARSER_VERSION } = require('./action-ir');
const { classifySemantic, mergeDecisions } = require('./compass-semantic');
const { renderDecision, saferPathFor, MESSAGE_VERSION } = require('./decision-message');

function compassV2Mode() {
  const raw = (process.env.T2HELIX_COMPASS_V2 || 'shadow').toLowerCase().trim();
  if (raw === 'off' || raw === '0' || raw === 'false') return 'off';
  if (raw === 'enforce' || raw === 'on' || raw === '1' || raw === 'true') return 'enforce';
  return 'shadow';
}

// ── The second leg's budget (2026-07-30) ────────────────────────────────────
//
// The classify() budget in lib/compass.js covers the LEGACY leg only. The
// adversarial review measured where the time actually goes on
// `git reset --hard HEAD~5; echo ` + 'a'*80000:
//
//     legacy classify   1ms   (WITNESS — the verdict already exists)
//     parseToIR         3ms   (LINEAR at every size measured)
//     classifySemantic  9,647ms at 100KB   (quadratic; lib/secrets, paid twice)
//
// So the hook was killed at 5s AFTER a correct WITNESS had been computed, and
// the harness read the silence as no objection. A budget cannot preempt a regex
// already entered, so the only defence is to not enter the leg when it cannot
// change the verdict. Three cases where that is provable:
//
//  1. legacy NOT_EVALUATED — mergeDecisions now treats it as absorbing (a
//     non-verdict cannot be cleared by a semantic OPEN and must not be softened
//     to a token-bearing PAUSE), so the semantic leg cannot move it in ANY mode.
//  2. legacy WITNESS on an oversize action — WITNESS is the top of the lattice,
//     so the semantic leg can only CLEAR it (migrated-family / documentation-only)
//     or leave it. Skipping therefore fails closed, never open. The size gate is
//     what keeps ordinary shadow-window telemetry intact: every realistic command
//     is far below it, so the agreement dataset is unaffected.
//  3. the legacy leg already spent the budget — entering a second uninterruptible
//     leg from there is what runs the process past the harness timeout.
//
// PAUSE and OPEN are deliberately NOT skipped at any size: for those the semantic
// leg can ESCALATE, and dropping an escalation would be a fail-open.
const DEFAULT_SEMANTIC_SKIP_BYTES = 4096;
const DEFAULT_SEMANTIC_BUDGET_MS = 1200;

function envNum(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function actionLength(tool_name, tool_input) {
  try {
    if (tool_name === 'Bash') return String((tool_input && tool_input.command) || '').length;
    return JSON.stringify(tool_input || {}).length;
  } catch (_) {
    return 0;
  }
}

// Returns a reason string when the semantic leg must be skipped, else null.
function semanticSkipReason(legacy, legacyMs, len) {
  if (legacy.classification === legacyCompass.NOT_EVALUATED) return 'legacy-not-evaluated';
  const skipBytes = envNum('T2HELIX_SEMANTIC_SKIP_BYTES', DEFAULT_SEMANTIC_SKIP_BYTES);
  if (legacy.classification === 'WITNESS' && len > skipBytes) {
    return `legacy-witness-oversize:${len}b>${skipBytes}b`;
  }
  const budget = envNum('T2HELIX_SEMANTIC_BUDGET_MS', DEFAULT_SEMANTIC_BUDGET_MS);
  if (legacyMs > budget) return `legacy-leg-spent-budget:${legacyMs}ms>${budget}ms`;
  return null;
}

/**
 * Full classification with IR + optional semantic path.
 * @returns {{
 *   active: object,
 *   legacy: object,
 *   semantic: object|null,
 *   ir: object|null,
 *   mode: string,
 *   action_summary: string,
 *   shadow: object|null,
 *   message: object|null
 * }}
 */
function classifyV2({ tool_name, tool_input }, ctx = {}) {
  const mode = compassV2Mode();
  const legacyStarted = Date.now();
  const legacy = legacyCompass.classify({ tool_name, tool_input }, ctx);
  const legacyMs = Date.now() - legacyStarted;
  const legacySummary = legacyCompass.summarizeAction({ tool_name, tool_input });

  if (mode === 'off') {
    return {
      active: legacy,
      legacy,
      semantic: null,
      ir: null,
      mode,
      action_summary: legacySummary,
      display_summary: legacySummary,
      shadow: null,
      message: null
    };
  }

  let ir = null;
  let semantic = null;
  let semantic_skipped = null;
  try {
    // parseToIR is kept UNCONDITIONALLY: it is linear and cheap (3ms at 40KB,
    // 4ms at 100KB) and it supplies the normalized_action_hash that the PAUSE
    // token and safe-repeat-lease flows key on. Only classifySemantic is skippable.
    ir = parseToIR(tool_name, tool_input, {
      cwd: ctx.cwd || process.cwd(),
      has_goal: ctx.has_goal
    });
    semantic_skipped = semanticSkipReason(legacy, legacyMs, actionLength(tool_name, tool_input));
    if (!semantic_skipped) {
      semantic = classifySemantic(tool_name, tool_input, { ...ctx, ir });
    }
  } catch (e) {
    semantic = {
      classification: 'PAUSE',
      rule_id: 'parser-degraded',
      predicate_id: 'orchestrator-exception',
      reason: `Compass V2 parse failed: ${e.message}`,
      evidence: { error: e.message },
      parser_version: PARSER_VERSION,
      semantic: true,
      degraded: true
    };
  }

  const merged = mergeDecisions(legacy, semantic, mode, ir);
  const active = merged.active;

  // Two summaries, deliberately distinct:
  //
  //   action_summary  — IDENTITY. Hashed into the `action:<hash>` chain anchor
  //     (helix criterion #3), used as the recall/FTS query for memory coupling
  //     (criterion #2), and hashed into the pending-confirmation key. PostToolUse
  //     independently computes it via compass.summarizeAction(), so this MUST stay
  //     byte-identical to that function or the two ends of the chain stop pairing
  //     and every pre-0.12 chronicle row becomes unmatchable.
  //   display_summary — the calmer IR rendering, for operator messages only.
  const action_summary = legacySummary;
  const display_summary = ir ? `${tool_name}: ${summarizeIR(ir)}` : legacySummary;

  // Agreement is measured on CLASSIFICATION, not rule id: legacy and semantic
  // routinely reach the same verdict under different rule names (rm -rf / is
  // rm-rf-wildcard to legacy, rm-rf-root to the predicates). Counting that as a
  // disagreement would make the shadow window — the signal that gates enabling
  // enforce — permanently pessimistic. `same_rule` keeps the finer detail.
  const shadow = {
    agree: semantic ? legacy.classification === semantic.classification : null,
    same_rule: semantic ? (legacy.rule_id || null) === (semantic.rule_id || null) : null,
    legacy_classification: legacy.classification,
    legacy_rule_id: legacy.rule_id,
    semantic_classification: semantic ? semantic.classification : null,
    semantic_rule_id: semantic ? semantic.rule_id : null,
    semantic_predicate_id: semantic ? semantic.predicate_id : null,
    normalized_action_hash: ir ? ir.normalized_action_hash : null,
    parser_version: PARSER_VERSION,
    // Null when the leg ran. When set, it names WHY the leg was not consulted, so
    // a shadow row with agree:null is distinguishable from one where the leg
    // silently failed — the same audit-integrity property NOT_EVALUATED exists for.
    semantic_skipped
  };

  let message = null;
  if (active.classification !== 'OPEN') {
    message = renderDecision(active, {
      action_summary: display_summary.replace(/^[^:]+:\s*/, ''),
      safer_path: saferPathFor(active.rule_id)
    });
  }

  return {
    active,
    legacy,
    semantic,
    ir,
    mode,
    action_summary,
    display_summary,
    shadow,
    message,
    message_version: MESSAGE_VERSION
  };
}

module.exports = {
  classifyV2,
  compassV2Mode,
  PARSER_VERSION,
  MESSAGE_VERSION
};
