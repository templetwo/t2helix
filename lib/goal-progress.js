'use strict';

// Boundary-active goal support (v0.3 / Stage 2, step 3). Pure assessment logic,
// kept out of the DB layer and the hook so it is unit-testable and legible.
//
// A goal can carry acceptance_criteria — the BOUNDARY of "done". At session end
// the Stop hook asks, for each criterion: is there recorded evidence it was
// addressed? The answer is SOFT by design — token overlap against the session's
// OWN insights is a weak signal, explicitly labelled, never an authoritative
// verdict. A criterion with no recorded evidence is marked unfinished so an
// unclosed boundary stays visible rather than silently dropping off the radar.
// This runs ONCE at Stop; it is never per-tool (the spec's hard line).

const { significantTokens } = require('./surface');

// For each acceptance criterion, scan the session's insights for one whose
// content shares enough significant tokens to be RELATED to the criterion.
// `need` is 2 so a single incidental word can't relate a criterion — but a
// one-token criterion still needs only that token, and a criterion with NO
// significant tokens can never relate (need=Infinity → always unrelated, the
// safe direction: an unassessable boundary stays visible). Returns the first
// (newest) related insight id, or null.
//
// IMPORTANT: token overlap means "mentioned near these words", NOT "done". It
// cannot tell completion from a TODO, and it cannot read negation ("do NOT
// deploy" relates to "deploy"). The formatter below is deliberately worded so a
// related insight never reads as a verdict — see formatCriteriaProgress.
function assessCriteria({ criteria, insights }) {
  const list = Array.isArray(criteria) ? criteria : [];
  const rows = Array.isArray(insights) ? insights : [];
  // Tokenize the corpus once, not per-criterion.
  const corpus = rows.map(r => ({ id: r && r.id, tokens: significantTokens(r && r.content) }));
  return list
    .filter(c => typeof c === 'string' && c.trim().length > 0)
    .map(c => {
      const critTokens = significantTokens(c);
      const need = critTokens.size === 0 ? Infinity : Math.min(2, critTokens.size);
      let relatedId = null;
      for (const doc of corpus) {
        let shared = 0;
        for (const t of critTokens) if (doc.tokens.has(t)) shared++;
        if (shared >= need) { relatedId = doc.id; break; }
      }
      return { text: c.trim(), addressed: relatedId !== null, evidenceId: relatedId };
    });
}

// Render the assessment as synthesis lines. Soft language on BOTH sides — a
// related insight is "mentioned", never "done"; this is a token-overlap heuristic
// for the next session, not a completion check. Returns [] for no criteria.
function formatCriteriaProgress(assessed) {
  if (!Array.isArray(assessed) || assessed.length === 0) return [];
  const related = assessed.filter(a => a.addressed).length;
  const lines = [`Acceptance criteria (${related}/${assessed.length} with a related insight this session):`];
  for (const a of assessed) {
    // '~' not 'x': a related insight is not proof the criterion is done.
    const mark = a.addressed ? '~' : ' ';
    const note = a.addressed ? `related: #${a.evidenceId}` : 'no related insight';
    lines.push(`  - [${mark}] ${a.text} (${note})`);
  }
  const open = assessed.length - related;
  if (open > 0) {
    lines.push(`  (soft signal — token-overlap only, not a completion check; ${open} criterion(s) have no related insight and may be unfinished.)`);
  }
  return lines;
}

module.exports = { assessCriteria, formatCriteriaProgress };
