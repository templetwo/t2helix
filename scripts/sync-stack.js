#!/usr/bin/env node
'use strict';

// scripts/sync-stack.js — push new local ground_truth t2helix insights to the
// shared Sovereign Stack so the two chronicles stop drifting.
//
// WHY THIS EXISTS: a Claude Code session actively BUILDING t2helix reaches for
// the in-process `record` MCP tool (local chronicle) and skips the Sovereign
// Stack bridge, while lineage/continuity sessions write the stack. The two
// stores drift — on 2026-06-18 seven dogfood-build entries were found local-only
// and hand-backfilled. This makes that mirroring a one-command, idempotent step.
//
// WHAT IT SYNCS: insights with layer='ground_truth' whose domain mentions
// 't2helix' (and is not already a mirror), id beyond a per-dir cursor. Each is
// re-recorded on the stack VERBATIM with a provenance header and the domain
// tagged ',mirrored-from-local' — honest that the authoring session, not this
// sync, wrote it. Originals stay in the local chronicle untouched.
//
// Usage:
//   T2HELIX_DATA_DIR=<dir> npm run sync-stack            # sync new rows
//   npm run sync-stack -- --data-dir <dir>               # same, via flag
//   npm run sync-stack -- --dry-run --data-dir <dir>     # preview, no network
//   npm run sync-stack -- --backfill --data-dir <dir>    # sync ALL (since id 0)
//   npm run sync-stack -- --since 4126 --data-dir <dir>  # sync ids > 4126
//   npm run sync-stack -- --limit 50 --data-dir <dir>    # cap rows this run
//
// Cursor: <dataDir>/.stack_sync_cursor holds the highest synced local id. FIRST
// run with no cursor (and no --backfill/--since) INITIALISES the cursor to the
// current max id and pushes nothing — so an existing chronicle isn't bulk-shoved
// onto the stack by surprise. Use --backfill once if you do want the history.
//
// Token: BRIDGE_TOKEN from the env, else parsed from ~/.config/sovereign-bridge.env
// (override with SOVEREIGN_BRIDGE_ENV). The token is never logged or written.
// Endpoint: STACK_URL env, default https://stack.templetwo.com/api/call.
//
// data-dir resolution mirrors redact-sweep: a bare (non-dry) run resolves to the
// ~/.t2helix-data fallback, almost never the live plugin chronicle, so a real
// push REFUSES without an explicit --data-dir / T2HELIX_DATA_DIR.

const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
function flag(name) { return argv.includes(name); }
function valueOf(name) { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : null; }

const DRY_RUN = flag('--dry-run');
const BACKFILL = flag('--backfill');
const SINCE_ARG = valueOf('--since');
const LIMIT = parseInt(valueOf('--limit') || '500', 10);
const STACK_URL = process.env.STACK_URL || 'https://stack.templetwo.com/api/call';

const hadEnvDir = !!(process.env.T2HELIX_DATA_DIR || process.env.CLAUDE_PLUGIN_DATA);
const dirFlag = valueOf('--data-dir');
if (dirFlag) process.env.T2HELIX_DATA_DIR = dirFlag;
const EXPLICIT_DIR = hadEnvDir || !!dirFlag;

const ch = require('../lib/chronicle');

// ── token resolution (never logged) ────────────────────────────────────────
function resolveToken() {
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN;
  const envPath = process.env.SOVEREIGN_BRIDGE_ENV ||
    path.join(os.homedir(), '.config', 'sovereign-bridge.env');
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?BRIDGE_TOKEN\s*=\s*(.+?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    }
  } catch (_) { /* no env file — handled by caller */ }
  return null;
}

// ── cursor ──────────────────────────────────────────────────────────────────
function cursorFile() { return path.join(ch.dataDir(), '.stack_sync_cursor'); }
function readCursor() {
  try { const n = parseInt(fs.readFileSync(cursorFile(), 'utf8').trim(), 10); return Number.isFinite(n) ? n : null; }
  catch (_) { return null; }
}
function writeCursor(id) { fs.writeFileSync(cursorFile(), String(id)); }

// ── selection (pure; unit-tested) ────────────────────────────────────────────
// New ground_truth t2helix insights past `sinceId`, excluding rows that are
// themselves mirrors (so a synced row never re-syncs).
function selectPending(database, { sinceId, limit }) {
  return database.prepare(`
    SELECT id, session_id, created_at, domain, content
    FROM insights
    WHERE id > ?
      AND layer = 'ground_truth'
      AND domain LIKE '%t2helix%'
      AND domain NOT LIKE '%mirrored-from-local%'
    ORDER BY id ASC
    LIMIT ?
  `).all(sinceId, limit);
}

function maxInsightId(database) {
  const row = database.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM insights').get();
  return row ? row.m : 0;
}

function iso(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return String(ms);
  return new Date(n).toISOString().slice(0, 16) + 'Z';
}

function provenance(row) {
  return '[SYNCED to the Sovereign Stack from t2helix-LOCAL chronicle #' + row.id +
    ' (orig ' + iso(row.created_at) + ') by npm run sync-stack. Authoring session: ' +
    (row.session_id || 'unknown') + '. Original author = that session, NOT the sync; ' +
    'text preserved verbatim below.]';
}

async function pushOne(token, row) {
  const resp = await fetch(STACK_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tool: 'record_insight',
      arguments: {
        domain: (row.domain || 't2helix') + ',mirrored-from-local',
        content: provenance(row) + '\n\n' + row.content,
        layer: 'ground_truth',
        session_id: row.session_id || undefined
      }
    })
  });
  const j = await resp.json().catch(() => ({}));
  return !!(j && j.ok && /Insight recorded/.test(j.result || ''));
}

async function main() {
  const dir = ch.dataDir();
  console.log(`T2Helix sync-stack ${DRY_RUN ? '(DRY RUN)' : ''}`.trim());
  console.log(`  data dir : ${dir}`);
  console.log(`  endpoint : ${STACK_URL}`);

  if (!DRY_RUN && !EXPLICIT_DIR) {
    console.error('\n  REFUSING to sync: no explicit data dir.');
    console.error('  A bare run resolves to the standalone fallback, almost never the live plugin');
    console.error('  chronicle. Re-run with the chronicle you mean, e.g.:');
    console.error('    T2HELIX_DATA_DIR="$HOME/.claude/plugins/data/t2helix-templetwo-t2helix" npm run sync-stack');
    console.error('  (or add --dry-run to preview this path read-only).');
    process.exitCode = 2;
    return;
  }

  const database = ch.db();

  // Resolve the lower bound.
  let sinceId;
  let initialising = false;
  if (SINCE_ARG != null) {
    sinceId = parseInt(SINCE_ARG, 10) || 0;
  } else if (BACKFILL) {
    sinceId = 0;
  } else {
    const cur = readCursor();
    if (cur == null) {
      // First run: pin the cursor to the current max so existing history is not
      // bulk-pushed unless --backfill is explicitly asked for.
      sinceId = maxInsightId(database);
      initialising = true;
    } else {
      sinceId = cur;
    }
  }

  const rows = selectPending(database, { sinceId, limit: LIMIT });
  console.log(`  since id : ${sinceId}${initialising ? ' (first run — initialising cursor)' : ''}`);
  console.log(`  matched  : ${rows.length} ground_truth t2helix row(s)`);

  if (initialising && rows.length === 0) {
    if (!DRY_RUN) writeCursor(sinceId);
    console.log(`\n  Initialised cursor at ${sinceId}. New entries beyond this will sync next run.`);
    console.log('  (Run once with --backfill to also push existing history.)');
    return;
  }

  if (rows.length === 0) {
    console.log('\n  Nothing to sync — both chronicles are in step.');
    return;
  }

  if (DRY_RUN) {
    console.log('\n  Would push:');
    for (const r of rows) {
      console.log(`    #${r.id} [${iso(r.created_at)}] (${r.domain}) ${r.content.replace(/\s+/g, ' ').slice(0, 78)}…`);
    }
    console.log(`\n  DRY RUN — nothing pushed, cursor unchanged (would advance to ${rows[rows.length - 1].id}).`);
    return;
  }

  const token = resolveToken();
  if (!token) {
    console.error('\n  No BRIDGE_TOKEN found (env or ~/.config/sovereign-bridge.env). Cannot reach the stack.');
    process.exitCode = 2;
    return;
  }

  // Push in ascending id order; advance the cursor only across a contiguous run
  // of successes, so a mid-list failure (egress/stack down) is retried next run
  // and nothing is skipped.
  let lastOk = sinceId;
  let pushed = 0;
  for (const r of rows) {
    let ok = false;
    try { ok = await pushOne(token, r); }
    catch (e) { console.error(`  XX #${r.id} ${e.message}`); }
    if (!ok) {
      console.error(`  XX #${r.id} push failed — stopping; will retry from here next run.`);
      break;
    }
    console.log(`  OK #${r.id} mirrored`);
    lastOk = r.id;
    pushed++;
  }

  if (lastOk > sinceId) writeCursor(lastOk);
  console.log(`\n  Pushed ${pushed}/${rows.length}. Cursor now at ${lastOk}.`);
  if (pushed < rows.length) process.exitCode = 1;
}

// Export the pure bits for unit testing; run main() only as a CLI.
module.exports = { selectPending, maxInsightId, provenance, iso };

if (require.main === module) {
  main().catch((e) => { console.error('sync-stack failed:', e.message); process.exitCode = 1; });
}
