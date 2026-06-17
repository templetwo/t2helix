#!/usr/bin/env node
'use strict';

// scripts/export.js — export a portable T2Helix manifest.
//
// Usage:
//   node scripts/export.js [--out <file>] [--snapshot]
//
// --out <file>  Write JSON manifest to <file> (default: t2helix-manifest.json)
// --snapshot    Also write a consistent DB snapshot to <file>.snapshot.db
//
// The manifest contains:
//   manifest_version, t2helix_version, created_at,
//   rules (loaded compass rule set), promoted_methods, audit_schema_version
//
// Requires T2HELIX_DATA_DIR or CLAUDE_PLUGIN_DATA to point at the live data dir.

const path = require('path');
const fs = require('fs');
const { buildManifest } = require('../lib/manifest');
const ch = require('../lib/chronicle');

const argv = process.argv.slice(2);
function argValue(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : null;
}

const outFile = argValue('--out') || 't2helix-manifest.json';
const doSnapshot = argv.includes('--snapshot');

try {
  const manifest = buildManifest();
  const json = JSON.stringify(manifest, null, 2);
  fs.writeFileSync(outFile, json, 'utf8');
  process.stdout.write(`manifest written → ${outFile}\n`);
  process.stdout.write(`  ${manifest.rules.length} rules, ${manifest.promoted_methods.length} promoted methods\n`);
  process.stdout.write(`  t2helix ${manifest.t2helix_version}, manifest_version ${manifest.manifest_version}\n`);

  if (doSnapshot) {
    const snapshotFile = outFile + '.snapshot.db';
    // db.backup() writes a consistent snapshot (WAL-safe, no mid-write corruption).
    ch.db().backup(snapshotFile)
      .then(() => process.stdout.write(`snapshot written → ${snapshotFile}\n`))
      .catch(e => {
        process.stderr.write(`snapshot failed: ${e.message}\n`);
        process.exit(1);
      });
  }
} catch (e) {
  process.stderr.write(`export failed: ${e.message}\n`);
  if (e.code === 'T2HELIX_DRIVER_UNAVAILABLE') {
    process.stderr.write('Run `npm run rebuild` to fix the native binding.\n');
  }
  process.exit(1);
}
