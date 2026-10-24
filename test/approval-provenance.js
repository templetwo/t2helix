'use strict';

// test/approval-provenance.js — the approval credential and its provenance.
//
// Two properties no other suite asserts:
//   1. The gate never hands the gated party the credential that lifts it. The
//      deny text is model-visible by construction, so a token printed there is
//      volunteered, not sought. list_pending remains the way to find a pending
//      request; the deny string is not.
//   2. An approval flips a soft-deny to an allow, so the record must say where
//      the approval came from. A row that cannot distinguish an operator from a
//      model self-approval is a row that states more than it knows.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-approval-provenance-'));
process.env.T2HELIX_DATA_DIR = tmpDir;

const ch = require('../lib/chronicle');
const { renderDecision } = require('../lib/decision-message');

let pass = 0, fail = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

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

function denyReason(r) {
  return (r.out.hookSpecificOutput && r.out.hookSpecificOutput.permissionDecisionReason) || '';
}

// Minimal stdio JSON-RPC client, same shape as test/regression.js.
function makeClient(extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'server.js')], {
    env: { ...process.env, T2HELIX_DATA_DIR: tmpDir, ...extraEnv },
    stdio: ['pipe', 'pipe', 'inherit']
  });
  const responses = new Map();
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && responses.has(msg.id)) {
        const handler = responses.get(msg.id);
        responses.delete(msg.id);
        handler.resolve(msg);
      }
    }
  });
  let nextId = 1;
  return {
    request(method, params) {
      const id = nextId++;
      const p = new Promise(resolve => responses.set(id, { resolve }));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return p;
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    close() {
      child.stdin.end();
      return new Promise(resolve => child.on('exit', resolve));
    }
  };
}

async function initialize(client) {
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'approval-provenance-test', version: '1.0.0' }
  });
  client.notify('notifications/initialized', {});
}

async function call(client, name, args = {}) {
  const r = await client.request('tools/call', { name, arguments: args });
  if (r.error) throw new Error(`tool ${name} error: ${r.error.message}`);
  const text = r.result.content[0].text;
  try { return JSON.parse(text); } catch { return text; }
}

// ── 1. The deny string does not carry the credential ────────────────────────

test('renderDecision: a PAUSE message never prints the token it was given', () => {
  const decision = {
    classification: 'PAUSE',
    rule_id: 'credential-paste',
    reason: 'credential-shaped assignment',
    evidence: { executable: 'echo' }
  };
  const msg = renderDecision(decision, { action_summary: 'echo api_key=zzz', token: 'deadbeefcafe1234' });
  assert.ok(!msg.text.includes('deadbeefcafe1234'), 'token value must not appear in the message text');
  assert.ok(!/token\s*=/i.test(msg.text), 'the message must not hand over a token= assignment');
  assert.ok(msg.lines.every(l => !l.includes('deadbeefcafe1234')), 'no line may carry the token');
});

test('renderDecision: a PAUSE message still names how to seek approval', () => {
  const decision = { classification: 'PAUSE', rule_id: 'credential-paste', reason: 'cred' };
  const msg = renderDecision(decision, { action_summary: 'echo api_key=zzz', token: 'deadbeefcafe1234', pending_id: 42 });
  assert.ok(/approv/i.test(msg.text), 'the message must say approval is what unblocks this');
  assert.ok(/retry/i.test(msg.text), 'the message must say the action is retried after approval');
});

test('PreToolUse: the PAUSE deny reason does not contain the minted token', () => {
  const sid = 'ap-leak-' + Date.now();
  const r = runHook('pre-tool-use.js', {
    session_id: sid,
    tool_name: 'Bash',
    tool_input: { command: 'echo aws_secret=abc' }
  });
  assert.strictEqual(r.out.hookSpecificOutput.permissionDecision, 'deny');
  const pending = ch.listPendingConfirmations({ session_id: sid, limit: 10 });
  assert.strictEqual(pending.length, 1, 'the PAUSE minted exactly one pending request');
  const reason = denyReason(r);
  assert.ok(!reason.includes(pending[0].token),
    `deny reason leaked the minted token: ${reason}`);
  assert.ok(!/token="?[0-9a-f]{8,}/.test(reason),
    `deny reason still carries a token-shaped literal: ${reason}`);
});

// ── Cross-contract: this fix and the fail-closed floor share renderDecision ──

test('renderDecision: NO classification renders a token, including NOT_EVALUATED', () => {
  // Two branches changed renderDecision from different directions and merged
  // without a textual conflict: this fix removed the token from the PAUSE "next"
  // string, and the fail-closed fix added a fourth classification with its own
  // banner and its own next-step branch. The no-leak guarantee has to hold at the
  // FUNCTION, not merely at the one caller that respects it — the hook mints no
  // token on the non-evaluation path, but renderDecision is a library and the next
  // caller need not know that.
  const TOKEN = 'deadbeefcafef00ddeadbeefcafef00d';
  for (const classification of ['PAUSE', 'WITNESS', 'NOT_EVALUATED']) {
    const rendered = renderDecision(
      { classification, rule_id: 'probe-rule', reason: 'probe' },
      { token: TOKEN, pending_id: 42, action_summary: 'probe action' }
    );
    assert.ok(!rendered.text.includes(TOKEN),
      `${classification} rendered the override token: ${rendered.text}`);
    assert.ok(!/token="?[0-9a-f]{8,}/.test(rendered.text),
      `${classification} rendered a token-shaped literal: ${rendered.text}`);
  }
});

test('renderDecision: the NOT_EVALUATED banner and next step are their own branch', () => {
  // A non-evaluation is not a softer WITNESS and not a PAUSE: it must not offer an
  // override, and it must not read as a rule having matched.
  const r = renderDecision(
    { classification: 'NOT_EVALUATED', rule_id: 'classify-budget-exceeded', reason: 'budget' },
    { token: 'deadbeefcafef00ddeadbeefcafef00d', action_summary: 'probe' }
  );
  assert.ok(r.text.includes('NOT EVALUATED'), r.text);
  assert.ok(!r.text.includes('[soft-deny]'), 'a non-evaluation must not render as a soft-deny');
  assert.ok(/no verdict to override/.test(r.text), r.text);
});

test('MESSAGE_VERSION names the merged contract, not either branch alone', () => {
  const { MESSAGE_VERSION } = require('../lib/decision-message');
  assert.strictEqual(MESSAGE_VERSION, 'decision-message/0.12.2',
    'both the token removal and the NOT_EVALUATED branch changed this contract; ' +
    'one string may not name two contracts');
  // Every rendered message reports the same version, on every branch.
  for (const classification of ['PAUSE', 'WITNESS', 'NOT_EVALUATED', 'OPEN']) {
    assert.strictEqual(
      renderDecision({ classification, rule_id: 'r', reason: 'x' }, {}).message_version,
      MESSAGE_VERSION
    );
  }
});

test('PreToolUse: the deny reason leaks no token on stderr either', () => {
  const sid = 'ap-stderr-' + Date.now();
  const r = runHook('pre-tool-use.js', {
    session_id: sid,
    tool_name: 'Bash',
    tool_input: { command: 'echo api_key=qqq' }
  });
  const pending = ch.listPendingConfirmations({ session_id: sid, limit: 10 });
  assert.strictEqual(pending.length, 1);
  assert.ok(!r.stderr.includes(pending[0].token), 'hook stderr must not carry the token');
});

test('PreToolUse: the operator override loop still works without the deny string', () => {
  const sid = 'ap-loop-' + Date.now();
  const payload = { session_id: sid, tool_name: 'Bash', tool_input: { command: 'echo api_key=loop' } };

  const first = runHook('pre-tool-use.js', payload);
  assert.strictEqual(first.out.hookSpecificOutput.permissionDecision, 'deny');

  // The surviving path: the request is found through list_pending, not the deny text.
  const pending = ch.listPendingConfirmations({ session_id: sid, limit: 10 });
  assert.strictEqual(pending.length, 1, 'list_pending surfaces the request awaiting approval');
  const approval = ch.approveConfirmation({ token: pending[0].token, origin: 'cli' });
  assert.strictEqual(approval.ok, true, 'the request approves');

  const second = runHook('pre-tool-use.js', payload);
  assert.deepStrictEqual(second.out, {}, 'the approved retry passes through');
});

// ── 2. Provenance is recorded, not inferred ─────────────────────────────────

test('approveConfirmation: records the origin it was given', () => {
  const sid = 'ap-origin-' + Date.now();
  const p = ch.createPendingConfirmation({ session_id: sid, action_summary: 'origin-' + Date.now() });
  const r = ch.approveConfirmation({ token: p.token, origin: 'cli' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.origin, 'cli', 'the result states the recorded origin');
  const row = ch.listPendingConfirmations({ session_id: sid, limit: 10 })[0];
  assert.strictEqual(row.approved_origin, 'cli', 'the row records the origin durably');
});

test('approveConfirmation: an unnamed origin records as unattributed, never blank', () => {
  const sid = 'ap-unattributed-' + Date.now();
  const p = ch.createPendingConfirmation({ session_id: sid, action_summary: 'unattributed-' + Date.now() });
  const r = ch.approveConfirmation({ token: p.token });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.origin, 'unattributed', 'an origin-less approval says so');
  const row = ch.listPendingConfirmations({ session_id: sid, limit: 10 })[0];
  assert.strictEqual(row.approved_origin, 'unattributed',
    'a null origin must read as unattributed, not as a clean blank');
});

test('approveConfirmation: records TTY as a raw fact, and does not gate on it', () => {
  const sid = 'ap-tty-' + Date.now();
  const p = ch.createPendingConfirmation({ session_id: sid, action_summary: 'tty-' + Date.now() });
  const r = ch.approveConfirmation({ token: p.token, origin: 'cli' });
  assert.strictEqual(typeof r.tty, 'boolean', 'the approval states whether it came from a TTY');
  assert.strictEqual(r.ok, true, 'a non-TTY approval is still an approval — this is a record, not a gate');
});

test('createPendingConfirmation: returns the row id (the non-secret handle)', () => {
  const sid = 'ap-id-' + Date.now();
  const p = ch.createPendingConfirmation({ session_id: sid, action_summary: 'id-' + Date.now() });
  assert.strictEqual(typeof p.id, 'number', 'the pending request has an id a message can name');
  assert.ok(p.id > 0);
});

test('compass_log: a consumed approval names its origin in user_override', () => {
  const sid = 'ap-log-' + Date.now();
  const payload = { session_id: sid, tool_name: 'Bash', tool_input: { command: 'echo api_key=logged' } };
  runHook('pre-tool-use.js', payload);
  const pending = ch.listPendingConfirmations({ session_id: sid, limit: 10 });
  ch.approveConfirmation({ token: pending[0].token, origin: 'cli' });
  runHook('pre-tool-use.js', payload);

  const rows = ch.getCompassHistory({ limit: 50 })
    .filter(r => r.session_id === sid && r.user_override);
  assert.strictEqual(rows.length, 1, 'exactly one override row for this session');
  assert.ok(/origin=cli/.test(rows[0].user_override),
    `compass_log must state the approval origin, got: ${rows[0].user_override}`);
});

// ── 3. The MCP surface names itself, and cannot be told what to name ────────

test('confirm_pending: the MCP surface records origin mcp', async (client) => {
  const sid = 'ap-mcp-' + Date.now();
  const p = ch.createPendingConfirmation({ session_id: sid, action_summary: 'mcp-' + Date.now() });
  const r = await call(client, 'confirm_pending', { token: p.token });
  assert.strictEqual(r.ok, true);
  const row = ch.listPendingConfirmations({ session_id: sid, limit: 10 })[0];
  assert.strictEqual(row.approved_origin, 'mcp',
    'an approval arriving over the model-facing surface must be recorded as such');
});

test('confirm_pending: the caller cannot declare its own origin', async (client) => {
  const r = await client.request('tools/list', {});
  const tool = r.result.tools.find(t => t.name === 'confirm_pending');
  assert.ok(tool, 'confirm_pending is still exposed — the soft-deny class survives');
  const props = Object.keys(tool.inputSchema.properties || {});
  assert.ok(!props.includes('origin'),
    'a caller-supplied origin is a lie vector; the surface must set it');

  const sid = 'ap-mcp-claim-' + Date.now();
  const p = ch.createPendingConfirmation({ session_id: sid, action_summary: 'claim-' + Date.now() });
  await call(client, 'confirm_pending', { token: p.token, origin: 'operator' });
  const row = ch.listPendingConfirmations({ session_id: sid, limit: 10 })[0];
  assert.strictEqual(row.approved_origin, 'mcp', 'a claimed origin must not overwrite the surface');
});

// ── 4. The human-confirm switch, default off ────────────────────────────────
//
// Each test sets or deletes the switch itself and leaves it unset, so they run
// in any order. approveConfirmation reads the switch at call time in this
// process; origin 'mcp' is what the model-facing surface passes (mcp/server.js
// hardcodes it), and 'cli' is what scripts/approve-pending.js passes.

test('confirm_pending with origin mcp and the switch unset → approved (today\'s behaviour)', () => {
  delete process.env.T2HELIX_REQUIRE_HUMAN_CONFIRM;
  const sid = 'ap-switch-unset-' + Date.now();
  const p = ch.createPendingConfirmation({ session_id: sid, action_summary: 'switch-unset-' + Date.now() });
  const r = ch.approveConfirmation({ token: p.token, origin: 'mcp' });
  assert.strictEqual(r.ok, true, 'with the switch unset an mcp-origin approval still goes through');
  const row = ch.listPendingConfirmations({ session_id: sid, limit: 10 })[0];
  assert.strictEqual(row.status, 'approved');
  assert.strictEqual(row.approved_origin, 'mcp');
});

test('with T2HELIX_REQUIRE_HUMAN_CONFIRM=1, origin mcp → refused, row still pending, error names the switch', () => {
  process.env.T2HELIX_REQUIRE_HUMAN_CONFIRM = '1';
  try {
    const sid = 'ap-switch-mcp-' + Date.now();
    const p = ch.createPendingConfirmation({ session_id: sid, action_summary: 'switch-mcp-' + Date.now() });
    const r = ch.approveConfirmation({ token: p.token, origin: 'mcp' });
    assert.strictEqual(r.ok, false, 'an mcp-origin approval must be refused while the switch is set');
    assert.strictEqual(r.pending, true, 'the refusal must say the request is still pending');
    assert.ok(/T2HELIX_REQUIRE_HUMAN_CONFIRM/.test(String(r.error)),
      `the refusal must name the switch, got: ${r.error}`);
    const row = ch.listPendingConfirmations({ session_id: sid, limit: 10 })[0];
    assert.strictEqual(row.status, 'pending', 'the refused request stays pending for a human');
    assert.strictEqual(row.approved_origin, null, 'a refused approval records no origin');
  } finally {
    delete process.env.T2HELIX_REQUIRE_HUMAN_CONFIRM;
  }
});

test('with the switch set, origin cli → approved, approved_origin recorded cli', () => {
  process.env.T2HELIX_REQUIRE_HUMAN_CONFIRM = '1';
  try {
    const sid = 'ap-switch-cli-' + Date.now();
    const p = ch.createPendingConfirmation({ session_id: sid, action_summary: 'switch-cli-' + Date.now() });
    const r = ch.approveConfirmation({ token: p.token, origin: 'cli' });
    assert.strictEqual(r.ok, true, 'a human origin still approves while the switch is set');
    assert.strictEqual(r.origin, 'cli');
    const row = ch.listPendingConfirmations({ session_id: sid, limit: 10 })[0];
    assert.strictEqual(row.status, 'approved');
    assert.strictEqual(row.approved_origin, 'cli', 'the row records the human origin durably');
  } finally {
    delete process.env.T2HELIX_REQUIRE_HUMAN_CONFIRM;
  }
});

test('with the switch set, the mcp-origin refusal says a human approves outside the agent session, and names no script, listing or token', () => {
  process.env.T2HELIX_REQUIRE_HUMAN_CONFIRM = '1';
  try {
    const sid = 'ap-switch-text-' + Date.now();
    const p = ch.createPendingConfirmation({ session_id: sid, action_summary: 'switch-text-' + Date.now() });
    const r = ch.approveConfirmation({ token: p.token, origin: 'mcp' });
    assert.strictEqual(r.ok, false);
    const msg = String(r.error);
    // The refusal goes back to the model, which already holds the token. Naming
    // the terminal script there would hand the gated party a second way past the
    // gate (README: the gate does not volunteer the credential that lifts it).
    assert.ok(!/approve-pending|scripts\//.test(msg), `the refusal names the approval script: ${msg}`);
    assert.ok(!/list_pending/.test(msg), `the refusal points at the token listing: ${msg}`);
    assert.ok(!msg.includes(p.token), 'the refusal carries the token');
    assert.ok(/human/.test(msg) && /outside the agent session/.test(msg),
      `the refusal must say a human approves outside the agent session, got: ${msg}`);
  } finally {
    delete process.env.T2HELIX_REQUIRE_HUMAN_CONFIRM;
  }
});

test('confirm_pending over MCP, switch set in the server\'s env: refused and left pending; neither the refusal nor the tool description names the approval script', async () => {
  const guarded = makeClient({ T2HELIX_REQUIRE_HUMAN_CONFIRM: '1' });
  try {
    await initialize(guarded);
    const listed = await guarded.request('tools/list', {});
    const tool = listed.result.tools.find(t => t.name === 'confirm_pending');
    assert.ok(!/approve-pending|scripts\//.test(tool.description),
      `the model-facing tool description names the approval script: ${tool.description}`);
    const sid = 'ap-switch-mcp-e2e-' + Date.now();
    const p = ch.createPendingConfirmation({ session_id: sid, action_summary: 'switch-mcp-e2e-' + Date.now() });
    const r = await call(guarded, 'confirm_pending', { token: p.token });
    assert.strictEqual(r.ok, false, 'the server must read the switch from its own environment');
    assert.strictEqual(r.pending, true);
    assert.ok(!/approve-pending|scripts\//.test(String(r.error)), `the refusal names the approval script: ${r.error}`);
    const row = ch.listPendingConfirmations({ session_id: sid, limit: 10 })[0];
    assert.strictEqual(row.status, 'pending', 'the refused request stays pending for a human');
    assert.strictEqual(row.approved_origin, null);
  } finally {
    await guarded.close();
  }
});

// ── 5. The human path: scripts/approve-pending.js from a terminal ───────────
//
// Run as a child process, the way a human runs it. Each run names its data dir
// explicitly or is refused, and none inherits CLAUDE_PLUGIN_DATA or the switch
// from the shell that runs this suite.

const APPROVE_SCRIPT = path.join(__dirname, '..', 'scripts', 'approve-pending.js');
const TMP_CHRONICLE = path.join(tmpDir, 'chronicle.db');

function approveEnv(overrides = {}) {
  const env = { ...process.env, T2HELIX_DATA_DIR: tmpDir };
  delete env.CLAUDE_PLUGIN_DATA;
  delete env.T2HELIX_REQUIRE_HUMAN_CONFIRM;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function runApprove(args, env) {
  const res = spawnSync(process.execPath, [APPROVE_SCRIPT, ...args], { env, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(res.stdout || ''); }
  catch { out = { _unparseable: res.stdout }; }
  return { code: res.status, out, raw: `${res.stdout || ''}${res.stderr || ''}` };
}

test('approve-pending.js: a bare run (neither T2HELIX_DATA_DIR nor CLAUDE_PLUGIN_DATA) is refused with exit 2, names the path it resolved, and creates nothing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-approve-home-'));
  const env = approveEnv({ T2HELIX_DATA_DIR: undefined, HOME: home });
  for (const args of [['0123456789abcdef'], ['--list'], []]) {
    const r = runApprove(args, env);
    assert.strictEqual(r.code, 2, `bare run ${JSON.stringify(args)} must exit 2: ${r.raw}`);
    assert.strictEqual(r.out.ok, false);
    assert.strictEqual(r.out.chronicle, path.join(home, '.t2helix-data', 'chronicle.db'),
      'the refusal must name the store it would have read');
    assert.ok(/T2HELIX_DATA_DIR=/.test(r.out.error), `the refusal must show the explicit form: ${r.out.error}`);
  }
  assert.ok(!fs.existsSync(path.join(home, '.t2helix-data')), 'a refused run must not create the fallback store');
});

test('approve-pending.js: a named directory with no chronicle.db is refused with exit 2 and left empty', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-approve-empty-'));
  const r = runApprove(['0123456789abcdef'], approveEnv({ T2HELIX_DATA_DIR: empty }));
  assert.strictEqual(r.code, 2, r.raw);
  assert.strictEqual(r.out.ok, false);
  assert.strictEqual(r.out.chronicle, path.join(empty, 'chronicle.db'));
  assert.deepStrictEqual(fs.readdirSync(empty), [], 'an approval attempt must not create a store as a side effect');
});

test('approve-pending.js <token> with the switch set: approves as origin cli and names the chronicle it wrote', () => {
  const sid = 'ap-script-ok-' + Date.now();
  const p = ch.createPendingConfirmation({ session_id: sid, action_summary: 'script-ok-' + Date.now() });
  const r = runApprove([p.token], approveEnv({ T2HELIX_REQUIRE_HUMAN_CONFIRM: '1' }));
  assert.strictEqual(r.code, 0, r.raw);
  assert.strictEqual(r.out.ok, true);
  assert.strictEqual(r.out.origin, 'cli');
  assert.strictEqual(r.out.chronicle, TMP_CHRONICLE);
  const row = ch.listPendingConfirmations({ session_id: sid, limit: 10 })[0];
  assert.strictEqual(row.status, 'approved');
  assert.strictEqual(row.approved_origin, 'cli');
});

test('approve-pending.js: an unknown token or a missing argument exits 1 and still names the chronicle', () => {
  for (const args of [['ffffffffffffffff'], []]) {
    const r = runApprove(args, approveEnv());
    assert.strictEqual(r.code, 1, `${JSON.stringify(args)}: ${r.raw}`);
    assert.strictEqual(r.out.ok, false);
    assert.strictEqual(r.out.chronicle, TMP_CHRONICLE);
  }
});

test('approve-pending.js --list: each pending request with its id, action summary, token and expiry; an approved one drops out', () => {
  const sid = 'ap-script-list-' + Date.now();
  const a = ch.createPendingConfirmation({ session_id: sid, action_summary: 'list-a-' + Date.now(), rule_matched: 'credential-paste' });
  const b = ch.createPendingConfirmation({ session_id: sid, action_summary: 'list-b-' + Date.now() });
  ch.approveConfirmation({ token: b.token, origin: 'cli' });
  const r = runApprove(['--list'], approveEnv());
  assert.strictEqual(r.code, 0, r.raw);
  assert.strictEqual(r.out.chronicle, TMP_CHRONICLE);
  const mine = (r.out.pending || []).filter(e => e.token === a.token || e.token === b.token);
  assert.strictEqual(mine.length, 1, 'only the request still awaiting approval is listed');
  assert.strictEqual(mine[0].id, a.id);
  assert.ok(mine[0].action_summary.startsWith('list-a-'), mine[0].action_summary);
  assert.strictEqual(mine[0].rule_matched, 'credential-paste');
  assert.strictEqual(mine[0].token, a.token);
  assert.strictEqual(mine[0].expires_at, new Date(a.expires_at).toISOString());
});

// ── 6. The agent's shell cannot run the human path ──────────────────────────
//
// With the switch set, the model still holds the token and has a shell. A
// bundled WITNESS rule denies a shell command that names approve-pending
// wherever the PreToolUse hook runs. A human's own terminal runs no hook, so the
// human path stays open. This is a speed bump, not a wall (README).

const compass = require('../lib/compass');
const { classifyV2 } = require('../lib/compass-v2');

function agentApproveCommands(token) {
  return [
    `node scripts/approve-pending.js ${token}`,
    `node ${APPROVE_SCRIPT} ${token}`,
    `node /Users/someone/.claude/plugins/cache/templetwo-t2helix/t2helix/abc/scripts/approve-pending.js ${token}`,
    `T2HELIX_DATA_DIR="$HOME/.claude/plugins/data/t2helix-templetwo-t2helix" node scripts/approve-pending.js --list`,
    `cd /tmp && node ./Scripts/APPROVE-PENDING.js ${token}`
  ];
}

test('compass: a shell command that runs approve-pending is WITNESS under legacy, V2 shadow and V2 enforce (real minted token)', () => {
  const p = ch.createPendingConfirmation({ session_id: 'ap-witness-' + Date.now(), action_summary: 'witness-' + Date.now() });
  const prev = process.env.T2HELIX_COMPASS_V2;
  try {
    for (const command of agentApproveCommands(p.token)) {
      const payload = { tool_name: 'Bash', tool_input: { command } };
      const legacy = compass.classify(payload);
      assert.strictEqual(legacy.classification, 'WITNESS', `legacy did not deny: ${command}`);
      assert.strictEqual(legacy.rule_id, 'approve-pending-script', command);
      for (const mode of ['shadow', 'enforce']) {
        process.env.T2HELIX_COMPASS_V2 = mode;
        const v2 = classifyV2(payload, {});
        assert.strictEqual(v2.active.classification, 'WITNESS', `V2 ${mode} did not deny: ${command}`);
      }
    }
  } finally {
    if (prev === undefined) delete process.env.T2HELIX_COMPASS_V2;
    else process.env.T2HELIX_COMPASS_V2 = prev;
  }
});

test('PreToolUse: a Bash call that runs approve-pending is hard-denied and mints no override token', () => {
  const victim = ch.createPendingConfirmation({ session_id: 'ap-victim-' + Date.now(), action_summary: 'victim-' + Date.now() });
  const sid = 'ap-agent-script-' + Date.now();
  const r = runHook('pre-tool-use.js', {
    session_id: sid,
    tool_name: 'Bash',
    tool_input: { command: `node ${APPROVE_SCRIPT} ${victim.token}` }
  });
  const decision = r.out.hookSpecificOutput && r.out.hookSpecificOutput.permissionDecision;
  assert.strictEqual(decision, 'deny', `the hook let it through: ${JSON.stringify(r.out)}`);
  assert.ok(denyReason(r).includes('approve-pending-script'), denyReason(r));
  assert.strictEqual(ch.listPendingConfirmations({ session_id: sid, limit: 10 }).length, 0,
    'a WITNESS deny mints no confirm token, so there is nothing to approve past it');
});

async function main() {
  console.log(`T2Helix approval provenance tests (data: ${tmpDir})`);
  const client = makeClient();
  await initialize(client);

  for (const t of tests) {
    try {
      await t.fn(client);
      console.log(`  PASS  ${t.name}`);
      pass++;
    } catch (e) {
      console.log(`  FAIL  ${t.name}: ${e.message}`);
      fail++;
    }
  }
  await client.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
