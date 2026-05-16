'use strict';

// Memory → compass coupling — criterion #2 of the helix milestone.
//
// Pure escalation policy. Given a base classification (from lib/compass.js
// rules) and a set of similar past chronicle entries (from recall()), decide
// whether memory evidence is strong enough to UPGRADE the classification.
//
// Constraints by design:
//   - Memory can ONLY escalate OPEN → PAUSE. Never PAUSE → WITNESS, never
//     OPEN → WITNESS, never downgrade. Hard denials stay rule-driven; memory
//     can warn, not absolve.
//   - Escalation requires N ≥ MIN_SIMILAR outcome-tagged entries (success or
//     failure). Below that, the sample is too small to draw a signal.
//   - Of those, ≥ FAILURE_RATIO must be tagged outcome:failure.
//   - Untagged entries (pre-criterion-1 or ambiguous shapes) are ignored —
//     they contribute neither to numerator nor denominator. Silence is safe.

const MIN_SIMILAR = 3;          // sample-size floor
const FAILURE_RATIO = 0.5;      // escalate when failures ≥ this fraction
const MAX_REASON_ENTRIES = 3;   // how many failure IDs to surface in the reason

function entryHasTag(entry, tag) {
  if (!entry || !entry.tags) return false;
  if (Array.isArray(entry.tags)) return entry.tags.includes(tag);
  return false;
}

function countOutcomes(entries) {
  let success = 0, failure = 0;
  const failureEntries = [];
  for (const e of entries || []) {
    if (entryHasTag(e, 'outcome:failure')) {
      failure++;
      failureEntries.push(e);
    } else if (entryHasTag(e, 'outcome:success')) {
      success++;
    }
  }
  return { success, failure, total: success + failure, failureEntries };
}

function escalateByMemory(baseResult, similar_entries) {
  // Memory only touches OPEN. Rule-driven decisions stand.
  if (!baseResult || baseResult.classification !== 'OPEN') {
    return { ...baseResult, memory_escalated: false };
  }

  const { success, failure, total, failureEntries } = countOutcomes(similar_entries);

  if (total < MIN_SIMILAR) {
    return { ...baseResult, memory_escalated: false, memory_stats: { success, failure, total } };
  }

  const ratio = failure / total;
  if (ratio < FAILURE_RATIO) {
    return { ...baseResult, memory_escalated: false, memory_stats: { success, failure, total } };
  }

  // Escalate. Surface the matched failure entries in the reason for auditability.
  const shownFailures = failureEntries.slice(0, MAX_REASON_ENTRIES);
  const idList = shownFailures.map(e => `#${e.id}`).join(', ');
  const memoryReason =
    `memory: ${failure}/${total} similar past actions tagged outcome:failure (${idList}). ` +
    `Review before proceeding; if intentional, override via confirm_pending.`;

  return {
    classification: 'PAUSE',
    rule_id: 'memory:similar-failures',
    reason: memoryReason,
    memory_escalated: true,
    memory_stats: { success, failure, total },
    similar_entries: shownFailures
  };
}

module.exports = {
  escalateByMemory,
  countOutcomes,
  MIN_SIMILAR,
  FAILURE_RATIO,
  MAX_REASON_ENTRIES
};
