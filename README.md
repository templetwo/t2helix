# T2Helix

Persistent recall and pre-action compass for Claude Code, running locally on your machine.

## Install

**Requires Node 20–25.** Node v26+ is not yet supported by the SQLite dependency.

```bash
# Use Node 22 LTS (recommended)
nvm use 22

# Add the T2Helix marketplace and install
claude plugin marketplace add https://github.com/templetwo/t2helix
claude plugin install t2helix
```

That's it. Claude Code will handle hooks and MCP server registration automatically.

## What it does

Two hooks integrated into Claude Code's agent loop:

- **UserPromptSubmit** → recall: searches a local SQLite chronicle for past insights related to your prompt, plus the current session goal, and injects the result as additional context. Writes the current `session_id` to a state file so the MCP server can use the same signature.
- **PreToolUse** → compass: matches the proposed tool action against a rule set. **WITNESS** classifications (rm -rf wildcards, `git push --force`, `drop table`, prod-context deploys, `--no-verify`) are hard-denied. **PAUSE** classifications (credential-shaped patterns) are soft-denied with an override token — see "PAUSE override flow" below.

Plus an in-process MCP server exposing eight tools:

| Tool | Purpose |
|------|---------|
| `recall` | Search the chronicle for past insights by query (FTS5 + recency-weighted). |
| `record` | Write a new insight inline. |
| `set_goal` | Anchor a session goal. Archives any prior goal as a `reflection`-layer insight tagged `archived-goal`. |
| `open_thread` | Capture an unresolved question to revisit later. |
| `get_state` | Read current goal + recent open threads + recent insights. |
| `recall_compass` | Query the compass log of past PreToolUse classifications (filter by classification, matched_only, limit). |
| `confirm_pending` | Approve a pending PAUSE confirmation by token. Single-use; the retry consumes the approval. |
| `list_pending` | Review unexpired pending/approved/used confirmation requests. |

## PAUSE override flow

Under `defaultMode: bypassPermissions` (the typical Claude Code config), `permissionDecision: ask` is silently overridden by the harness. To preserve a real safety surface for PAUSE-classified actions, T2Helix routes PAUSE through `deny` with a token-based override:

1. Tool call matches a PAUSE rule (e.g., a `-----BEGIN RSA PRIVATE KEY-----` pattern in a Bash command).
2. Hook creates a `pending_confirmations` row keyed by `(session_id, sha256(action_summary))`, returns `deny` with the token in the reason text.
3. To approve: call `mcp__t2helix__confirm_pending` with the token.
4. Retry the original action within 10 minutes. Hook finds the matching approval, consumes it, lets the call through, and re-logs in `compass_log` as OPEN with `reason: "approved via token X (consumed)"`.
5. The approval is single-use. A new approval is needed for another retry.

WITNESS has no override path — those operations require manual rule edits.

## Where state lives

Under Claude Code (the normal install path), data lives at:

```
~/.claude/plugins/data/t2helix-inline/
```

The full resolution order (highest precedence first):

1. `T2HELIX_DATA_DIR` — manual override
2. `CLAUDE_PLUGIN_DATA` — set by Claude Code when running as a plugin; resolves to `~/.claude/plugins/data/t2helix-inline/`
3. `~/.t2helix-data/` — standalone fallback when neither env var is set (not the path you want under Claude Code)

Inside the data dir: `chronicle.db` (SQLite, WAL mode, FTS5 indexed) and `.current_session` (the active `session_id`, written by the hooks so the MCP server can use the same signature). The path lives outside the plugin install, so it survives plugin updates and Claude Code session boundaries.

## Session signature

Every chronicle write (goal, insight, thread, compass log row, pending confirmation) is keyed by a `session_id`. The hooks receive Claude Code's real session UUID from stdin and persist it to `.current_session`. The MCP server reads that file in its `sessionId()` resolution chain, so MCP tool calls write under the same signature the hooks use. Without this unification, MCP-side writes (like `set_goal`) would key under a fallback constant and be invisible to hook-side reads (the recall hook's "no session goal" pathology in pre-0.0.4 builds).

## Tests

```bash
npm run smoke
```

Runs `test/smoke.js` against an isolated temp data dir. Covers compass rule classifications, chronicle CRUD, session-state file round-trip, `setGoal` preserve-prior behavior, `getCompassHistory` filters, the full `pending_confirmations` lifecycle, cross-session isolation, and single-use enforcement. 44 tests.

## Status

**v0.0.5** — five hooks, full session arc:

- Recall hook (UserPromptSubmit) + compass hook (PreToolUse)
- PostToolUse hook — records significant tool actions (Bash, Edit, Write, MultiEdit) to the chronicle
- PreCompact hook — archives goal + open threads + insight count before context compression
- Stop hook — writes session synthesis on close (goal, threads, compass summary)
- MCP server with eight tools
- PAUSE soft-deny with token-based override (`pending_confirmations` table, `confirm_pending` tool, single-use enforcement)
- `recall_compass` — read your own compass gate history
- Session ID unification via `.current_session` file — MCP writes and hook writes key under the same session UUID
- `set_goal` preserve-prior — prior goal archived as a `reflection`-layer insight before overwrite
- 44 smoke tests

Coming in v0.1+: goal-anchor skill. The `edit-no-context` compass rule ships in v0.1 pending the goal-anchor skill.
