'use strict';

// Outcome detection for PostToolUse — the substrate the helix coupling reads.
//
// Returns one of: 'success' | 'failure' | null
//   'success' — tool returned a recognizable success shape, no failure signal
//   'failure' — explicit failure signal (interrupted, Traceback, fatal:, etc.)
//   null      — unknown tool or ambiguous response; do NOT tag
//
// Design constraint per the helix plan: "explicit and heuristic — exit codes,
// obvious error strings, immediate tool_response only. No clever inference."
// Better to leave an entry untagged than to mislabel it; the coupling reads
// only tagged entries, so silence is the safe default.

// Strong failure signatures. Anchored at line start where possible to avoid
// matching benign substrings (e.g., "error-handling" in narrative output).
const FAILURE_STDERR_PATTERNS = [
  /^fatal:/m,
  /^Error:/m,
  /^error:/m,
  /^Traceback \(most recent call last\):/m,
  /^SyntaxError:/m,
  /^TypeError:/m,
  /^ModuleNotFoundError:/m
];

const FAILURE_STDOUT_PATTERNS = [
  /\bFAILED\b/,
  /^Traceback \(most recent call last\):/m,
  /^Error:/m,
  /\bAssertionError\b/
];

function bashOutcome(tool_response) {
  const stdout = String(tool_response.stdout || '');
  const stderr = String(tool_response.stderr || '');
  for (const re of FAILURE_STDERR_PATTERNS) {
    if (re.test(stderr)) return 'failure';
  }
  for (const re of FAILURE_STDOUT_PATTERNS) {
    if (re.test(stdout)) return 'failure';
  }
  return 'success';
}

function editOutcome(tool_response) {
  // Edit/Write/MultiEdit: Claude Code returns errors via JSON-RPC error path,
  // not as the tool_response body. If we reach PostToolUse with any object
  // response, the edit succeeded. Defensively also catch string responses
  // that start with "Error" in case the harness changes shape.
  if (typeof tool_response === 'string' && /^Error/i.test(tool_response)) {
    return 'failure';
  }
  if (typeof tool_response === 'object' && tool_response !== null) {
    return 'success';
  }
  return null;
}

function detectOutcome(tool_name, tool_response) {
  if (!tool_response) return null;

  // Universal signal: interrupted is always failure
  if (typeof tool_response === 'object' && tool_response.interrupted === true) {
    return 'failure';
  }

  switch (tool_name) {
    case 'Bash':
      return typeof tool_response === 'object' ? bashOutcome(tool_response) : null;
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return editOutcome(tool_response);
    default:
      return null;
  }
}

module.exports = { detectOutcome };
