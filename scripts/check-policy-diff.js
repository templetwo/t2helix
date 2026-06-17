#!/usr/bin/env node
'use strict';

// CI gate: compare the PR branch's .t2helix/policy.json against the base branch.
// Exits non-zero if the diff removes or downgrades any WITNESS/PAUSE rule.
// Pattern changes on safety rules are flagged as warnings (informational) but
// do not fail the build — regex-weakening is undecidable; a human must review.
//
// Usage (GitHub Actions):
//   node scripts/check-policy-diff.js [--base <git-ref>]
//   Default base: origin/main
//
// Example workflow step:
//   node scripts/check-policy-diff.js --base origin/main

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { diffRuleSets, hasLoosenedBoundaries } = require('../lib/policy-diff');

const POLICY_PATH = '.t2helix/policy.json';
const argv = process.argv.slice(2);
const baseIdx = argv.indexOf('--base');
const baseRef = baseIdx !== -1 ? argv[baseIdx + 1] : 'origin/main';

function getRulesFromRef(ref, filePath) {
  const res = spawnSync('git', ['show', `${ref}:${filePath}`], { encoding: 'utf8' });
  if (res.status !== 0) return []; // file doesn't exist on that ref — no rules to compare
  try {
    const raw = JSON.parse(res.stdout);
    return raw.rules || [];
  } catch {
    console.warn(`Warning: could not parse ${filePath} at ${ref} as JSON — treating as empty.`);
    return [];
  }
}

function getRulesFromFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return raw.rules || [];
  } catch {
    console.warn(`Warning: could not parse ${filePath} as JSON — treating as empty.`);
    return [];
  }
}

const baseRules = getRulesFromRef(baseRef, POLICY_PATH);
const headRules = getRulesFromFile(path.join(process.cwd(), POLICY_PATH));

if (baseRules.length === 0 && headRules.length === 0) {
  console.log(`policy-guard: no rules in ${POLICY_PATH} on either branch — nothing to diff. PASS.`);
  process.exit(0);
}

const findings = diffRuleSets(baseRules, headRules);

if (findings.length === 0) {
  console.log(`policy-guard: ${POLICY_PATH} diff is clean (no removed or downgraded rules). PASS.`);
  process.exit(0);
}

let hasFailure = false;
for (const f of findings) {
  if (f.kind === 'removed' || f.kind === 'downgraded') {
    console.error(`FAIL  ${f.message}`);
    hasFailure = true;
  } else {
    console.warn(`WARN  ${f.message}`);
  }
}

if (hasFailure) {
  console.error(`\npolicy-guard: FAIL — the PR loosens boundaries in ${POLICY_PATH}.`);
  console.error('Rules may only be added or tightened, not removed or downgraded.');
  process.exit(1);
} else {
  console.log(`\npolicy-guard: PASS — no hard boundary loosening detected (${findings.length} warning(s) above require human review).`);
  process.exit(0);
}
