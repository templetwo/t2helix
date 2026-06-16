'use strict';

// Recall-surface selection (v0.3 / Stage 2). Pure logic, extracted from the
// UserPromptSubmit hook so it is unit-testable and legible. The cardinal rule:
// total injected volume goes DOWN vs v0.2 — fewer, sharper, procedure-bearing
// injections that REPLACE noise. The injected block is at most:
//   [goal line] + [≤1 relevant method] + [≤3 relevance-filtered insights],
// and on a conversational/trivial prompt the generic insights are suppressed
// entirely (a strong method and the goal may still show).

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'is', 'are',
  'this', 'that', 'with', 'my', 'your', 'it', 'be', 'at', 'as', 'do', 'we',
  'you', 'can', 'what', 'how', 'why', 'when', 'where', 'from', 'into', 'just'
]);

// Conversational / acknowledgment / pure-operational prompts that recall can't
// help (Q1: gate on task-shape, not length — these drew only noise in practice).
const ACK_RE = /^\s*(?:ok(?:ay)?|k|nice|cool|great|perfect|thx|thanks?|thank you|ty|yes|yep|yeah|yea|sure|go|go ahead|do it|sounds good|got it|right|correct|yup|nope|no|stop|wait|nvm|continue|keep going|proceed|try (?:hq )?again|run it|merge it|ship it|done)[\s.!?]*$/i;

function significantTokens(s) {
  const m = String(s || '').toLowerCase().match(/[a-z0-9]{4,}/g) || [];
  return new Set(m.filter(t => !STOPWORDS.has(t)));
}

// A prompt that should suppress the generic recall firehose.
function isTrivialPrompt(p) {
  const t = String(p || '').trim();
  if (!t) return true;
  if (ACK_RE.test(t)) return true;
  const words = t.split(/\s+/);
  // Short AND carrying no task-shaped token (a path, dotted/snake name, CamelCase
  // identifier, or a long word) → nothing for recall to anchor on.
  if (words.length <= 4 && !/[/._]|[A-Z][a-z]+[A-Z]|[A-Za-z0-9]{8,}/.test(t)) return true;
  return false;
}

function overlapCount(tokenSet, text) {
  const tt = significantTokens(text);
  let n = 0;
  for (const t of tokenSet) if (tt.has(t)) n++;
  return n;
}

function methodShape(m) {
  const tag = (m && Array.isArray(m.tags) ? m.tags : []).find(t => typeof t === 'string' && t.startsWith('shape:'));
  return tag ? tag.slice('shape:'.length) : '';
}

// Decide what to inject. `recall` is injected (DI) for testability. Each lookup is
// independently guarded — a throw degrades to "nothing from that source", never an
// exception out of here (the hook adds its own last-resort fail-open on top).
function selectInjection({ goal, prompt, recall }) {
  const goalText = goal && goal.goal ? goal.goal : '';
  const trivial = isTrivialPrompt(prompt);

  // 1. Targeted method lookup (attempted even on a trivial prompt — a method is
  //    signal, not noise). Keyed to the goal when one is active, else the prompt.
  //    Relevance bar: the shape slug must share a significant token with the query,
  //    so a weak/wrong method surfaces NOTHING rather than misleading.
  let method = null;
  const methodQuery = goalText || prompt || '';
  const methodTokens = significantTokens(methodQuery);
  try {
    const methods = recall({ query: methodQuery, tag: 'method', include_meta: true, topK: 2 }) || [];
    for (const m of methods) {
      const slugTokens = significantTokens(methodShape(m).replace(/[-_]+/g, ' '));
      let shared = 0;
      for (const t of slugTokens) if (methodTokens.has(t)) shared++;
      if (shared >= 1) { method = m; break; }
    }
  } catch (_) { /* no method */ }

  // 2. Generic recall — suppressed on trivial prompts, trimmed harder when a goal
  //    already anchors context (Q1), relevance-filtered against the prompt, capped.
  let hits = [];
  if (!trivial) {
    try {
      const topK = goalText ? 2 : 3;
      const promptTokens = significantTokens(prompt);
      const raw = recall({ query: prompt, topK }) || [];
      hits = raw
        .filter(h => promptTokens.size === 0 || overlapCount(promptTokens, h.content) >= 1)
        .slice(0, 3);
    } catch (_) { hits = []; }
  }

  return { trivial, method, hits };
}

function buildContext({ goal, method, hits }) {
  const lines = ['## T2Helix recall'];
  if (goal && goal.goal) {
    lines.push(`**Current goal:** ${goal.goal}`);
    if (goal.why) lines.push(`_Why:_ ${goal.why}`);
  } else {
    lines.push('_No session goal set. Set one with mcp__t2helix__set_goal to anchor the work._');
  }
  if (method) {
    const snip = method.content.length > 400 ? method.content.slice(0, 400) + '…' : method.content;
    lines.push('', '**Method for this kind of task:**', snip);
  }
  if (hits && hits.length) {
    lines.push('', '**Related from chronicle:**');
    for (const h of hits) {
      const tag = h.domain ? ` [${h.domain}]` : '';
      const layer = h.layer && h.layer !== 'hypothesis' ? ` (${h.layer})` : '';
      const snippet = h.content.length > 240 ? h.content.slice(0, 240) + '…' : h.content;
      lines.push(`- _#${h.id}${tag}${layer}_ ${snippet}`);
    }
  }
  return lines.join('\n');
}

module.exports = { isTrivialPrompt, significantTokens, methodShape, selectInjection, buildContext };
