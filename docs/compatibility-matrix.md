# T2Helix Compatibility Matrix

## Node.js versions

| Node | Status | Notes |
|------|--------|-------|
| 20 LTS | CI-tested | Minimum supported version (`engines.node: ">=20 <27"`) |
| 22 LTS | CI-tested | |
| 24 | CI-tested | |
| 26 | CI-tested | Check `npm run rebuild` after ABI bump |

All versions require `npm run rebuild` after a Node major-version upgrade
(`better-sqlite3` is a native addon; see the [native-module landmine](../CLAUDE.md)).

## MCP transports

| Transport | Status | Notes |
|-----------|--------|-------|
| stdio | CI-tested | Default plugin path; regression suite covers all 13 tools |
| SSE (HTTP) | CI-tested (v0.7.0) | `--transport sse --port <N>`; use port 0 for ephemeral; SSE contract suite |

The SSE transport is a thin wrapper around the same `handleToolCall()` function
used by the stdio transport. Both expose the same 13-tool contract and the same
chronicle backend.

## MCP clients

| Client | Transport | Status | Notes |
|--------|-----------|--------|-------|
| Claude Code (plugin) | stdio | Tested | Primary use-case; hooks wired by `claude plugin install` |
| Standalone MCP client | stdio | Supported | `node mcp/server.js` (default) |
| Standalone MCP client | SSE | Supported | `node mcp/server.js --transport sse --port 3742` |
| Non-Claude-Code tools | SSE | Supported | GET /sse → endpoint event → POST /messages |

## Manifest portability (v0.7.0)

| Feature | Status |
|---------|--------|
| Export: `node scripts/export.js` | Supported |
| Import: `node scripts/import.js <manifest>` | Supported |
| Round-trip (export → fresh dir → import → verify) | Tested in smoke suite |
| Chronicle snapshot (`--snapshot` flag on export) | Supported (WAL-safe `db.backup()`) |

## Known constraints

- `better-sqlite3` is a native addon and requires recompilation after a Node major version bump. Run `npm run rebuild`.
- The SSE transport is deprecated upstream (SDK 1.29.0 marks `SSEServerTransport` deprecated; `StreamableHTTPServerTransport` is the successor). T2Helix ships SSE for now; migration is tracked as a future item.
- Rule import is intentionally not supported: rules travel via `.t2helix/policy.json` (git-tracked) or the bundled rules file, not via the manifest. The manifest exports rules for audit/documentation only.
