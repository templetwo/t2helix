#!/usr/bin/env node
'use strict';

const { classify, summarizeAction } = require('../lib/compass');
const {
  logCompass,
  getGoal,
  writeCurrentSession,
  findApproval,
  consumeApproval,
  createPendingConfirmation,
  recall,
  recordCompassFire,
  emitDegradedWarning
} = require('../lib/chronicle');
const { readStdin } = require('../lib/hook-io');
const { escalateByMemory } = require('../lib/coupling');

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
    // Resolve has_goal best-effort. classify() itself reads only the rules file
    // (no DB), so a broken/missing native binding must NOT disable rules-based
    // gating — the headline safety feature (deny rm -rf / force-push / drop
    // table) survives a DB outage; only the memory-coupling escalation degrades.
    let has_goal = false;
    try {
      has_goal = session_id ? !!getGoal(session_id) : false;
    } catch (e) {
      if (e && e.code === 'T2HELIX_DRIVER_UNAVAILABLE') emitDegradedWarning();
    }
    result = classify({ tool_name, tool_input }, { has_goal });
  } catch (e) {
    process.stdout.write(JSON.stringify({ systemMessage: `t2helix compass error: ${e.message}` }));
    process.exit(0);
  }

  const action_summary = summarizeAction({ tool_name, tool_input });

  // Memory → compass coupling (helix criterion #2). When the rules return
  // OPEN, query recall() for similar past actions and let lib/coupling
  // decide whether the outcome history of those actions warrants escalation
  // to PAUSE. Failures here never block the tool — coupling failure means
  // "rules-only verdict stands."
  if (result.classification === 'OPEN') {
    try {
      const similar = recall({
        query: action_summary,
        topK: 10,
        include_meta: true
      });
      const coupled = escalateByMemory(result, similar);
      if (coupled && coupled.memory_escalated) {
        result = coupled;
      }
    } catch (e) {
      if (e && e.code === 'T2HELIX_DRIVER_UNAVAILABLE') emitDegradedWarning();
    }
  }

  try {
    logCompass({
      session_id,
      tool_name,
      action_summary,
      classification: result.classification,
      rule_matched: result.rule_id,
      reason: result.reason
    });
  } catch (e) {
    process.stderr.write(`[t2helix] logCompass dropped: ${e.message}\n`);
  }

  // Compass → memory coupling (helix criterion #3). When the compass actually
  // fires (PAUSE or WITNESS, never OPEN), write a chronicle entry tagged with
  // action:<hash> so PostToolUse entries (also tagged with the same hash)
  // close the chain. Recall by tag returns both endpoints: what the compass
  // judged, and what actually happened next. Fire regardless of whether the
  // approval-token override will consume it — the "compass fired here once"
  // event is itself informative for future sessions.
  if (result.classification !== 'OPEN') {
    try {
      recordCompassFire({
        session_id,
        action_summary,
        classification: result.classification,
        rule_matched: result.rule_id,
        reason: result.reason
      });
    } catch (e) {
      // Fail-open, but surface a dropped chain-anchor write so a half-chain
      // (compass-fire with no paired PostToolUse outcome) isn't invisible.
      process.stderr.write(`[t2helix] recordCompassFire dropped: ${e.message}\n`);
    }
  }

  if (result.classification === 'OPEN') {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  // PAUSE override flow: if Claude (or user) already approved this exact action
  // for this session_id, consume the approval and let the tool through.
  if (result.classification === 'PAUSE' && session_id) {
    try {
      const approval = findApproval({ session_id, action_summary });
      // consumeApproval is an atomic compare-and-swap: it returns false if a
      // racing process already claimed this single-use token, in which case we
      // fall through to deny rather than double-spend the approval.
      if (approval && consumeApproval(approval.id)) {
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

main().catch(() => {
  // Last-resort fail-open: an unexpected throw must never break the host.
  try { process.stdout.write(JSON.stringify({})); } catch (_) {}
  process.exit(0);
});
