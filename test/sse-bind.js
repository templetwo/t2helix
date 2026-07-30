'use strict';

// test/sse-bind.js — the SSE transport must bind loopback, and must advertise
// the address it ACTUALLY bound.
//
// Two properties, both of them load-bearing:
//   1. Default bind is loopback — the MCP surface hands out chronicle writes
//      and compass state, so an accidental all-interfaces bind exposes it to
//      anything that can route to this machine.
//   2. The startup line prints the kernel's answer (httpServer.address()), not
//      a hardcoded name. A log that says "localhost" while the socket is on *
//      is a false clean bill of health.
//
// The off-box leg connects from a non-internal IPv4 of this host: if that
// succeeds the server is reachable beyond loopback regardless of what it
// logged. It reports SKIP loudly when the machine has no such address — a
// silent skip reading as a pass is the failure shape this file exists for.
//
// Run: node test/sse-bind.js

const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-bind-'));
process.env.T2HELIX_DATA_DIR = tmpDir;
process.env.T2HELIX_POLICY_DIR = '';

const SERVER = path.join(__dirname, '..', 'mcp', 'server.js');
const LOOPBACK = ['127.0.0.1', '::1'];

// ── Harness ───────────────────────────────────────────────────────────────────

// Resolves once the startup line lands; keeps the full stderr for assertions
// about the warning text.
function spawnServer(extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, '--transport', 'sse', '--port', '0'], {
      env: { ...process.env, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stderr = '';
    let settled = false;
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      const m = stderr.match(/listening on http:\/\/(\[[^\]]+\]|[^:/\s]+):(\d+)\/sse/);
      if (!settled && m) {
        settled = true;
        const host = m[1].replace(/^\[|\]$/g, '');
        resolve({ child, host, port: parseInt(m[2], 10), stderr: () => stderr });
      }
    });
    child.on('error', reject);
    child.on('exit', code => { if (!settled) reject(new Error(`server exited ${code}: ${stderr}`)); });
    setTimeout(() => { if (!settled) reject(new Error(`server start timeout (8s): ${stderr}`)); }, 8000);
  });
}

// stderr after the startup line can land in a later chunk — poll rather than
// read once, so a passing assertion is never a timing accident.
function waitForStderr(server, re, ms = 3000) {
  const deadline = Date.now() + ms;
  return new Promise(resolve => {
    const tick = () => {
      if (re.test(server.stderr()) || Date.now() > deadline) return resolve(server.stderr());
      setTimeout(tick, 25);
    };
    tick();
  });
}

function probe(host, port) {
  return new Promise(resolve => {
    const sock = net.connect({ host, port, family: net.isIPv6(host) ? 6 : 4 });
    const done = r => { sock.destroy(); resolve(r); };
    sock.on('connect', () => done({ reachable: true }));
    sock.on('error', e => done({ reachable: false, code: e.code }));
    sock.setTimeout(3000, () => done({ reachable: null, code: 'ETIMEDOUT' }));
  });
}

function externalIPv4() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('default bind advertises a loopback address, not a hardcoded name', async () => {
  const s = await spawnServer({});
  try {
    assert.ok(
      LOOPBACK.includes(s.host),
      `startup line must name the address actually bound; got "${s.host}"`
    );
  } finally { s.child.kill('SIGTERM'); }
});

test('the advertised host is really listening', async () => {
  const s = await spawnServer({});
  try {
    const r = await probe(s.host, s.port);
    assert.strictEqual(r.reachable, true, `advertised ${s.host}:${s.port} not connectable (${r.code})`);
  } finally { s.child.kill('SIGTERM'); }
});

test('default bind is NOT reachable from a non-loopback address of this host', async () => {
  const lan = externalIPv4();
  if (!lan) return 'SKIP no non-internal IPv4 on this machine — off-box leg not exercised';
  const s = await spawnServer({});
  try {
    const r = await probe(lan, s.port);
    if (r.reachable === null) return `SKIP probe to ${lan} timed out — inconclusive, not a pass`;
    assert.strictEqual(r.reachable, false, `reachable on ${lan}:${s.port} — bound beyond loopback`);
  } finally { s.child.kill('SIGTERM'); }
});

test('T2HELIX_SSE_HOST honored, advertised verbatim, and warned about', async () => {
  const s = await spawnServer({ T2HELIX_SSE_HOST: '0.0.0.0' });
  try {
    assert.strictEqual(s.host, '0.0.0.0', `expected the requested bind to be advertised, got "${s.host}"`);
    const err = await waitForStderr(s, /WARNING/i);
    assert.match(err, /WARNING/i, 'a non-loopback bind must warn on stderr');
    assert.ok(err.includes('0.0.0.0'), 'the warning must name the address it bound');
  } finally { s.child.kill('SIGTERM'); }
});

test('an unusable bind host fails closed instead of falling back to all interfaces', async () => {
  let s = null;
  try {
    s = await spawnServer({ T2HELIX_SSE_HOST: '203.0.113.1' });
  } catch (e) {
    assert.match(e.message, /EADDRNOTAVAIL|exited/, `expected a hard failure, got: ${e.message}`);
    return;
  }
  s.child.kill('SIGTERM');
  assert.fail(`server came up on "${s.host}" after being asked for an unassignable address`);
});

// ── Runner ─────────────────────────────────────────────────────────────────────

(async () => {
  let pass = 0, fail = 0, skip = 0;
  for (const { name, fn } of tests) {
    try {
      const r = await fn();
      if (typeof r === 'string' && r.startsWith('SKIP')) {
        console.log(`  SKIP  ${name}\n        ${r.slice(5)}`);
        skip++;
      } else {
        console.log(`  PASS  ${name}`);
        pass++;
      }
    } catch (e) {
      console.log(`  FAIL  ${name}: ${e.message}`);
      fail++;
    }
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
  if (fail > 0) process.exit(1);
})();
