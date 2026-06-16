'use strict';

// Hooks integration tests — the layer no other suite exercises.
//
// smoke.js and regression.js test the libraries and the MCP server, but NEVER
// spawn the actual hook scripts. The hooks are where the shipped wiring lives:
// stdin parsing, the deny-payload shape Claude Code consumes, the PAUSE
// override loop, outcome tagging, and the fail-open contract. A typo in any of
// those passes every unit test and only surfaces in a live session. This suite
// spawns `node hooks/<hook>.js`, pipes JSON to stdin, and asserts on stdout.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-integration-'));
process.env.T2HELIX_DATA_DIR = tmpDir;

// Chronicle, loaded with the SAME data dir the spawned hooks use, so the test
// can approve tokens and inspect what the hooks wrote.
const ch = require('../lib/chronicle');

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

const HOOK_DIR = path.join(__dirname, '..', 'hooks');
function runHook(hookFile, payload) {
  const res = spawnSync('node', [path.join(HOOK_DIR, hookFile)], {
    input: JSON.stringify(payload),
    env: { ...process.env, T2HELIX_DATA_DIR: tmpDir },
    encoding: 'utf8'
  });
  let out = null;
  try { out = JSON.parse((res.stdout || '').trim() || '{}'); }
  catch { out = { _unparseable: res.stdout }; }
  return { code: res.status, out, stderr: res.stderr || '' };
}

console.log(`T2Helix hooks integration tests (data: ${tmpDir})`);

// ── PreToolUse: classification → payload shape ──────────────────────────────

test('PreToolUse: OPEN action → empty {} + exit 0', () => {
  const r = runHook('pre-tool-use.js', {
    session_id: 'int-open',
    tool_name: 'Bash',
    tool_input: { command: 'ls -la' }
  });
  assert.strictEqual(r.code, 0, `exit ${r.code}`);
  assert.deepStrictEqual(r.out, {}, 'OPEN must emit {}');
});

test('PreToolUse: WITNESS action → deny, no override token', () => {
  const r = runHook('pre-tool-use.js', {
    session_id: 'int-witness',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf /' }
  });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.out.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(/rm-rf/.test(r.out.hookSpecificOutput.permissionDecisionReason), 'reason names the rule');
  assert.ok(!/confirm_pending/.test(r.out.hookSpecificOutput.permissionDecisionReason),
    'WITNESS must NOT mint an override token');
});

test('PreToolUse: PAUSE action → deny with confirm_pending token', () => {
  const r = runHook('pre-tool-use.js', {
    session_id: 'int-pause',
    tool_name: 'Bash',
    tool_input: { command: 'echo aws_secret=abc' }
  });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.out.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(/\[soft-deny\]/.test(r.out.hookSpecificOutput.permissionDecisionReason), 'PAUSE is a soft-deny');
  assert.ok(/confirm_pending with token="[0-9a-f]+"/.test(r.out.hookSpecificOutput.permissionDecisionReason),
    'PAUSE must mint an override token');
});

// ── PreToolUse: full PAUSE override loop (mint → approve → consume → re-deny) ─

test('PreToolUse: PAUSE override loop is single-use end-to-end', () => {
  const sid = 'int-override';
  const payload = { session_id: sid, tool_name: 'Bash', tool_input: { command: 'echo api_key=zzz' } };

  // 1. First call mints a token.
  const first = runHook('pre-tool-use.js', payload);
  const m = /token="([0-9a-f]+)"/.exec(first.out.hookSpecificOutput.permissionDecisionReason);
  assert.ok(m, 'first call mints a token');
  const token = m[1];

  // 2. Approve it (as the confirm_pending MCP tool would).
  const approval = ch.approveConfirmation({ token });
  assert.strictEqual(approval.ok, true, 'token approves');

  // 3. Retry the identical action → approval consumed, tool let through.
  const second = runHook('pre-tool-use.js', payload);
  assert.deepStrictEqual(second.out, {}, 'approved retry passes through as {}');

  // 4. Third identical retry → approval already consumed → deny again.
  const third = runHook('pre-tool-use.js', payload);
  assert.strictEqual(third.out.hookSpecificOutput.permissionDecision, 'deny',
    'single-use: a second retry is denied again');
});

// ── PreToolUse: fail-open on adversarial input ──────────────────────────────

test('PreToolUse: empty stdin → {} exit 0 (fail-open)', () => {
  const res = spawnSync('node', [path.join(HOOK_DIR, 'pre-tool-use.js')], {
    input: '', env: { ...process.env, T2HELIX_DATA_DIR: tmpDir }, encoding: 'utf8'
  });
  assert.strictEqual(res.status, 0);
  assert.deepStrictEqual(JSON.parse((res.stdout || '{}').trim() || '{}'), {});
});

test('PreToolUse: non-JSON garbage stdin → {} exit 0 (fail-open)', () => {
  const res = spawnSync('node', [path.join(HOOK_DIR, 'pre-tool-use.js')], {
    input: 'not json at all {{{', env: { ...process.env, T2HELIX_DATA_DIR: tmpDir }, encoding: 'utf8'
  });
  assert.strictEqual(res.status, 0);
  assert.deepStrictEqual(JSON.parse((res.stdout || '{}').trim() || '{}'), {});
});

test('PreToolUse: valid JSON missing tool_name/tool_input → {} exit 0', () => {
  const r = runHook('pre-tool-use.js', { session_id: 'int-missing' });
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(r.out, {});
});

// ── PreToolUse: broken native binding (ABI mismatch) — fail-open AND rules survive

const BREAK = path.join(__dirname, 'fixtures', 'break-sqlite.js');
function runHookBroken(payload) {
  const res = spawnSync('node', ['--require', BREAK, path.join(HOOK_DIR, 'pre-tool-use.js')], {
    input: JSON.stringify(payload),
    env: { ...process.env, T2HELIX_DATA_DIR: tmpDir },
    encoding: 'utf8'
  });
  let out = null;
  try { out = JSON.parse((res.stdout || '').trim() || '{}'); } catch { out = { _unparseable: res.stdout }; }
  return { code: res.status, out, stderr: res.stderr || '' };
}

test('PreToolUse: broken native binding does not crash the host (exit 0, valid JSON)', () => {
  const r = runHookBroken({ session_id: 'int-broken-open', tool_name: 'Bash', tool_input: { command: 'ls -la' } });
  assert.strictEqual(r.code, 0, `must exit 0 with a broken binding, got ${r.code}`);
  assert.ok(!r.out._unparseable, 'stdout is valid JSON, not a node crash dump');
});

test('PreToolUse: broken native binding STILL gates a WITNESS command (rules survive DB loss)', () => {
  const r = runHookBroken({ session_id: 'int-broken-witness', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
  assert.strictEqual(r.code, 0);
  assert.ok(r.out.hookSpecificOutput, 'a permission decision is still emitted without the DB');
  assert.strictEqual(r.out.hookSpecificOutput.permissionDecision, 'deny',
    'rm -rf / is still denied even when the native binding is unavailable');
  assert.ok(/rm-rf/.test(r.out.hookSpecificOutput.permissionDecisionReason), 'reason names the rule');
});

// ── PostToolUse: outcome tagging + action chain + skip-noise ────────────────

test('PostToolUse: Bash failure → session-action entry tagged outcome:failure + action:<hash>', () => {
  const sid = 'int-post-fail';
  const r = runHook('post-tool-use.js', {
    session_id: sid,
    tool_name: 'Bash',
    tool_input: { command: 'pytest tests/' },
    tool_response: { stdout: '', stderr: 'Traceback (most recent call last):\n  File x\nError: boom' }
  });
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(r.out, {});
  const hits = ch.recall({ query: 'pytest', topK: 10, include_meta: true });
  const entry = hits.find(h => /pytest/.test(h.content));
  assert.ok(entry, 'a session-action entry was written for the Bash call');
  assert.ok(entry.tags.includes('outcome:failure'), 'tagged outcome:failure');
  assert.ok(entry.tags.some(t => /^action:[0-9a-f]+$/.test(t)), 'tagged action:<hash> for chain linkage');
});

test('PostToolUse: read-only tool (Read) → {} and no chronicle entry', () => {
  const before = ch.recall({ query: 'Read', topK: 50, include_meta: true }).length;
  const r = runHook('post-tool-use.js', {
    session_id: 'int-post-read',
    tool_name: 'Read',
    tool_input: { file_path: '/etc/hosts' },
    tool_response: { content: 'whatever' }
  });
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(r.out, {});
  const after = ch.recall({ query: 'Read', topK: 50, include_meta: true }).length;
  assert.strictEqual(after, before, 'read-only tools write nothing');
});

// ── UserPromptSubmit: method surfacing + de-noise wiring (v0.3 step 2) ───────

test('UserPromptSubmit: injects a relevant method; trivial prompt yields no generic dump', () => {
  const sid = 'ups-' + Date.now();
  ch.recordMethod({
    session_id: sid, shape: 'rotate-bridge-token',
    steps: ['read -s prompt', 'write env + plist', 'launchctl reload'],
    acceptance: 'heartbeat 200', tool_classes: ['Bash']
  });
  // Substantive prompt sharing tokens with the method shape → method leads.
  const r1 = runHook('user-prompt-submit.js', { session_id: sid, prompt: 'how do I rotate the bridge token' });
  assert.strictEqual(r1.code, 0);
  const ctx1 = (r1.out.hookSpecificOutput && r1.out.hookSpecificOutput.additionalContext) || '';
  assert.ok(/Method for this kind of task:/.test(ctx1), 'relevant method injected as a section');
  assert.ok(/rotate-bridge-token/.test(ctx1), 'method content present');
  // Trivial prompt → no generic "Related from chronicle" dump.
  const r2 = runHook('user-prompt-submit.js', { session_id: sid, prompt: 'yea' });
  assert.strictEqual(r2.code, 0);
  const ctx2 = (r2.out.hookSpecificOutput && r2.out.hookSpecificOutput.additionalContext) || '';
  assert.ok(!/Related from chronicle:/.test(ctx2), 'generic recall suppressed on a trivial prompt');
});

// ── Stop: boundary-active goal → per-criterion progress (v0.3 step 3) ────────

test('Stop synthesis: per-criterion progress with a soft unfinished marker', () => {
  const sid = 'stop-goal-' + Date.now();
  ch.setGoal({
    session_id: sid,
    goal: 'wire the boundary-active goal',
    acceptance_criteria: ['parser tokenization fixed', 'PR opened for review']
  });
  // One criterion has in-session evidence; the other does not.
  ch.record({ session_id: sid, content: 'fixed the parser tokenization edge case', domain: 't2helix' });

  const r = runHook('stop.js', { session_id: sid });
  assert.strictEqual(r.code, 0, `stop exited ${r.code}: ${r.stderr}`);
  assert.deepStrictEqual(r.out, {}, 'stop fails-open with empty {}');

  const synth = ch.db()
    .prepare(`SELECT content FROM insights WHERE session_id = ? AND domain = 'session-synthesis' ORDER BY created_at DESC LIMIT 1`)
    .get(sid);
  assert.ok(synth, 'stop wrote a session-synthesis record');
  assert.ok(/Acceptance criteria \(1\/2 with a related insight this session\):/.test(synth.content), 'count header present');
  assert.ok(/\[~\] parser tokenization fixed \(related: #/.test(synth.content), 'related criterion marked [~]');
  assert.ok(/\[ \] PR opened for review \(no related insight\)/.test(synth.content), 'unrelated criterion marked open');
});

// ── scrub: the one-shot redact-sweep against already-leaked rows ─────────────

test('redact-sweep: scrubs a pre-existing leaked row from insights + compass_log + FTS', () => {
  const sid = 'scrub-seed';
  const SECRET = 'f'.repeat(48);
  const LEAK = `Authorization: Bearer ${SECRET}`;

  // Seed rows the pre-0.2 way: raw inserts that bypass record()/logCompass()
  // redaction, simulating credentials already at rest. The insights_ai trigger
  // indexes the leaked content into FTS, exactly as the real leak did.
  ch.db().prepare(
    `INSERT INTO insights (session_id, content, domain, tags, intensity, layer, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(sid, `[compass-fire] PAUSE: curl with ${LEAK}`, 'compass-fire', JSON.stringify(['compass-fire']), 0.7, 'reflection', Date.now());
  ch.db().prepare(
    `INSERT INTO compass_log (session_id, tool_name, action_summary, classification, occurred_at)
     VALUES (?, 'Bash', ?, 'PAUSE', ?)`
  ).run(sid, `Bash: curl with ${LEAK}`, Date.now());
  // pending_confirmations was the third write site the sweep originally skipped.
  ch.db().prepare(
    `INSERT INTO pending_confirmations (token, session_id, action_hash, action_summary, reason, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run('seedtoken123456', sid, 'deadbeef', `Bash: curl with ${LEAK}`, `leaked ${LEAK}`, Date.now(), Date.now() + 600000);

  // Confirm the secret is searchable BEFORE the sweep (the leak is real).
  const before = ch.recall({ query: SECRET, topK: 10, include_meta: true });
  assert.ok(before.some(h => h.content.includes(SECRET)), 'secret should be present + FTS-searchable pre-sweep');

  // Close our connection so the child sweep owns the db cleanly, then run it.
  ch.close();
  const res = spawnSync('node', [path.join(__dirname, '..', 'scripts', 'redact-sweep.js'), '--data-dir', tmpDir], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, `sweep exited ${res.status}: ${res.stderr}`);
  assert.ok(/redacted 1/.test(res.stdout), 'sweep should report redacting the insight');

  // Reopen (lazy) and verify the leak is gone from rows AND from FTS.
  const insightRow = ch.db().prepare('SELECT content FROM insights WHERE session_id = ?').get(sid);
  assert.ok(!insightRow.content.includes(SECRET), 'insight content scrubbed');
  assert.ok(/\[REDACTED:bearer:/.test(insightRow.content), 'insight carries the fingerprint');
  const compassRow = ch.db().prepare('SELECT action_summary FROM compass_log WHERE session_id = ?').get(sid);
  assert.ok(!compassRow.action_summary.includes(SECRET), 'compass_log scrubbed');
  const pendingRow = ch.db().prepare('SELECT action_summary, reason FROM pending_confirmations WHERE session_id = ?').get(sid);
  assert.ok(!pendingRow.action_summary.includes(SECRET) && !String(pendingRow.reason).includes(SECRET), 'pending_confirmations scrubbed by sweep');
  const after = ch.recall({ query: SECRET, topK: 10, include_meta: true });
  assert.ok(!after.some(h => h.content.includes(SECRET)), 'secret no longer FTS-searchable post-sweep');
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed`);
try { ch.close(); } catch (_) {}
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
process.exit(fail === 0 ? 0 : 1);
