#!/usr/bin/env node
'use strict';

// scripts/import-atlas.js — load a curated error-resolution atlas (JSONL of
// {pattern, resolution}) into the chronicle as domain:'error-fix' ground_truth
// insights, via the normal record() write path so secrets.scrub() and the
// insights_fts mirror fire automatically. Idempotent: re-running skips entries
// already loaded (fingerprint match), so a partial/interrupted run is safe to
// repeat. Append-only and non-destructive — no existing row is rewritten, hence
// no backup step (unlike redact-sweep).
//
// Usage:
//   node scripts/import-atlas.js --file <atlas.jsonl> --data-dir <dir>
//   node scripts/import-atlas.js --file <atlas.jsonl> --dry-run    # preview, write nothing
//   T2HELIX_DATA_DIR=<dir> node scripts/import-atlas.js --file <atlas.jsonl>
//
// data-dir resolution mirrors redact-sweep: a real (non-dry) run REFUSES to
// proceed without an explicit --data-dir / T2HELIX_DATA_DIR / CLAUDE_PLUGIN_DATA,
// so the atlas can't be silently loaded into the standalone ~/.t2helix-data
// fallback instead of the live plugin chronicle, typically:
//   ~/.claude/plugins/data/t2helix-templetwo-t2helix/

const fs = require('fs');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
function argValue(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : null;
}

const fileArg = argValue('--file');
// Capture whether the operator pointed us somewhere explicitly BEFORE mutating
// the env (same ordering as redact-sweep), so we can refuse a bare run against
// the fallback dir.
const hadEnvDir = !!(process.env.T2HELIX_DATA_DIR || process.env.CLAUDE_PLUGIN_DATA);
const dirFlag = argValue('--data-dir');
if (dirFlag) process.env.T2HELIX_DATA_DIR = dirFlag;
const EXPLICIT_DIR = hadEnvDir || !!dirFlag;

const ch = require('../lib/chronicle');
const atlas = require('../lib/atlas');

function main() {
  if (!fileArg) {
    console.error('import-atlas: --file <atlas.jsonl> is required');
    process.exitCode = 2;
    return;
  }
  if (!fs.existsSync(fileArg)) {
    console.error(`import-atlas: file not found: ${fileArg}`);
    process.exitCode = 2;
    return;
  }

  console.log(`T2Helix import-atlas ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log(`  source   : ${fileArg}`);
  console.log(`  data dir : ${ch.dataDir()}`);
  console.log(`  database : ${ch.dbPath()}`);

  if (!DRY_RUN && !EXPLICIT_DIR) {
    console.error('\n  REFUSING to import: no explicit data dir.');
    console.error('  A bare run resolves to the standalone fallback (~/.t2helix-data), almost never');
    console.error('  the live plugin chronicle. Re-run with the chronicle you mean, e.g.:');
    console.error('    node scripts/import-atlas.js --file <atlas.jsonl> \\');
    console.error('      --data-dir "$HOME/.claude/plugins/data/t2helix-templetwo-t2helix"');
    console.error('  (or add --dry-run to preview this path read-only).');
    process.exitCode = 2;
    return;
  }

  const text = fs.readFileSync(fileArg, 'utf8');
  const { records, errors } = atlas.parseAtlas(text);
  if (errors.length) {
    console.log(`  parse    : ${records.length} valid, ${errors.length} skipped (malformed):`);
    for (const e of errors.slice(0, 10)) console.log(`             line ${e.line}: ${e.reason}`);
    if (errors.length > 10) console.log(`             … and ${errors.length - 10} more`);
  } else {
    console.log(`  parse    : ${records.length} valid entries, 0 malformed`);
  }
  if (!records.length) {
    console.log('  (nothing to import)');
    // A file that parsed to ZERO valid records but DID have malformed lines is a
    // failed run, not a no-op — exit non-zero so it isn't mistaken for success.
    if (errors.length) process.exitCode = 1;
    return;
  }

  const { counts, dropped, conflicts } = atlas.importAtlas({ ch, records, dryRun: DRY_RUN });
  const verb = DRY_RUN ? 'would insert' : 'inserted';
  console.log(`  ${verb.padEnd(12)}: ${counts.inserted}`);
  console.log(`  ${'skipped'.padEnd(12)}: ${counts.skipped} (already present)`);
  if (counts.dropped) {
    // Print ONLY the fingerprint. A row drops when scrub throws OR record() throws
    // (e.g. content over the 100KB cap), so its raw text may contain the secret or
    // the oversized payload that tripped the drop — echoing the pattern here would
    // leak to stdout/logs the very thing the DB-drop just isolated. The fp is enough
    // to locate the offending line in the source file.
    console.log(`  ${'dropped'.padEnd(12)}: ${counts.dropped} (NOT persisted — scrub or record() threw; fingerprints only):`);
    for (const d of dropped.slice(0, 10)) console.log(`             ${d.fp}`);
  }

  if (conflicts && conflicts.length) {
    // Surfaced, not buried: the atlas asserts >1 distinct resolution for the same
    // error pattern. Both rows still loaded (append-only — an error can carry more
    // than one valid fix); this WARNS so a divergence is a deliberate curation call,
    // not a silent one. Goes to stderr (visible even when stdout is captured) and
    // does NOT change the exit code — nothing failed to load. Prints the pattern
    // (public error signature) truncated + the fingerprints; never the resolution
    // text, which is the secret-bearing field.
    console.error(`  conflicts   : ${conflicts.length} pattern(s) with DIVERGENT resolutions (all kept — review):`);
    for (const c of conflicts.slice(0, 10)) {
      const p = c.pattern.length > 80 ? c.pattern.slice(0, 79) + '…' : c.pattern;
      console.error(`             ${c.count}× "${p}"  [${c.fps.join(', ')}]`);
    }
    if (conflicts.length > 10) console.error(`             … and ${conflicts.length - 10} more`);
  }

  if (!DRY_RUN) {
    const total = ch.db().prepare(`SELECT count(*) AS n FROM insights WHERE domain = ?`).get(atlas.ATLAS_DOMAIN).n;
    console.log(`  verify   : ${total} error-fix insight(s) now in the chronicle`);
  }
  ch.close();

  // Honest exit code (review findings 1 + 3): 0 ONLY on a fully clean run. A
  // malformed parse line OR a scrub-dropped row means a PARTIAL load — the valid
  // subset still landed (useful, idempotent re-run fills the rest), but an
  // operator/CI must be able to tell from $? that not everything made it in.
  // Consistent with the project's "make dropped writes visible" ethos.
  if (errors.length || counts.dropped) {
    console.error(
      `  INCOMPLETE: ${errors.length} malformed line(s), ${counts.dropped} dropped row(s) — partial load. Exit 1.`
    );
    process.exitCode = 1;
  }
}

try {
  main();
} catch (e) {
  console.error(`import-atlas failed: ${e.message}`);
  if (e && e.code === 'T2HELIX_DRIVER_UNAVAILABLE') {
    console.error('Run `npm run rebuild` to fix the native binding, then re-run (idempotent).');
  }
  process.exit(1);
}
