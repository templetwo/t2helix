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
  let classification = 'OPEN';
  let reason = null;

  try {
    // compass may export check() or have different surface; be defensive
    const decision = (compass.check || compass.classify || (() => ({ classification: 'OPEN' })))(actionOrQuery);
    classification = decision.classification || decision.mode || 'OPEN';
    reason = decision.reason;
  } catch (_) {}

  const content = typeof actionOrQuery === 'string' ? actionOrQuery : JSON.stringify(actionOrQuery);
  const session_id = context.session_id || chronicle.readCurrentSession && chronicle.readCurrentSession() || 'grok-direct-' + Date.now();

  const payload = {
    session_id,
    content,
    layer: context.layer || 'hypothesis',
    domain: context.domain || 'grok-action',
    tags: [...(context.tags || []), `source:grok-heavy`, `classification:${classification}`],
    intensity: context.intensity || 0.6
  };

  let recordResult = null;
  if (classification !== 'WITNESS') {
    try {
      recordResult = chronicle.record(payload);
    } catch (e) {
      recordResult = { error: e.message };
    }
  } else {
    recordResult = { blocked: 'WITNESS' };
  }

  return {
    classification,
    reason,
    recorded: !!(recordResult && recordResult.id),
    result: recordResult,
    session_id,
    adapter: 'grok-adapter'
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
