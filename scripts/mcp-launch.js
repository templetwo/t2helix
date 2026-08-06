#!/usr/bin/env node
'use strict';

/**
 * MCP entrypoint that refuses the false-green Node ABI trap.
 *
 * Clients often configure `command: node` (PATH). That binary may not match
 * the better-sqlite3 ABI in this install. This launcher:
 *   1. Probes the current process for a real :memory: open
 *   2. If OK, re-spawns mcp/server.js under the same execPath
 *   3. If not, searches stamp + well-known nodes for a compatible binary
 *   4. Re-execs under that binary, or exits 1 with rebuild instructions
 *
 * Usage (stdio or SSE args pass through):
 *   node scripts/mcp-launch.js
 *   node scripts/mcp-launch.js --transport sse --port 3742
 */

const { spawn } = require('child_process');
const path = require('path');
const native = require('../lib/native-binding');

const ROOT = native.packageRoot();
const SERVER = path.join(ROOT, 'mcp', 'server.js');
const passthrough = process.argv.slice(2);

function die(msg) {
  process.stderr.write(`[t2helix-mcp-launch] ${msg}\n`);
  process.exit(1);
}

function run(nodePath) {
  const child = spawn(nodePath, [SERVER, ...passthrough], {
    stdio: 'inherit',
    env: process.env,
    cwd: ROOT
  });
  child.on('error', (err) => die(`failed to spawn ${nodePath}: ${err.message}`));
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code == null ? 1 : code);
  });
}

// 1. Current node can load the binding — use it (pin absolute execPath).
if (native.probeBinding().ok) {
  run(process.execPath);
} else {
  // 2. Find another binary that can.
  const alt = native.findCompatibleNode(ROOT);
  if (alt) {
    process.stderr.write(
      `[t2helix-mcp-launch] current node ABI mismatch (${process.execPath}); ` +
        `re-exec under ${alt}\n`
    );
    run(alt);
  } else {
    die(
      `no compatible Node found for better-sqlite3.\n` +
        `  ${native.remedyText()}\n` +
        `  After rebuild, re-point clients at: node ${SERVER}\n` +
        `  or keep using this launcher so PATH drift self-heals.`
    );
  }
}
