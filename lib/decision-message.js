'use strict';

// Versioned operator-facing decision message contract (Compass V2).
// Silence is success: OPEN renders nothing. Non-OPEN uses one stable shape.

// This identifier exists so a compass_log row can be read back against the
// message contract that produced it; leaving it pinned while the contract
// changed would make rows written before and after the change indistinguishable
// by the one field whose job is to distinguish them. It is a CONTRACT version,
// not the package version.
//
// 0.12.2 names ONE contract carrying TWO changes that arrived on separate
// branches and merged without a textual conflict:
//   - the PAUSE "next step" stopped carrying the override token and names the
//     pending request id instead (approval-provenance branch, which bumped to
//     0.12.1 for this alone);
//   - a fourth classification, NOT_EVALUATED, gained its own banner and its own
//     "there is no verdict to override" next step (fail-closed branch, which
//     changed the contract and did NOT bump).
// Left as 0.12.1 the two would have been indistinguishable: one string naming
// two different contracts, which is precisely the failure this field exists to
// prevent. Hence 0.12.2 — the union — rather than either branch's number.
//
// 0.14.0: the PAUSE next step is switch-aware. With T2HELIX_REQUIRE_HUMAN_CONFIRM
// on (read in the rendering process), it no longer names list_pending and says
// instead that approval is a human's, from a terminal outside the session. With
// the switch off the text is byte-identical to 0.12.2, but a row's version names
// the contract that could have produced it, and that contract now has a branch.
const { requireHumanConfirm, HUMAN_APPROVAL_SENTENCE } = require('./human-confirm');

const MESSAGE_VERSION = 'decision-message/0.14.0';

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
  const isUnevaluated = decision.classification === 'NOT_EVALUATED';
  const banner = isPause
    ? 'T2Helix Compass - PAUSE'
    : isUnevaluated
      ? 'T2Helix Compass - NOT EVALUATED'
      : 'T2Helix Compass - BLOCKED';
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
      // Under the human-confirm switch the model cannot approve, so the text
      // names neither the listing nor the MCP tool: only that a human approves
      // from a terminal. The switch is read in THIS process (the hook's).
      next = requireHumanConfirm()
        ? `Next: approval required. Confirmation request${handle} is pending. ${HUMAN_APPROVAL_SENTENCE} After a human approves it, retry. Single-use, expires in 10 minutes.`
        : `Next: approval required. Confirmation request${handle} is pending — have it approved (list_pending shows what is waiting), then retry. Single-use, expires in 10 minutes.`;
      if (opts.offer_lease) {
        next += ' Or arm a safe-repeat lease if this exact action will repeat.';
      }
    } else {
      next = 'Next: confirm intentionally, or revise the action to a safer form.';
      if (opts.offer_lease) {
        next += ' A safe-repeat lease can be armed after confirmation.';
      }
    }
  } else if (isUnevaluated) {
    next = 'Next: the compass reached no verdict, so there is no verdict to override. Resolve the cause (npm run doctor) and retry.';
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
