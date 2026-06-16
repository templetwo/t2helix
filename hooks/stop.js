#!/usr/bin/env node
'use strict';

// Stop — fires when the Claude Code session closes. Writes a session synthesis
// record to the chronicle: what goal was set, what threads were opened, how
// many insights were recorded, and a brief summary of the last action pattern.
//
// This is the corpus-building hook. Over time these synthesis records make
// recall() genuinely powerful — not just "what have I learned" but "what was
// I doing in sessions like this one."

const { getState, getCompassHistory, record, readCurrentSession, writeCurrentSession, prune } = require('../lib/chronicle');
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
  if (session_id) writeCurrentSession(session_id);

  try {
    const state = getState(session_id || 'unknown');
    const goal = state.goal;
    const threads = state.open_threads || [];
    const insights = state.recent_insights || [];

    // Compass summary for the session — how many WITNESS / PAUSE / OPEN
    const compassLog = getCompassHistory({ limit: 100 });
    const sessionCompass = compassLog.filter(e => e.session_id === session_id);
    const counts = { WITNESS: 0, PAUSE: 0, OPEN: 0 };
    for (const e of sessionCompass) counts[e.classification] = (counts[e.classification] || 0) + 1;

    const lines = ['[Stop synthesis]'];
    if (goal && goal.goal) {
      lines.push(`Goal: ${goal.goal}`);
      if (goal.acceptance_criteria && goal.acceptance_criteria.length) {
        lines.push(`Acceptance criteria: ${goal.acceptance_criteria.join('; ')}`);
      }
    } else {
      lines.push('Goal: (none set this session)');
    }

    lines.push(`Insights recorded: ${insights.length}`);

    if (threads.length) {
      lines.push(`Open threads left (${threads.length}):`);
      for (const t of threads.slice(0, 5)) lines.push(`  - ${t.question}`);
    }

    const compassSummary = Object.entries(counts)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}:${v}`)
      .join(' ');
    if (compassSummary) lines.push(`Compass: ${compassSummary}`);

    record({
      session_id: session_id || 'unknown',
      content: lines.join('\n'),
      domain: 'session-synthesis',
      tags: ['stop', 'session-end', 'synthesis'],
      intensity: 0.7,
      layer: 'reflection'
    });
  } catch (_) {
    // Never block session close
  }

  // Retention pass — bound the unbounded operational tables (v0.2). Separate
  // try/catch so a prune failure never costs the synthesis write above, and
  // vice versa. Fail-open: a skipped prune is harmless.
  try {
    prune();
  } catch (_) {
    // Never block session close
  }

  process.stdout.write(JSON.stringify({}));
  process.exit(0);
}

main().catch(() => {
  // Last-resort fail-open: an unexpected throw must never break the host.
  try { process.stdout.write(JSON.stringify({})); } catch (_) {}
  process.exit(0);
});
