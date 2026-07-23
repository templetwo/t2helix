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
  const legacy = legacyCompass.classify({ tool_name, tool_input }, ctx);
  const legacySummary = legacyCompass.summarizeAction({ tool_name, tool_input });

  if (mode === 'off') {
    return {
      active: legacy,
      legacy,
      semantic: null,
      ir: null,
      mode,
      action_summary: legacySummary,
      shadow: null,
      message: null
    };
  }

  let ir = null;
  let semantic = null;
  try {
    ir = parseToIR(tool_name, tool_input, {
      cwd: ctx.cwd || process.cwd(),
      has_goal: ctx.has_goal
    });
    semantic = classifySemantic(tool_name, tool_input, { ...ctx, ir });
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

  const merged = mergeDecisions(legacy, semantic, mode);
  const active = merged.active;

  // Prefer IR summary when available (calmer operator surface)
  const action_summary = ir
    ? `${tool_name}: ${summarizeIR(ir)}`
    : legacySummary;

  const shadow = {
    agree:
      legacy.classification === (semantic && semantic.classification) &&
      (legacy.rule_id || null) === ((semantic && semantic.semantic && semantic.classification !== 'OPEN')
        ? semantic.rule_id
        : legacy.classification === 'OPEN' ? null : legacy.rule_id)
        // simpler agree metric:
        || false,
    legacy_classification: legacy.classification,
    legacy_rule_id: legacy.rule_id,
    semantic_classification: semantic ? semantic.classification : null,
    semantic_rule_id: semantic ? semantic.rule_id : null,
    semantic_predicate_id: semantic ? semantic.predicate_id : null,
    normalized_action_hash: ir ? ir.normalized_action_hash : null,
    parser_version: PARSER_VERSION
  };
  // Fix agree computation cleanly
  shadow.agree =
    legacy.classification === (semantic ? semantic.classification : legacy.classification) &&
    (
      (legacy.classification === 'OPEN' && (!semantic || semantic.classification === 'OPEN')) ||
      (legacy.rule_id === (semantic && semantic.rule_id))
    );

  let message = null;
  if (active.classification !== 'OPEN') {
    message = renderDecision(active, {
      action_summary: action_summary.replace(/^[^:]+:\s*/, ''),
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
