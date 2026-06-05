# Changelog

All notable changes to t2helix are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versioning is [SemVer](https://semver.org/).

## [0.1.0] — 2026-06-04

The helix earns its name: memory and compass couple end-to-end. This release
also fixes the bug that made that coupling silently inert in practice, plus a
sweep of robustness/safety hardening surfaced by a full readiness audit.

### Fixed
- **Memory→compass coupling was inert in production (criterion #2).** `recall()`
  built an invalid FTS5 query for command-shaped inputs (`Bash: git commit -m x`)
  — the `:`/`-`/`(` were parsed as FTS operators, the query threw, and a silent
  recency fallback returned the *most recent* entries instead of the *most
  similar* ones. The compass escalation then reasoned over an unrelated sample.
  FTS tokens are now quoted as string literals; retrieval matches by similarity.
  A degraded fallback now logs to stderr instead of hiding.
- **A broken native binding could crash every hook before fail-open.** The
  top-level `require('better-sqlite3')` is now lazy/guarded; an ABI mismatch
  (`NODE_MODULE_VERSION`) surfaces a tagged, actionable error at first DB touch
  instead of a load-time crash. PreToolUse was restructured so **rules-based
  gating survives a DB outage** — `rm -rf /` / force-push / drop-table are still
  denied even when the binding is unavailable; only memory coupling degrades.
- **Single-use approval tokens could be double-spent** under concurrent hook
  processes. `consumeApproval()` is now an atomic compare-and-swap.
- **Data dir could land at a CWD-relative path** when `$HOME` was unset. Now uses
  `os.homedir()` (with an absolute `os.tmpdir()` last resort).
- **`deploy-prod` WITNESS rule hard-denied read-only commands** (`kubectl get -n
  production`, `aws s3 ls s3://prod-logs`). It now requires a mutating verb.

### Added
- Lazy native-driver loader with an actionable rebuild hint; `npm run rebuild`.
- `busy_timeout = 1500` (explicit, under the 5s hook budget); dropped chain
  writes now log to stderr instead of being swallowed.
- MCP boundary hardening: numeric/`0` coercion (`??` not `||`, numeric-string
  coercion) and `-32602` on missing required fields.
- FTS5 `AFTER DELETE` / `AFTER UPDATE` triggers (additive; future-proofs the
  index against any later redaction/retention path).
- `deploy-prod` rule hardened after independent (Grok + Antigravity) review:
  command segments are newline-bounded (a multi-line command can no longer hide
  a mutation behind a read-only verb on another line), the mutating-verb set was
  widened (`run`/`start`/`stop`/`import`/`edit`/`cp`/…), and read-only verbs must
  be standalone words (a resource named `get-prod` no longer shields a `delete`).
- **Hooks integration test suite** (`npm run integration`) — spawns the real
  PreToolUse/PostToolUse scripts and asserts the shipped wiring: OPEN/WITNESS/
  PAUSE payloads, the full PAUSE override loop, fail-open on adversarial input,
  and fail-safe gating with a broken native binding. Plus FTS-similarity,
  atomic-consume, deploy-prod, and MCP-coercion tests. **135 tests total.**
- `tools/witness-relay/` — cross-agent relay monitors (chronicle as a message
  bus), moved out of the repo root and documented.

### Changed
- README brought current (nine MCP tools, Node 20–26, test counts, data-dir
  naming, native-module troubleshooting).

### Known / deferred (documented, not fixed in 0.1.0)
Low-severity items from the audit, recorded for a later pass:
- `pending_confirmations` / `compass_log` grow unbounded (no pruning/retention).
- `recall()` tag filter uses `LIKE` with unescaped `%`/`_` — fine for the current
  controlled tag vocabulary; would over/under-match if tags ever open up.
- PAUSE with an existing approval is denied if the approval *read* fails (safe
  direction; diagnostic friction only).
- MCP raw error messages are forwarded to the client; logical-failure tool
  results don't set `isError`.
- `recall` declares `query` required but has a reachable no-query listing mode.
- No concurrency test for parallel hook writes (default `busy_timeout` absorbs it).
- Compass rules match the literal command string, so shell **aliases** (`k=kubectl`)
  and runtime expansions are not resolved — inherent to a regex gate, not a regression.

## [0.0.6] and earlier
See git history. 0.0.x established the five hooks, the nine-tool MCP server, the
PAUSE token-override flow, session-id unification, and the helix criteria commits
(outcome detection, coupling policy, compass→memory writes, `action:<hash>` chain)
— which landed on `main` but, prior to 0.1.0, had not been deployed to the live
plugin cache.
