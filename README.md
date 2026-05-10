# T2Helix

Persistent recall and pre-action compass for Claude Code, running locally on your machine.

## What it does (v0.0.1)

Two hooks integrated into Claude Code's agent loop:

- **UserPromptSubmit** → recall: searches a local SQLite chronicle for past insights related to your prompt, plus the current session goal, and injects the result as additional context.
- **PreToolUse** → compass: matches the proposed tool action against a rule set. Destructive operations (rm -rf wildcards, `git push --force`, `drop table`, prod-context deploys, `--no-verify`) are blocked with a clear reason. Edits without a session goal trigger a soft "ask" prompt.

Plus an in-process MCP server exposing five tools so Claude can write back: `recall`, `record`, `set_goal`, `open_thread`, `get_state`.

## Where state lives

`${CLAUDE_PLUGIN_DATA}/chronicle.db` (SQLite, WAL mode). Falls back to `~/.t2helix-data/chronicle.db` outside the plugin context, or `$T2HELIX_DATA_DIR` if set. The chronicle survives plugin updates and Claude Code session boundaries.

## Status

v0.0.1 — recall + compass only. PostToolBatch goal coherence, PreCompact archive, and Stop session synthesis ship in v0.2+.
