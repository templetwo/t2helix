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
// allocation-light pass over line splits and BOUNDED-quantifier regexes: every
// quantifier is capped (no unbounded greedy run sitting in front of a failing
// suffix), so matching stays linear in input length — no catastrophic and no
// polynomial backtracking. It is a no-op on any text that shows no error
// signature, so ordinary prompts pass through verbatim.

// An error paste announces itself with a typed exception, a Python Traceback
// header, or a panic/fatal marker. The leading-identifier run is bounded to 64
// chars: real exception names are far shorter, and the cap is what keeps the
// guard linear (an unbounded `[\w$]*` here backtracks O(n^2) on a long
// suffix-less word run — measured ~21s at 200K chars before the bound).
const ERROR_SIGNAL =
  /[A-Za-z_$][\w$]{0,64}(?:Error|Exception|Warning)\b|Traceback \(most recent call last\)|(?:^|\n)\s*(?:panic|fatal):/;

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
