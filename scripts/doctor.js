#!/usr/bin/env node
'use strict';

// Active health probe: checks the native binding, DB connection, and schema.
// Exits 0 when everything is GREEN, non-zero when any subsystem is DEGRADED.
//
// Usage:
//   npm run doctor                              # check the active data dir
//   T2HELIX_DATA_DIR=<dir> npm run doctor       # check a specific chronicle

const { health } = require('../lib/chronicle');

const r = health();

function badge(ok) { return ok ? '  GREEN  ' : ' DEGRADED'; }

console.log('T2Helix Doctor');
console.log('');
console.log(`  Node:      ${r.node_version}`);
console.log(`  Data dir:  ${r.data_dir}`);
console.log(`  DB path:   ${r.db_path}`);
console.log('');
console.log(`  [${badge(r.driver_ok)}]  Native binding (better-sqlite3)`);
console.log(`  [${badge(r.db_ok)}]  Chronicle DB connection`);
console.log(`  [${badge(r.schema_ok)}]  Schema (recall / audit tables)`);
console.log('');

if (r.degraded) {
  console.log('STATUS: DEGRADED — recall, coupling, and audit logging unavailable.');
  if (r.hint) {
    console.log(`Remedy: ${r.hint}`);
  }
  process.exit(1);
} else {
  console.log('STATUS: GREEN — all systems operational.');
  process.exit(0);
}
