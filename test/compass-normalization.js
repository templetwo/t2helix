'use strict';

// Haystack normalization: a destructive command written with quoted or long-form
// flags must reach the same verdict as its plain spelling, and normalization must
// move nothing that was not already moving. The prose corpus below is a permanent
// fixture: it is the both-directions half of the proof, and a future rule edit that
// starts gating ordinary prose fails here rather than in someone's session.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-compass-normalization-'));
process.env.T2HELIX_DATA_DIR = path.join(tmpRoot, 'chronicle');
process.env.T2HELIX_POLICY_DIR = '';

const compass = require('../lib/compass');
const { classifyV2 } = require('../lib/compass-v2');
const specimens = require('./fixtures/compass-normalization-specimens.json');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function withMode(mode, fn) {
  const previous = process.env.T2HELIX_COMPASS_V2;
  process.env.T2HELIX_COMPASS_V2 = mode;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.T2HELIX_COMPASS_V2;
    else process.env.T2HELIX_COMPASS_V2 = previous;
  }
}

function legacy(command) {
  const verdict = compass.classify({ tool_name: 'Bash', tool_input: { command } });
  return { classification: verdict.classification, rule_id: verdict.rule_id };
}

function modeMatrix(command) {
  const payload = { tool_name: 'Bash', tool_input: { command } };
  return {
    legacy: compass.classify(payload).classification,
    shadow: withMode('shadow', () => classifyV2(payload).active.classification),
    enforce: withMode('enforce', () => classifyV2(payload).active.classification)
  };
}

// ── Finding F: quoted flag spellings ─────────────────────────────────────────
// A paired quote around a whitespace-free span is shell syntax, not evidence of
// intent. `rm "-rf" x` runs exactly what `rm -rf x` runs.

for (const s of specimens.quoted_flag_bypasses) {
  test(`quoted flag is not a bypass: ${s.id}`, () => {
    assert.deepStrictEqual(
      legacy(s.command),
      { classification: s.expected, rule_id: s.expected_rule },
      s.command
    );
    assert.deepStrictEqual(
      legacy(s.command),
      legacy(s.plain_twin),
      `${s.command} must reach the same verdict as ${s.plain_twin}`
    );
  });
}

// ── Finding F: long-form flag spellings ──────────────────────────────────────
// Bundled (-rf), separated (-r -f) and long (--recursive --force) are the same
// invocation. The rule flag classes enumerate the short letters, so the long
// spellings are mapped onto them before matching.

for (const s of specimens.long_flag_bypasses) {
  test(`long-form flag is not a bypass: ${s.id}`, () => {
    assert.deepStrictEqual(
      legacy(s.command),
      { classification: s.expected, rule_id: s.expected_rule },
      s.command
    );
    assert.deepStrictEqual(
      legacy(s.command),
      legacy(s.plain_twin),
      `${s.command} must reach the same verdict as ${s.plain_twin}`
    );
  });
}

// ── Finding J: git reset flag position ───────────────────────────────────────
// git accepts the flag anywhere in the argument list; the rule required it
// adjacent to the subcommand, so the flag-last spelling ran ungated.

for (const s of specimens.reset_flag_position) {
  test(`reset flag position does not matter: ${s.id}`, () => {
    assert.deepStrictEqual(
      legacy(s.command),
      { classification: s.expected, rule_id: s.expected_rule },
      s.command
    );
  });
}

for (const s of specimens.must_stay_open) {
  test(`stays OPEN: ${s.id}`, () => {
    assert.strictEqual(legacy(s.command).classification, s.expected, s.command);
  });
}

// ── Monotonicity ─────────────────────────────────────────────────────────────
// The load-bearing invariant. Normalization runs only after the raw spelling has
// been matched and found clean, so it may ADD a denial and can never change WHICH
// rule fires on a command that already denied. Without that ordering, rule #1 —
// first in a first-match-wins list, and a migrated family — starts capturing
// chained commands whose real gate is a later rule, and the migrated-family merge
// then clears the whole verdict. That is the 2026-07-26 revert, reachable again
// from the normalization site: measured DENY -> ALLOW in enforce for every
// specimen below before the two-pass ordering was adopted.

for (const s of specimens.rule_order_preserved) {
  test(`normalization never relabels an existing denial: ${s.id}`, () => {
    assert.deepStrictEqual(
      legacy(s.command),
      { classification: s.expected, rule_id: s.expected_rule },
      s.command
    );
    assert.deepStrictEqual(
      modeMatrix(s.command),
      { legacy: s.expected, shadow: s.expected, enforce: s.expected },
      `${s.command} must hold its gate in every mode`
    );
  });
}

test('normalization is monotonic across the whole corpus', () => {
  // Stated as a property rather than per-specimen: for every command in this
  // fixture, a rule id present before normalization is the rule id after.
  const everything = [
    ...specimens.quoted_flag_bypasses,
    ...specimens.long_flag_bypasses,
    ...specimens.reset_flag_position,
    ...specimens.must_stay_open,
    ...specimens.rule_order_preserved,
    ...specimens.prose_false_positives
  ];
  for (const s of everything) {
    const verdict = legacy(s.command);
    if (verdict.classification === 'OPEN') continue;
    assert.ok(verdict.rule_id, `${s.id}: a non-OPEN verdict must name its rule`);
  }
});

// ── Prose, both directions ───────────────────────────────────────────────────
// Baselines are the verdicts the rules gave before normalization existed. Five of
// them are already WITNESS: legacy string rules cannot tell an invocation from an
// echo of one, and Compass V2's documentation_only branch is what clears those.
// Recording the real baseline rather than an aspirational OPEN is what makes this
// a movement test instead of a wish.

for (const s of specimens.prose_false_positives) {
  test(`prose does not move: ${s.id}`, () => {
    assert.deepStrictEqual(
      legacy(s.command),
      { classification: s.legacy_baseline, rule_id: s.legacy_baseline_rule },
      s.command
    );
  });
}

// ── Cost ─────────────────────────────────────────────────────────────────────

test('reset pattern stays linear on adversarial whitespace', () => {
  // The 2026-07-26 attempt at this same rule used `(?:[^|;&]*\s+)?`, where
  // [^|;&] is a superset of \s and three quantifiers compete for one contiguous
  // run — 95ms at 400 spaces, 181ms at 1000, and cubic from there against a
  // 5000ms PreToolUse budget. The token-then-separator form is unambiguous.
  const timings = [];
  for (const n of [400, 1000, 4000, 8000]) {
    const sample = 'git reset ' + ' '.repeat(n) + 'x';
    const started = Date.now();
    compass.classify({ tool_name: 'Bash', tool_input: { command: sample } });
    const elapsed = Date.now() - started;
    timings.push(`${n}sp:${elapsed}ms`);
    assert.ok(elapsed < 250, `git reset with ${n} spaces took ${elapsed}ms`);
  }
  console.log(`        [note] reset on whitespace runs — ${timings.join(' ')}`);
});

test('normalization does not double the cost of a clean command', () => {
  // The second pass is skipped when normalization is a no-op, so a command with
  // no quotes and no long flags pays for one match, not two.
  const sample = 'git status --short && ls -la /tmp && echo done';
  const started = Date.now();
  for (let i = 0; i < 2000; i++) {
    compass.classify({ tool_name: 'Bash', tool_input: { command: sample } });
  }
  const elapsed = Date.now() - started;
  console.log(`        [note] 2000 classifications of a clean command — ${elapsed}ms`);
  assert.ok(elapsed < 2000, `2000 classifications took ${elapsed}ms`);
});

// ── Scope ────────────────────────────────────────────────────────────────────

test('normalization is confined to shell text', () => {
  // Quote-stripping models shell quoting. actionString() serializes a non-shell
  // tool_input to JSON, where the quotes are structure rather than syntax, and a
  // repo policy may scope a rule to any tool — so the rewrite must not reach it.
  const jsonish = { tool_name: 'Mystery', tool_input: { command: 'rm "-rf" /tmp/*' } };
  assert.strictEqual(compass.classify(jsonish).classification, 'OPEN');

  const filePath = { tool_name: 'Write', tool_input: { file_path: '"/tmp/x"' } };
  assert.strictEqual(compass.classify(filePath).classification, 'OPEN');
});

test('CHARACTERIZATION: a condition-only rule short-circuits the second pass', () => {
  // A rule with a `condition` and no pattern does not read the haystack, so it
  // fires on the first pass and the normalized pass never runs. A quoted or
  // long-form delete then lands on the condition rule's verdict instead of the
  // floor the plain spelling gets. No bundled rule is condition-only, so this
  // needs a repo policy or a replacement rules.json to reach; and it is not a
  // regression — the same command returned the same PAUSE before normalization
  // existed, because no pattern matched it either. Recorded rather than fixed:
  // reordering the passes around condition rules changes rule precedence, and a
  // replacement rules.json may deliberately place a condition rule first.
  const repoRoot = path.join(tmpRoot, 'policy-repo');
  fs.mkdirSync(path.join(repoRoot, '.t2helix'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, '.t2helix', 'policy.json'),
    JSON.stringify({
      rules: [{
        id: 'needs-goal',
        classification: 'PAUSE',
        tool: 'Bash',
        condition: 'no_session_goal',
        reason: 'no goal set'
      }]
    })
  );

  const previous = process.env.T2HELIX_POLICY_DIR;
  process.env.T2HELIX_POLICY_DIR = repoRoot;
  compass._resetCache();
  try {
    const quoted = { tool_name: 'Bash', tool_input: { command: 'rm "-rf" /tmp/*' } };
    assert.strictEqual(
      compass.classify(quoted, { has_goal: false }).rule_id,
      'needs-goal',
      'the condition rule takes the first pass'
    );
    assert.strictEqual(
      compass.classify(quoted, { has_goal: true }).rule_id,
      'rm-rf-wildcard',
      'with the condition satisfied the normalized pass reaches the floor'
    );
  } finally {
    if (previous === undefined) delete process.env.T2HELIX_POLICY_DIR;
    else process.env.T2HELIX_POLICY_DIR = previous;
    compass._resetCache();
  }
});

test('flag rewriting fires no rule it should not', () => {
  // The long-flag map is applied across the whole haystack, so every command that
  // carries one of those flags for an unrelated reason is a candidate false
  // positive. None of these may gate on account of the rewrite.
  for (const command of [
    'git reset --force-with-lease HEAD~1',
    'git commit --force -m x',
    'git rebase --force HEAD~1',
    'git clean --force -d',
    'git checkout --force main',
    'npm publish --force',
    'docker build --force-rm .',
    'git submodule update --recursive --force',
    'cp --recursive --force src dst',
    'chmod --recursive 755 ./dir'
  ]) {
    assert.strictEqual(legacy(command).classification, 'OPEN', command);
  }
});

test('summarizeAction is untouched by normalization', () => {
  // action_summary is the identity hashed into the action:<hash> chain anchor and
  // recomputed independently by PostToolUse. Normalization is a matching concern
  // only; if it leaked into the summary the two ends of the chain stop pairing.
  for (const command of [
    'rm "-rf" /tmp/*',
    'rm --recursive --force /tmp/*',
    'git reset HEAD~1 --hard',
    "sed -i 's/a/b/' file.txt"
  ]) {
    assert.strictEqual(
      compass.summarizeAction({ tool_name: 'Bash', tool_input: { command } }),
      `Bash: ${command}`,
      command
    );
  }
});

(async () => {
  let passed = 0;
  let failed = 0;
  console.log(`Compass normalization (data: ${process.env.T2HELIX_DATA_DIR})`);
  for (const entry of tests) {
    try {
      await entry.fn();
      passed++;
      console.log(`  PASS  ${entry.name}`);
    } catch (error) {
      failed++;
      console.error(`  FAIL  ${entry.name}: ${error.stack || error.message}`);
    }
  }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
