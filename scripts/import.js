#!/usr/bin/env node
'use strict';

// scripts/import.js — import promoted methods from a T2Helix manifest.
//
// Usage:
//   node scripts/import.js <manifest.json> [--dry-run]
//
// Reads a manifest produced by `node scripts/export.js` and imports its
// promoted_methods into the current T2HELIX_DATA_DIR chronicle.
// Methods whose content already exists are skipped (content-equality dedup).
//
// --dry-run  Report what would be imported/skipped without writing.

const fs = require('fs');
const { importManifest } = require('../lib/manifest');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const manifestFile = argv.find(a => !a.startsWith('--'));

if (!manifestFile) {
  process.stderr.write('Usage: node scripts/import.js <manifest.json> [--dry-run]\n');
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
} catch (e) {
  process.stderr.write(`Could not read manifest: ${e.message}\n`);
  process.exit(1);
}

try {
  const result = importManifest(manifest, { dryRun });
  const prefix = dryRun ? '[dry-run] ' : '';
  process.stdout.write(`${prefix}imported: ${result.imported}, skipped (duplicate): ${result.skipped}\n`);
  if (result.errors.length > 0) {
    process.stderr.write(`Errors during import:\n`);
    for (const e of result.errors) {
      process.stderr.write(`  method ${e.method_id}: ${e.error}\n`);
    }
    process.exit(1);
  }
  if (!dryRun) {
    process.stdout.write(`Import complete. ${result.imported} method(s) added to chronicle.\n`);
  }
} catch (e) {
  process.stderr.write(`import failed: ${e.message}\n`);
  if (e.code === 'T2HELIX_DRIVER_UNAVAILABLE') {
    process.stderr.write('Run `npm run rebuild` to fix the native binding.\n');
  }
  process.exit(1);
}
