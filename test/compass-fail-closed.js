'use strict';

// The fail-closed floor and the budget-starvation chain.
//
// Two defects, one exploit. (1) `git-push-force` competed three quantifiers for a
// single contiguous whitespace run, which is cubic: 3,400 spaces cost ~6s against
// a 5,000ms PreToolUse budget. (2) Every internal failure in the hook emitted a
// bare `{}`, which is byte-identical to an evaluated OPEN — so a hook the harness
// killed for running long was indistinguishable from a hook that looked and
// cleared. Chained: prefix a destructive command with `git push` and enough
// padding, the push rule eats the budget, the rules after it never run, the hook
// is killed mid-regex, and the call proceeds ungated with no compass_log row.
//
// This suite spawns the real hook with the real 5s budget and asserts the
// decision, the wall clock, and the audit row. The pattern-level tests assert the
// timing property rather than the pattern text, because the property is what the
// fix has to keep.
//
// VACUOUS-PASS DISCLOSURE (round 1 disclosed one of these; the review found two).
// Against unpatched fe8aa0c, TWO of the four passing tests proved nothing about
// the change: (1) the exhaustive equivalence walk compared the old literal against
// the loaded rule, which on unpatched IS that literal, so it matched itself; and
// (2) "the escape hatch governs non-evaluation only — it cannot open a WITNESS"
// passed because unpatched has no hatch and a WITNESS denies regardless. Both are
// meaningful only after the change. Round 2 fixes (1) by putting `git`/`push` into
// the fuzz alphabet, which is the construct the new pattern turns on.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-failclosed-'));
process.env.T2HELIX_DATA_DIR = tmpDir;

const ch = require('../lib/chronicle');
const compass = require('../lib/compass');
const { classifyV2 } = require('../lib/compass-v2');

// The hook budget declared in hooks/hooks.json — the number the exploit targets.
const HOOK_BUDGET_MS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8')
).hooks.PreToolUse[0].hooks[0].timeout * 1000;

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL  ${name}: ${e.message}`);
    fail++;
  }
}

const HOOK = path.join(__dirname, '..', 'hooks', 'pre-tool-use.js');

// Spawn the hook under the SAME timeout the harness enforces. A killed hook is
// the exploit's payload, so `killed` is part of the result, not an error.
function runGate(payload, { env = {}, raw = null } = {}) {
  const started = Date.now();
  const res = spawnSync('node', [HOOK], {
    input: raw !== null ? raw : JSON.stringify(payload),
    env: { ...process.env, T2HELIX_DATA_DIR: tmpDir, ...env },
    encoding: 'utf8',
    timeout: HOOK_BUDGET_MS
  });
  const elapsed = Date.now() - started;
  const killed = res.signal != null || res.status === null;
  let out;
  try { out = JSON.parse((res.stdout || '').trim() || '{}'); }
  catch { out = { _unparseable: res.stdout }; }
  const hso = out.hookSpecificOutput || null;
  return {
    elapsed,
    killed,
    out,
    decision: hso ? hso.permissionDecision : null,
    reason: hso ? hso.permissionDecisionReason : '',
    // A clearance is the empty object AND nothing else. A killed hook emits
    // nothing, which the harness also reads as "no objection" — same thing.
    cleared: killed || (!hso && Object.keys(out).length === 0),
    stderr: res.stderr || ''
  };
}

function bash(session_id, command) {
  return { session_id, tool_name: 'Bash', tool_input: { command } };
}

// Assembled from fragments so this file can be edited by a seat whose own compass
// would deny a Bash call containing the literal string.
const HARD_RESET = 'git ' + 'reset' + ' --' + 'hard HEAD~1';
const DROP_TABLE = 'psql -c "' + 'drop ' + 'table users"';
const CRED = 'api' + '_key=abcdefghij';

console.log(`T2Helix fail-closed + budget tests (data: ${tmpDir}, hook budget: ${HOOK_BUDGET_MS}ms)`);

// ── The chain: padding stalls rule 2, rules 3-8 never run ───────────────────

const PAD = 3400;
const chained = [
  ['space padding', 'git push ' + ' '.repeat(PAD) + HARD_RESET],
  ['newline padding', 'git push ' + '\n'.repeat(PAD) + HARD_RESET],
  ['tab padding', 'git push ' + '\t'.repeat(PAD) + HARD_RESET],
  ['drop-table behind the padding', 'git push ' + ' '.repeat(PAD) + DROP_TABLE]
];

for (const [label, command] of chained) {
  test(`chained bypass — ${label} — reaches a decision inside the hook budget`, () => {
    const r = runGate(bash('chain-' + label.replace(/\s+/g, '-'), command));
    assert.ok(!r.killed, `hook was killed at ${HOOK_BUDGET_MS}ms (took >=${r.elapsed}ms) and emitted nothing`);
    assert.ok(r.elapsed < HOOK_BUDGET_MS, `took ${r.elapsed}ms, budget is ${HOOK_BUDGET_MS}ms`);
    assert.ok(!r.cleared, 'padded destructive command was cleared');
    assert.strictEqual(r.decision, 'deny', `expected deny, got ${r.decision}`);
  });
}

test('chained bypass: padding cannot buy an override token', () => {
  // The exploit's second move. If a stalled evaluation minted a confirm_pending
  // token the way PAUSE does, an attacker would pad, collect the token, approve
  // it, and retry — turning a two-step dance into the same bypass. Non-evaluation
  // is a hard deny with no override, like WITNESS.
  const r = runGate(bash('chain-token', 'git push ' + ' '.repeat(PAD) + HARD_RESET));
  assert.strictEqual(r.decision, 'deny');
  assert.ok(!/confirm_pending/.test(r.reason), `a token was offered: ${r.reason}`);
});

// ── The pattern property: linear on a contiguous run of one character ────────

test('git-push-force stays linear on contiguous whitespace runs', () => {
  // 400 spaces cost 51ms and 4,000 cost 141,887ms on the shipped pattern. Assert
  // the shape (doubling the run must not multiply the cost) rather than a wall
  // clock, so the test means the same thing on slower hardware.
  const rule = compass.loadRules().find(r => r.id === 'git-push-force');
  assert.ok(rule && rule._regex, 'git-push-force rule is loaded');
  const at = n => {
    const s = 'git push ' + ' '.repeat(n) + 'x';
    const t = Date.now();
    rule._regex.test(s);
    return Date.now() - t;
  };
  at(500); // warm
  const small = at(1000);
  const large = at(4000);
  assert.ok(large < 250, `4,000-space run took ${large}ms (was ~141,887ms before the fix)`);
  assert.ok(large <= small + 100, `cost grew ${small}ms -> ${large}ms across a 4x run`);
});

test('every bundled rule stays inside the per-rule budget on adversarial padding', () => {
  const rules = compass.loadRules();
  const shapes = [
    'git push ' + ' '.repeat(4000) + 'x',
    'git push ' + '\n'.repeat(4000) + 'x',
    'git push ' + '\t'.repeat(4000) + 'x',
    'git reset ' + ' '.repeat(4000) + 'x',
    'rm -rf ' + ' '.repeat(4000) + 'x',
    'rm ' + '-rf '.repeat(8000) + 'X'
  ];
  const slow = [];
  for (const rule of rules) {
    if (!rule._regex && !rule._matcher) continue;
    for (const s of shapes) {
      const t = Date.now();
      // compass.ruleTest, not rule._regex.test: a rule may ship a pattern as its
      // SPECIFICATION and be evaluated by an equivalent linear matcher, and a
      // cost test that reaches past the engine measures code the gate does not
      // run. That gap is exactly how deploy-prod stayed a named residual in a
      // suite written to watch for it.
      compass.ruleTest(rule, s);
      const ms = Date.now() - t;
      if (ms > 100) slow.push(`${rule.id} ${ms}ms on ${s.length}b`);
    }
  }
  assert.deepStrictEqual(slow, [], `rules exceeded 100ms: ${slow.join(', ')}`);
});

test('the git-push-force replacement denies everything the shipped pattern denied', () => {
  // A random byte fuzz over this alphabet produces almost no matches, which makes
  // an equivalence claim vacuous, so enumerate the token grammar exhaustively
  // instead and report the hit count next to the divergences — a run with zero
  // both-hits proves nothing and has to be visible as such.
  //
  // `git` and `push` are IN the alphabet deliberately: the round-2 pattern differs
  // from round 1 only by refusing to scan across an interior `git push`, so an
  // alphabet without those tokens cannot tell the two apart and this assertion
  // would be vacuous a second time. With them, the walk exercises exactly the
  // construct that made the pattern linear.
  const OLD = /git\s+push\s+(?:[^|;&]*\s+)?(?:--force(?!-with-lease)|-f)\b/;
  const NEW = compass.loadRules().find(r => r.id === 'git-push-force')._regex;
  const TOK = ['--force', '-f', '--force-with-lease', '--forced', '-force', '"--force"',
    'origin', 'main', '-u', '|', ';', '&', '', 'x', 'git', 'push'];
  const WS = [' ', '  ', '\t', '\n'];
  let checked = 0, both = 0, lost = 0, widened = 0;
  const lostSamples = [], widenedSamples = [];
  const check = s => {
    checked++;
    const o = OLD.test(s), n = NEW.test(s);
    if (o && n) both++;
    if (o && !n) { lost++; if (lostSamples.length < 5) lostSamples.push(JSON.stringify(s)); }
    if (n && !o) { widened++; if (widenedSamples.length < 5) widenedSamples.push(JSON.stringify(s)); }
  };
  const walk = (prefix, depth) => {
    check(prefix);
    if (depth === 0) return;
    for (const t of TOK) for (const w of WS) walk(prefix + t + w, depth - 1);
  };
  for (const pre of WS) walk('git push' + pre, 3);
  console.log(`        [note] exhaustive ${checked} inputs — both-hit:${both} lost:${lost} widened:${widened}`);
  assert.ok(both > 1000, `fuzz produced only ${both} matches — it is not exercising the pattern`);
  assert.strictEqual(lost, 0, `replacement LOST denials: ${lostSamples.join(' ')}`);
  assert.strictEqual(widened, 0, `replacement gained denials: ${widenedSamples.join(' ')}`);
});

// ── CLASS GUARD: length must not buy a non-decision, for ANY rule ────────────
//
// Round 1 pinned the INSTANCE, not the class: every adversarial input above is a
// contiguous whitespace run of the one exploit's exact shape, so the suite could
// not see either bypass the adversarial review then landed — a repeated-token pad
// against a rule whose pattern restarts on every occurrence (198KB), and an
// unbroken-token pad routed through classifySemantic, which the per-rule timing
// arm structurally CANNOT reach because it calls rule._regex.test directly.
//
// The guard below is written against the rule SET and the whole gate:
//   • a seed per rule id, with an assertion that every loaded rule has one, so a
//     new rule cannot be added without adversarial coverage;
//   • four pad shapes (whitespace run, repeated trigger, unbroken token, chained
//     repeated trigger + another rule's destructive tail);
//   • growth, not a wall clock — doubling the pad may not multiply the cost, so
//     the assertion means the same thing on slower hardware;
//   • one arm through classifyV2, which is the only way the semantic leg is
//     inside the test at all.

const ADVERSARIAL_SEEDS = {
  'rm-rf-wildcard':     { trigger: 'rm -rf ', tail: '/tmp/junk*' },
  'rm-rf-root':         { trigger: 'rm -rf ', tail: '/' },
  'git-push-force':     { trigger: 'git push ', tail: '--force' },
  'git-reset-hard':     { trigger: 'git reset ', tail: '--hard' },
  'drop-table-or-db':   { trigger: 'drop table ', tail: 'users' },
  'deploy-prod':        { trigger: 'kubectl apply ', tail: '--namespace prod' },
  'no-verify':          { trigger: 'git commit ', tail: '--no-verify' },
  'credential-paste':   { trigger: 'password=', tail: 'hunter2hunter2' },
  'grok-direct-mutate': { trigger: 'raw-mutate ', tail: 'raw-mutate' },
  // Not bundled — this repo's own .t2helix/policy.json. Seeded anyway: repo-local
  // rules compile operator regexes with no linearity check, so they are exactly
  // the population the guard should cover.
  't2helix-protect-chronicle-db': { trigger: 'rm x ', tail: 'chronicle.db' }
};

// NAMED, UNCLOSED RESIDUALS — do not delete entries to make the suite green.
//
// Measured at a 200,000-char pad, every rule is 0-8ms on all four shapes; the one
// entry left here is 3,500-4,100ms, so the signal is a 400x separation, not a
// judgement call. It is quadratic in the number of TRIGGER words in a segment.
//
//  • t2helix-protect-chronicle-db — this repo's own .t2helix/policy.json, pattern
//    `rm\s+.*chronicle\.db`. Left AS IS deliberately: it is the concrete instance
//    of the population the classify/gate budgets exist for — operator regexes that
//    lib/compass has never seen and cannot linearity-check. On a carrier fe8aa0c
//    never gated, a rule like this one is now bounded from the other end too: the
//    capability parity floor (lib/compass.capabilityOnlyCall) clears such a call
//    rather than denying it, so an operator's slow regex can cost latency there
//    but can no longer turn a base ALLOW into a deny. See
//    test/compass-no-worse-than-base.js.
//
// CLOSED 2026-07-30 — deploy-prod. It was quadratic for the same reason, and the
// note here said the fix "needs its own equivalence proof" because deploy-prod's
// read-only carve-out can block an EARLIER trigger that a later one does not, so
// the restart-at-a-later-trigger rewrite that linearised git-push-force and
// no-verify would have changed which commands match. That proof now exists: the
// rule keeps its pattern as the SPECIFICATION and is evaluated by
// lib/rules/deploy-prod-matcher.js, a linear reimplementation that
// test/compass-no-worse-than-base.js walks against the declared pattern over a
// generated corpus of the rule's own vocabulary, failing on a divergence in
// either direction. `kubectl apply x ` repeated: 1,935ms -> 2ms at 150KB, and
// 8ms at 800KB where both trees previously went ungated.
//
// The list is an UPPER BOUND. A new superlinear rule fails the test; fixing one of
// these also fails it (remove the entry) rather than passing silently.
const KNOWN_SUPERLINEAR = ['t2helix-protect-chronicle-db'];

// Where a single rule's regex sits when it is linear, versus when it is not.
const RULE_COST_PAD = 200000;
const RULE_COST_CEILING_MS = 250;

// Every pad is built so the rule does NOT match — a matching rule returns on the
// first hit and is therefore never the stall vector. The cost being measured is
// the cost of FAILING to match, which is what the exploit buys.
function padShapes({ trigger, tail }, n) {
  return {
    'whitespace-run': trigger + ' '.repeat(n) + 'q',
    'repeated-trigger': trigger.repeat(Math.max(1, Math.floor(n / trigger.length))) + 'q',
    'unbroken-token': trigger + 'a'.repeat(n),
    'chained-trigger': trigger.repeat(Math.max(1, Math.floor(n / trigger.length))) + ' ' + HARD_RESET,
    // The tail the rule is LOOKING for, placed where the rule cannot reach it —
    // behind a command separator. A mandatory-literal guard ("the tail word is
    // not in the input, so skip the rule") passes the four shapes above and is
    // defeated by this one, which is why it is here: the deploy-prod fix had to
    // be a linearisation, not a presence check. Every trigger in the run still
    // has to be considered and every one still fails, so this is the worst case
    // for a rule that restarts on each occurrence.
    'blocked-tail': trigger.repeat(Math.max(1, Math.floor(n / trigger.length))) + '|' + tail
  };
}

test('every bundled rule has adversarial coverage — a new rule cannot slip in untested', () => {
  const missing = compass.loadRules()
    .filter(r => (r._regex || r._matcher) && !ADVERSARIAL_SEEDS[r.id])
    .map(r => r.id);
  assert.deepStrictEqual(missing, [],
    `rules with no entry in ADVERSARIAL_SEEDS: ${missing.join(', ')} — add a trigger/tail seed`);
});

test('no rule can burn the hook budget on any pad shape, except the named residuals', () => {
  // Cost of FAILING to match at attack scale, per rule, per shape. A matching rule
  // returns on the first hit and is never the stall vector, so every pad here is
  // built not to match. Threshold is 250ms against a measured 0-1ms for the linear
  // rules — a 250x margin, so this does not become a hardware-speed assertion.
  const detail = [];
  const offenders = new Set();
  for (const rule of compass.loadRules()) {
    if ((!rule._regex && !rule._matcher) || !ADVERSARIAL_SEEDS[rule.id]) continue;
    const shapes = padShapes(ADVERSARIAL_SEEDS[rule.id], RULE_COST_PAD);
    for (const [shape, s] of Object.entries(shapes)) {
      const t = Date.now();
      compass.ruleTest(rule, s);
      const ms = Date.now() - t;
      if (ms > RULE_COST_CEILING_MS) {
        offenders.add(rule.id);
        detail.push(`${rule.id}/${shape}: ${ms}ms on ${s.length}b`);
      }
    }
  }
  const found = [...offenders].sort();
  const unexpected = found.filter(id => !KNOWN_SUPERLINEAR.includes(id));
  // Scoped to LOADED rules: the repo-policy entry is absent whenever
  // T2HELIX_POLICY_DIR is blanked (which the suite runner does), and "not loaded"
  // is not "fixed".
  const loaded = new Set(compass.loadRules().map(r => r.id));
  const fixed = KNOWN_SUPERLINEAR.filter(id => loaded.has(id) && !found.includes(id));
  console.log(`        [note] over ${RULE_COST_CEILING_MS}ms at ${RULE_COST_PAD}b: ${found.join(', ') || 'none'}`);
  assert.deepStrictEqual(unexpected, [],
    `NEW superlinear rules (not in KNOWN_SUPERLINEAR): ${detail.join(' | ')}`);
  assert.deepStrictEqual(fixed, [],
    `these are no longer superlinear — remove them from KNOWN_SUPERLINEAR: ${fixed.join(', ')}`);
});

test('the WHOLE gate (both legs) stays in budget on every pad shape', () => {
  // classifyV2, not rule._regex — classifySemantic is the leg that dominated cost
  // and that the round-1 timing test could not see. 100KB is past every size the
  // review landed a bypass at (80KB semantic pad, 198KB repeated prefix scaled).
  const N = 100000;
  const slow = [];
  let worst = 0, worstLabel = '';
  // 3,000ms against the 5,000ms hook budget. The ceiling is uniform rather than
  // per-seed because classifyV2 runs the WHOLE rule set on every input: the two
  // KNOWN_SUPERLINEAR rules are paid by every pad here, whichever rule the pad was
  // built for, so a tighter per-seed ceiling would only measure them anyway.
  const ceiling = 3000;
  for (const id of Object.keys(ADVERSARIAL_SEEDS)) {
    const shapes = padShapes(ADVERSARIAL_SEEDS[id], N);
    for (const [shape, command] of Object.entries(shapes)) {
      const t = Date.now();
      const v2 = classifyV2({ tool_name: 'Bash', tool_input: { command } }, {});
      const ms = Date.now() - t;
      assert.ok(v2 && v2.active && v2.active.classification, `${id}/${shape} produced no verdict`);
      if (ms > worst) { worst = ms; worstLabel = `${id}/${shape}`; }
      if (ms > ceiling) slow.push(`${id}/${shape} ${ms}ms > ${ceiling}ms (${command.length}b)`);
    }
  }
  console.log(`        [note] slowest 100KB pad through both legs: ${worstLabel} ${worst}ms`);
  assert.deepStrictEqual(slow, [], `gate over budget: ${slow.join(' | ')}`);
});

test('a padded destructive command reaches a DECISION at every size, not a timeout', () => {
  // The end-to-end property both landed bypasses violated: the hook must emit a
  // verdict inside the harness budget however long the command is. Sizes span the
  // two exploits (80KB semantic pad, 198KB repeated prefix) and 4x past the point
  // fe8aa0c itself went ungated on the repeated-prefix shape (352KB).
  const bad = [];
  const cases = [
    ['semantic-leg pad 80KB', HARD_RESET + '; echo ' + 'a'.repeat(80000)],
    ['semantic-leg pad 200KB', HARD_RESET + '; echo ' + 'a'.repeat(200000)],
    ['repeated git-push 198KB', 'git push '.repeat(22000) + ' ' + HARD_RESET],
    ['repeated git-push 432KB', 'git push '.repeat(48000) + ' ' + HARD_RESET],
    ['repeated git-push 198KB + drop table', 'git push '.repeat(22000) + ' ' + DROP_TABLE]
  ];
  for (const [label, command] of cases) {
    const r = runGate(bash('cls-' + label.replace(/\W+/g, '-'), command));
    if (r.killed) bad.push(`${label}: hook killed at ${HOOK_BUDGET_MS}ms, emitted nothing (UNGATED)`);
    else if (r.cleared) bad.push(`${label}: cleared`);
    else if (r.decision !== 'deny') bad.push(`${label}: decision=${r.decision}`);
  }
  assert.deepStrictEqual(bad, [], bad.join(' | '));
});

test('the semantic leg is skipped only where it provably cannot change the verdict', () => {
  // The skip is the load-bearing half of the 80KB fix, so assert the CONDITION,
  // not just the timing: a WITNESS is skippable only above the size gate; PAUSE
  // and OPEN are never skipped at any size, because for those the semantic leg
  // can ESCALATE and dropping an escalation would be a fail-open.
  const big = 'a'.repeat(20000);
  const witnessBig = classifyV2({ tool_name: 'Bash', tool_input: { command: HARD_RESET + '; echo ' + big } }, {});
  assert.strictEqual(witnessBig.legacy.classification, 'WITNESS');
  assert.ok(/^legacy-witness-oversize/.test(String(witnessBig.shadow.semantic_skipped)),
    `oversize WITNESS should skip the semantic leg, got ${witnessBig.shadow.semantic_skipped}`);
  assert.strictEqual(witnessBig.active.classification, 'WITNESS', 'skipping must not soften the verdict');

  const witnessSmall = classifyV2({ tool_name: 'Bash', tool_input: { command: HARD_RESET } }, {});
  assert.strictEqual(witnessSmall.shadow.semantic_skipped, null,
    'an ordinary WITNESS still runs the leg — the shadow window must not go dark');
  // The leg RAN, which is the property under test. git-reset-hard is a
  // non-migrated rule, so the semantic verdict is legitimately OPEN and
  // shadow.agree is legitimately false — what must not happen is a null verdict.
  assert.notStrictEqual(witnessSmall.shadow.semantic_classification, null,
    'the shadow row must carry a real semantic verdict, not a hole');
  assert.strictEqual(witnessSmall.active.classification, 'WITNESS');

  const pauseBig = classifyV2({ tool_name: 'Bash', tool_input: { command: 'echo api_key=abcdefghij ' + big } }, {});
  assert.strictEqual(pauseBig.legacy.classification, 'PAUSE');
  assert.strictEqual(pauseBig.shadow.semantic_skipped, null,
    'PAUSE must never be skipped — the semantic leg can escalate it');

  const openBig = classifyV2({ tool_name: 'Bash', tool_input: { command: 'echo ' + big } }, {});
  assert.strictEqual(openBig.legacy.classification, 'OPEN');
  assert.strictEqual(openBig.shadow.semantic_skipped, null,
    'OPEN must never be skipped — the semantic leg can escalate it');

  // "Never" has to be tested with the skip FORCED, not merely with inputs that
  // happen not to trigger it. The size gate above cannot fire for OPEN/PAUSE, but
  // the clock gate could: with the budget at -1 every skip condition is true, so
  // any one of them that is not gated on the fail-closed set shows up here.
  // (It did: the clock gate skipped OPEN and PAUSE until it was gated.)
  const prevBudget = process.env.T2HELIX_SEMANTIC_BUDGET_MS;
  process.env.T2HELIX_SEMANTIC_BUDGET_MS = '-1';
  try {
    for (const [expected, command] of [['OPEN', 'ls -la'], ['PAUSE', 'echo ' + CRED]]) {
      const v = classifyV2({ tool_name: 'Bash', tool_input: { command } }, {});
      assert.strictEqual(v.legacy.classification, expected, `setup: expected legacy ${expected}`);
      assert.strictEqual(v.shadow.semantic_skipped, null,
        `${expected} was skipped with the semantic budget forced negative — an escalation can be lost`);
      assert.ok(v.semantic && v.semantic.classification,
        `${expected} must still carry a semantic verdict`);
    }
    // The same forced budget MUST still skip a WITNESS — otherwise the assertion
    // above would pass simply because the clock gate stopped working at all.
    const w = classifyV2({ tool_name: 'Bash', tool_input: { command: HARD_RESET } }, {});
    assert.ok(/^legacy-leg-spent-budget/.test(String(w.shadow.semantic_skipped)),
      `the clock gate must still fire for WITNESS, got ${w.shadow.semantic_skipped}`);
  } finally {
    if (prevBudget === undefined) delete process.env.T2HELIX_SEMANTIC_BUDGET_MS;
    else process.env.T2HELIX_SEMANTIC_BUDGET_MS = prevBudget;
  }
});

test('a legacy NOT_EVALUATED cannot be cleared or softened by the semantic leg', () => {
  // The one merge site round 1 asserted rather than read. Measured then: enforce +
  // semantic documentation_only returned active OPEN with false_positive_cleared:
  // 'classify-budget-exceeded' — a non-evaluation recorded as a cleared false
  // positive, the exact audit defect NOT_EVALUATED exists to close. A semantic
  // PAUSE is equally disallowed: PAUSE mints an override token and the
  // non-evaluation floor deliberately mints none.
  const { mergeDecisions } = require('../lib/compass-semantic');
  const ne = { classification: 'NOT_EVALUATED', rule_id: 'classify-budget-exceeded', reason: 'starved' };
  const semantics = {
    documentation_only: { classification: 'OPEN', rule_id: null, documentation_only: true },
    open: { classification: 'OPEN', rule_id: null },
    pause: { classification: 'PAUSE', rule_id: 'credential-paste' },
    witness: { classification: 'WITNESS', rule_id: 'rm-rf-root' },
    skipped: null
  };
  const wrong = [];
  for (const mode of ['shadow', 'enforce']) {
    for (const [label, sem] of Object.entries(semantics)) {
      const m = mergeDecisions(ne, sem, mode, { normalized_action_hash: 'h' });
      if (m.active.classification !== 'NOT_EVALUATED') wrong.push(`${mode}/${label} -> ${m.active.classification}`);
      if (m.active.false_positive_cleared) wrong.push(`${mode}/${label} recorded false_positive_cleared`);
    }
  }
  assert.deepStrictEqual(wrong, [], wrong.join(' | '));
});

// ── The floor: an internal failure is not a clearance ───────────────────────

function notEvaluatedRows(session_id) {
  return ch.db()
    .prepare(`SELECT * FROM compass_log WHERE session_id = ? AND classification = 'NOT_EVALUATED'`)
    .all(session_id);
}

test('unparseable stdin denies instead of emitting a bare {}', () => {
  const r = runGate(null, { raw: 'not json at all {{{' });
  assert.ok(!r.cleared, 'garbage stdin cleared the call');
  assert.strictEqual(r.decision, 'deny');
  assert.ok(/not evaluate/i.test(r.reason), `reason should say the gate did not evaluate: ${r.reason}`);
});

test('empty stdin denies instead of emitting a bare {}', () => {
  const r = runGate(null, { raw: '' });
  assert.ok(!r.cleared, 'empty stdin cleared the call');
  assert.strictEqual(r.decision, 'deny');
});

test('a payload with no tool_name denies — the gate cannot clear what it cannot name', () => {
  const r = runGate({ session_id: 'fc-no-tool' });
  assert.ok(!r.cleared);
  assert.strictEqual(r.decision, 'deny');
});

test('a non-evaluation writes a compass_log row that says so', () => {
  const sid = 'fc-audit-row';
  const r = runGate({ session_id: sid, tool_input: { command: 'ls' } });
  assert.strictEqual(r.decision, 'deny');
  const rows = notEvaluatedRows(sid);
  assert.strictEqual(rows.length, 1, `expected one NOT_EVALUATED row, got ${rows.length}`);
  assert.ok(rows[0].rule_matched, 'the row names which failure path fired');
});

test('the escape hatch restores the old behaviour and still leaves an audit row', () => {
  const sid = 'fc-hatch';
  const r = runGate({ session_id: sid, tool_input: { command: 'ls' } },
    { env: { T2HELIX_GATE_FAILURE_MODE: 'open' } });
  assert.ok(r.cleared, 'escape hatch must clear');
  const rows = notEvaluatedRows(sid);
  assert.strictEqual(rows.length, 1, 'the row is written even when the hatch clears the call');
  assert.ok(/hatch|open/i.test(String(rows[0].user_override || '')),
    `the row records that the hatch was active: ${rows[0].user_override}`);
});

test('the escape hatch governs non-evaluation only — it cannot open a WITNESS', () => {
  const r = runGate(bash('fc-hatch-witness', 'rm -rf /'),
    { env: { T2HELIX_GATE_FAILURE_MODE: 'open' } });
  assert.strictEqual(r.decision, 'deny', 'the hatch must not touch a real verdict');
  assert.ok(/rm-rf/.test(r.reason));
});

test('an approved token for the same action does not clear a non-evaluation', () => {
  // The retry half of the padding exploit. PAUSE consumes an approval keyed on the
  // action summary; if a non-evaluation reached that branch, an attacker could get
  // a token from any PAUSE on the same text and spend it on the unevaluated call.
  const sid = 'fc-no-reuse';
  const command = 'echo api_key=zzz';
  const first = runGate(bash(sid, command));
  // The token is NOT scraped from the deny text any more — that text is read by
  // the party being denied, and handing it the credential that lifts the deny was
  // the leak the approval-provenance fix closed. It names the pending request
  // instead, and the token is fetched from the ledger by an operator surface.
  // Asserting both halves here keeps this test honest about which contract it
  // depends on: the token must be absent from the reason, and present in the row.
  assert.ok(!/token="?[0-9a-f]{8,}/.test(String(first.reason || '')),
    `the deny reason must not carry the override token: ${first.reason}`);
  const pending = ch.listPendingConfirmations({ session_id: sid })
    .filter(r => r.status === 'pending');
  assert.strictEqual(pending.length, 1, 'the PAUSE minted exactly one pending confirmation');
  assert.ok(new RegExp(`#${pending[0].id}\\b`).test(String(first.reason || '')),
    `the deny reason names the request handle #${pending[0].id}: ${first.reason}`);
  assert.strictEqual(ch.approveConfirmation({ token: pending[0].token, origin: 'test' }).ok, true);

  const retry = runGate(bash(sid, command), { env: { T2HELIX_CLASSIFY_BUDGET_MS: '-1' } });
  assert.ok(!retry.cleared, 'an approved token cleared a call that was never evaluated');
  assert.strictEqual(retry.decision, 'deny');
});

// ── The budget guard: an unevaluated rule is not a cleared rule ──────────────

test('classify() reports NOT_EVALUATED when the rule budget runs out', () => {
  const prev = process.env.T2HELIX_CLASSIFY_BUDGET_MS;
  process.env.T2HELIX_CLASSIFY_BUDGET_MS = '-1';
  try {
    const r = compass.classify({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }, {});
    assert.strictEqual(r.classification, 'NOT_EVALUATED');
    assert.ok(r.evidence && Array.isArray(r.evidence.rules_unevaluated),
      'evidence names the rules that never ran');
    assert.ok(r.evidence.rules_unevaluated.length > 0, 'at least one rule went unevaluated');
  } finally {
    if (prev === undefined) delete process.env.T2HELIX_CLASSIFY_BUDGET_MS;
    else process.env.T2HELIX_CLASSIFY_BUDGET_MS = prev;
  }
});

test('a budget-exhausted classify denies at the hook', () => {
  const sid = 'fc-budget';
  const r = runGate(bash(sid, 'ls -la'), { env: { T2HELIX_CLASSIFY_BUDGET_MS: '-1' } });
  assert.ok(!r.cleared, 'a benign command cleared despite no rule having been evaluated');
  assert.strictEqual(r.decision, 'deny');
  assert.strictEqual(notEvaluatedRows(sid).length, 1);
});

// ── Non-clearance propagates to every seat, not just the hook ───────────────

test('non-clearance is a predicate, and the adapters honour it', () => {
  assert.strictEqual(compass.isClearance('OPEN'), true);
  assert.strictEqual(compass.isClearance('NOT_EVALUATED'), false);
  assert.strictEqual(compass.isClearance('WITNESS'), false);
  assert.strictEqual(compass.isClearance('PAUSE'), false);

  const prev = process.env.T2HELIX_CLASSIFY_BUDGET_MS;
  process.env.T2HELIX_CLASSIFY_BUDGET_MS = '-1';
  try {
    delete require.cache[require.resolve('../lib/codex-adapter')];
    const codex = require('../lib/codex-adapter');
    const c = codex.codexCompassCheck('ls -la');
    assert.strictEqual(c.classification, 'NOT_EVALUATED');
    assert.strictEqual(c.recommendation, 'STOP_AND_REQUEST_HUMAN_REVIEW',
      'a non-evaluation must not read as PROCEED_WITH_NORMAL_JUDGMENT');
  } finally {
    if (prev === undefined) delete process.env.T2HELIX_CLASSIFY_BUDGET_MS;
    else process.env.T2HELIX_CLASSIFY_BUDGET_MS = prev;
  }
});

// ── The floor the fix must not move ─────────────────────────────────────────

test('OPEN still clears and WITNESS still denies', () => {
  const open = runGate(bash('fc-open', 'ls -la'));
  assert.deepStrictEqual(open.out, {}, 'OPEN must still emit {}');
  const witness = runGate(bash('fc-witness', 'rm -rf /'));
  assert.strictEqual(witness.decision, 'deny');
  assert.ok(/rm-rf/.test(witness.reason), 'reason names the rule');
});

test('a large ordinary command is still evaluated, not denied for its size', () => {
  const heredoc = 'cat <<EOF\n' + 'an ordinary line of file content\n'.repeat(3000) + 'EOF';
  const r = runGate(bash('fc-heredoc', heredoc));
  assert.ok(!r.killed, `heredoc hook was killed after ${r.elapsed}ms`);
  assert.deepStrictEqual(r.out, {}, 'a 96KB heredoc is ordinary work and must clear');
});

console.log(`\n${pass} passed, ${fail} failed`);
try { ch.close(); } catch (_) {}
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
process.exit(fail === 0 ? 0 : 1);
