'use strict';

// Versioned operator-facing decision message contract (Compass V2).
// Silence is success: OPEN renders nothing. Non-OPEN uses one stable shape.

// Bumped from 0.12.0 when the PAUSE "next step" stopped carrying the override
// token and started naming the pending request id instead. This identifier
// exists so a compass_log row can be read back against the message contract that
// produced it; leaving it pinned while the contract changed would make rows
// written before and after this change indistinguishable by the one field whose
// job is to distinguish them. It is a contract version, not the package version.
const MESSAGE_VERSION = 'decision-message/0.12.1';

/**
 * Render a non-OPEN decision for the operator / hook reason string.
 * @param {object} decision - classification, rule_id, predicate_id, reason, evidence, ...
 * @param {object} [opts]
 * @param {string} [opts.action_summary]
 * @param {string} [opts.token] - presence signals a pending confirmation exists;
 *   the value is a credential and is never rendered
 * @param {number} [opts.pending_id] - non-secret handle for the pending request
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
      // The token is what lifts this deny, and this string is read by the party
      // being denied — so it names the request, not the credential. list_pending
      // is where a request awaiting approval is found.
      const handle = opts.pending_id ? ` #${opts.pending_id}` : '';
      next = `Next: approval required. Confirmation request${handle} is pending — have it approved (list_pending shows what is waiting), then retry. Single-use, expires in 10 minutes.`;
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
