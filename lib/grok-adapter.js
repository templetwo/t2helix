'use strict';

/**
 * T2 Helix Grok Heavy Adapter
 * Equal partner integration for Grok alongside Claude in the production T2 Helix surface.
 *
 * Reuses the exact same chronicle, compass, and MCP tool surface.
 * No separate DB. No second-class memory.
 */

const chronicle = require('./chronicle');
const compass = require('./compass');
const path = require('path');
const fs = require('fs');

const ADAPTER_VERSION = '1.0.0';

/**
 * Boot a Grok session against the shared Helix chronicle.
 * Mirrors what the UserPromptSubmit hook does for Claude.
 */
async function grokBoot(options = {}) {
  let sessionId = 'grok-direct';
  try {
    const s = chronicle.readCurrentSession && chronicle.readCurrentSession();
    if (s) sessionId = s;
  } catch (_) {}

  let memory = [];
  try {
    memory = chronicle.recall({
      query: options.query || 'current context goal recent work',
      topK: options.topK || 8,
      layer: options.layer || ['ground_truth', 'hypothesis'],
      include_meta: false
    });
  } catch (e) {
    memory = [{ content: '[chronicle recall unavailable at boot: ' + e.message + ']', layer: 'reflection' }];
  }

  return {
    status: 'booted',
    adapter: 't2helix-grok',
    version: ADAPTER_VERSION,
    sessionId,
    memoryCount: memory.length,
    memory: memory.slice(0, 3), // compact for CLI
    protocol: 'Temple of Two — equal co-partnership (no Rings formality for creative layer)',
    dataDir: chronicle.dataDir ? chronicle.dataDir() : null
  };
}

/**
 * Witness + record path for Grok.
 * Runs the action through compass first (WITNESS/PAUSE/OPEN),
 * then records the outcome into the shared chronicle.
 */
async function grokWitness(actionOrQuery, context = {}) {
  // Route through the real compass pipeline (classify + summarizeAction)
  // for parity with Claude hooks. See pre-tool-use.js for the full flow
  // (including memory coupling and PAUSE token handling).
  //
  // Scope note for creative layer:
  // - WITNESS classifications are hard-denied (same as Claude).
  // - PAUSE single-use token override flow is not yet exposed in this adapter
  //   (Grok direct calls currently treat PAUSE as OPEN for now).
  // - For full tool-call fidelity, pass {tool_name, tool_input} instead of plain string.
  let classification = 'OPEN';
  let reason = null;
  let actionSummary = '';

  try {
    let structured;
    if (typeof actionOrQuery === 'string') {
      structured = { tool_name: 'Grok', tool_input: { note: actionOrQuery } };
      actionSummary = `Grok: ${actionOrQuery.slice(0, 180)}`;
    } else {
      structured = actionOrQuery;
      actionSummary = compass.summarizeAction(structured);
    }

    const decision = compass.classify(structured, { has_goal: false });
    classification = decision.classification || 'OPEN';
    reason = decision.reason;
  } catch (_) {}

  const content = typeof actionOrQuery === 'string' ? actionOrQuery : JSON.stringify(actionOrQuery);
  const session_id = context.session_id || chronicle.readCurrentSession && chronicle.readCurrentSession() || 'grok-direct-' + Date.now();

  // Enforce PAUSE for non-hook seats (Cosmic CLI, direct Grok). Previously PAUSE
  // was logged but treated as OPEN — same failure shape as a safe-mode flag that
  // is never read. Token flow matches PreToolUse: mint pending → confirm_pending
  // → retry with findApproval/consumeApproval.
  if (classification === 'WITNESS') {
    return {
      classification: 'WITNESS',
      reason,
      actionSummary,
      blocked: true,
      recorded: false,
      result: { blocked: 'WITNESS' },
      session_id,
      adapter: 'grok-adapter',
    };
  }

  if (classification === 'PAUSE') {
    // If already approved for this action, consume and fall through as OPEN.
    let approval = null;
    try {
      approval = chronicle.findApproval({
        session_id,
        action_summary: actionSummary,
      });
    } catch (_) {}

    if (approval && approval.id) {
      const claimed = chronicle.consumeApproval(approval.id);
      if (claimed) {
        classification = 'OPEN';
        reason = (reason ? reason + ' · ' : '') + `approved via token (consumed id=${approval.id})`;
      }
    } else {
      let pending = null;
      try {
        pending = chronicle.createPendingConfirmation({
          session_id,
          action_summary: actionSummary,
          rule_matched: null,
          reason,
        });
      } catch (e) {
        pending = { error: e.message };
      }
      return {
        classification: 'PAUSE',
        reason,
        actionSummary,
        blocked: true,
        recorded: false,
        pending_token: pending && pending.token ? pending.token : null,
        expires_at: pending && pending.expires_at ? pending.expires_at : null,
        result: { blocked: 'PAUSE', pending },
        session_id,
        adapter: 'grok-adapter',
        note:
          'PAUSE enforced for non-hook seats. Approve with confirm_pending(token), then retry the action.',
      };
    }
  }

  const payload = {
    session_id,
    content: actionSummary ? `${actionSummary}\n\n${content}`.trim() : content,
    layer: context.layer || 'hypothesis',
    domain: context.domain || 'grok-witness',
    tags: [...(context.tags || []), `source:grok-heavy`, `classification:${classification}`],
    intensity: context.intensity || 0.6
  };

  let recordResult = null;
  try {
    recordResult = chronicle.record(payload);
  } catch (e) {
    recordResult = { error: e.message };
  }

  return {
    classification,
    reason,
    actionSummary,
    blocked: false,
    recorded: !!(recordResult && recordResult.id),
    result: recordResult,
    session_id,
    adapter: 'grok-adapter',
  };
}

/**
 * Direct access to the shared chronicle recall for Grok sessions.
 * This is the primary "foundational memory" door.
 */
function grokRecall(query, opts = {}) {
  return chronicle.recall({
    query,
    topK: opts.topK || 6,
    layer: opts.layer,
    include_meta: opts.include_meta || false,
    tag: opts.tag
  });
}

/**
 * Write back into the shared chronicle (same as Claude `record`).
 */
function grokRecord(content, opts = {}) {
  const session_id = opts.session_id || chronicle.readCurrentSession && chronicle.readCurrentSession() || 'grok-direct-' + Date.now();
  return chronicle.record({
    session_id,
    content,
    layer: opts.layer || 'hypothesis',
    domain: opts.domain || 'grok',
    tags: [...(opts.tags || []), 'source:grok-heavy'],
    intensity: opts.intensity || 0.6
  });
}

/**
 * One-time init helper (can be called via `npm run grok:init`).
 * Ensures data dir exists and prints the session surface.
 */
function grokInit() {
  const dir = chronicle.dataDir ? chronicle.dataDir() : path.join(process.env.HOME || process.env.USERPROFILE, '.t2helix-data');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, 'chronicle.db');
    return {
      ok: true,
      dataDir: dir,
      db: dbPath,
      message: 'Grok now shares the same chronicle as Claude. Use grokRecall / grokRecord.'
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Export the public surface for CLI + direct require from Grok seats
module.exports = {
  grokBoot,
  grokWitness,
  grokRecall,
  grokRecord,
  grokInit,
  ADAPTER_VERSION
};
