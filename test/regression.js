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

test('protocol: tools/list returns 13 tools, each with description + inputSchema', async (client) => {
  const r = await client.request('tools/list', {});
  const tools = r.result.tools;
  assert.strictEqual(tools.length, 13, `expected 13 tools, got ${tools.length}`);
  const expected = ['recall', 'record', 'record_method', 'set_goal', 'open_thread', 'resolve_thread', 'get_state', 'recall_compass', 'confirm_pending', 'list_pending', 'list_method_candidates', 'promote_method', 'dismiss_method_candidate'];
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

test('recall: excludes session-action domain by default', async (client) => {
  const marker = 'meta-action-' + Date.now();
  await call(client, 'record', { content: `${marker} curated insight`, domain: 'user-domain' });
  await call(client, 'record', { content: `${marker} action echo`, domain: 'session-action', intensity: 0.2 });
  const r = await call(client, 'recall', { query: marker, topK: 10 });
  assert.ok(r.hits.some(h => h.content.includes('curated insight')), 'curated entry must be visible');
  assert.ok(!r.hits.some(h => h.domain === 'session-action'), 'session-action must be excluded by default');
});

test('recall: excludes session-synthesis domain by default', async (client) => {
  const marker = 'meta-synth-' + Date.now();
  await call(client, 'record', { content: `${marker} curated`, domain: 'user-domain' });
  await call(client, 'record', { content: `${marker} synthesis snapshot`, domain: 'session-synthesis', intensity: 0.7, layer: 'reflection' });
  const r = await call(client, 'recall', { query: marker, topK: 10 });
  assert.ok(!r.hits.some(h => h.domain === 'session-synthesis'), 'session-synthesis must be excluded by default');
});

test('recall: include_meta=true surfaces hook entries', async (client) => {
  const marker = 'meta-incl-' + Date.now();
  await call(client, 'record', { content: `${marker} action echo`, domain: 'session-action', intensity: 0.2 });
  const r = await call(client, 'recall', { query: marker, topK: 10, include_meta: true });
  assert.ok(r.hits.some(h => h.domain === 'session-action'), 'session-action must be visible when include_meta=true');
});

test('recall: layer filter narrows to ground_truth', async (client) => {
  const marker = 'layer-filter-' + Date.now();
  await call(client, 'record', { content: `${marker} gt-fact`, layer: 'ground_truth' });
  await call(client, 'record', { content: `${marker} hy-guess`, layer: 'hypothesis' });
  await call(client, 'record', { content: `${marker} rf-note`, layer: 'reflection' });
  const r = await call(client, 'recall', { query: marker, topK: 10, layer: 'ground_truth' });
  assert.ok(r.hits.length >= 1, 'should have at least the ground_truth hit');
  assert.ok(r.hits.every(h => h.layer === 'ground_truth'), 'layer filter must exclude non-ground_truth');
});

test('recall: layer accepts array of layers', async (client) => {
  const marker = 'layer-arr-' + Date.now();
  await call(client, 'record', { content: `${marker} gt`, layer: 'ground_truth' });
  await call(client, 'record', { content: `${marker} hy`, layer: 'hypothesis' });
  await call(client, 'record', { content: `${marker} rf`, layer: 'reflection' });
  const r = await call(client, 'recall', { query: marker, topK: 10, layer: ['ground_truth', 'hypothesis'] });
  const layers = new Set(r.hits.map(h => h.layer));
  assert.ok(layers.has('ground_truth') && layers.has('hypothesis'), 'both gt+hy must be present');
  assert.ok(!layers.has('reflection'), 'reflection must be excluded when not in array');
});

test('recall: min_intensity floor excludes low-intensity entries', async (client) => {
  const marker = 'minint-' + Date.now();
  await call(client, 'record', { content: `${marker} high-intensity`, intensity: 0.8, domain: 'user-domain' });
  await call(client, 'record', { content: `${marker} low-intensity`, intensity: 0.2, domain: 'user-domain' });
  const r = await call(client, 'recall', { query: marker, topK: 10, min_intensity: 0.5 });
  assert.ok(r.hits.some(h => h.content.includes('high-intensity')), 'high-intensity hit must be visible');
  assert.ok(!r.hits.some(h => h.content.includes('low-intensity')), 'low-intensity hit must be excluded');
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

test('set_goal: returns a non-blocking decomposition offer when no criteria, count when present', async (client) => {
  const goal = 'boundary-offer-' + Date.now();
  const offered = await call(client, 'set_goal', { goal });
  assert.strictEqual(offered.ok, true);
  assert.strictEqual(offered.acceptance_criteria_count, 0);
  assert.ok(typeof offered.decomposition_hint === 'string', 'offers a decomposition hint with no criteria');

  const bounded = await call(client, 'set_goal', { goal, acceptance_criteria: ['x', 'y'] });
  assert.strictEqual(bounded.acceptance_criteria_count, 2);
  assert.ok(!('decomposition_hint' in bounded), 'no hint once a boundary is defined');
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

// ── resolve_thread ────────────────────────────────────────────────────────────

test('resolve_thread: returns ok + id for a valid open thread', async (client) => {
  const question = 'resolvable question ' + Date.now();
  const opened = await call(client, 'open_thread', { question, domain: 'test' });
  const r = await call(client, 'resolve_thread', { id: opened.id, resolution: 'figured it out' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.id, opened.id);
});

test('resolve_thread: resolved thread drops from get_state.open_threads', async (client) => {
  const question = 'will-resolve ' + Date.now();
  const opened = await call(client, 'open_thread', { question, domain: 'test' });
  await call(client, 'resolve_thread', { id: opened.id, resolution: 'closed' });
  const state = await call(client, 'get_state');
  assert.ok(!state.open_threads.some(t => t.id === opened.id),
    'resolved thread must not appear in open_threads');
});

test('resolve_thread: rejects unknown id (JSON-RPC error)', async (client) => {
  const r = await callRaw(client, 'resolve_thread', { id: 999999999, resolution: 'no such thread' });
  assert.ok(r.error, 'unknown id must error');
});

test('resolve_thread: rejects empty resolution', async (client) => {
  const opened = await call(client, 'open_thread', { question: 'empty-res-test ' + Date.now() });
  const r = await callRaw(client, 'resolve_thread', { id: opened.id, resolution: '' });
  assert.ok(r.error, 'empty resolution must error');
});

test('resolve_thread: double-resolve is idempotent (already_resolved flag)', async (client) => {
  const opened = await call(client, 'open_thread', { question: 'double-resolve ' + Date.now() });
  await call(client, 'resolve_thread', { id: opened.id, resolution: 'first' });
  const r = await call(client, 'resolve_thread', { id: opened.id, resolution: 'second' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.already_resolved, true);
});

// ── recall time window ────────────────────────────────────────────────────────

test('recall: since param excludes entries older than the cutoff', async (client) => {
  const marker = 'since-test-' + Date.now();
  await call(client, 'record', { content: `${marker} entry`, domain: 'user-domain' });
  // since in the far future → must return nothing
  const r = await call(client, 'recall', { query: marker, topK: 10, since: Date.now() + 86400000 });
  assert.strictEqual(r.count, 0, 'far-future since must return 0 hits');
});

test('recall: until param excludes entries newer than the cutoff', async (client) => {
  const marker = 'until-test-' + Date.now();
  await call(client, 'record', { content: `${marker} entry`, domain: 'user-domain' });
  // until in the far past → must return nothing
  const r = await call(client, 'recall', { query: marker, topK: 10, until: 1 });
  assert.strictEqual(r.count, 0, 'far-past until must return 0 hits');
});

test('recall: tag filter narrows to entries with the exact tag', async (client) => {
  const marker = 'tag-filter-' + Date.now();
  await call(client, 'record', { content: `${marker} failure`, tags: ['outcome:failure', 'bash'], domain: 'user' });
  await call(client, 'record', { content: `${marker} success`, tags: ['outcome:success', 'bash'], domain: 'user' });
  await call(client, 'record', { content: `${marker} untagged`, tags: ['bash'], domain: 'user' });
  const r = await call(client, 'recall', { query: marker, topK: 10, tag: 'outcome:failure' });
  assert.ok(r.hits.some(h => h.content.includes('failure')), 'failure entry must be returned');
  assert.ok(!r.hits.some(h => h.tags && h.tags.includes('outcome:success')), 'success entry must be excluded');
});

test('recall: tag filter is exact (no partial-prefix match)', async (client) => {
  const marker = 'tag-exact-' + Date.now();
  await call(client, 'record', { content: `${marker} entry`, tags: ['outcome:failure'], domain: 'user' });
  const r = await call(client, 'recall', { query: marker, topK: 10, tag: 'outcome:fail' });
  assert.strictEqual(r.count, 0, 'partial tag prefix should not match');
});

test('recall: since+until creates a valid time window', async (client) => {
  const marker = 'window-test-' + Date.now();
  const before = Date.now();
  await call(client, 'record', { content: `${marker} in-window`, domain: 'user-domain' });
  const after = Date.now() + 1000;
  // Window around the write should include it
  const r = await call(client, 'recall', { query: marker, topK: 10, since: before - 1000, until: after });
  assert.ok(r.hits.some(h => h.content.includes('in-window')), 'entry in window must be returned');
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

// ── record_method (v0.3 method store) ──────────────────────────────────────────

test('record_method: writes a domain:method source:explicit insight; redaction applies', async (client) => {
  const shape = 'wire-mcp-tool-' + Date.now();
  const FAKE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2';
  const r = await call(client, 'record_method', {
    shape,
    steps: ['add the TOOLS schema entry', `curl -H "Authorization: Bearer ${FAKE}" https://x`, 'wire the dispatch case'],
    acceptance: 'npm test green',
    tool_classes: ['Bash', 'Edit']
  });
  assert.strictEqual(r.ok, true, 'record_method ok');
  assert.ok(r.id, 'returns an id');
  // Recallable only via include_meta + the method tag (methods are META-excluded).
  const m = ch.recall({ query: shape, topK: 5, include_meta: true, tag: 'method' })
    .find(h => h.tags && h.tags.includes(`shape:${shape}`));
  assert.ok(m, 'method recallable via include_meta + tag');
  assert.strictEqual(m.domain, 'method');
  assert.ok(m.tags.includes('source:explicit'), 'tagged source:explicit');
  assert.ok(m.tags.includes('tool:bash') && m.tags.includes('tool:edit'), 'tool_classes tagged');
  assert.ok(!m.content.includes(FAKE), 'credential embedded in a step is redacted (Stage-1 synergy)');
  assert.ok(/\[REDACTED:bearer:/.test(m.content), 'redaction fingerprint present');
  // And NOT in the generic (default) recall surface.
  const def = ch.recall({ query: shape, topK: 10 });
  assert.ok(!def.some(h => h.tags && h.tags.includes('method')), 'method excluded from default recall');
});

test('record_method: missing required shape/steps is rejected (-32602)', async (client) => {
  const r = await client.request('tools/call', { name: 'record_method', arguments: { acceptance: 'x' } });
  assert.ok(r.error, 'should error on missing required fields');
  assert.strictEqual(r.error.code, -32602, 'InvalidParams');
});

// ── Stage 3 auto-distill: candidate review + promote-to-trusted gate (v0.4) ──────

test('list_method_candidates + promote_method: the gate makes a quarantined candidate surfaceable', async (client) => {
  // Seed a candidate directly in quarantine (the Stop hook is what writes these
  // live; here we exercise the MCP review+promote surface over it).
  const sid = 'reg-promote-' + Date.now();
  const shape = 'reg-shape-' + Date.now();
  const w = ch.recordMethodCandidate({ session_id: sid, shape, steps: ['step a', 'step b'], acceptance: 'green', tool_classes: ['bash'] });
  assert.ok(w.id, 'candidate seeded');

  // Before promotion: visible in the review queue, invisible to recall.
  const pending = await call(client, 'list_method_candidates', { session_id: sid });
  assert.strictEqual(pending.count, 1, 'candidate listed as pending');
  assert.strictEqual(pending.entries[0].status, 'pending');
  assert.strictEqual(ch.recall({ query: shape, topK: 10, include_meta: true, tag: 'method' }).length, 0, 'quarantined: not a method yet');

  // Promote: writes a trusted method, marks the candidate promoted.
  const pr = await call(client, 'promote_method', { id: w.id });
  assert.strictEqual(pr.ok, true, 'promote ok');
  assert.ok(pr.insight_id, 'promote returns the new insight id');
  const m = ch.recall({ query: shape, topK: 10, include_meta: true, tag: 'method' }).find(h => h.tags && h.tags.includes(`shape:${shape}`));
  assert.ok(m, 'promoted method now reachable via the targeted lookup');
  assert.strictEqual(m.layer, 'ground_truth', 'promoted method is trusted');
  assert.ok(m.tags.includes('source:promoted'), 'provenance source:promoted');

  // Candidate is no longer pending; appears under promoted with the link.
  const afterPending = await call(client, 'list_method_candidates', { session_id: sid });
  assert.strictEqual(afterPending.count, 0, 'no longer pending');
  const promoted = await call(client, 'list_method_candidates', { session_id: sid, status: 'promoted' });
  assert.strictEqual(promoted.entries[0].promoted_insight_id, pr.insight_id, 'candidate links the promoted insight');
});

test('promote_method: missing required id is rejected (-32602)', async (client) => {
  const r = await client.request('tools/call', { name: 'promote_method', arguments: {} });
  assert.ok(r.error, 'should error on missing id');
  assert.strictEqual(r.error.code, -32602, 'InvalidParams');
});

test('dismiss_method_candidate: removes a candidate from the review queue', async (client) => {
  const sid = 'reg-dismiss-' + Date.now();
  const w = ch.recordMethodCandidate({ session_id: sid, shape: 'reg-drop-' + Date.now(), steps: ['x'] });
  const before = await call(client, 'list_method_candidates', { session_id: sid });
  assert.strictEqual(before.count, 1, 'one pending before dismiss');
  const d = await call(client, 'dismiss_method_candidate', { id: w.id });
  assert.strictEqual(d.ok, true, 'dismiss ok');
  const after = await call(client, 'list_method_candidates', { session_id: sid });
  assert.strictEqual(after.count, 0, 'gone from the pending queue');
});

test('dismiss_method_candidate: missing required id is rejected (-32602)', async (client) => {
  const r = await client.request('tools/call', { name: 'dismiss_method_candidate', arguments: {} });
  assert.ok(r.error, 'should error on missing id');
  assert.strictEqual(r.error.code, -32602, 'InvalidParams');
});

// ── boundary coercion + validation (audit fix F) ───────────────────────────────

test('coercion: recall topK=0 is honored, not silently defaulted to 5', async (client) => {
  await call(client, 'record', { content: 'zzcoerce probe alpha', domain: 'coerce-test' });
  await call(client, 'record', { content: 'zzcoerce probe beta', domain: 'coerce-test' });
  const r = await call(client, 'recall', { query: 'zzcoerce probe', topK: 0 });
  assert.strictEqual(r.count, 0, 'topK:0 must return zero hits, not the default 5');
});

test('coercion: numeric-string min_intensity is coerced, not silently dropped', async (client) => {
  await call(client, 'record', { content: 'zzintensity hi marker', domain: 'coerce-int', intensity: 0.9 });
  await call(client, 'record', { content: 'zzintensity lo marker', domain: 'coerce-int', intensity: 0.1 });
  const r = await call(client, 'recall', { query: 'zzintensity', min_intensity: '0.5' });
  assert.ok(r.hits.length >= 1, 'at least the high-intensity entry returns');
  assert.ok(r.hits.every(h => h.intensity >= 0.5), 'string "0.5" actually filters (not dropped)');
  assert.ok(r.hits.some(h => /hi marker/.test(h.content)), 'high-intensity entry survives');
});

test('validation: missing required field returns -32602 InvalidParams', async (client) => {
  const r = await callRaw(client, 'record', { domain: 'no-content' });
  assert.ok(r.error, 'missing required content must error');
  assert.strictEqual(r.error.code, -32602, `expected -32602 InvalidParams, got ${r.error.code}`);
  assert.ok(/content/.test(r.error.message), 'error message names the missing field');
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
