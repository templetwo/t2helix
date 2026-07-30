#!/usr/bin/env node
'use strict';

// scripts/replay-compass.js — replay historical compass_log rows under Compass V2.
// Compares original classification/rule with live legacy + semantic decisions.
//
// Usage:
//   node scripts/replay-compass.js [--limit N] [--data-dir PATH] [--json]
//
// Exit 0 always for observational runs (diffs are reported, not failed), unless
// --strict is set (then non-zero if any adversarial-floor weakening is detected).

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}
const LIMIT = parseInt(flag('--limit') || '100', 10);
const DATA_DIR = flag('--data-dir');
const AS_JSON = args.includes('--json');
const STRICT = args.includes('--strict');

if (DATA_DIR) process.env.T2HELIX_DATA_DIR = DATA_DIR;

const ch = require('../lib/chronicle');
const { classifyV2 } = require('../lib/compass-v2');
const { ALL_MIGRATED_RULE_IDS } = require('../lib/compass-semantic');

// Rebuild a tool call from its action_summary. Two failure modes are now named
// rather than guessed around, because both made this instrument report the
// OPPOSITE of the truth about the rows it was pointed at:
//
//   1. For an unrecognized tool, summarizeAction's `rest` is the JSON ENVELOPE
//      (`{"command":"…"}`), not a bare string. Reconstructing it as {raw: rest}
//      put the payload in a field no rule can be matched against, so every
//      capability-gated deny replayed as OPEN and was reported as a softening.
//   2. summarizeAction truncates at 200 chars with a trailing '…'. A truncated
//      summary cannot be faithfully replayed AT ALL — the trigger may be in the
//      part that was cut — and replaying it anyway manufactures a false
//      softening (or hides a real weakening) with no signal. Those rows are now
//      counted as `unreplayable` and excluded from every other count.
const TRUNCATION_MARK = '…';

function parseToolFromSummary(summary) {
  // summarizeAction format: "Tool: rest"
  const m = String(summary || '').match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/s);
  if (!m) return { tool_name: 'Bash', tool_input: { command: String(summary || '') } };
  const tool_name = m[1];
  const rest = m[2];
  if (rest.endsWith(TRUNCATION_MARK)) {
    return { tool_name, tool_input: null, unreplayable: 'summary-truncated' };
  }
  if (tool_name === 'Bash') return { tool_name, tool_input: { command: rest } };
  if (tool_name === 'Edit' || tool_name === 'Write' || tool_name === 'MultiEdit') {
    return { tool_name, tool_input: { file_path: rest } };
  }
  // Unrecognized tool: the summary holds the JSON envelope actionString built.
  try {
    const parsed = JSON.parse(rest);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { tool_name, tool_input: parsed };
    }
  } catch {
    // fall through — a summary that is not an envelope cannot be reconstructed
  }
  return { tool_name, tool_input: null, unreplayable: 'envelope-unparseable' };
}

function severity(c) {
  if (c === 'WITNESS') return 2;
  if (c === 'PAUSE') return 1;
  return 0;
}

function main() {
  let rows = [];
  try {
    rows = ch.db().prepare(`
      SELECT id, session_id, tool_name, action_summary, classification, rule_matched, reason, occurred_at
      FROM compass_log
      ORDER BY id DESC
      LIMIT ?
    `).all(LIMIT);
  } catch (e) {
    console.error(`replay-compass: cannot read compass_log: ${e.message}`);
    process.exit(2);
  }

  const report = {
    replayed: 0,
    unreplayable: 0,
    unreplayable_rows: [],
    agree_legacy: 0,
    agree_semantic: 0,
    diffs: [],
    weakenings: [],
    migrated_softenings: []
  };

  // Replay oldest-first for readability
  for (const row of rows.slice().reverse()) {
    const parsed = parseToolFromSummary(row.action_summary);
    const { tool_name, tool_input } = parsed;

    // A row whose call cannot be reconstructed is NOT evidence of agreement,
    // softening or weakening. Counting it as any of those is how a drift
    // instrument lies about the drift it exists to measure.
    if (parsed.unreplayable || !tool_input) {
      report.unreplayable++;
      if (report.unreplayable_rows.length < 20) {
        report.unreplayable_rows.push({
          id: row.id,
          reason: parsed.unreplayable || 'no-tool-input',
          original: { classification: row.classification, rule: row.rule_matched },
          summary: row.action_summary
        });
      }
      continue;
    }

    // Prefer stored tool_name
    const tn = row.tool_name || tool_name;
    let v2;
    try {
      v2 = classifyV2({ tool_name: tn, tool_input }, { cwd: process.cwd() });
    } catch (e) {
      report.diffs.push({ id: row.id, error: e.message });
      continue;
    }
    report.replayed++;

    if (v2.legacy.classification === row.classification &&
        (v2.legacy.rule_id || null) === (row.rule_matched || null)) {
      report.agree_legacy++;
    }
    if (v2.semantic &&
        v2.semantic.classification === row.classification &&
        (v2.semantic.rule_id || null) === (row.rule_matched || null)) {
      report.agree_semantic++;
    }

    const diff = {
      id: row.id,
      original: { classification: row.classification, rule: row.rule_matched },
      legacy: { classification: v2.legacy.classification, rule: v2.legacy.rule_id },
      semantic: v2.semantic
        ? { classification: v2.semantic.classification, rule: v2.semantic.rule_id, predicate: v2.semantic.predicate_id }
        : null,
      active: { classification: v2.active.classification, rule: v2.active.rule_id },
      summary: row.action_summary
    };

    if (
      diff.original.classification !== diff.legacy.classification ||
      diff.original.classification !== (diff.semantic && diff.semantic.classification)
    ) {
      report.diffs.push(diff);
    }

    // A weakening is any row whose replayed verdict is softer than what was
    // originally recorded. Migrated families are SUPPOSED to soften in places
    // (that is the false-positive fix), so they are reported separately rather
    // than excluded — excluding them made --strict blind to regressions in the
    // exact rules this release changes.
    if (severity(row.classification) > severity(v2.active.classification) && row.rule_matched) {
      if (ALL_MIGRATED_RULE_IDS.has(row.rule_matched)) {
        report.migrated_softenings.push(diff);
      } else {
        report.weakenings.push(diff);
      }
    }
  }

  if (AS_JSON) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    console.log(`replay-compass: ${report.replayed} rows`);
    console.log(`  unreplayable:   ${report.unreplayable}  (summary truncated or not an envelope — NOT counted as agreement or drift)`);
    console.log(`  agree_legacy:   ${report.agree_legacy}`);
    console.log(`  agree_semantic: ${report.agree_semantic}`);
    console.log(`  diffs:          ${report.diffs.length}`);
    console.log(`  weakenings:     ${report.weakenings.length}  (non-migrated floor rules — fails --strict)`);
    console.log(`  softenings:     ${report.migrated_softenings.length}  (migrated families — expected, review them)`);
    for (const d of report.migrated_softenings.slice(0, 10)) {
      console.log(
        `    softened #${d.id} ${d.original.classification}/${d.original.rule}` +
        ` → ${d.active.classification}/${d.active.rule} :: ${(d.summary || '').slice(0, 70)}`
      );
    }
    if (report.diffs.length && report.diffs.length <= 20) {
      for (const d of report.diffs.slice(0, 20)) {
        if (d.error) {
          console.log(`  #${d.id} ERROR ${d.error}`);
          continue;
        }
        console.log(
          `  #${d.id} orig=${d.original.classification}/${d.original.rule}` +
          ` leg=${d.legacy.classification}/${d.legacy.rule}` +
          ` sem=${d.semantic ? d.semantic.classification + '/' + d.semantic.rule : 'n/a'}` +
          ` :: ${(d.summary || '').slice(0, 80)}`
        );
      }
    }
  }

  if (STRICT && report.weakenings.length) process.exit(1);
  process.exit(0);
}

main();
