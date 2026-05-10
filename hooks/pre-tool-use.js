#!/usr/bin/env node
'use strict';

const { classify, summarizeAction } = require('../lib/compass');
const { logCompass, getGoal } = require('../lib/chronicle');

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
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

  const session_id = input.session_id || null;
  const tool_name = input.tool_name || '';
  const tool_input = input.tool_input || {};

  let result;
  try {
    const goal = session_id ? getGoal(session_id) : null;
    result = classify({ tool_name, tool_input }, { has_goal: !!goal });
  } catch (e) {
    process.stdout.write(JSON.stringify({ systemMessage: `t2helix compass error: ${e.message}` }));
    process.exit(0);
  }

  try {
    logCompass({
      session_id,
      tool_name,
      action_summary: summarizeAction({ tool_name, tool_input }),
      classification: result.classification,
      rule_matched: result.rule_id,
      reason: result.reason
    });
  } catch (_) {}

  if (result.classification === 'OPEN') {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  const decision = result.classification === 'WITNESS' ? 'deny' : 'ask';
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: `[t2helix:${result.rule_id}] ${result.reason}`
    }
  }));
  process.exit(0);
}

main();
