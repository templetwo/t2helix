#!/usr/bin/env node
'use strict';

// PostToolUse — records significant tool actions to the chronicle and checks
// whether the last action aligns with the current session goal.
//
// Significant tools: Bash, Edit, Write, MultiEdit (state-changing work).
// Read-only tools (Read, Glob, Grep, LS, etc.) are silently skipped to avoid
// chronicle noise.
//
// Goal drift detection is structural, not LLM-powered: if a goal exists and
// the last N tools were all outside the tool classes associated with any
// goal-adjacent domain keyword, we surface a soft reminder. This is v0.0.5
// behavior — a lightweight signal, not a hard gate.

const { record, getGoal, writeCurrentSession, actionHash } = require('../lib/chronicle');
const { summarizeAction } = require('../lib/compass');
const { readStdin } = require('../lib/hook-io');
const { detectOutcome } = require('../lib/outcome');

const SIGNIFICANT_TOOLS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit']);

function summarizeResult(tool_response) {
  if (!tool_response) return '';
  const text = typeof tool_response === 'string'
    ? tool_response
    : JSON.stringify(tool_response);
  return text.slice(0, 300);
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
  const tool_response = input.tool_response;

  if (session_id) writeCurrentSession(session_id);

  // Skip non-significant tools silently
  if (!SIGNIFICANT_TOOLS.has(tool_name)) {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  try {
    const goal = session_id ? getGoal(session_id) : null;

    // Build a compact action description
    let action = tool_name;
    if (tool_name === 'Bash' && tool_input.command) {
      action = `Bash: ${String(tool_input.command).slice(0, 120)}`;
    } else if ((tool_name === 'Edit' || tool_name === 'Write' || tool_name === 'MultiEdit') && tool_input.file_path) {
      action = `${tool_name}: ${tool_input.file_path}`;
    }

    const resultSnippet = summarizeResult(tool_response);
    const content = goal
      ? `[PostToolUse] ${action}\nGoal: ${goal.goal}\nResult: ${resultSnippet}`
      : `[PostToolUse] ${action}\nResult: ${resultSnippet}`;

    // Outcome detection — the substrate the helix coupling reads.
    // Heuristic and explicit; ambiguous responses produce no tag (silent is
    // safer than mislabeled — the compass-side coupling reads only tagged
    // entries, so missing labels just mean "no signal," not "false signal").
    const outcome = detectOutcome(tool_name, tool_response);
    const tags = ['post-tool-use', tool_name.toLowerCase()];
    if (outcome) tags.push(`outcome:${outcome}`);

    // action:<hash> tag — pairs with the same tag on compass-fire entries so
    // recall by tag returns both endpoints of the chain (compass judged X,
    // then X actually happened with this outcome). Helix criterion #3 link.
    try {
      const hash = actionHash(summarizeAction({ tool_name, tool_input }));
      tags.push(`action:${hash}`);
    } catch (_) {}

    record({
      session_id: session_id || 'unknown',
      content,
      domain: 'session-action',
      tags,
      intensity: 0.2,
      layer: 'hypothesis'
    });
  } catch (e) {
    // Never block the agent — but make a dropped chronicle write observable on
    // stderr rather than silently breaking action:<hash> chain integrity (a
    // compass-fire with no paired outcome leaves a misleading half-chain).
    process.stderr.write(`[t2helix] post-tool-use record dropped: ${e.message}\n`);
  }

  process.stdout.write(JSON.stringify({}));
  process.exit(0);
}

main().catch(() => {
  // Last-resort fail-open: an unexpected throw must never break the host.
  try { process.stdout.write(JSON.stringify({})); } catch (_) {}
  process.exit(0);
});
