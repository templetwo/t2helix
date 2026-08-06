#!/usr/bin/env node
'use strict';

/**
 * Claude Code hook entrypoint that survives Node ABI drift.
 *
 * hooks.json uses bare `node` on PATH. Claude's PATH may be Node 20 while the
 * better-sqlite3 binding was built for Node 22 (or vice versa). This launcher
 * is pure JS (no native deps), finds a Node that can open better-sqlite3, and
 * re-execs the real hook script under it.
 *
 * Usage (hooks.json):
 *   node ${CLAUDE_PLUGIN_ROOT}/scripts/hook-launch.js user-prompt-submit.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const native = require('../lib/native-binding');

const ROOT = native.packageRoot();
const hookName = process.argv[2];
if (!hookName) {
  process.stderr.write('[t2helix-hook-launch] usage: hook-launch.js <hook-file.js>\n');
  process.exit(1);
}

const hookPath = path.isAbsolute(hookName)
  ? hookName
  : path.join(ROOT, 'hooks', path.basename(hookName));

if (!fs.existsSync(hookPath)) {
  process.stderr.write(`[t2helix-hook-launch] hook not found: ${hookPath}\n`);
  process.exit(1);
}

const passthrough = process.argv.slice(3);

function run(nodePath) {
  const child = spawn(nodePath, [hookPath, ...passthrough], {
    stdio: 'inherit',
    env: process.env,
    cwd: ROOT
  });
  child.on('error', (err) => {
    process.stderr.write(`[t2helix-hook-launch] spawn failed: ${err.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      try { process.kill(process.pid, signal); } catch { /* ignore */ }
    }
    process.exit(code == null ? 1 : code);
  });
}

if (native.probeBinding().ok) {
  run(process.execPath);
} else {
  const alt = native.findCompatibleNode(ROOT);
  if (alt) {
    process.stderr.write(
      `[t2helix-hook-launch] ABI mismatch under ${process.execPath}; re-exec ${path.basename(hookPath)} via ${alt}\n`
    );
    run(alt);
  } else {
    // Fail-open for hooks: print once-style message and exit 0 so Claude is not blocked.
    process.stderr.write(
      `[t2helix] hook DEGRADED — better-sqlite3 unavailable under any known Node.\n` +
        `  ${native.remedyText()}\n`
    );
    // Empty JSON on stdout for hooks that expect {}
    try { process.stdout.write('{}\n'); } catch { /* ignore */ }
    process.exit(0);
  }
}
