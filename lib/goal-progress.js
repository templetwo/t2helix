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
// content shares enough significant tokens to count as evidence the criterion
// was touched. `need` defaults to 2 so a single incidental word can't mark a
// criterion addressed — but a one-token criterion still needs only that token.
// Returns the first matching insight id (cheap provenance) or null.
function assessCriteria({ criteria, insights }) {
  const list = Array.isArray(criteria) ? criteria : [];
  const rows = Array.isArray(insights) ? insights : [];
  // Tokenize the corpus once, not per-criterion.
  const corpus = rows.map(r => ({ id: r.id, tokens: significantTokens(r && r.content) }));
  return list
    .filter(c => typeof c === 'string' && c.trim().length > 0)
    .map(c => {
      const critTokens = significantTokens(c);
      const need = Math.min(2, critTokens.size) || 1;
      let evidenceId = null;
      for (const doc of corpus) {
        let shared = 0;
        for (const t of critTokens) if (doc.tokens.has(t)) shared++;
        if (shared >= need) { evidenceId = doc.id; break; }
      }
      return { text: c.trim(), addressed: evidenceId !== null, evidenceId };
    });
}

// Render the assessment as synthesis lines. Soft language throughout — this is a
// heuristic note for the next session, not a verdict. Returns [] for no criteria.
function formatCriteriaProgress(assessed) {
  if (!Array.isArray(assessed) || assessed.length === 0) return [];
  const done = assessed.filter(a => a.addressed).length;
  const lines = [`Acceptance criteria (${done}/${assessed.length} with recorded evidence):`];
  for (const a of assessed) {
    const note = a.addressed ? `evidence #${a.evidenceId}` : 'unfinished, no recorded evidence';
    lines.push(`  - [${a.addressed ? 'x' : ' '}] ${a.text} (${note})`);
  }
  const open = assessed.length - done;
  if (open > 0) {
    lines.push(`  (soft marker: ${open} criterion(s) without recorded evidence — may be unfinished)`);
  }
  return lines;
}

module.exports = { assessCriteria, formatCriteriaProgress };
