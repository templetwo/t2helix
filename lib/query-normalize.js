'use strict';

// Recall-side query de-noiser (error-fix matching stage).
//
// When a user pastes a traceback/stack into the prompt, the file paths,
// line:col offsets, hex addresses, and frame lines flood the FTS query with
// noise tokens that bury the error identity (ModuleNotFoundError,
// sqlite3.OperationalError, ...) and dilute BM25 against the v0.10 error-fix
// atlas. This collapses a pasted traceback down to its error type + message so
// the matcher that already exists (recall() over insights_fts) can find the
// resolution.
//
// Deliberately NOT a signature / hash / frame-state-machine — that was the
// rejected half of the optimization spec's traceback section. This is a pure,
// allocation-light pass over line splits and LINEAR regexes only: no nested
// quantifiers, so it cannot catastrophically backtrack (ReDoS-safe by
// construction). It is a no-op on any text that shows no error signature, so
// ordinary prompts pass through verbatim.

// An error paste announces itself with a typed exception, a Python Traceback
// header, or a panic/fatal marker. Linear alternation — no backtracking.
const ERROR_SIGNAL =
  /[A-Za-z_$][\w$]*(?:Error|Exception|Warning)\b|Traceback \(most recent call last\)|(?:^|\n)\s*(?:panic|fatal):/;

const V8_FRAME = /^\s*at\s/;       // "    at Object.<anonymous> (/p/f.js:1:2)"
const PY_FRAME = /^\s*File\s+"/;   // '  File "/p/f.py", line 3, in <module>'
const CARET    = /^\s*\^+\s*$/;    // Python caret-underline line

// Reduce a prompt that contains a traceback to its matchable error identity.
// Returns the input unchanged when it shows no error signature or is too short.
function denoiseErrorQuery(text) {
  const s = String(text == null ? '' : text);
  if (s.length < 16 || !ERROR_SIGNAL.test(s)) return s;

  // 1. Drop stack-frame lines — pure location noise, no matchable identity.
  const kept = [];
  for (const line of s.split('\n')) {
    if (V8_FRAME.test(line) || PY_FRAME.test(line) || CARET.test(line)) continue;
    kept.push(line);
  }

  // 2. Strip residual location noise from the surviving header/message lines:
  //    memory addresses, :line[:col] suffixes, and long bare digit runs.
  const cleaned = kept.join(' ')
    .replace(/0x[0-9a-fA-F]+/g, ' ')
    .replace(/:\d+(?::\d+)?/g, ' ')
    .replace(/\b\d{4,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Never hand back an empty query (e.g. a paste that was ALL frames) — fall
  // back to the original so recall still has something to anchor on.
  return cleaned || s;
}

module.exports = { denoiseErrorQuery };
