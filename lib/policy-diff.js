'use strict';

// Pure diff logic for comparing two sets of raw rule objects.
// Used by scripts/check-policy-diff.js (the CI gate).
//
// "Loosening" is defined conservatively:
//   - removing a WITNESS or PAUSE rule: hard failure
//   - downgrading a rule's classification (WITNESS→PAUSE, WITNESS→OPEN, PAUSE→OPEN): hard failure
//   - changing a safety rule's pattern: flagged as REVIEW (informational, not a hard failure)
//     because regex-weakening is undecidable in general — a human must judge
//
// Adding new rules or adding entirely new IDs is always a pass.

const SEVERITY = { WITNESS: 2, PAUSE: 1, OPEN: 0 };

function diffRuleSets(baseRules, headRules) {
  const findings = [];
  const headById = new Map(headRules.map(r => [r.id, r]));

  for (const base of baseRules) {
    if (!base.classification || base.classification === 'OPEN') continue;
    const head = headById.get(base.id);
    if (!head) {
      findings.push({
        kind: 'removed',
        id: base.id,
        base_classification: base.classification,
        head_classification: null,
        message: `Rule "${base.id}" (${base.classification}) was removed — this loosens boundaries.`
      });
    } else if ((SEVERITY[head.classification] || 0) < (SEVERITY[base.classification] || 0)) {
      findings.push({
        kind: 'downgraded',
        id: base.id,
        base_classification: base.classification,
        head_classification: head.classification,
        message: `Rule "${base.id}" downgraded from ${base.classification} to ${head.classification}.`
      });
    } else if (base.pattern && head.pattern && base.pattern !== head.pattern) {
      findings.push({
        kind: 'pattern_changed',
        id: base.id,
        base_classification: base.classification,
        head_classification: head.classification,
        message: `Rule "${base.id}" (${base.classification}) pattern changed — requires human review to confirm it was not weakened.`
      });
    }
  }

  return findings;
}

// Returns true if any findings constitute a hard boundary loosening
// (removed or downgraded). pattern_changed is informational only.
function hasLoosenedBoundaries(findings) {
  return findings.some(f => f.kind === 'removed' || f.kind === 'downgraded');
}

module.exports = { diffRuleSets, hasLoosenedBoundaries };
