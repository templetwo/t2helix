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

const { NOT_EVALUATED, isClearance } = legacyCompass;

// How long the whole gate may take before its own verdict stops being trustworthy.
// hooks.json gives PreToolUse 5000ms; past this the harness is close enough to
// killing the process that a clearance is more likely to be "we ran out of time"
// than "we looked and it was fine."
const GATE_BUDGET_MS = Number(process.env.T2HELIX_GATE_BUDGET_MS) > 0
  ? Number(process.env.T2HELIX_GATE_BUDGET_MS)
  : 3500;

// The escape hatch. Fail-closed is right for a gate, but a gate that denies every
// call and cannot be turned off from outside the session is a brick — if a future
// harness renames a payload field, every tool call would deny and the operator
// could not run the command that fixes it. This restores the pre-fix behaviour for
// the NON-EVALUATION path only; it never touches a real WITNESS or PAUSE verdict,
// and the compass_log row is written either way so the hatch cannot hide a gap.
const FAILURE_MODE_OPEN =
  String(process.env.T2HELIX_GATE_FAILURE_MODE || '').toLowerCase() === 'open';

// Emit the non-clearance floor. No override token is minted here, deliberately:
// the padded-command bypass works by making evaluation not happen, so a token on
// this path would let an attacker pad, collect, approve and retry — the same
// bypass in two steps. Like WITNESS, a non-evaluation has nothing to override.
function emitNotEvaluated({ session_id, tool_name, action_summary, rule_id, detail, evidence }) {
  try {
    logCompass({
      session_id: session_id || null,
      tool_name: tool_name || 'unknown',
      action_summary: action_summary || 'unknown action',
      classification: NOT_EVALUATED,
      rule_matched: rule_id,
      reason: detail,
      user_override: FAILURE_MODE_OPEN ? 'gate-failure-mode:open' : null,
      evidence_json: evidence || null,
      message_version: MESSAGE_VERSION
    });
  } catch (e) {
    process.stderr.write(`[t2helix] NOT_EVALUATED row dropped: ${e.message}\n`);
  }

  if (FAILURE_MODE_OPEN) {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `[t2helix:${rule_id}] T2Helix Compass - NOT EVALUATED\n` +
        `Why: the compass did not evaluate this call, so it cannot clear it. ${detail}\n` +
        'Next: no override token exists for a non-evaluation — fix the cause (npm run doctor), ' +
        'or the operator can set T2HELIX_GATE_FAILURE_MODE=open to restore the previous behaviour ' +
        'of letting unevaluated calls through.'
    }
  }));
  process.exit(0);
}

async function main() {
  const gateStarted = Date.now();
  let input;
  try {
    const raw = await readStdin();
    input = raw ? JSON.parse(raw) : {};
  } catch (e) {
    emitNotEvaluated({
      rule_id: 'gate-input-unparseable',
      detail: `The hook payload did not parse as JSON (${e.message}), so no tool call could be read.`
    });
    return;
  }

  const session_id = input.session_id || null;
  const tool_name = input.tool_name || '';
  const tool_input = input.tool_input || {};

  // Every bundled rule is tool-scoped, so a payload with no tool name matches
  // nothing and used to emit the same `{}` as an evaluated clearance.
  if (!tool_name) {
    emitNotEvaluated({
      session_id,
      rule_id: 'gate-payload-no-tool',
      detail: 'The hook payload carried no tool_name, so there was no action to classify.'
    });
    return;
  }

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
      emitNotEvaluated({
        session_id,
        tool_name,
        rule_id: 'gate-classifier-failed',
        detail: `Both the V2 orchestrator and the legacy classifier threw (${e2.message}).`
      });
      return;
    }
  }

  let result = v2.active;

  // The rule loop stopped short — see lib/compass.js. Carry it out to the floor
  // rather than letting the OPEN branch below treat it as a clearance.
  if (result.classification === NOT_EVALUATED) {
    emitNotEvaluated({
      session_id,
      tool_name,
      action_summary: v2.action_summary,
      rule_id: result.rule_id,
      detail: result.reason,
      evidence: result.evidence
    });
    return;
  }

  // Late clearance. Everything above is synchronous, so a gate that took this
  // long has been racing the harness timeout, and the verdict it came back with
  // is as likely to be "nothing had time to match" as "nothing matched".
  const gateElapsed = Date.now() - gateStarted;
  if (gateElapsed > GATE_BUDGET_MS && isClearance(result.classification)) {
    emitNotEvaluated({
      session_id,
      tool_name,
      action_summary: v2.action_summary,
      rule_id: 'gate-budget-exceeded',
      detail: `Classification took ${gateElapsed}ms against a ${GATE_BUDGET_MS}ms budget, so the clearance is not trustworthy.`,
      evidence: { elapsed_ms: gateElapsed, budget_ms: GATE_BUDGET_MS }
    });
    return;
  }

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
  if (isClearance(result.classification)) {
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
  if (!isClearance(result.classification)) {
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

  if (isClearance(result.classification)) {
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

main().catch((e) => {
  // Last resort. An unexpected throw must never break the host — but it must not
  // read as a clearance either, so it lands on the same non-clearance floor.
  try {
    emitNotEvaluated({
      rule_id: 'gate-unhandled-error',
      detail: `The gate threw before reaching a verdict (${e && e.message}).`
    });
  } catch (_) {
    try { process.stdout.write(JSON.stringify({})); } catch (_e) {}
    process.exit(0);
  }
});
