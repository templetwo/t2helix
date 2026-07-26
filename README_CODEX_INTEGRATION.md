# T2Helix for Codex

Codex can join the same local T2Helix chronicle used by Claude Code. The connector registers the existing stdio MCP server, points it at the shared SQLite data directory, and installs standing Codex instructions for recall and advisory compass checks.

This is shared memory, not a second database:

```text
Claude Code hooks ─┐
                   ├─ ~/.claude/plugins/data/t2helix-templetwo-t2helix/chronicle.db
Codex MCP tools ───┘
```

## Install

Use the Node runtime for which this checkout's `better-sqlite3` was built, then initialize:

```bash
cd ~/t2helix
nvm use 20                 # use the compatible installed runtime
npm run codex:init
```

`codex:init`:

1. backs up `~/.codex/config.toml` before changing it;
2. adds one marker-owned `[mcp_servers.t2helix]` block using stdio transport;
3. preserves every existing MCP server and all unrelated Codex settings;
4. extends—not replaces—`~/.codex/instructions.md` with a marker-owned discipline block;
5. points both adapter and MCP server at Claude's existing T2Helix data directory;
6. refuses to write config unless the selected Node process can load the native driver and query the chronicle schema.

The edit is idempotent. A second identical init is a byte-for-byte no-op and creates no duplicate block. If an older unmarked `[mcp_servers.t2helix]` section exists, init replaces that section once.

Restart Codex after init so it reloads MCP configuration and standing instructions.

## Use

At the start of non-trivial work, Codex's installed instructions tell it to call:

- `get_state` for the current shared goal, threads, and recent insights;
- `recall` with a short task-specific query;
- `set_goal` when the objective should persist;
- `record` for durable decisions or findings;
- `dry_run_compass` / `explain_compass` before destructive or high-impact actions.

Direct adapter smoke/diagnostic commands are also available:

```bash
npm run codex:boot -- "current connector work"
npm run codex:test
```

From Node:

```js
const {
  codexBoot,
  codexRecall,
  codexRecord,
  codexCompassCheck
} = require('./lib/codex-adapter');

await codexBoot({ query: 'current connector work' });
codexRecall('past decisions about MCP transport');
codexRecord('Codex verified the stdio connector', { layer: 'ground_truth' });
codexCompassCheck({
  tool_name: 'Bash',
  tool_input: { command: 'git push --force' }
});
```

The direct adapter uses the same `lib/chronicle.js` and Compass V2 implementation as the MCP server. Normal Codex usage should prefer MCP tools because those are the registered integration surface.

## What this does NOT give you

Codex has no equivalents of T2Helix's two load-bearing Claude Code hooks.

- **No automatic recall.** Claude Code's `UserPromptSubmit` hook injects recall on every prompt. Codex must choose to call `get_state` / `recall`. The standing instructions make this a discipline, not a guarantee.
- **No pre-tool interception.** Claude Code's `PreToolUse` hook sees an action before execution. Codex MCP tools cannot intercept Codex's other tool calls.
- **No enforced compass.** `dry_run_compass`, `explain_compass`, and `codexCompassCheck` are advisory. A WITNESS result cannot technically deny a Codex command, and a PAUSE result cannot force an approval loop. Codex or its operator must voluntarily stop.
- **No automatic action/outcome chain.** Without `PostToolUse` and `Stop` hooks, Codex actions and session outcomes are not automatically written or auto-distilled. Codex must explicitly record durable information.
- **No true Codex session signature.** The MCP server reads `.current_session`, which Claude hooks maintain. In a Codex-only flow it can inherit the last Claude session id or fall back to `mcp-session`; the current MCP lifecycle does not supply a Codex session UUID.

Do not describe this connector as a safety boundary. It provides shared memory plus policy advice. The standing instructions reduce accidental omission, but they do not enforce behavior and must never be used to claim that WITNESS actions are impossible.

## Files and recovery

The initializer owns only text between these markers:

```text
# >>> T2HELIX CODEX CONNECTOR >>>
# <<< T2HELIX CODEX CONNECTOR <<<
```

and the equivalent HTML-comment markers in `instructions.md`. Config backups are named like:

```text
~/.codex/config.toml.t2helix-backup-<timestamp>-<pid>
```

To disable the connector, remove the marker-owned config/instruction blocks and restart Codex. To restore a prior config, copy the desired backup over `~/.codex/config.toml` while Codex is stopped.

## Native module note

T2Helix uses `better-sqlite3`. The Node binary written into Codex config is the exact `process.execPath` that ran `codex:init`, avoiding later PATH drift. Run init using a Node runtime compatible with the checkout's installed native addon. After changing Node major versions, run `npm run rebuild`, rerun `npm run codex:init`, and restart Codex.
