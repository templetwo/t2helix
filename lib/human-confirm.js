'use strict';

// lib/human-confirm.js — the human-confirm switch, in one place.
//
// T2HELIX_REQUIRE_HUMAN_CONFIRM is read on every call, from the environment of
// the process asking: the process that approves (lib/chronicle.js), and the
// processes that write model-facing text about approval (the MCP server's
// list_pending, the PreToolUse deny message, the memory-coupling reason, the
// Grok adapter). Each of them follows its OWN environment, so the switch has to
// be set wherever those run. Kept dependency-free so lib/coupling.js and
// lib/decision-message.js can read it without loading the SQLite layer.
//
// While the switch is on, approval is an allowlist of one origin: HUMAN_ORIGIN,
// the terminal path. Matching is exact (after the trim normalizeApprovalOrigin
// applies); no surface passes 'CLI', so 'CLI' is not a human origin.

const HUMAN_ORIGIN = 'cli';

function requireHumanConfirm() {
  const v = String(process.env.T2HELIX_REQUIRE_HUMAN_CONFIRM || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

// One sentence the model may read, shared by every surface that would otherwise
// point it at confirm_pending. It names no script, no path and no token: the
// reader is the party being gated.
const HUMAN_APPROVAL_SENTENCE =
  'Approval is a human\'s, from a terminal outside the agent session; this session cannot approve it.';

module.exports = { HUMAN_ORIGIN, requireHumanConfirm, HUMAN_APPROVAL_SENTENCE };
