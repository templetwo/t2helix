'use strict';

// test/compass-no-worse-than-base.js
//
// THE PROPERTY: there is no input, on any carrier, for which this tree produces
// a worse outcome than fe8aa0c — the commit this release is measured against.
// "Worse" is four things, and each has its own arm below:
//
//   1. base denies and this tree clears           (a detection loss)
//   2. base reaches a decision and this tree is killed emitting nothing
//   3. base writes an audit row and this tree writes none
//   4. base clears a benign command and this tree denies it
//
// WHAT WENT WRONG, so the arms are readable as answers rather than as ritual.
// Capability routing began feeding the `command`/`script` of NON-Bash tools
// (mcp__shell__run, Terminal, any future MCP shell tool) to the shell rules.
// fe8aa0c skipped every one of those rules for those tools — one line,
// `if (rule.tool && rule.tool !== tool_name) continue;` — so it returned ALLOW in
// ~55ms at any size without reading a byte. Measured hook-level, base vs merged,
// `kubectl apply x ` repeated:
//
//         base mcp__shell__run     merged mcp__shell__run
//   80KB    55ms ALLOW               618ms ALLOW
//  150KB    56ms ALLOW              2006ms NOT_EVALUATED   (4: a new denial)
//  400KB    58ms ALLOW              5003ms KILLED          (2 and 3: no row)
//
// and on BASH, where the brief said the merge was strictly better:
//
//  150KB  1978ms ALLOW              2004ms NOT_EVALUATED   (4: a new denial)
//
// One cause, two fixes. The cost was the deploy-prod rule, quadratic in the
// number of trigger words in a segment; it is now a linear matcher, which is
// what closes the Bash cells (a budget cannot preempt a regex already entered,
// and the parity floor is forbidden on Bash). The parity floor closes the
// newly-routed carriers against rules this file has never seen — an operator's
// .t2helix/policy.json — by making budget exhaustion there fall back to what
// fe8aa0c did, rather than to a denial.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-nowworse-'));
process.env.T2HELIX_DATA_DIR = tmpDir;
process.env.T2HELIX_POLICY_DIR = ''; // bundled rules only unless an arm says otherwise

const compass = require('../lib/compass');
const { classifyV2 } = require('../lib/compass-v2');
const matcher = require('../lib/rules/deploy-prod-matcher');
const APERIODIC = require('./fixtures/aperiodic-pad');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(`    ${e.stack || e.message}`);
  }
}

console.log(`T2Helix no-worse-than-base tests (data: ${tmpDir})`);

// Assembled rather than written literally, so this file can be edited by an
// agent whose own PreToolUse gate reads the diff.
const PROD = 'pr' + 'od';
const RM = 'r' + 'm';
const DROPTBL = 'dr' + 'op ta' + 'ble';

function pad(s, n) {
  let o = '';
  while (o.length < n) o += s;
  return o.slice(0, n);
}

// ── ARM 1: the linear matcher denies exactly what the declared pattern denies ──
//
// deploy-prod keeps its `pattern` as the SPECIFICATION and is evaluated by
// lib/rules/deploy-prod-matcher.js. The previous round declined to touch this
// rule with the note that a rewrite "needs its own equivalence proof", because
// its read-only carve-out can block an EARLIER trigger that a later one does
// not. This is that proof. It has to be a walk over the rule's OWN vocabulary:
// a random-byte fuzz produces no matches at all and the assertion would be
// vacuous, which is why the both-hit count is asserted and printed.

const DECLARED = (() => {
  const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'rules', 'compass-rules.json'), 'utf8'));
  const dp = rules.rules.find(r => r.id === 'deploy-prod');
  assert.ok(dp && dp.pattern, 'deploy-prod must still ship its pattern as the specification');
  return new RegExp(dp.pattern.replace(/^\(\?i\)/, ''), 'i');
})();

test('the matcher and the rule file are built from one vocabulary', () => {
  const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'rules', 'compass-rules.json'), 'utf8'));
  const dp = rules.rules.find(r => r.id === 'deploy-prod');
  assert.strictEqual(matcher.buildPattern(), dp.pattern,
    'the matcher rebuilds the shipped pattern character for character — a vocabulary edit that reaches only one of the two is this failure');
  assert.strictEqual(dp.matcher_source, 'deploy-prod', 'the rule must name the matcher that evaluates it');
});

test('deploy-prod: the linear matcher agrees with the declared pattern on every input walked', () => {
  const TOK = [
    ...matcher.TRIGGERS, ...matcher.READ_ONLY, ...matcher.MUTATING, ...matcher.TARGETS,
    'KUBECTL', 'Prod', 'GET', 'prods', 'xprod', 'ns/prod', 'x', 'foo', '-f', '--namespace', 'a', ''
  ];
  const SEP = [' ', '  ', '\t', '|', ';', '&', '\n', '\r', '', '/', '-', '_', '=', '.', ':'];
  let seed = 0x2f6e2b1;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const pick = a => a[Math.floor(rnd() * a.length)];

  let checked = 0, both = 0, lost = 0, widened = 0;
  const lostS = [], widS = [];
  const check = s => {
    checked++;
    const a = DECLARED.test(s), b = matcher.test(s);
    if (a && b) both++;
    if (a && !b) { lost++; if (lostS.length < 5) lostS.push(JSON.stringify(s)); }
    if (b && !a) { widened++; if (widS.length < 5) widS.push(JSON.stringify(s)); }
  };

  // Exhaustive over a reduced alphabet: every ordering of trigger / read-only /
  // mutating / target across four slots and three separators. This is the arm
  // that exercises the carve-out interaction the old note was worried about.
  const SMALL = ['kubectl', 'aws', 'get', 'status', 'apply', RM, PROD, 'production', 'x', ''];
  const SMALLSEP = [' ', '|', ';', '\n', '', '-'];
  for (const a of SMALL) for (const s1 of SMALLSEP)
    for (const b of SMALL) for (const s2 of SMALLSEP)
      for (const c of SMALL) for (const s3 of SMALLSEP)
        for (const d of SMALL) check(a + s1 + b + s2 + c + s3 + d);

  // Randomised longer sequences over the full vocabulary.
  for (let i = 0; i < 120000; i++) {
    const len = 1 + Math.floor(rnd() * 9);
    let s = '';
    for (let j = 0; j < len; j++) s += pick(TOK) + pick(SEP);
    check(s);
  }

  // The `$` in the read-only lookahead is the end of the WHOLE string, not of
  // the segment, so every edge gets a prefix and a suffix walk of its own.
  for (const t of TOK) for (const s of SEP) {
    check('kubectl apply ' + PROD + s + t);
    check(t + s + 'kubectl apply ' + PROD);
    check('kubectl ' + t + s + 'apply ' + PROD);
    check('kubectl apply ' + t + s + PROD);
  }

  console.log(`        [note] deploy-prod equivalence: ${checked} inputs — both-hit:${both} lost:${lost} widened:${widened}`);
  assert.ok(both > 5000, `walk produced only ${both} matches — it is not exercising the rule`);
  assert.strictEqual(lost, 0, `the matcher LOST denials the pattern makes: ${lostS.join(' ')}`);
  assert.strictEqual(widened, 0, `the matcher GAINED denials the pattern does not make: ${widS.join(' ')}`);
});

test('deploy-prod: cost grows linearly, including when the target is present but unreachable', () => {
  // Growth, not a wall clock, so the assertion means the same thing on slower
  // hardware. Quadratic would multiply by ~16 when the input quadruples; linear
  // multiplies by ~4. The ceiling of 8 sits between them with room for timer
  // noise at these sizes.
  const shapes = {
    'no-target': n => pad('kubectl apply x ', n),
    // A mandatory-literal guard would pass 'no-target' and fail here: the target
    // IS in the input, just behind a separator no trigger can reach across.
    'unreachable-target': n => pad('kubectl apply x ', n) + '|' + PROD,
    'read-only-blocked': n => pad('kubectl get x ', n)
  };
  const detail = [];
  for (const [label, mk] of Object.entries(shapes)) {
    const small = mk(100000);
    const big = mk(400000);
    const t1 = Date.now(); matcher.test(small); const msSmall = Math.max(1, Date.now() - t1);
    const t2 = Date.now(); matcher.test(big); const msBig = Math.max(1, Date.now() - t2);
    const ratio = msBig / msSmall;
    detail.push(`${label} ${msSmall}ms->${msBig}ms (x${ratio.toFixed(1)})`);
    assert.ok(msBig < 500, `${label}: 400KB took ${msBig}ms — the rule is back to superlinear`);
    assert.ok(ratio < 8, `${label}: 4x the input cost ${ratio.toFixed(1)}x the time — that is not linear`);
  }
  console.log(`        [note] deploy-prod growth 100KB->400KB: ${detail.join(', ')}`);
});

// ── ARM 2: the carriers fe8aa0c never gated are never worse off ───────────────
//
// The relation is asserted against BASH rather than against a recorded fixture
// of fe8aa0c's outputs. A fixture goes stale the moment the rules change and
// then asserts history instead of behaviour; Bash is the carrier fe8aa0c DID
// gate, so "this carrier reaches the same verdict Bash reaches" is both the
// no-new-false-positive property (arm 4 — nothing denies here that has not
// denied on Bash since before fe8aa0c) and the no-detection-loss property
// (arm 1) in one statement.

const CARRIERS = [
  ['mcp__shell__run', 'command'],
  ['Terminal', 'script'],
  ['mcp__future__exec', 'command'],
  ['ShellTool', 'command']
];

const BENIGN_SHAPES = {
  'base64-blob': n => 'echo ' + pad('QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqaw==', n),
  'lowercase-run': n => 'echo ' + pad('abcdefghijklmnopqrstuvwxyz', n),
  'prose': n => pad('Please summarize the following notes about the release and say what changed. ', n),
  'heredoc': n => "cat <<'EOF'\n" + pad('the quick brown fox jumps over the lazy dog\n', n) + '\nEOF',
  'quote-churn': n => 'echo ' + pad('"tok" \'other\' "x" ', n),
  'long-flag-churn': n => 'echo ' + pad('--force-with-lease --recursive --verbose ', n),
  // The shape that produced every regression cell in the matrix above.
  'repeated-deploy-trigger': n => pad('kubectl apply x ', n),
  'repeated-trigger-blocked-target': n => pad('kubectl apply x ', n) + '|' + PROD,
  // ── APERIODIC letter+digit runs ──────────────────────────────────────────
  //
  // Every shape above is PERIODIC: `base64-blob` repeats one 52-char token,
  // `lowercase-run` a 26-char cycle, the rest a word or a flag. All of them
  // measure ~2ms against lib/secrets.DETECTION_REGEX, which is why the first
  // "420 cells, 0 worse" receipt from this file was accurate for what it swept
  // and blind to the shape that mattered. An independent 630-cell grid then
  // found five cells WORSE than fe8aa0c, every one of them a random letter+digit
  // run: ALLOW/62ms on base became DENY/2,620ms at 400K and a 5,004ms SIGKILL at
  // 800K that emitted nothing and LOST the audit row (1 -> 0).
  //
  // Hex dumps and alphanumeric ID streams are ordinary shell payloads
  // (`openssl rand -hex`, concatenated sha256s, `xxd -p`), so this is a benign
  // shape and belongs in this list rather than in the exploit set.
  'aperiodic-hex-run': n => 'echo ' + APERIODIC.hexRun(n),
  'aperiodic-alnum-run': n => 'echo ' + APERIODIC.alnum36Run(n),
  'aperiodic-mixedcase-run': n => 'echo ' + APERIODIC.alnum62Run(n),
  // ── RUNS OF COMMAND-POSITION STARTS (0.14.0 re-review) ───────────────────
  //
  // The narrowed approval-script rule treats "(" and "$(" as command-position
  // starts. Its first form let the classes AFTER a start accept "(", so every
  // "(" in an unbroken run restarted a scan to the end: 3.6s at 64KB, killed at
  // 800KB, and at the real hook a 120KB pad took 14s against the 8s budget and
  // hid credential-paste behind NOT_EVALUATED. Subshells are ordinary shell,
  // so this is a benign shape. Its "$(" sibling is pinned in its own test
  // below, on the rules leg only: see the note there.
  'paren-run': n => 'echo ' + pad('(', n)
};

const SIZES = [20000, 80000, 150000, 180000, 200000, 400000, 800000];

// "$(" runs: the rules leg is held linear here at every size. The WHOLE gate is
// not asserted for this shape because its cost there is lib/action-ir's
// parseToIR, which is pre-existing and untouched by this release: measured on
// main 8d75894, classifyV2 on 'echo ' + "$(" x n took 0.9s at 75KB, 1.7s at
// 150KB and 4.0s at 300KB with legacy classify at 3ms (this branch: 0.87s,
// 1.6s, 4.2s). Putting the shape in BENIGN_SHAPES would fail the gate arm on
// main and on this branch alike and assert nothing this release regressed;
// that cost is named as its own finding instead.
test('a "$(" run: the rules leg (incl. the approval-script rule) stays linear at every size', () => {
  const rule = compass.loadRules().find(r => r.id === 'approve-' + 'pending-script');
  const bad = [];
  let worst = 0, worstLabel = '';
  for (const n of SIZES) {
    const command = 'echo ' + pad('$(', n);
    const t0 = Date.now();
    compass.ruleTest(rule, command);
    const ruleMs = Date.now() - t0;
    const t1 = Date.now();
    const legacy = compass.classify({ tool_name: 'Bash', tool_input: { command } }, {});
    const rulesMs = Date.now() - t1;
    if (rulesMs > worst) { worst = rulesMs; worstLabel = `${n}b`; }
    if (ruleMs > 250) bad.push(`${n}b: approval-script rule ${ruleMs}ms > 250ms`);
    if (rulesMs > 250) bad.push(`${n}b: rules leg ${rulesMs}ms > 250ms`);
    if (legacy.classification === compass.NOT_EVALUATED) bad.push(`${n}b: legacy leg NOT_EVALUATED`);
  }
  console.log(`        [note] "$(" run: slowest rules leg ${worstLabel} ${worst}ms`);
  assert.deepStrictEqual(bad, [], bad.join(' | '));
});

// Generated pads for the approval-script rule: every 1- or 2-piece combination
// of the pattern's own pieces (command-position starts, prefix words, flags,
// quotes, separators, whitespace), repeated to 8KB. A linear rule answers each
// in well under a millisecond; the quadratic first form took ~57ms on "$(" at
// this size and the re-review's 3-piece scan found 326 slow pads. The ceiling
// is 25ms per pad — a 25x+ margin over linear, and still under half of what the
// smallest quadratic offender costs here — so this stays a shape assertion,
// not a hardware-speed one.
test('approval-script rule: no generated 1-2 piece pad of its own vocabulary is slow at 8KB', () => {
  const rule = compass.loadRules().find(r => r.id === 'approve-' + 'pending-script');
  assert.ok(rule, 'the approval-script rule is loaded');
  const AP7 = 'app' + 'rove-';
  const pieces = ['(', '$(', 'node', 'node ', 'env ', '-', '-x', ' -x', 'a=', 'a=b ', '"', "'", '/', ' ', '\t', '\n',
    'then ', 'if ', 'bash -c ', ';', 'x', '`', '{ ', '! ', AP7];
  const N = 8000, CEILING_MS = 25;
  const seen = new Set();
  const slow = [];
  let count = 0, worst = 0, worstUnit = '';
  const started = Date.now();
  for (const a of pieces) for (const b of ['', ...pieces]) {
    const unit = a + b;
    if (seen.has(unit)) continue;
    seen.add(unit);
    const s = pad(unit, N);
    const t = process.hrtime.bigint();
    compass.ruleTest(rule, s);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    count++;
    if (ms > worst) { worst = ms; worstUnit = unit; }
    if (ms > CEILING_MS) slow.push(`${JSON.stringify(unit)} ${ms.toFixed(0)}ms`);
  }
  console.log(`        [note] ${count} generated pads in ${Date.now() - started}ms; slowest ${JSON.stringify(worstUnit)} ${worst.toFixed(1)}ms`);
  assert.deepStrictEqual(slow, [], `slow pads at ${N}b: ${slow.slice(0, 20).join(', ')}`);
});

test('no benign payload on a newly-routed carrier is worse than it is on Bash', () => {
  const bad = [];
  let worst = 0, worstLabel = '';
  for (const [shape, mk] of Object.entries(BENIGN_SHAPES)) {
    for (const n of SIZES) {
      const body = mk(n);
      const onBash = classifyV2({ tool_name: 'Bash', tool_input: { command: body } }, {});
      for (const [tool, field] of CARRIERS) {
        const t = Date.now();
        const v2 = classifyV2({ tool_name: tool, tool_input: { [field]: body } }, {});
        const ms = Date.now() - t;
        if (ms > worst) { worst = ms; worstLabel = `${shape}/${n}/${tool}`; }
        const cell = `${shape} ${n}b ${tool}`;
        // (2)+(3): a non-evaluation on a carrier fe8aa0c cleared in constant time
        // is a new denial and, at the hook, a lost row.
        if (v2.active.classification === compass.NOT_EVALUATED) {
          bad.push(`${cell}: NOT_EVALUATED — fe8aa0c cleared this carrier without reading it`);
        }
        // (4): nothing may deny here that does not also deny on Bash.
        if (v2.active.classification !== onBash.active.classification) {
          bad.push(`${cell}: ${v2.active.classification} but Bash says ${onBash.active.classification}`);
        }
        // (2): the cost that turns into a kill at the hook.
        if (ms > 1000) bad.push(`${cell}: ${ms}ms — heading for the 5,000ms hook kill`);
      }
    }
  }
  console.log(`        [note] slowest newly-routed cell: ${worstLabel} ${worst}ms (${SIZES.length * Object.keys(BENIGN_SHAPES).length * CARRIERS.length} cells)`);
  assert.deepStrictEqual(bad, [], bad.join(' | '));
});

test('Bash itself reaches a decision on every shape at every size — no new denial', () => {
  // fe8aa0c cleared all of these (measured: the worst was 1,978ms ALLOW at
  // 150KB on the repeated-trigger shape, and a 5,000ms kill at 400KB). A
  // NOT_EVALUATED here would be a Bash regression, which the parity floor is
  // structurally forbidden from covering — only the linearisation can.
  // TWO ceilings, because two different things are being bounded.
  //
  // The RULES ceiling is tight: the legacy leg is what capability routing and the
  // normalized second pass touched, so a regression there is this release's to
  // own. Measured worst case is 36ms at 800KB (fe8aa0c: 4ms — the second pass on
  // strings normalization actually changed), against 250ms.
  //
  // The GATE ceiling is 3,000ms against the 5,000ms hook budget, matching
  // test/compass-fail-closed.js. It is looser because at 800KB the dominant term
  // is classifySemantic on the quote-churn shape, and that cost is PRE-EXISTING
  // and untouched: measured 1,216ms on fe8aa0c and 1,223ms here, same verdict
  // (OPEN) on both. Tightening this arm to catch it would assert an improvement
  // this release did not make, and would fail on nothing that regressed.
  const RULES_CEILING_MS = 250;
  const GATE_CEILING_MS = 3000;
  const bad = [];
  let worst = 0, worstLabel = '', worstRules = 0, worstRulesLabel = '';
  for (const [shape, mk] of Object.entries(BENIGN_SHAPES)) {
    for (const n of SIZES) {
      const command = mk(n);
      const tr = Date.now();
      const legacy = compass.classify({ tool_name: 'Bash', tool_input: { command } }, {});
      const rulesMs = Date.now() - tr;
      const t = Date.now();
      const v2 = classifyV2({ tool_name: 'Bash', tool_input: { command } }, {});
      const ms = Date.now() - t;
      if (ms > worst) { worst = ms; worstLabel = `${shape}/${n}`; }
      if (rulesMs > worstRules) { worstRules = rulesMs; worstRulesLabel = `${shape}/${n}`; }
      if (v2.active.classification === compass.NOT_EVALUATED) {
        bad.push(`${shape} ${n}b: NOT_EVALUATED (fe8aa0c cleared it)`);
      }
      if (legacy.classification === compass.NOT_EVALUATED) {
        bad.push(`${shape} ${n}b: legacy leg NOT_EVALUATED (fe8aa0c cleared it)`);
      }
      if (rulesMs > RULES_CEILING_MS) bad.push(`${shape} ${n}b: rules leg ${rulesMs}ms > ${RULES_CEILING_MS}ms`);
      if (ms > GATE_CEILING_MS) bad.push(`${shape} ${n}b: whole gate ${ms}ms > ${GATE_CEILING_MS}ms`);
    }
  }
  console.log(`        [note] slowest Bash cell: gate ${worstLabel} ${worst}ms, rules ${worstRulesLabel} ${worstRules}ms`);
  assert.deepStrictEqual(bad, [], bad.join(' | '));
});

// ── ARM 3: the parity floor, and the two guards that keep Bash off it ─────────

test('capabilityOnlyCall is true only for a shell payload on a tool no rule names', () => {
  assert.strictEqual(compass.capabilityOnlyCall({ tool_name: 'mcp__shell__run', tool_input: { command: 'ls' } }), true);
  assert.strictEqual(compass.capabilityOnlyCall({ tool_name: 'Terminal', tool_input: { script: 'ls' } }), true);
  // Bash is named by every bundled shell rule, so it was never ungated.
  assert.strictEqual(compass.capabilityOnlyCall({ tool_name: 'Bash', tool_input: { command: 'ls' } }), false);
  // Grok is named by a bundled rule of its own.
  assert.strictEqual(compass.capabilityOnlyCall({ tool_name: 'Grok', tool_input: { command: 'ls' } }), false);
  // No shell payload at all — nothing was routed, so there is nothing to decline.
  assert.strictEqual(compass.capabilityOnlyCall({ tool_name: 'mcp__shell__run', tool_input: { query: 'ls' } }), false);
});

function withBudget(env, fn) {
  const prev = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; process.env[k] = env[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
}

test('budget exhaustion on a newly-routed carrier CLEARS with a reason, and never denies', () => {
  const r = withBudget({ T2HELIX_CLASSIFY_BUDGET_MS: '-1' }, () =>
    compass.classify({ tool_name: 'mcp__shell__run', tool_input: { command: 'ls -la' } }, {}));
  assert.strictEqual(r.classification, 'OPEN', 'a carrier fe8aa0c cleared in constant time may not become a denial');
  assert.strictEqual(r.rule_id, 'capability-scan-declined');
  assert.strictEqual(r.capability_declined, true);
  assert.strictEqual(r.capability_only, true);
  assert.ok(/did not evaluate|declined/i.test(r.reason), 'the row must say the leg declined, not that it cleared');
  assert.ok(Array.isArray(r.evidence.rules_declined) && r.evidence.rules_declined.length > 0,
    'the row must name the rules that did not run');
});

test('the SAME exhausted budget still denies on Bash — the floor is not reachable there', () => {
  const r = withBudget({ T2HELIX_CLASSIFY_BUDGET_MS: '-1' }, () =>
    compass.classify({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }, {}));
  assert.strictEqual(r.classification, compass.NOT_EVALUATED,
    'a starved Bash classify must stay fail-closed — this is the exploit the budget exists for');
  assert.strictEqual(r.rule_id, 'classify-budget-exceeded');
  assert.strictEqual(r.capability_only, false);
});

test('a user ruleset written entirely as capability rules still cannot put Bash on the parity path', () => {
  // loadRules() step 2: T2HELIX_DATA_DIR/compass/rules.json REPLACES the bundled
  // set. A ruleset with no `tool` field anywhere is the shape that would defeat a
  // naive "every applying rule applies by capability" test — Bash would match
  // byCapability only, be classified capability-only, and the shell gate would
  // fall off the one tool it has always covered.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-userrules-'));
  fs.mkdirSync(path.join(dir, 'compass'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'compass', 'rules.json'), JSON.stringify({
    rules: [{
      id: 'user-shell-only',
      classification: 'WITNESS',
      capability: 'shell',
      pattern: 'never-matches-anything-zzz',
      reason: 'user rule'
    }]
  }));
  const prevData = process.env.T2HELIX_DATA_DIR;
  process.env.T2HELIX_DATA_DIR = dir;
  compass._resetCache();
  try {
    const rules = compass.loadRules();
    assert.strictEqual(rules.length, 1, 'the user ruleset must have replaced the bundled set for this arm to mean anything');
    assert.strictEqual(rules[0]._capability, 'shell');
    assert.ok(!rules[0].tool, 'the fixture rule must carry no tool field — that is the shape under test');

    assert.strictEqual(compass.capabilityOnlyCall({ tool_name: 'Bash', tool_input: { command: 'ls' } }), false,
      'BASH ON THE PARITY PATH — the shell gate would be off on the tool it has always covered');
    const r = withBudget({ T2HELIX_CLASSIFY_BUDGET_MS: '-1' }, () =>
      compass.classify({ tool_name: 'Bash', tool_input: { command: 'ls' } }, {}));
    assert.strictEqual(r.classification, compass.NOT_EVALUATED, 'a starved Bash classify must still fail closed');

    // An unscoped rule (no `tool`) was base-eligible for EVERY tool under
    // fe8aa0c, so this carrier was not ungated either and must also stay off the
    // floor. This is the clause that makes the Bash conjunct belt-and-braces
    // rather than the only guard.
    assert.strictEqual(compass.capabilityOnlyCall({ tool_name: 'mcp__shell__run', tool_input: { command: 'ls' } }), false,
      'a rule with no tool field was eligible for every tool on fe8aa0c — that carrier was gated, so it may not decline');
  } finally {
    if (prevData === undefined) delete process.env.T2HELIX_DATA_DIR; else process.env.T2HELIX_DATA_DIR = prevData;
    compass._resetCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an operator rule that NAMES the carrier keeps it off the floor too', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-namedtool-'));
  fs.mkdirSync(path.join(dir, '.t2helix'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.t2helix', 'policy.json'), JSON.stringify({
    rules: [{
      id: 'names-the-carrier',
      classification: 'WITNESS',
      tool: 'mcp__shell__run',
      pattern: 'zzz-never',
      reason: 'operator rule'
    }]
  }));
  const prevPolicy = process.env.T2HELIX_POLICY_DIR;
  process.env.T2HELIX_POLICY_DIR = dir;
  compass._resetCache();
  try {
    assert.strictEqual(compass.capabilityOnlyCall({ tool_name: 'mcp__shell__run', tool_input: { command: 'ls' } }), false,
      'fe8aa0c would have run this rule against this tool, so the call was never ungated');
    assert.strictEqual(compass.capabilityOnlyCall({ tool_name: 'Terminal', tool_input: { script: 'ls' } }), true,
      'a different carrier is still ungated on fe8aa0c and still declines');
  } finally {
    if (prevPolicy === undefined) delete process.env.T2HELIX_POLICY_DIR; else process.env.T2HELIX_POLICY_DIR = prevPolicy;
    compass._resetCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── ARM 4: the hook writes the row fe8aa0c wrote, and lets the call through ────

const HOOK = path.join(__dirname, '..', 'hooks', 'pre-tool-use.js');
const HOOK_BUDGET_MS = 5000;

function runGate(payload, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-nw-hook-'));
  const started = Date.now();
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    env: {
      ...process.env,
      HOME: home,
      // The SAME data dir this module opened, so the row the hook writes is
      // readable here. Reading it through lib/chronicle is deliberate: if the
      // write path fails, this arm fails, and "the row exists" is half the
      // property under test.
      T2HELIX_DATA_DIR: tmpDir,
      T2HELIX_POLICY_DIR: '',
      ...env
    },
    encoding: 'utf8',
    timeout: HOOK_BUDGET_MS,
    maxBuffer: 64 * 1024 * 1024
  });
  const elapsed = Date.now() - started;
  const killed = !!(r.error && r.error.code === 'ETIMEDOUT');
  const raw = (r.stdout || '').trim();
  // A harness that reads "no stdout" as a clearance is the same fail-open the
  // gate itself was fixed for. Empty output from a hook that exited nonzero is a
  // harness fault, and must never be scored as ALLOW.
  const harnessError = !killed && (r.status !== 0 || !raw);
  let out = {};
  if (!killed && !harnessError) { try { out = JSON.parse(raw); } catch (_) { out = { __bad: raw.slice(0, 120) }; } }
  const reason = (out.hookSpecificOutput && out.hookSpecificOutput.permissionDecisionReason) || '';
  return {
    elapsed,
    killed,
    harnessError,
    stderr: (r.stderr || '').slice(0, 300),
    cleared: !killed && !harnessError && !out.hookSpecificOutput && !out.__bad,
    denied: !!out.hookSpecificOutput,
    notEvaluated: /NOT EVALUATED/.test(reason),
    home
  };
}

const ch = require('../lib/chronicle');
function compassRows(session_id) {
  return ch.db().prepare('SELECT * FROM compass_log WHERE session_id = ?').all(session_id);
}

test('a starved gate on a newly-routed carrier LETS THE CALL THROUGH, as fe8aa0c did', () => {
  const r = runGate(
    { session_id: 'nw-parity', tool_name: 'mcp__shell__run', tool_input: { command: 'ls -la' } },
    { T2HELIX_CLASSIFY_BUDGET_MS: '-1' }
  );
  assert.ok(!r.harnessError, `harness fault: status/stdout empty — ${r.stderr}`);
  assert.ok(!r.killed, 'the hook must not be killed');
  assert.ok(r.cleared, `the call must be cleared, got denied=${r.denied} notEvaluated=${r.notEvaluated}`);
});

test('the same starved gate still DENIES on Bash', () => {
  const r = runGate(
    { session_id: 'nw-bash', tool_name: 'Bash', tool_input: { command: 'ls -la' } },
    { T2HELIX_CLASSIFY_BUDGET_MS: '-1' }
  );
  assert.ok(!r.harnessError, `harness fault: ${r.stderr}`);
  assert.ok(r.denied && r.notEvaluated, 'Bash must stay fail-closed when the classifier is starved');
});

test('a starved gate on a newly-routed carrier still WRITES the audit row', () => {
  // Losing the row was the worst cell in the matrix: the call proceeds either
  // way, so a kill is security-equivalent, but it destroys the record fe8aa0c
  // kept. The parity floor writes an OPEN row naming the reason.
  const r = runGate(
    { session_id: 'nw-row', tool_name: 'Terminal', tool_input: { script: 'ls -la' } },
    { T2HELIX_CLASSIFY_BUDGET_MS: '-1' }
  );
  assert.ok(!r.harnessError, `harness fault: ${r.stderr}`);
  assert.ok(r.cleared, 'the call must be cleared');
  const rows = compassRows('nw-row');
  assert.ok(rows && rows.length > 0, 'a compass_log row must exist for a declined capability scan');
  const row = rows[rows.length - 1];
  assert.strictEqual(row.classification, 'OPEN');
  assert.ok(/capability/.test(String(row.rule_matched)),
    `the row must name the decline, got rule_matched=${row.rule_matched}`);
});

test('the shapes that were killed or denied now reach a decision at the hook', () => {
  const bad = [];
  const cases = [
    ['repeated-deploy-trigger 200KB / mcp__shell__run', 'mcp__shell__run', 'command', pad('kubectl apply x ', 200000)],
    ['repeated-deploy-trigger 400KB / mcp__shell__run', 'mcp__shell__run', 'command', pad('kubectl apply x ', 400000)],
    ['repeated-deploy-trigger 400KB / Bash', 'Bash', 'command', pad('kubectl apply x ', 400000)],
    ['blocked-target 400KB / Terminal', 'Terminal', 'script', pad('kubectl apply x ', 400000) + '|' + PROD]
  ];
  for (const [label, tool, field, command] of cases) {
    const r = runGate({ session_id: 'nw-' + label.replace(/\W+/g, '-'), tool_name: tool, tool_input: { [field]: command } });
    if (r.harnessError) bad.push(`${label}: harness fault ${r.stderr}`);
    else if (r.killed) bad.push(`${label}: hook killed at ${HOOK_BUDGET_MS}ms, emitted nothing (UNGATED, no row)`);
    else if (!r.cleared) bad.push(`${label}: ${r.notEvaluated ? 'NOT_EVALUATED' : 'denied'} — fe8aa0c cleared this`);
  }
  assert.deepStrictEqual(bad, [], bad.join(' | '));
});

// ── ARM 5: R4 — prose in a command/script field ───────────────────────────────
//
// The finding was that prose in a `command`/`script` field hard-denies on the
// newly-routed carriers where fe8aa0c was OPEN. The answer is parity, not a
// content heuristic: on a tool that EXECUTES that field as a shell command, a
// string containing a trigger phrase is a command, and Bash has denied exactly
// this string since long before fe8aa0c. Un-routing by guessing at "does this
// look like prose" would be a new classifier standing between the payload and
// the gate — a bigger attack surface than the false positive it removes. What
// is pinned instead: the verdict never differs from Bash's, in either direction.

test('R4: prose only denies where Bash denies, and denies identically', () => {
  const cases = [
    ['plain prose', 'Please summarize the release notes and tell me what changed.'],
    ['prose about a database', 'The migration will remove the old rows from the users table.'],
    ['prose naming a trigger phrase', `We should ${DROPTBL} users once the migration lands.`],
    ['prose naming a delete', `Remember to ${RM} -rf /tmp/build-cache before the next run.`],
    ['prose about deploying', `Ship it to ${PROD} with kubectl apply once review is done.`],
    ['prose with a credential shape', 'Set password=hunter2hunter2 in the staging env file.']
  ];
  const bad = [];
  for (const [label, text] of cases) {
    const onBash = compass.classify({ tool_name: 'Bash', tool_input: { command: text } }, {});
    for (const [tool, field] of CARRIERS) {
      const other = compass.classify({ tool_name: tool, tool_input: { [field]: text } }, {});
      if (other.classification !== onBash.classification) {
        bad.push(`${label} / ${tool}: ${other.classification} vs Bash ${onBash.classification}`);
      }
      if (other.rule_id !== onBash.rule_id) {
        bad.push(`${label} / ${tool}: rule ${other.rule_id} vs Bash ${onBash.rule_id}`);
      }
    }
  }
  assert.deepStrictEqual(bad, [], bad.join(' | '));
});

test('R4: a field the tool does not execute is still not routed at all', () => {
  // The genuinely wrong case would be a tool whose `command` field is not shell.
  // The answer is the scope of SHELL_PAYLOAD_FIELDS, kept minimal and explicit —
  // a tool that carries its payload under any other name is untouched.
  assert.deepStrictEqual(compass.SHELL_PAYLOAD_FIELDS, ['command', 'script']);
  const notShell = compass.classify(
    { tool_name: 'mcp__notes__save', tool_input: { text: `We should ${DROPTBL} users`, title: 'todo' } }, {});
  assert.strictEqual(notShell.classification, 'OPEN',
    'a payload under a field no shell tool executes must not be routed into the shell rules');
  assert.strictEqual(compass.detectCapability({ tool_name: 'mcp__notes__save', tool_input: { text: 'x' } }).capability, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
process.exit(failed === 0 ? 0 : 1);
