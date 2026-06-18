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
//     failure). Below that, the sample is too small to draw a signal. This
//     floor is a RAW count — recency cannot manufacture a sample.
//   - Of those, the RECENCY-WEIGHTED failure share must be ≥ FAILURE_RATIO, so
//     recent evidence arbitrates the failure-vs-success balance (a fresh success
//     can outweigh stale failures, and a fresh failure can outweigh stale
//     successes).
//   - And the live failure MASS (Σ of decayed failure weights) must be ≥
//     MIN_FAILURE_WEIGHT, so a cluster of purely ancient failures decays below
//     the bar and stops warning forever — stale failures fade.
//   - Untagged entries (pre-criterion-1 or ambiguous shapes) are ignored —
//     they contribute neither to numerator nor denominator. Silence is safe.

const MIN_SIMILAR = 3;          // sample-size floor (raw count)
const FAILURE_RATIO = 0.5;      // escalate when the weighted failure share ≥ this
const MAX_REASON_ENTRIES = 3;   // how many failure IDs to surface in the reason

// Read-time recency decay (pure). Each outcome-tagged entry contributes a weight
// w = e^(-k·Δh), where Δh is the entry's age in hours (clamped ≥ 0) and
// k = ln(2)/half-life. So a failure one half-life old counts half as much as a
// fresh one. The decay is computed at recall time from the entry's created_at —
// nothing is mutated, no row is pruned. Entries with no/invalid created_at are
// undateable and are NOT penalized (weight 1.0), which also keeps the policy
// identical to the old flat-count behaviour for callers that pass dateless rows.
const FAILURE_HALFLIFE_HOURS = 72;  // 3 days: ~1d≈0.79, 2d≈0.63, 3d=0.50, 1wk≈0.20, 1mo≈0
const MIN_FAILURE_WEIGHT = 1.0;     // ≈ one fresh failure's worth of live evidence
const DECAY_K = Math.log(2) / FAILURE_HALFLIFE_HOURS;
const HOUR_MS = 3600000;

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

// Recency weight for one entry, in (0, 1]. Undateable entries (missing or
// non-finite created_at) → 1.0 (no decay). Future timestamps clamp to the
// present, so clock skew can never inflate a weight above 1.
function recencyWeight(entry, now) {
  const ts = entry && entry.created_at;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return 1.0;
  const ageHours = Math.max(0, (now - ts) / HOUR_MS);
  return Math.exp(-DECAY_K * ageHours);
}

// Like countOutcomes, but each outcome-tagged entry contributes its recency
// weight instead of 1. Pure; reads only tags + created_at.
function weighOutcomes(entries, now) {
  let weightedSuccess = 0, weightedFailure = 0;
  for (const e of entries || []) {
    if (entryHasTag(e, 'outcome:failure')) {
      weightedFailure += recencyWeight(e, now);
    } else if (entryHasTag(e, 'outcome:success')) {
      weightedSuccess += recencyWeight(e, now);
    }
  }
  return { weightedSuccess, weightedFailure, weightedTotal: weightedSuccess + weightedFailure };
}

function round2(n) { return Math.round(n * 100) / 100; }

function escalateByMemory(baseResult, similar_entries, now = Date.now()) {
  // Memory only touches OPEN. Rule-driven decisions stand.
  if (!baseResult || baseResult.classification !== 'OPEN') {
    return { ...baseResult, memory_escalated: false };
  }

  const { success, failure, total, failureEntries } = countOutcomes(similar_entries);

  // Sample-size floor: a RAW count. Recency reweights signal strength, but it
  // must never let a thin sample speak.
  if (total < MIN_SIMILAR) {
    return { ...baseResult, memory_escalated: false, memory_stats: { success, failure, total } };
  }

  const { weightedSuccess, weightedFailure, weightedTotal } = weighOutcomes(similar_entries, now);
  const stats = {
    success, failure, total,
    weightedFailure: round2(weightedFailure),
    weightedSuccess: round2(weightedSuccess)
  };

  // Recency-weighted balance: is this action class currently failure-prone?
  const weightedRatio = weightedTotal > 0 ? weightedFailure / weightedTotal : 0;
  if (weightedRatio < FAILURE_RATIO) {
    return { ...baseResult, memory_escalated: false, memory_stats: stats };
  }

  // Live failure mass: has the failure evidence decayed away? A pile of ancient
  // failures (no fresh ones) falls below the bar and is allowed to fade.
  if (weightedFailure < MIN_FAILURE_WEIGHT) {
    return { ...baseResult, memory_escalated: false, memory_stats: stats };
  }

  // Escalate. Surface the FRESHEST matched failures (most actionable) in the
  // reason. (sort is stable, so dateless entries keep their input order.)
  const shownFailures = [...failureEntries]
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
    .slice(0, MAX_REASON_ENTRIES);
  const idList = shownFailures.map(e => `#${e.id}`).join(', ');
  const memoryReason =
    `memory: ${failure}/${total} similar past actions tagged outcome:failure (${idList}), ` +
    `recency-weighted. Review before proceeding; if intentional, override via confirm_pending.`;

  return {
    classification: 'PAUSE',
    rule_id: 'memory:similar-failures',
    reason: memoryReason,
    memory_escalated: true,
    memory_stats: stats,
    similar_entries: shownFailures
  };
}

module.exports = {
  escalateByMemory,
  countOutcomes,
  weighOutcomes,
  recencyWeight,
  MIN_SIMILAR,
  FAILURE_RATIO,
  MAX_REASON_ENTRIES,
  FAILURE_HALFLIFE_HOURS,
  MIN_FAILURE_WEIGHT
};
