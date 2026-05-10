# T2Helix

Persistent recall and pre-action compass for Claude Code, running locally on your machine.

## What it does (v0.0.1)

Two hooks integrated into Claude Code's agent loop:

- **UserPromptSubmit** → recall: searches a local SQLite chronicle for past insights related to your prompt, plus the current session goal, and injects the result as additional context.
- **PreToolUse** → compass: matches the proposed tool action against a rule set. Destructive operations (rm -rf wildcards, `git push --force`, `drop table`, prod-context deploys, `--no-verify`) are blocked with a clear reason. Edits without a session goal trigger a soft "ask" prompt.

Plus an in-process MCP server exposing five tools so Claude can write back: `recall`, `record`, `set_goal`, `open_thread`, `get_state`.

## Where state lives

`~/.t2helix-data/chronicle.db` by default (SQLite, WAL mode, FTS5 indexed). Set `T2HELIX_DATA_DIR` to override. The path lives outside the plugin install, so it survives plugin updates and Claude Code session boundaries.

## Status

v0.0.3 — recall + compass + MCP server registration. PostToolBatch goal coherence, PreCompact archive, and Stop session synthesis ship in v0.2+. The `edit-no-context` rule moved to `lib/rules/optional.json` in v0.0.2 pending the goal-anchor skill (v0.1+).
