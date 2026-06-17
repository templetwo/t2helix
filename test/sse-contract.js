'use strict';

// test/sse-contract.js — T2Helix v0.7.0 SSE transport contract test.
//
// Proves the same 13 tools and behavior are available over HTTP+SSE as over
// stdio. The MCP SSE handshake:
//   1. GET /sse → Content-Type: text/event-stream
//      Server sends: event: endpoint\ndata: /messages?sessionId=<uuid>\n\n
//   2. POST /messages?sessionId=<uuid> (JSON-RPC) → 202 Accepted
//      Response arrives via the open SSE stream: event: message\ndata: {...}\n\n
//
// Spawns the server with --port 0 so the OS assigns an ephemeral port, then
// reads the actual port from the "listening on http://localhost:<port>/sse"
// stderr line.
//
// Run: node test/sse-contract.js

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-sse-'));
process.env.T2HELIX_DATA_DIR = tmpDir;
// Don't pick up the project's .t2helix/policy.json during the test
process.env.T2HELIX_POLICY_DIR = '';

// ── Minimal SSE client ────────────────────────────────────────────────────────

class SseClient {
  constructor() {
    this._pending = new Map(); // id → resolve
    this._endpoint = null;
    this._sseReq = null;
    this._buf = '';
    this._nextId = 0;
    this._onEndpoint = null;
  }

  connect(port) {
    return new Promise((resolve, reject) => {
      const req = http.get(
        { hostname: 'localhost', port, path: '/sse', headers: { Accept: 'text/event-stream' } },
        res => {
          if (res.statusCode !== 200) {
            return reject(new Error(`/sse status ${res.statusCode}`));
          }
          res.on('data', chunk => this._onData(chunk.toString()));
          res.on('error', reject);
        }
      );
      req.on('error', reject);
      this._sseReq = req;
      this._onEndpoint = resolve;
      setTimeout(() => reject(new Error('SSE connect timeout (5s)')), 5000);
    });
  }

  _onData(text) {
    this._buf += text;
    let idx;
    while ((idx = this._buf.indexOf('\n\n')) !== -1) {
      const block = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 2);
      this._handleBlock(block);
    }
  }

  _handleBlock(block) {
    let eventType = 'message', data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) eventType = line.slice(7).trim();
      else if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (!data) return;

    if (eventType === 'endpoint') {
      this._endpoint = data; // e.g. /messages?sessionId=<uuid>
      if (this._onEndpoint) { this._onEndpoint(); this._onEndpoint = null; }
      return;
    }

    try {
      const msg = JSON.parse(data);
      if (msg.id != null && this._pending.has(msg.id)) {
        const resolve = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        resolve(msg);
      }
    } catch (_) {}
  }

  request(port, method, params) {
    const id = ++this._nextId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, resolve);
      const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
      const opts = {
        method: 'POST',
        hostname: 'localhost',
        port,
        path: this._endpoint || '/messages',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      };
      const req = http.request(opts, res => res.resume());
      req.write(body);
      req.end();
      req.on('error', e => { this._pending.delete(id); reject(e); });
      setTimeout(() => {
        if (this._pending.has(id)) { this._pending.delete(id); reject(new Error(`Timeout: ${method}`)); }
      }, 8000);
    });
  }

  // Fire-and-forget notification (no id, no response expected over SSE).
  notify(port, method, params) {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params: params || {} });
    const opts = {
      method: 'POST',
      hostname: 'localhost',
      port,
      path: this._endpoint || '/messages',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = http.request(opts, res => res.resume());
    req.write(body);
    req.end();
    req.on('error', () => {}); // notifications are best-effort
  }

  close() { if (this._sseReq) this._sseReq.destroy(); }
}

// ── Spawn the SSE server ──────────────────────────────────────────────────────

function spawnServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, '..', 'mcp', 'server.js'), '--transport', 'sse', '--port', '0'],
      { env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    let ready = false;
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      const m = text.match(/:(\d+)\/sse/);
      if (!ready && m) {
        ready = true;
        resolve({ child, port: parseInt(m[1], 10) });
      }
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (!ready) reject(new Error(`Server exited ${code} before ready`));
    });
    setTimeout(() => { if (!ready) reject(new Error('Server start timeout (8s)')); }, 8000);
  });
}

// ── Parse tool call result ─────────────────────────────────────────────────────

function payload(rpcResponse) {
  if (rpcResponse.error) throw new Error(`RPC error: ${rpcResponse.error.message}`);
  const text = rpcResponse.result?.content?.[0]?.text;
  if (!text) throw new Error(`Unexpected response shape: ${JSON.stringify(rpcResponse)}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function call(client, port, name, args = {}) {
  const r = await client.request(port, 'tools/call', { name, arguments: args });
  return payload(r);
}

// ── Test registry ─────────────────────────────────────────────────────────────

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── MCP initialize handshake ──────────────────────────────────────────────────

test('sse: initialize handshake succeeds', async ({ client, port }) => {
  const r = await client.request(port, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'sse-contract-test', version: '0.1' }
  });
  assert.ok(r.result, 'initialize must succeed');
  assert.ok(r.result.serverInfo, 'initialize result must include serverInfo');
  assert.strictEqual(r.result.serverInfo.name, 't2helix');
  // Send the initialized notification (fire-and-forget)
  client.notify(port, 'notifications/initialized', {});
});

// ── Protocol ──────────────────────────────────────────────────────────────────

test('sse: tools/list returns 13 tools over SSE', async ({ client, port }) => {
  const r = await client.request(port, 'tools/list', {});
  const tools = r.result.tools;
  assert.strictEqual(tools.length, 13, `expected 13 tools, got ${tools.length}`);
  const expected = ['recall', 'record', 'record_method', 'set_goal', 'open_thread',
    'resolve_thread', 'get_state', 'recall_compass', 'confirm_pending', 'list_pending',
    'list_method_candidates', 'promote_method', 'dismiss_method_candidate'];
  const names = new Set(tools.map(t => t.name));
  for (const n of expected) assert.ok(names.has(n), `tools/list missing ${n}`);
  for (const t of tools) {
    assert.ok(t.description, `tool ${t.name} missing description`);
    assert.ok(t.inputSchema, `tool ${t.name} missing inputSchema`);
  }
});

// ── Core round-trips ──────────────────────────────────────────────────────────

test('sse: record returns ok:true + id', async ({ client, port }) => {
  const r = await call(client, port, 'record', { content: 'sse-test-entry-' + Date.now() });
  assert.strictEqual(r.ok, true);
  assert.ok(r.id, 'record must return an id');
});

test('sse: record + recall round-trip', async ({ client, port }) => {
  const marker = 'sse-roundtrip-' + Date.now();
  await call(client, port, 'record', { content: `unique ${marker} insight via SSE` });
  const r = await call(client, port, 'recall', { query: marker, topK: 5 });
  assert.ok(r.count >= 1, `expected ≥1 hit, got ${r.count}`);
  assert.ok(r.hits.some(h => h.content.includes(marker)));
});

test('sse: record with layer=ground_truth round-trips the layer', async ({ client, port }) => {
  const marker = 'sse-layer-gt-' + Date.now();
  await call(client, port, 'record', { content: marker + ' content', layer: 'ground_truth' });
  const r = await call(client, port, 'recall', { query: marker, topK: 5 });
  const hit = r.hits.find(h => h.content.includes(marker));
  assert.ok(hit, 'inserted insight must be recallable');
  assert.strictEqual(hit.layer, 'ground_truth');
});

test('sse: set_goal + get_state round-trip', async ({ client, port }) => {
  const marker = 'sse-goal-' + Date.now();
  await call(client, port, 'set_goal', { goal: `SSE test goal ${marker}` });
  const state = await call(client, port, 'get_state', {});
  assert.ok(state.goal, 'get_state must return goal after set_goal');
  assert.ok(state.goal.goal.includes(marker), 'goal text must round-trip');
});

test('sse: open_thread + get_state shows thread', async ({ client, port }) => {
  const marker = 'sse-thread-' + Date.now();
  await call(client, port, 'open_thread', { question: `Thread question ${marker}` });
  const state = await call(client, port, 'get_state', {});
  assert.ok(state.open_threads.length >= 1, 'open_thread must appear in get_state');
  assert.ok(state.open_threads.some(t => t.question.includes(marker)));
});

test('sse: record rejects empty content', async ({ client, port }) => {
  const r = await client.request(port, 'tools/call', { name: 'record', arguments: { content: '' } });
  assert.ok(r.error, 'empty content must error');
});

test('sse: recall_compass returns ok', async ({ client, port }) => {
  const r = await call(client, port, 'recall_compass', { limit: 5 });
  assert.ok(Array.isArray(r.entries), 'recall_compass must return entries array');
});

// ── Runner ─────────────────────────────────────────────────────────────────────

(async () => {
  let server, client;
  try {
    process.stdout.write('Starting SSE server…\n');
    server = await spawnServer();
    client = new SseClient();
    await client.connect(server.port);
    process.stdout.write(`SSE server ready on port ${server.port}\n`);
  } catch (e) {
    process.stderr.write(`SSE setup failed: ${e.message}\n`);
    process.exit(1);
  }

  let passed = 0, failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn({ client, port: server.port });
      process.stdout.write(`  ✓ ${name}\n`);
      passed++;
    } catch (e) {
      process.stderr.write(`  ✗ ${name}\n    ${e.message}\n`);
      failed++;
    }
  }

  client.close();
  server.child.kill('SIGTERM');

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  process.stdout.write(`\nSSE contract: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
