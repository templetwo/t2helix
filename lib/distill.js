'use strict';

// Stage 3 auto-distill (v0.4). Pure, DI-tested logic that turns a *successful*
// session into a candidate method — a rough draft of "the procedure that worked"
// — for later human review and promotion. Like lib/goal-progress.js and
// lib/surface.js it touches no DB: the Stop hook feeds it session data and
// persists whatever it returns to the QUARANTINE store (lib/chronicle
// recordMethodCandidate), never the surfaced method store.
//
// Cardinal discipline (chronicle #2382 / #2381): the Stop hook is a
// high-frequency writer, and "amplify successes the way the compass amplifies
// failures" is the exact firehose trap that polluted recall in v0.1. So distill
// is deliberately CONSERVATIVE — it returns a candidate ONLY when a goal with
// acceptance_criteria was set, the session shows real success signal and ZERO
// failures, and a majority of the criteria were addressed. Quality over volume:
// most sessions distill nothing, and what they do distill is quarantined until a
// human promotes it. The candidate is a skeleton, not a polished playbook — that
// roughness is precisely why it is gated rather than auto-surfaced.

const { significantTokens } = require('./surface');

const MAX_STEPS = 8;
const STEP_MAX_CHARS = 140;
const ACCEPTANCE_MAX_CHARS = 200;

// Read the outcome a PostToolUse row carries in its tags
// ('outcome:success' | 'outcome:failure'); null when the action was ambiguous.
function actionOutcome(row) {
  const tags = row && Array.isArray(row.tags) ? row.tags : [];
  for (const t of tags) {
    if (t === 'outcome:success') return 'success';
    if (t === 'outcome:failure') return 'failure';
  }
  return null;
}

// Best-effort <verb>-<object> slug from the goal text: the first few significant
// tokens, lowercased, joined with '-'. Humble by design — the retrieval slug is
// only a draft; the human refines it on promote (and the surface relevance bar
// still requires a real token overlap before it would ever surface).
function deriveShape(goalText) {
  const toks = [...significantTokens(goalText)];
  if (!toks.length) return '';
  return toks.slice(0, 4).join('-');
}

// Compact a session-action row to a single step string. The row content is
// already `tool: summary` and was scrubbed at write time; we just normalize and
// trim it to keep the candidate small.
function actionToStep(row) {
  const c = String((row && row.content) || '').replace(/\s+/g, ' ').trim();
  if (!c) return '';
  return c.length > STEP_MAX_CHARS ? c.slice(0, STEP_MAX_CHARS) + '…' : c;
}

// `goal`       — the session goal { goal, acceptance_criteria }.
// `assessment` — assessCriteria() output: [{ text, addressed, evidenceId }].
// `actions`    — this session's session-action rows: [{ content, tags, created_at }],
//                newest-first (as getSessionActions returns them).
// Returns { shape, steps, acceptance, tool_classes } or null (most sessions).
function distillCandidate({ goal, assessment, actions } = {}) {
  if (!goal || !goal.goal) return null;
  const criteria = Array.isArray(goal.acceptance_criteria) ? goal.acceptance_criteria : null;
  if (!criteria || criteria.length === 0) return null; // need a bounded goal to distill against

  // Success gate: real positive signal AND not a single detected failure. A
  // session that hit a failure is not a clean "this worked" to amplify.
  const acts = Array.isArray(actions) ? actions : [];
  let successes = 0;
  let failures = 0;
  for (const a of acts) {
    const o = actionOutcome(a);
    if (o === 'success') successes++;
    else if (o === 'failure') failures++;
  }
  if (failures > 0) return null;
  if (successes < 1) return null;

  // A majority of the acceptance criteria must have a related insight this
  // session (reuses the Stop goal-progress assessment — same soft signal).
  const assessed = Array.isArray(assessment) ? assessment : [];
  if (assessed.length === 0) return null;
  const addressed = assessed.filter(a => a && a.addressed).length;
  if (addressed < Math.ceil(assessed.length / 2)) return null;

  const shape = deriveShape(goal.goal);
  if (!shape) return null;

  // Steps: chronological (actions arrive newest-first), de-duplicated against the
  // immediately preceding step, capped. A rough skeleton of what was done.
  const chrono = acts.slice().reverse();
  const steps = [];
  let last = null;
  for (const a of chrono) {
    const s = actionToStep(a);
    if (!s || s === last) continue;
    steps.push(s);
    last = s;
    if (steps.length >= MAX_STEPS) break;
  }
  if (steps.length === 0) return null;

  // tool_classes: distinct tool names from the action tags. PostToolUse writes
  // the lowercased tool name as a bare tag (alongside 'post-tool-use' and the
  // ':'-bearing outcome:/action: tags), so keep bare, non-'post-tool-use' tags.
  const toolSet = new Set();
  for (const a of acts) {
    if (!a) continue;
    const tags = Array.isArray(a.tags) ? a.tags : [];
    for (const t of tags) {
      if (typeof t === 'string' && t !== 'post-tool-use' && !t.includes(':')) {
        toolSet.add(t.toLowerCase());
      }
    }
  }
  const tool_classes = [...toolSet].slice(0, 6);

  const acceptance = criteria.join('; ').slice(0, ACCEPTANCE_MAX_CHARS);

  return { shape, steps, acceptance, tool_classes };
}

module.exports = { distillCandidate, deriveShape, actionOutcome };
