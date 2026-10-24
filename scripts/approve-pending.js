#!/usr/bin/env node
'use strict';

// Approve a pending PAUSE confirmation from a terminal: the human path. The
// approval is recorded with origin 'cli', which T2HELIX_REQUIRE_HUMAN_CONFIRM
// does not refuse (it refuses only 'mcp', the model-facing surface).
//
// Usage, from the plugin root or a clone, naming the chronicle the hooks write:
//   T2HELIX_DATA_DIR="$HOME/.claude/plugins/data/t2helix-<marketplace>" node scripts/approve-pending.js --list
//   T2HELIX_DATA_DIR="$HOME/.claude/plugins/data/t2helix-<marketplace>" node scripts/approve-pending.js <token>
//
// --list prints each pending request's id, action summary, rule, token and
// expiry. <token> approves that request; retry the gated action before it
// expires (10 minutes after the deny). Every result is one JSON object on stdout
// that names the chronicle it used. Exit 0: listed, or approved. Exit 1: not
// approved (unknown, used or expired token; no argument). Exit 2: refused before
// any store was opened, because neither T2HELIX_DATA_DIR nor CLAUDE_PLUGIN_DATA
// is set (a bare run resolves to the standalone fallback ~/.t2helix-data, almost
// never the store the hooks write; scripts/import-atlas.js refuses it the same
// way), or because the named directory holds no chronicle.db.
//
// Hooks do not run in a human's own terminal. Inside an agent session the
// bundled approve-pending-script WITNESS rule denies a shell command that RUNS
// this script (node/nodejs/bun/deno on it, or executing it directly, in command
// position) wherever the PreToolUse hook runs; a command that only mentions the
// file (git add, git log, a commit message) is not denied. That is a speed bump,
// not a wall: an
// agent that can write files or the store has other ways to approve (README).

const fs = require('fs');

const arg = process.argv[2];
const LIST = arg === '--list';
// Read before ../lib/chronicle resolves its data dir, as scripts/import-atlas.js
// does, so a bare run is refused instead of served from the fallback.
const EXPLICIT_DIR = !!(process.env.T2HELIX_DATA_DIR || process.env.CLAUDE_PLUGIN_DATA);

const ch = require('../lib/chronicle');
const chronicle = ch.dbPath();
const EXPLICIT_FORM = 'T2HELIX_DATA_DIR="$HOME/.claude/plugins/data/t2helix-<marketplace>" node scripts/approve-pending.js';

function finish(result, code) {
  console.log(JSON.stringify({ ...result, chronicle }, null, 2));
  process.exitCode = code;
}

function main() {
  if (!EXPLICIT_DIR) {
    finish({
      ok: false,
      error: `refused: neither T2HELIX_DATA_DIR nor CLAUDE_PLUGIN_DATA is set, so this run would use the standalone fallback, not the chronicle the hooks write. Name it: ${EXPLICIT_FORM} --list (or <token>)`
    }, 2);
    return;
  }
  if (!arg || (arg.startsWith('-') && !LIST)) {
    finish({ ok: false, error: `usage: ${EXPLICIT_FORM} --list | <token>` }, 1);
    return;
  }
  if (!fs.existsSync(chronicle)) {
    finish({
      ok: false,
      error: `refused: no chronicle.db in ${ch.dataDir()}; check the directory name (an approval attempt does not create a store)`
    }, 2);
    return;
  }
  if (LIST) {
    const now = Date.now();
    const pending = ch.listPendingConfirmations({ limit: 500 })
      .filter(r => r.status === 'pending')
      .map(r => ({
        id: r.id,
        action_summary: r.action_summary,
        rule_matched: r.rule_matched,
        token: r.token,
        expires_at: new Date(r.expires_at).toISOString(),
        expires_in_s: Math.max(0, Math.round((r.expires_at - now) / 1000))
      }));
    finish({ ok: true, count: pending.length, pending }, 0);
    return;
  }
  const result = ch.approveConfirmation({ token: arg, origin: 'cli' });
  finish(result, result.ok ? 0 : 1);
}

try {
  main();
} catch (e) {
  const hint = e && e.code === 'T2HELIX_DRIVER_UNAVAILABLE' ? ' (run npm run rebuild to fix the native binding)' : '';
  finish({ ok: false, error: `approve-pending failed: ${e && e.message}${hint}` }, 1);
} finally {
  try { ch.close(); } catch (_) {}
}
