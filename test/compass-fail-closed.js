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

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-failclosed-'));
process.env.T2HELIX_DATA_DIR = tmpDir;

const ch = require('../lib/chronicle');
const compass = require('../lib/compass');

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
    if (!rule._regex) continue;
    for (const s of shapes) {
      const t = Date.now();
      rule._regex.test(s);
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
  const OLD = /git\s+push\s+(?:[^|;&]*\s+)?(?:--force(?!-with-lease)|-f)\b/;
  const NEW = compass.loadRules().find(r => r.id === 'git-push-force')._regex;
  const TOK = ['--force', '-f', '--force-with-lease', '--forced', '-force', '"--force"',
    'origin', 'main', '-u', '|', ';', '&', '', 'x'];
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
  const m = /token="([0-9a-f]+)"/.exec(first.reason);
  assert.ok(m, 'the PAUSE minted a token');
  assert.strictEqual(ch.approveConfirmation({ token: m[1] }).ok, true);

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
