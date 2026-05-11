#!/usr/bin/env node
'use strict';

// PreCompact — fires before Claude Code compresses context. Archives the
// current session state (goal + recent threads + insight count) into the
// chronicle so that key context survives the compaction boundary.
//
// Without this hook, insights explicitly recorded during a session survive
// (they're in the db), but the narrative of what was being worked on and
// what was left open gets lost with the context window. This hook captures
// that snapshot at the last moment before compression.

const { getState, record, readCurrentSession, writeCurrentSession } = require('../lib/chronicle');
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

  const session_id = input.session_id || readCurrentSession() || null;
  const compact_summary = input.summary || input.compact_summary || null;

  if (session_id) writeCurrentSession(session_id);

  try {
    const state = getState(session_id || 'unknown');
    const goal = state.goal;
    const threads = (state.open_threads || []).slice(0, 5);
    const insightCount = (state.recent_insights || []).length;

    const lines = ['[PreCompact snapshot]'];
    if (goal && goal.goal) {
      lines.push(`Goal: ${goal.goal}`);
      if (goal.why) lines.push(`Why: ${goal.why}`);
    } else {
      lines.push('Goal: (none set)');
    }
    if (threads.length) {
      lines.push(`Open threads (${threads.length}):`);
      for (const t of threads) lines.push(`  - ${t.question}`);
    }
    if (insightCount) lines.push(`Insights recorded this session: ${insightCount}`);
    if (compact_summary) lines.push(`\nCompact summary preview: ${compact_summary.slice(0, 200)}`);

    record({
      session_id: session_id || 'unknown',
      content: lines.join('\n'),
      domain: 'session-compact',
      tags: ['pre-compact', 'session-snapshot'],
      intensity: 0.6,
      layer: 'reflection'
    });
  } catch (_) {
    // Never block compaction
  }

  // Return empty — PreCompact hooks should not inject context
  process.stdout.write(JSON.stringify({}));
  process.exit(0);
}

main();
