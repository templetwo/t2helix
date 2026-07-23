'use strict';

// Versioned operator-facing decision message contract (Compass V2).
// Silence is success: OPEN renders nothing. Non-OPEN uses one stable shape.

const MESSAGE_VERSION = 'decision-message/0.12.0';

/**
 * Render a non-OPEN decision for the operator / hook reason string.
 * @param {object} decision - classification, rule_id, predicate_id, reason, evidence, ...
 * @param {object} [opts]
 * @param {string} [opts.action_summary]
 * @param {string} [opts.token] - pending confirmation token for PAUSE
 * @param {boolean} [opts.offer_lease]
 * @param {string} [opts.safer_path]
 */
function renderDecision(decision, opts = {}) {
  if (!decision || decision.classification === 'OPEN') {
    return { text: '', message_version: MESSAGE_VERSION, lines: [] };
  }

  const isPause = decision.classification === 'PAUSE';
  const banner = isPause ? 'T2Helix Compass - PAUSE' : 'T2Helix Compass - BLOCKED';
  const action = opts.action_summary || summarizeFromEvidence(decision);
  const ruleBit = [decision.rule_id, decision.predicate_id].filter(Boolean).join(' / ');
  const actionLine = ruleBit ? `Action: ${action} (${ruleBit})` : `Action: ${action}`;
  const why = `Why: ${decision.reason || 'Policy matched this action.'}`;

  let next;
  if (isPause) {
    if (opts.token) {
      // Phrase must keep `confirm_pending with token="…"` for existing hook
      // integration tests and operator muscle memory (v0.x deny reason contract).
      next = `Next: call mcp__t2helix__confirm_pending with token="${opts.token}" then retry. Single-use, expires in 10 minutes.`;
      if (opts.offer_lease) {
        next += ' Or arm a safe-repeat lease if this exact action will repeat.';
      }
    } else {
      next = 'Next: confirm intentionally, or revise the action to a safer form.';
      if (opts.offer_lease) {
        next += ' A safe-repeat lease can be armed after confirmation.';
      }
    }
  } else {
    next = opts.safer_path
      ? `Safer path: ${opts.safer_path}`
      : 'Next: this is an immutable WITNESS floor — no override token. Change the action.';
  }

  const lines = [banner, actionLine, why, next];
  // Soft-deny prefix preserves v0.x hook compatibility for PAUSE
  const softPrefix = isPause ? '[soft-deny] ' : '';
  const ruleTag = decision.rule_id ? `[t2helix:${decision.rule_id}] ` : '[t2helix] ';
  const text = `${ruleTag}${softPrefix}${lines.join('\n')}`;

  return {
    text,
    message_version: MESSAGE_VERSION,
    lines,
    banner,
    classification: decision.classification
  };
}

function summarizeFromEvidence(decision) {
  const e = decision.evidence || {};
  if (e.executable && e.target) {
    const flags = Array.isArray(e.flags) ? e.flags.join(' ') : '';
    return [e.executable, flags, e.target].filter(Boolean).join(' ');
  }
  if (e.executable) return e.executable;
  return decision.rule_id || 'action';
}

/** Safer-path hints for common WITNESS rules. */
function saferPathFor(ruleId) {
  switch (ruleId) {
    case 'git-push-force':
      return 'use --force-with-lease on a branch you own';
    case 'git-reset-hard':
      return 'stash or commit work before reset, or use git reset --keep';
    case 'no-verify':
      return 'fix the failing hook or commit without --no-verify';
    case 'rm-rf-wildcard':
    case 'rm-rf-root':
      return 'name exact paths without recursive wildcards, or clean up under /tmp only';
    default:
      return null;
  }
}

module.exports = {
  MESSAGE_VERSION,
  renderDecision,
  saferPathFor,
  summarizeFromEvidence
};
