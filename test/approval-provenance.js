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
function makeClient() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'server.js')], {
    env: { ...process.env, T2HELIX_DATA_DIR: tmpDir },
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

async function main() {
  console.log(`T2Helix approval provenance tests (data: ${tmpDir})`);
  const client = makeClient();
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'approval-provenance-test', version: '1.0.0' }
  });
  client.notify('notifications/initialized', {});

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
