'use strict';

// test/sync-stack.js — scripts/sync-stack.js: row selection, cursor behaviour,
// and a full CLI push against a LOCAL stub stack (no network, no real bridge).

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-syncstack-'));
process.env.T2HELIX_DATA_DIR = tmpDir;

const ch = require('../lib/chronicle');
const sync = require('../scripts/sync-stack');

let pass = 0, fail = 0;
function test(name, ok) {
  if (ok) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}`); fail++; }
}

console.log(`T2Helix sync-stack tests (data: ${tmpDir})`);

// ── seed a representative chronicle ──────────────────────────────────────────
const SID = 'spiral_test_001';
ch.record({ session_id: SID, content: 'BUILD A — t2helix dogfood ground truth one', domain: 't2helix', layer: 'ground_truth' });
ch.record({ session_id: SID, content: 'BUILD B — t2helix dogfood ground truth two', domain: 't2helix,dashboard', layer: 'ground_truth' });
ch.record({ session_id: SID, content: 'a t2helix hypothesis, not yet confirmed', domain: 't2helix', layer: 'hypothesis' });
ch.record({ session_id: SID, content: 'unrelated ground truth about pizza', domain: 'misc', layer: 'ground_truth' });
ch.record({ session_id: SID, content: 'already a mirror — must never re-sync', domain: 't2helix,mirrored-from-local', layer: 'ground_truth' });

const db = ch.db();
const all = db.prepare('SELECT id, content, domain, layer FROM insights ORDER BY id ASC').all();
const gtA = all.find(r => r.content.startsWith('BUILD A'));
const gtB = all.find(r => r.content.startsWith('BUILD B'));

// ── unit: selection logic ────────────────────────────────────────────────────
const fromZero = sync.selectPending(db, { sinceId: 0, limit: 500 });
test('selectPending returns exactly the 2 t2helix ground_truth rows',
  fromZero.length === 2 && fromZero[0].id === gtA.id && fromZero[1].id === gtB.id);

test('selectPending excludes hypothesis, non-t2helix, and existing mirrors',
  !fromZero.some(r => r.content.includes('hypothesis')) &&
  !fromZero.some(r => r.domain === 'misc') &&
  !fromZero.some(r => /mirrored-from-local/.test(r.domain)));

test('selectPending honours the cursor (sinceId)',
  (() => { const r = sync.selectPending(db, { sinceId: gtA.id, limit: 500 }); return r.length === 1 && r[0].id === gtB.id; })());

test('selectPending honours limit',
  sync.selectPending(db, { sinceId: 0, limit: 1 }).length === 1);

test('maxInsightId matches highest seeded id',
  sync.maxInsightId(db) === all[all.length - 1].id);

test('provenance names the source id verbatim and the SYNCED marker',
  (() => { const p = sync.provenance(gtA); return p.includes('#' + gtA.id) && p.includes('SYNCED') && p.includes('verbatim'); })());

// ── CLI: dry-run writes no cursor and pushes nothing ─────────────────────────
function runCli(extraArgs, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath,
      [path.join(__dirname, '..', 'scripts', 'sync-stack.js'), '--data-dir', tmpDir, ...extraArgs],
      { env: { ...process.env, ...extraEnv } });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('close', code => resolve({ code, out, err }));
  });
}

(async () => {
  const cursorPath = path.join(tmpDir, '.stack_sync_cursor');

  const dry = await runCli(['--dry-run', '--backfill'], {});
  test('dry-run exits 0', dry.code === 0);
  test('dry-run reports both candidate rows', dry.out.includes('#' + gtA.id) && dry.out.includes('#' + gtB.id));
  test('dry-run pushes nothing / writes no cursor', dry.out.includes('DRY RUN') && !fs.existsSync(cursorPath));

  // ── stub stack: capture pushes, reply success ──────────────────────────────
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { received.push(JSON.parse(body)); } catch (_) { received.push({ raw: body }); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: '⟁ Insight recorded [ground_truth]: /stub/path.jsonl' }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const STACK_URL = `http://127.0.0.1:${port}/api/call`;

  // ── real backfill against the stub ─────────────────────────────────────────
  const run1 = await runCli(['--backfill'], { STACK_URL, BRIDGE_TOKEN: 'stub-token' });
  test('backfill exits 0', run1.code === 0);
  test('backfill pushed exactly the 2 ground_truth t2helix rows', received.length === 2);

  const okShape = received.every(b =>
    b.tool === 'record_insight' &&
    b.arguments.layer === 'ground_truth' &&
    /,mirrored-from-local$/.test(b.arguments.domain) &&
    b.arguments.content.includes('SYNCED'));
  test('pushed payloads carry mirror domain + provenance + ground_truth', okShape);

  const verbatim = received.some(b => b.arguments.content.includes('BUILD A — t2helix dogfood ground truth one'));
  test('pushed content preserves the original text verbatim', verbatim);

  const noToken = received.every(b => JSON.stringify(b).indexOf('stub-token') === -1);
  test('token never appears inside the pushed payload', noToken);

  test('cursor advanced to the last pushed id',
    fs.existsSync(cursorPath) && parseInt(fs.readFileSync(cursorPath, 'utf8'), 10) === gtB.id);

  // ── idempotency: a second run with the cursor set pushes nothing ───────────
  const before = received.length;
  const run2 = await runCli([], { STACK_URL, BRIDGE_TOKEN: 'stub-token' });
  test('second run exits 0', run2.code === 0);
  test('second run is a no-op (cursor in step)', received.length === before && /Nothing to sync/.test(run2.out));

  server.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
