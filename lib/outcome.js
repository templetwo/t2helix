'use strict';

// Outcome detection for PostToolUse — the substrate the helix coupling reads.
//
// Returns one of: 'success' | 'failure' | null
//   'success' — a clean accepted response
//   'failure' — only `interrupted`, and Edit/Write error strings
//   null      — unknown tools, ambiguous text, backgrounded or
//               harness-interpreted responses; do NOT tag
//
// The PostToolUse payload carries no exit code and the harness delivers only
// accepted calls, so text is never a failure signal here. Per the helix plan,
// still: "No clever inference."
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

// PostToolUse receives only calls the harness accepted, and the payload carries
// no exit status (Claude Code 2.1.x; the command's stderr arrives mixed into
// stdout). Failure text on an accepted call is ambiguous: a deliberate RED test
// run, a brief that says a test FAILS, a quoted traceback, or a real crash whose
// exit code a pipe hid. The contract for ambiguous is null, not a label. A
// command moved to the background (timeout or run_in_background) has no outcome
// yet. Real failures never reach this hook (they fire PostToolUseFailure, which
// this plugin does not register yet).
const FAILURE_TEXT_PATTERNS = [...FAILURE_STDERR_PATTERNS, ...FAILURE_STDOUT_PATTERNS];

function bashOutcome(r) {
  if (r.interrupted === true) return 'failure';
  if (r.backgroundTaskId != null || r.timedOutAfterMs != null || r.backgroundedByUser === true) return null;
  if (r.returnCodeInterpretation != null) return null;
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  if (FAILURE_TEXT_PATTERNS.some(re => re.test(text))) return null;
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

module.exports = { detectOutcome, FAILURE_TEXT_PATTERNS };
