'use strict';

// test/regression.js — T2Helix v0.0.5 API contract regression suite.
//
// Tests the 8 MCP tools end-to-end via stdio JSON-RPC. Defines the
// behavioral contract that v0.1.0 (filesystem-native chronicle) must
// satisfy after the SQLite → filesystem storage swap.
//
// Run: npm run regression

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-regression-'));
process.env.T2HELIX_DATA_DIR = tmpDir;

// lib/chronicle is used only to seed compass_log and pending_confirmations,
// since their write paths are exercised by hooks (PreToolUse) rather than
// MCP tools. v0.1.0 will reimplement these write paths against filesystem
// storage; the seeding lines below will need to migrate to the new API.
const ch = require('../lib/chronicle');

// ── MCP stdio client ──────────────────────────────────────────────────────────

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
    child,
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

// Parse the textContent payload returned by tools/call.
function payload(rpcResponse) {
  const text = rpcResponse.result.content[0].text;
  try { return JSON.parse(text); } catch { return text; }
}

// Call a tool, return parsed payload. Throws if JSON-RPC returns error.
async function call(client, name, args = {}) {
  const r = await client.request('tools/call', { name, arguments: args });
  if (r.error) throw new Error(`tool ${name} error: ${r.error.message}`);
  return payload(r);
}

// Call a tool, return the raw JSON-RPC response (for tests that assert on errors).
async function callRaw(client, name, args = {}) {
  return client.request('tools/call', { name, arguments: args });
}

// ── Test registry ─────────────────────────────────────────────────────────────

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── Protocol ──────────────────────────────────────────────────────────────────

test('protocol: tools/list returns 8 tools, each with description + inputSchema', async (client) => {
  const r = await client.request('tools/list', {});
  const tools = r.result.tools;
  assert.strictEqual(tools.length, 8, `expected 8 tools, got ${tools.length}`);
  const expected = ['recall', 'record', 'set_goal', 'open_thread', 'get_state', 'recall_compass', 'confirm_pending', 'list_pending'];
  const names = new Set(tools.map(t => t.name));
  for (const n of expected) {
    assert.ok(names.has(n), `tools/list missing ${n}`);
  }
  for (const t of tools) {
    assert.ok(t.description, `tool ${t.name} missing description`);
    assert.ok(t.inputSchema, `tool ${t.name} missing inputSchema`);
    assert.strictEqual(t.inputSchema.type, 'object', `tool ${t.name} inputSchema.type must be object`);
  }
});

// ── record ────────────────────────────────────────────────────────────────────

test('record: returns ok:true + id', async (client) => {
  const r = await call(client, 'record', { content: 'first regression insight ' + Date.now() });
  assert.strictEqual(r.ok, true);
  assert.ok(r.id, 'record must return an id');
});

test('record: rejects empty content (JSON-RPC error)', async (client) => {
  const r = await callRaw(client, 'record', { content: '' });
  assert.ok(r.error, 'empty content must error');
});

test('record: rejects oversize content (>100KB)', async (client) => {
  const huge = 'x'.repeat(100 * 1024 + 1);
  const r = await callRaw(client, 'record', { content: huge });
  assert.ok(r.error, 'oversize content must error');
});

test('record: preserves layer field across hypothesis/ground_truth/reflection', async (client) => {
  const marker = 'layer-test-' + Date.now();
  await call(client, 'record', { content: `${marker}-gt content`, layer: 'ground_truth' });
  await call(client, 'record', { content: `${marker}-hy content`, layer: 'hypothesis' });
  await call(client, 'record', { content: `${marker}-rf content`, layer: 'reflection' });
  const r = await call(client, 'recall', { query: marker, topK: 10 });
  const layers = new Set(r.hits.map(h => h.layer));
  assert.ok(layers.has('ground_truth'), 'ground_truth must round-trip');
  assert.ok(layers.has('hypothesis'), 'hypothesis must round-trip');
  assert.ok(layers.has('reflection'), 'reflection must round-trip');
});

test('record: preserves tags array', async (client) => {
  const marker = 'tags-test-' + Date.now();
  await call(client, 'record', { content: marker, tags: ['alpha', 'beta', 'gamma'] });
  const r = await call(client, 'recall', { query: marker, topK: 5 });
  const hit = r.hits.find(h => h.content === marker);
  assert.ok(hit, 'tagged insight should be recallable');
  assert.deepStrictEqual(hit.tags, ['alpha', 'beta', 'gamma']);
});

test('record: preserves domain field', async (client) => {
  const marker = 'domain-test-' + Date.now();
  await call(client, 'record', { content: marker, domain: 'test-domain' });
  const r = await call(client, 'recall', { query: marker, topK: 5 });
  const hit = r.hits.find(h => h.content === marker);
  assert.ok(hit);
  assert.strictEqual(hit.domain, 'test-domain');
});

// ── recall ────────────────────────────────────────────────────────────────────

test('recall: round-trips a recorded insight', async (client) => {
  const marker = 'recall-marker-' + Date.now();
  await call(client, 'record', { content: `unique ${marker} content for recall` });
  const r = await call(client, 'recall', { query: marker, topK: 5 });
  assert.ok(r.count >= 1, `expected ≥1 hit, got ${r.count}`);
  assert.ok(r.hits.some(h => h.content.includes(marker)));
});

test('recall: ranks higher-TF hits above lower-TF hits on FTS path', async (client) => {
  // NOTE: query terms must be hyphen-free so FTS5 prefix matching works.
  // Hyphenated terms hit the catch-block fallback to "most recent" and
  // bypass bm25 ranking entirely — that path is exercised by the
  // "no-match falls back to recent" test below.
  const kw = 'rankmark' + Date.now();
  await call(client, 'record', { content: `${kw} ${kw} ${kw} strong match insight` });
  await call(client, 'record', { content: `${kw} single occurrence` });
  await call(client, 'record', { content: `unrelated content with no marker` });
  const r = await call(client, 'recall', { query: kw, topK: 5 });
  assert.ok(r.count >= 2, `expected ≥2 hits, got ${r.count}`);
  // The 3× insight must rank above the 1× insight (bm25 TF effect).
  // Top hit must be the strong-match doc.
  assert.ok(r.hits[0].content.includes('strong match'),
    `top hit must be the 3-occurrence doc, got: ${r.hits[0].content}`);
});

test('recall: topK caps result count', async (client) => {
  const marker = 'topk-test-' + Date.now();
  for (let i = 0; i < 5; i++) {
    await call(client, 'record', { content: `${marker} occurrence ${i}` });
  }
  const r = await call(client, 'recall', { query: marker, topK: 2 });
  assert.ok(r.count <= 2, `topK=2 must return ≤2 hits, got ${r.count}`);
  assert.strictEqual(r.hits.length, r.count);
});

test('recall: no-match query returns empty (FTS5 0-row path)', async (client) => {
  // v0.0.5 contract: when the FTS5 query parses cleanly but matches nothing,
  // recall returns 0 hits. The "fall back to most recent" path in
  // lib/chronicle.js lines 105-108 only fires when FTS5 *throws* (e.g., on
  // syntactically problematic query terms — hyphens in unicode61 tokenizer,
  // etc.). That throw-fallback path is implementation-incidental; the
  // contract we encode is the clean one: "no matches" → "no hits."
  const r = await call(client, 'recall', { query: 'phantomtermnomatchexists' + Date.now(), topK: 5 });
  assert.strictEqual(r.count, 0, `no-match query should return 0 hits, got ${r.count}`);
  assert.deepStrictEqual(r.hits, []);
});

// ── set_goal ──────────────────────────────────────────────────────────────────

test('set_goal: sets goal and surfaces in get_state', async (client) => {
  const goal = 'regression goal ' + Date.now();
  await call(client, 'set_goal', { goal, why: 'verify roundtrip' });
  const state = await call(client, 'get_state');
  assert.strictEqual(state.goal.goal, goal);
  assert.strictEqual(state.goal.why, 'verify roundtrip');
});

test('set_goal: preserves acceptance_criteria array', async (client) => {
  const goal = 'goal-with-criteria-' + Date.now();
  await call(client, 'set_goal', {
    goal,
    acceptance_criteria: ['crit-a', 'crit-b', 'crit-c']
  });
  const state = await call(client, 'get_state');
  assert.deepStrictEqual(state.goal.acceptance_criteria, ['crit-a', 'crit-b', 'crit-c']);
});

test('set_goal: archives prior goal as an insight when goal changes', async (client) => {
  const first = 'first goal text ' + Date.now();
  const second = 'second goal text ' + Date.now();
  await call(client, 'set_goal', { goal: first, why: 'first why' });
  await call(client, 'set_goal', { goal: second });
  const r = await call(client, 'recall', { query: first, topK: 20 });
  const archived = r.hits.find(h =>
    h.content && h.content.includes(first) && h.tags && h.tags.includes('archived-goal')
  );
  assert.ok(archived, 'prior goal must be archived as insight tagged archived-goal');
  assert.strictEqual(archived.layer, 'reflection');
});

// ── open_thread ───────────────────────────────────────────────────────────────

test('open_thread: returns ok + id', async (client) => {
  const r = await call(client, 'open_thread', { question: 'why does x happen?', domain: 'test' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.id);
});

test('open_thread: question surfaces in get_state.open_threads', async (client) => {
  const question = 'unique question ' + Date.now();
  await call(client, 'open_thread', { question, domain: 'test' });
  const state = await call(client, 'get_state');
  assert.ok(state.open_threads.some(t => t.question === question),
    'open_thread question must surface in get_state');
});

// ── get_state ─────────────────────────────────────────────────────────────────

test('get_state: returns goal + open_threads + recent_insights shape', async (client) => {
  const state = await call(client, 'get_state');
  assert.ok('goal' in state, 'state must have goal key');
  assert.ok('open_threads' in state, 'state must have open_threads key');
  assert.ok('recent_insights' in state, 'state must have recent_insights key');
  assert.ok(Array.isArray(state.open_threads));
  assert.ok(Array.isArray(state.recent_insights));
});

// ── recall_compass (compass_log read; seeded via lib/chronicle.logCompass) ────

test('recall_compass: returns { count, entries } shape', async (client) => {
  const r = await call(client, 'recall_compass', { limit: 10 });
  assert.strictEqual(typeof r.count, 'number');
  assert.ok(Array.isArray(r.entries));
});

test('recall_compass: returns seeded entries after logCompass', async (client) => {
  const sid = 'rc-seed-' + Date.now();
  ch.logCompass({ session_id: sid, tool_name: 'Bash', action_summary: 'seed rm', classification: 'WITNESS', rule_matched: 'rm-rf', reason: 'test' });
  ch.logCompass({ session_id: sid, tool_name: 'Bash', action_summary: 'seed ls', classification: 'OPEN', rule_matched: null, reason: null });
  ch.logCompass({ session_id: sid, tool_name: 'Bash', action_summary: 'seed cred', classification: 'PAUSE', rule_matched: 'credential-paste', reason: 'test' });
  const r = await call(client, 'recall_compass', { limit: 100 });
  assert.ok(r.count >= 3, `expected ≥3 entries after seeding, got ${r.count}`);
});

test('recall_compass: classification filter narrows correctly', async (client) => {
  const r = await call(client, 'recall_compass', { limit: 100, classification: 'WITNESS' });
  assert.ok(r.entries.every(e => e.classification === 'WITNESS'),
    'classification:WITNESS must return only WITNESS rows');
});

test('recall_compass: matched_only excludes OPEN/null rule rows', async (client) => {
  const r = await call(client, 'recall_compass', { limit: 100, matched_only: true });
  assert.ok(r.entries.every(e => e.rule_matched !== null),
    'matched_only must exclude rule_matched=null rows');
});

// ── list_pending + confirm_pending (pending_confirmations read + approve) ─────

test('list_pending: returns { count, entries } shape', async (client) => {
  const r = await call(client, 'list_pending', { limit: 10 });
  assert.strictEqual(typeof r.count, 'number');
  assert.ok(Array.isArray(r.entries));
});

test('list_pending: session_id filter narrows', async (client) => {
  const sid = 'lp-filter-' + Date.now();
  ch.createPendingConfirmation({ session_id: sid, action_summary: 'a1-' + Date.now(), rule_matched: 'r', reason: 'r' });
  ch.createPendingConfirmation({ session_id: sid, action_summary: 'a2-' + Date.now(), rule_matched: 'r', reason: 'r' });
  const r = await call(client, 'list_pending', { session_id: sid, limit: 100 });
  assert.ok(r.count >= 2, `expected ≥2 entries for session ${sid}, got ${r.count}`);
  assert.ok(r.entries.every(e => e.session_id === sid),
    'session_id filter must return only matching session rows');
});

test('confirm_pending: rejects invalid token', async (client) => {
  const r = await call(client, 'confirm_pending', { token: 'not-a-real-token' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error, 'should include error message');
});

test('confirm_pending: approves valid seeded token', async (client) => {
  const sid = 'cp-approve-' + Date.now();
  const action = 'pending-action-' + Date.now();
  const p = ch.createPendingConfirmation({ session_id: sid, action_summary: action, rule_matched: 'r', reason: 'r' });
  const r = await call(client, 'confirm_pending', { token: p.token });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.action_summary, action);
});

test('confirm_pending: rejects double-approval', async (client) => {
  const sid = 'cp-double-' + Date.now();
  const action = 'pending-double-' + Date.now();
  const p = ch.createPendingConfirmation({ session_id: sid, action_summary: action, rule_matched: 'r', reason: 'r' });
  await call(client, 'confirm_pending', { token: p.token });
  const second = await call(client, 'confirm_pending', { token: p.token });
  assert.strictEqual(second.ok, false, 'second approval must fail');
});

// ── Runner ────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`T2Helix regression tests (data: ${tmpDir})`);
  const client = makeClient();

  // Initialize once for the whole suite. Tests are isolated by unique
  // session_id / marker strings rather than per-test process spawns.
  const initResp = await client.request('initialize', {
    protocolVersion: '2024-11-05',
    clientInfo: { name: 'regression-suite', version: '1.0.0' },
    capabilities: {}
  });
  assert.strictEqual(initResp.result.protocolVersion, '2024-11-05', 'initialize must return matching protocolVersion');
  client.notify('notifications/initialized', {});

  let pass = 0, fail = 0;
  for (const { name, fn } of tests) {
    try {
      await fn(client);
      console.log(`  PASS  ${name}`);
      pass++;
    } catch (e) {
      console.log(`  FAIL  ${name}: ${e.message}`);
      if (process.env.DEBUG && e.stack) console.log(e.stack);
      fail++;
    }
  }

  await client.close();
  try { ch.close(); } catch (_) {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(2);
});
