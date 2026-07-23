#!/usr/bin/env node
'use strict';

const legacyCompass = require('../lib/compass');
const { classifyV2 } = require('../lib/compass-v2');
const { renderDecision, saferPathFor, MESSAGE_VERSION } = require('../lib/decision-message');
const {
  logCompass,
  getGoal,
  writeCurrentSession,
  findApproval,
  consumeApproval,
  createPendingConfirmation,
  recall,
  recordCompassFire,
  emitDegradedWarning,
  findSafeRepeatLease,
  consumeSafeRepeatLease
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

  let has_goal = false;
  try {
    has_goal = session_id ? !!getGoal(session_id) : false;
  } catch (e) {
    if (e && e.code === 'T2HELIX_DRIVER_UNAVAILABLE') emitDegradedWarning();
  }

  let v2;
  try {
    v2 = classifyV2({ tool_name, tool_input }, { has_goal, cwd: process.cwd() });
  } catch (e) {
    // Last-resort: pure legacy path if V2 orchestrator throws
    try {
      const result = legacyCompass.classify({ tool_name, tool_input }, { has_goal });
      const summary = legacyCompass.summarizeAction({ tool_name, tool_input });
      v2 = {
        active: result,
        legacy: result,
        semantic: null,
        ir: null,
        mode: 'off',
        action_summary: summary,
        display_summary: summary,
        shadow: null,
        message: null,
        message_version: MESSAGE_VERSION
      };
    } catch (e2) {
      process.stdout.write(JSON.stringify({ systemMessage: `t2helix compass error: ${e2.message}` }));
      process.exit(0);
    }
  }

  let result = v2.active;
  // Identity vs display — see lib/compass-v2.js. action_summary is what
  // PostToolUse also derives, so the action:<hash> chain only pairs if this stays
  // the legacy raw-command summary.
  const action_summary = v2.action_summary;
  const display_summary = v2.display_summary || v2.action_summary;

  // The semantic hash, resolved once. escalateByMemory() returns a fresh object
  // that carries no IR fields, so every consumer needs the IR fallback — without
  // it a memory-escalated PAUSE is silently ineligible for a safe-repeat lease.
  const semanticHash = result.normalized_action_hash ||
    (v2.ir && v2.ir.normalized_action_hash) || null;
  const parserVersion = result.parser_version ||
    (v2.ir && v2.ir.parser_version) || null;

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

  // Safe-repeat lease: covers PAUSE only, never WITNESS.
  if (result.classification === 'PAUSE' && session_id && semanticHash) {
    try {
      const lease = findSafeRepeatLease({
        session_id,
        normalized_action_hash: semanticHash,
        parser_version: parserVersion,
        cwd: (v2.ir && v2.ir.cwd) || process.cwd()
      });
      if (lease && consumeSafeRepeatLease(lease.lease_id)) {
        try {
          logCompass({
            session_id,
            tool_name,
            action_summary,
            classification: 'OPEN',
            rule_matched: result.rule_id,
            reason: `approved via safe-repeat lease ${lease.lease_id} (use ${lease.uses_count + 1}/${lease.max_uses})`,
            user_override: `lease:${lease.lease_id}`,
            normalized_action_hash: semanticHash,
            parser_version: parserVersion,
            message_version: MESSAGE_VERSION,
            shadow_json: v2.shadow
          });
        } catch (_) {}
        process.stdout.write(JSON.stringify({}));
        process.exit(0);
      }
    } catch (_) {}
  }

  try {
    logCompass({
      session_id,
      tool_name,
      action_summary,
      classification: result.classification,
      rule_matched: result.rule_id,
      reason: result.reason,
      normalized_action_hash: semanticHash,
      evidence_json: result.evidence || null,
      parser_version: parserVersion,
      message_version: MESSAGE_VERSION,
      shadow_json: v2.shadow
    });
  } catch (e) {
    process.stderr.write(`[t2helix] logCompass dropped: ${e.message}\n`);
  }

  // Compass → memory coupling (helix criterion #3).
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
      process.stderr.write(`[t2helix] recordCompassFire dropped: ${e.message}\n`);
    }
  }

  if (result.classification === 'OPEN') {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  // PAUSE override flow: single-use confirmation token (semantic hash preferred).
  if (result.classification === 'PAUSE' && session_id) {
    try {
      const approval = findApproval({
        session_id,
        action_summary,
        normalized_action_hash: semanticHash,
        parser_version: parserVersion
      });
      if (approval && consumeApproval(approval.id)) {
        try {
          logCompass({
            session_id,
            tool_name,
            action_summary,
            classification: 'OPEN',
            rule_matched: result.rule_id,
            reason: 'approved via single-use override token (consumed)',
            user_override: String(approval.id),
            normalized_action_hash: semanticHash,
            parser_version: parserVersion,
            message_version: MESSAGE_VERSION,
            shadow_json: v2.shadow
          });
        } catch (_) {}
        process.stdout.write(JSON.stringify({}));
        process.exit(0);
      }
    } catch (_) {}
  }

  // No approval (or WITNESS): deny.
  let token = null;
  if (result.classification === 'PAUSE' && session_id) {
    try {
      const pending = createPendingConfirmation({
        session_id,
        action_summary,
        rule_matched: result.rule_id,
        reason: result.reason,
        normalized_action_hash: semanticHash,
        parser_version: parserVersion
      });
      token = pending.token;
    } catch (_) {}
  }

  // Display summary here, not the identity summary — the operator should read
  // the action the way the IR understood it. Mode disagreement stays out of the
  // reason string; it is audited in compass_log.shadow_json.
  const rendered = renderDecision(result, {
    action_summary: display_summary.replace(/^[^:]+:\s*/, ''),
    token,
    safer_path: saferPathFor(result.rule_id),
    offer_lease: false
  });

  // Prefer versioned message contract; fall back to classic one-liner if empty.
  const reasonText = rendered.text ||
    `[t2helix:${result.rule_id}] ${result.classification === 'PAUSE' ? '[soft-deny] ' : ''}${result.reason || ''}`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reasonText
    }
  }));
  process.exit(0);
}

main().catch(() => {
  // Last-resort fail-open: an unexpected throw must never break the host.
  try { process.stdout.write(JSON.stringify({})); } catch (_) {}
  process.exit(0);
});
