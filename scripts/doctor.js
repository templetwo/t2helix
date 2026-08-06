#!/usr/bin/env node
'use strict';

// Active health probe: checks the native binding (real :memory: open), DB
// connection, schema, and ABI stamp. Exits 0 when GREEN, non-zero when DEGRADED.
//
// Usage:
//   npm run doctor                              # check the active data dir
//   T2HELIX_DATA_DIR=<dir> npm run doctor       # check a specific chronicle

const native = require('../lib/native-binding');
const { health } = require('../lib/chronicle');

const r = health();

function badge(ok) { return ok ? '  GREEN  ' : ' DEGRADED'; }

console.log('T2Helix Doctor');
console.log('');
console.log(`  Node:      ${r.node_version}  (ABI ${r.node_abi || '?'})`);
console.log(`  Exec:      ${r.exec_path || process.execPath}`);
console.log(`  Data dir:  ${r.data_dir}`);
console.log(`  DB path:   ${r.db_path}`);
if (r.stamp) {
  console.log(
    `  Stamp:     ABI ${r.stamp.modules} · ${r.stamp.node || '?'} · ${r.stamp.execPath || '?'}` +
      (r.abi_match === false ? '  ⚠ ABI mismatch vs current node' : '')
  );
} else {
  console.log(`  Stamp:     (none — run npm run rebuild to write ${native.STAMP_NAME})`);
}
console.log('');
console.log(`  [${badge(r.driver_ok)}]  Native binding (better-sqlite3 :memory: open)`);
console.log(`  [${badge(r.db_ok)}]  Chronicle DB connection`);
console.log(`  [${badge(r.schema_ok)}]  Schema (recall / audit tables)`);
console.log('');

if (r.degraded) {
  console.log('STATUS: DEGRADED — recall, coupling, and audit logging unavailable.');
  if (r.hint) {
    console.log(`Remedy: ${r.hint}`);
  }
  // If current is bad but another node would work, say so.
  if (!r.driver_ok) {
    const alt = native.findCompatibleNode();
    if (alt && alt !== process.execPath) {
      console.log(`Compatible node found: ${alt}`);
      console.log('Point MCP clients at: node scripts/mcp-launch.js  (auto re-exec)');
      console.log(`Or pin command to: ${alt}`);
    }
  }
  process.exit(1);
} else {
  console.log('STATUS: GREEN — all systems operational.');
  process.exit(0);
}
