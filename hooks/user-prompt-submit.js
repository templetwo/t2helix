#!/usr/bin/env node
'use strict';

const { recall, getGoal, writeCurrentSession } = require('../lib/chronicle');
const { readStdin } = require('../lib/hook-io');
const { selectInjection, buildContext } = require('../lib/surface');

async function main() {
  let input;
  try {
    const raw = await readStdin();
    input = raw ? JSON.parse(raw) : {};
  } catch {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  const session_id = input.session_id || 'unknown';
  const prompt = (input.prompt || '').slice(0, 4000);

  // Write current session_id to a state file so the MCP server (which doesn't
  // receive session_id per-call) can use the same signature as the hooks.
  if (session_id && session_id !== 'unknown') {
    writeCurrentSession(session_id);
  }

  let ctx = '';
  try {
    const goal = getGoal(session_id);
    // v0.3: targeted method + de-noised, gated, capped generic recall (cardinal
    // rule — total injection goes down). selectInjection guards each lookup.
    const { method, hits } = selectInjection({ goal, prompt, recall });
    if ((goal && goal.goal) || method || (hits && hits.length)) {
      ctx = buildContext({ goal, method, hits });
    }
  } catch (e) {
    process.stdout.write(JSON.stringify({ systemMessage: `t2helix recall failed: ${e.message}` }));
    process.exit(0);
  }

  if (!ctx) {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: ctx
    }
  }));
  process.exit(0);
}

main().catch(() => {
  // Last-resort fail-open: an unexpected throw must never break the host.
  try { process.stdout.write(JSON.stringify({})); } catch (_) {}
  process.exit(0);
});
