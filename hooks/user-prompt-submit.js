#!/usr/bin/env node
'use strict';

const { recall, getGoal, writeCurrentSession } = require('../lib/chronicle');
const { readStdin } = require('../lib/hook-io');

function buildContext({ goal, hits }) {
  const lines = ['## T2Helix recall'];
  if (goal && goal.goal) {
    lines.push(`**Current goal:** ${goal.goal}`);
    if (goal.why) lines.push(`_Why:_ ${goal.why}`);
  } else {
    lines.push('_No session goal set. Set one with mcp__t2helix__set_goal to anchor the work._');
  }
  if (hits && hits.length) {
    lines.push('', '**Related from chronicle:**');
    for (const h of hits) {
      const tag = h.domain ? ` [${h.domain}]` : '';
      const layer = h.layer && h.layer !== 'hypothesis' ? ` (${h.layer})` : '';
      const snippet = h.content.length > 240 ? h.content.slice(0, 240) + '…' : h.content;
      lines.push(`- _#${h.id}${tag}${layer}_ ${snippet}`);
    }
  }
  return lines.join('\n');
}

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
    const hits = recall({ query: prompt, topK: 5 });
    if (goal || (hits && hits.length)) {
      ctx = buildContext({ goal, hits });
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
