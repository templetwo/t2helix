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
    process.stderr.write(
      `[t2helix] hook DEGRADED — better-sqlite3 unavailable under any known Node.\n` +
        `  ${native.remedyText()}\n`
    );
    const isGate = path.basename(hookPath) === 'pre-tool-use.js';
    const failOpen = process.env.T2HELIX_GATE_FAILURE_MODE === 'open';
    if (isGate && !failOpen) {
      // The compass cannot run at all in this state. Emitting {} here would be
      // the exact NOT_EVALUATED-reported-as-OPEN class 0.13.0 closed, reachable
      // by breaking the native binding. Deny, same contract as pre-tool-use.js.
      try {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              '[t2helix:gate-driver-unavailable] T2Helix Compass - NOT EVALUATED\n' +
              'Why: better-sqlite3 has no compatible Node on this machine, so the compass ' +
              'could not run and cannot clear this call.\n' +
              `Next: ${native.remedyText()} — or the operator can set ` +
              'T2HELIX_GATE_FAILURE_MODE=open to let unevaluated calls through.'
          }
        }) + '\n');
      } catch { /* ignore */ }
      process.exit(0);
    }
    // Observational hooks fail open so Claude is not blocked.
    try { process.stdout.write('{}\n'); } catch { /* ignore */ }
    process.exit(0);
  }
}
