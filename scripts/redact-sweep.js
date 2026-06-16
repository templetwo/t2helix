#!/usr/bin/env node
'use strict';

// One-shot, per-machine scrub of credentials already at rest in the chronicle.
// Redaction-on-write (v0.2) only protects NEW writes; rows written before the fix
// still hold secrets in cleartext (insights.content, compass_log.action_summary /
// reason, pending_confirmations.action_summary / reason). This sweep rewrites
// those rows through the same scrubber the write path uses.
//
// Usage:
//   T2HELIX_DATA_DIR=<dir> npm run redact-sweep   # scrub that chronicle
//   npm run redact-sweep -- --data-dir <dir>      # same, via flag
//   npm run redact-sweep -- --dry-run             # report only, write nothing
//
// data-dir resolution: run with NO explicit dir, the chronicle falls back to
// ~/.t2helix-data — almost never the live Claude Code plugin chronicle. A real
// (non-dry) run therefore REFUSES to proceed without an explicit --data-dir or
// T2HELIX_DATA_DIR, so an operator can't silently scrub the wrong (empty) db and
// conclude they're clean. The live plugin chronicle is typically:
//   ~/.claude/plugins/data/t2helix-<marketplace>/   (e.g. t2helix-templetwo-t2helix)

const fs = require('fs');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
// Capture whether the operator pointed us somewhere explicitly BEFORE we mutate
// the env, so we can refuse a bare destructive run against the fallback dir.
const hadEnvDir = !!(process.env.T2HELIX_DATA_DIR || process.env.CLAUDE_PLUGIN_DATA);
const dataDirFlagIdx = argv.indexOf('--data-dir');
const hadFlagDir = dataDirFlagIdx !== -1 && !!argv[dataDirFlagIdx + 1];
if (hadFlagDir) process.env.T2HELIX_DATA_DIR = argv[dataDirFlagIdx + 1];
const EXPLICIT_DIR = hadEnvDir || hadFlagDir;

const ch = require('../lib/chronicle');
const { scrub, redactSecrets } = require('../lib/secrets');

// A residual leak is a row the REDACTOR can still mask — not merely one the
// (looser) detector flags. A fully-scrubbed `AWS_SECRET_ACCESS_KEY=[REDACTED:…]`
// still trips the detector (key name) but has nothing left to mask, so it is NOT
// a leak. Gating on redactSecrets(x) !== x avoids the v0.2.0 sweep's mislabeling.
function hasResidual(text) {
  return text != null && redactSecrets(text) !== text;
}

async function main() {
  const dir = ch.dataDir();
  const dbFile = ch.dbPath();
  console.log(`T2Helix redact-sweep ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log(`  data dir : ${dir}`);
  console.log(`  database : ${dbFile}`);

  if (!DRY_RUN && !EXPLICIT_DIR) {
    console.error('\n  REFUSING to scrub: no explicit data dir.');
    console.error('  A bare run resolves to the standalone fallback, which is almost never the live');
    console.error('  Claude Code plugin chronicle. Re-run with the chronicle you mean, e.g.:');
    console.error('    T2HELIX_DATA_DIR="$HOME/.claude/plugins/data/t2helix-templetwo-t2helix" npm run redact-sweep');
    console.error('  (or add --dry-run to preview this path read-only).');
    process.exitCode = 2;
    return;
  }
  if (!fs.existsSync(dbFile)) {
    console.log('  (no chronicle.db at this path — nothing to do)');
    return;
  }

  const db = ch.db();

  if (!DRY_RUN) {
    // Consistent online snapshot — correct under WAL and concurrent connections,
    // unlike a checkpoint+copy (which silently produced a corrupt/incomplete
    // backup when another connection held a read snapshot). better-sqlite3's
    // backup() returns a promise that resolves when the copy is complete.
    const backup = `${dbFile}.bak-${Date.now()}`;
    await db.backup(backup);
    console.log(`  backup   : ${backup}`);
  }

  const counts = {};
  function sweepColumns(table, idCol, cols) {
    const sel = db.prepare(`SELECT ${idCol}, ${cols.join(', ')} FROM ${table}`);
    const setExpr = cols.map(c => `${c} = ?`).join(', ');
    const upd = db.prepare(`UPDATE ${table} SET ${setExpr} WHERE ${idCol} = ?`);
    let scanned = 0, changed = 0;
    const run = db.transaction(rows => {
      for (const row of rows) {
        scanned++;
        const next = cols.map(c => scrub(row[c]));
        if (cols.some((c, i) => next[i] !== row[c])) {
          changed++;
          if (!DRY_RUN) upd.run(...next, row[idCol]);
        }
      }
    });
    run(sel.all());
    counts[table] = { scanned, changed };
    console.log(`  ${table.padEnd(22)}: scanned ${scanned}, ${DRY_RUN ? 'would redact' : 'redacted'} ${changed}`);
  }

  sweepColumns('insights', 'id', ['content']);
  sweepColumns('compass_log', 'id', ['action_summary', 'reason']);
  sweepColumns('pending_confirmations', 'id', ['action_summary', 'reason']);

  if (!DRY_RUN) {
    const residual = [];
    for (const r of db.prepare('SELECT id, content FROM insights').all()) {
      if (hasResidual(r.content)) residual.push(`insight #${r.id}`);
    }
    for (const r of db.prepare('SELECT id, action_summary, reason FROM compass_log').all()) {
      if (hasResidual(r.action_summary) || hasResidual(r.reason)) residual.push(`compass #${r.id}`);
    }
    for (const r of db.prepare('SELECT id, action_summary, reason FROM pending_confirmations').all()) {
      if (hasResidual(r.action_summary) || hasResidual(r.reason)) residual.push(`pending #${r.id}`);
    }
    if (residual.length) {
      console.log(`  WARNING  : ${residual.length} row(s) still hold a maskable secret after the sweep — inspect:`);
      for (const id of residual.slice(0, 20)) console.log(`             ${id}`);
    } else {
      console.log('  verify   : OK — no row holds a maskable secret.');
    }
  }

  ch.close();
}

main().catch(e => {
  console.error(`redact-sweep failed: ${e.message}`);
  process.exit(1);
});
