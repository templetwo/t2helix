#!/usr/bin/env node
'use strict';

const { classify, summarizeAction } = require('../lib/compass');
const {
  logCompass,
  getGoal,
  writeCurrentSession,
  findApproval,
  consumeApproval,
  createPendingConfirmation
} = require('../lib/chronicle');
const { readStdin } = require('../lib/hook-io');

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

  // Belt-and-suspenders: also write session_id here in case PreToolUse fires
  // before UserPromptSubmit (e.g., session resume scenarios).
  if (session_id) {
    writeCurrentSession(session_id);
  }

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

  const action_summary = summarizeAction({ tool_name, tool_input });

  // PAUSE override flow: if Claude (or user) already approved this exact action
  // for this session_id, consume the approval and let the tool through.
  if (result.classification === 'PAUSE' && session_id) {
    try {
      const approval = findApproval({ session_id, action_summary });
      if (approval) {
        consumeApproval(approval.id);
        // Re-log as OPEN with a marker so the compass history reflects what happened.
        try {
          logCompass({
            session_id,
            tool_name,
            action_summary,
            classification: 'OPEN',
            rule_matched: result.rule_id,
            reason: `approved via token ${approval.token} (consumed)`
          });
        } catch (_) {}
        process.stdout.write(JSON.stringify({}));
        process.exit(0);
      }
    } catch (_) {}
  }

  // No approval (or WITNESS): deny. For PAUSE, mint a pending confirmation token
  // so Claude has a clear override path. For WITNESS, no override — hard deny.
  let extraMsg = '';
  if (result.classification === 'PAUSE' && session_id) {
    try {
      const pending = createPendingConfirmation({
        session_id,
        action_summary,
        rule_matched: result.rule_id,
        reason: result.reason
      });
      extraMsg = ` To approve this specific action, call mcp__t2helix__confirm_pending with token="${pending.token}" then retry. Single-use, expires in 10 minutes.`;
    } catch (_) {}
  }

  const softPrefix = result.classification === 'PAUSE' ? '[soft-deny] ' : '';
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[t2helix:${result.rule_id}] ${softPrefix}${result.reason}${extraMsg}`
    }
  }));
  process.exit(0);
}

main();
