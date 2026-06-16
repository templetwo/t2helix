# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

T2Helix is a **Claude Code plugin** (not an app): five hooks (`hooks/hooks.json`) plus
an in-process MCP server that give Claude Code persistent recall and a pre-action
compass, backed by a local SQLite chronicle. The two load-bearing hooks are recall
(UserPromptSubmit) and compass (PreToolUse); PostToolUse, PreCompact, and Stop round out
the helix. It is installed via `claude plugin marketplace add` /
`claude plugin install` — Claude Code wires the hooks and MCP server itself. There is
no build step and no transpile; the runtime is plain CommonJS on Node 20–26.

## Commands

```bash
npm test            # full suite: smoke + regression + integration (184 tests)
npm run smoke       # lib unit tests (chronicle CRUD, FTS, compass rules, coupling, redaction)
npm run regression  # MCP tool contract over stdio JSON-RPC
npm run integration # spawns the real hooks; asserts shipped wiring + PAUSE override loop + scrub
npm run serve       # run the MCP server in SSE mode on :3742 (for non-Claude-Code clients)
npm run rebuild     # npm rebuild better-sqlite3 (after a Node major-version bump)
npm run redact-sweep -- --dry-run --data-dir <dir>   # preview the one-shot credential scrub (v0.2)
```

Each test file is a standalone Node script — run one directly with `node test/smoke.js`
(likewise `regression.js` / `integration.js`). They assert with `node:assert` and each
allocates its own isolated temp data dir, so they are safe to run in any order. There is
no test runner/framework and no lint/format config — match the existing style by hand.

## The native-module landmine

The chronicle is backed by `better-sqlite3`, a native addon compiled against your Node
ABI. A Node major-version upgrade breaks the binding (`ERR_DLOPEN_FAILED` /
`NODE_MODULE_VERSION` mismatch) and silently disables recall. `lib/chronicle.js` loads
the driver **lazily and defensively** (`loadDriver()`, not a top-level `require`) for one
reason: every hook requires this module at load time, so a top-level throw would escape
the hook's `try/catch` and break the host CLI — violating fail-open. If recall/compass go
quiet, run `npm run rebuild`. Do not move the `require('better-sqlite3')` to module top.

## Architecture: the helix

Two halves that feed each other:

- **Memory** — `lib/chronicle.js` owns the entire SQLite layer (schema in
  `lib/schema.sql`): `insights` (+ FTS5 external-content mirror via triggers), `goals`,
  `threads`, `compass_log`, `pending_confirmations`. `recall()` is FTS5 + recency-weighted
  composite ranking, **not** plain recency.
- **Compass** — `lib/compass.js` classifies a proposed tool call against
  `lib/rules/compass-rules.json` into `OPEN` / `PAUSE` / `WITNESS`. Pure regex over a
  per-tool "action string"; reads no DB, so rule-based gating survives a DB outage.

They couple through two named criteria:

- **memory → compass** (`lib/coupling.js`): when rules return `OPEN`, PreToolUse recalls
  *similar* past actions and `escalateByMemory()` may upgrade `OPEN → PAUSE` if enough of
  them are tagged `outcome:failure`. Escalation is one-directional and bounded — memory
  can warn (OPEN→PAUSE only), never absolve (never downgrade) and never reach WITNESS.
- **compass → memory** (`recordCompassFire` + `lib/outcome.js`): every non-OPEN fire
  writes a chronicle entry tagged `action:<hash>`; PostToolUse tags the resulting outcome
  entry with the *same* `action:<hash>`. Recall by that tag returns both ends of the chain
  — what the compass judged and what then happened.

### Recall surfacing & boundary-active goal (v0.3, the "method-surfacing" stage)

`lib/surface.js` is pure, unit-tested selection logic the UserPromptSubmit hook delegates
to. Its **cardinal rule**: total injected volume on a normal prompt goes *down* vs v0.2.
It surfaces at most a goal line + ≤1 relevant **method** + ≤3 relevance-filtered insights,
gates conversational/ack prompts (and verb-led acks) out of the generic recall entirely,
and trims harder when a goal already anchors context. Methods (`domain:'method'`, written
by `record_method`) carry `[method] <shape>` + steps + `Acceptance:` and surface *only*
via a targeted slug-overlap lookup — never the generic firehose. A smoke test asserts the
volume claim in characters, not item counts.

`lib/goal-progress.js` (also pure) backs the boundary-active goal: a goal may carry
`acceptance_criteria`; `set_goal` returns a non-blocking `decomposition_hint` when it has
none. At Stop (once, never per-tool) `assessCriteria` emits a *soft* per-criterion note —
token overlap against the session's own insights, rendered `[~] … (related: #id)`, which
means "mentioned", not "done". `getSessionInsights` feeds it and deliberately excludes
`archived-goal` rows (else the archived copy of the criteria is phantom evidence).

### Classifications

- `OPEN` — allowed (empty hook output).
- `WITNESS` — **hard deny, no override**: `rm -rf` wildcards, `git push --force`,
  `git reset --hard`, `drop table/database`, prod-mutating `kubectl/terraform/helm/aws/
  gcloud` (read-only verbs like get/list/describe are deliberately *not* gated),
  `--no-verify`. Changing these requires editing `compass-rules.json`.
- `PAUSE` — **soft deny with a single-use token override** (credential-shaped patterns).
  See the override flow below.

### PAUSE override flow (the non-obvious part)

Under `defaultMode: bypassPermissions`, Claude Code silently overrides
`permissionDecision: ask`, so PAUSE cannot use `ask` and still mean anything. Instead
PreToolUse returns `deny` and mints a `pending_confirmations` row keyed by
`(session_id, sha256(action_summary))`, surfacing the token in the deny reason. To
proceed: call `mcp__t2helix__confirm_pending` with the token, then **retry the identical
action within 10 minutes**. The retry finds the approval, consumes it atomically
(`consumeApproval` is a compare-and-swap `status='approved' → 'used'`, so a token can
never be double-spent across racing hook processes), and re-logs the call as `OPEN`.

## The fail-open / fail-safe contract (the invariant that governs every hook)

Hooks must **never break the host CLI**. Every hook (`hooks/*.js`) has the same shape:
a `main()` wrapped in `try/catch` that always writes `{}` and exits 0, plus a
`main().catch()` last-resort fail-open. When editing hooks, preserve this: an unexpected
throw becomes "allow + continue," never a crash. The one deliberate exception is gating
safety — `classify()` reads only the rules file, so even with the DB dead the headline
denials (`rm -rf /`, force-push, drop-table) still fire (fail-*safe*), while the
memory-coupling escalation merely degrades to silent.

`stderr` is used to make *dropped writes visible* without breaking flow (e.g. a dropped
`recordCompassFire` would otherwise leave a misleading half-chain). Keep that pattern:
fail open on the control path, but log the drop.

## Secret redaction — the ONE inverted fail-open path (v0.2)

`lib/secrets.js` is the single source of truth for credential patterns. One `PATTERNS`
table drives BOTH masking (`REDACTORS`) and classification (`DETECTION_REGEX`), so the
detector can't flag a credential value the redactor fails to mask — the invariant that
keeps "detected but persisted raw" from happening. The compass binds to it via
`"pattern_source": "secrets"` on the `credential-paste` rule. `secrets.scrub()` (pattern
redaction + a fixed-point backstop that coarse-masks any field still holding a maskable
secret) runs inside the **three** write chokepoints — `record()`, `logCompass()`, and
`createPendingConfirmation()` — so every write to `insights`, `compass_log`, and
`pending_confirmations` is scrubbed (a secret span becomes
`[REDACTED:<kind>:<8-hex of sha256(secret)>]`). **Here and only here we invert fail-open:
if `scrub` throws, the write is dropped/marked, never persisted raw.** If you add a write
path that bypasses those three, route it through `secrets.scrub` too. `createPendingConfirmation`
hashes the **raw** summary (so `findApproval` still matches) but stores the scrubbed text.
Bare hashes (git SHAs) and `tokenizer=`/`tokens=` are intentionally not redacted — only
labelled/prefixed/structured secrets. `npm run redact-sweep` retro-scrubs pre-0.2 rows
across all three tables (consistent `db.backup()` first; refuses the fallback dir unless
explicit).

## Session-ID unification (why MCP writes are visible to hook reads)

Every chronicle row is keyed by `session_id`. Hooks receive Claude Code's real session
UUID on stdin and persist it to `<dataDir>/.current_session`. The MCP server has no
per-call session_id, so it reads that file to use the **same** signature. Without this,
MCP-side writes (e.g. `set_goal`) would key under a fallback constant and be invisible to
the recall hook — the "no session goal" pathology of pre-0.0.4 builds. If you touch
session resolution, keep hooks and MCP server reading the same file.

## Where state lives (data dir resolution, highest precedence first)

1. `T2HELIX_DATA_DIR` — manual override (also the only path that loads user compass rules
   from `<dir>/compass/rules.json`; otherwise the bundled `lib/rules/compass-rules.json`
   is used).
2. `CLAUDE_PLUGIN_DATA` — set by Claude Code; resolves to
   `~/.claude/plugins/data/t2helix-<marketplace>/`.
3. `~/.t2helix-data/` — standalone fallback (NOT the path you want under Claude Code).

Contains `chronicle.db` (WAL mode, FTS5, `busy_timeout=1500` so a contended write
fails-open inside the 5s hook budget instead of being killed mid-write) and
`.current_session`. It lives outside the plugin install so it survives updates.

## MCP server

`mcp/server.js` is hand-rolled JSON-RPC (no SDK transport abstraction beyond the schema
types) exposing ten tools — `recall`, `record`, `record_method`, `set_goal`,
`open_thread`, `resolve_thread`, `get_state`, `recall_compass`, `confirm_pending`,
`list_pending`. Each maps to a `lib/chronicle.js` function. Default transport is `stdio` (the plugin path);
`--transport sse --port 3742` serves any other MCP client from the same data dir. Both can
run simultaneously. When adding a tool, update `TOOLS` (schema), the dispatch switch, and
the regression contract test.

## Conventions worth keeping

- **Meta-domain hygiene**: hook-written entries use domains `session-action` /
  `session-synthesis` / `compass-fire` (v0.2) / `method` (v0.3) and are excluded from
  `recall()` / `get_state()` by default so curated content surfaces first. `method` is
  here so methods surface ONLY via the targeted lookup, never the generic firehose
  (the Stage-2 cardinal rule). Pass `include_meta:true` to see meta entries — the helix
  coupling and the method lookup already do. New hook-noise domains should be added to
  `META_DOMAINS` in `chronicle.js`. (`session-compact` PreCompact snapshots are a
  candidate for the same treatment.)
- **FTS query sanitization**: `recall()` quotes each token as an FTS5 string literal
  because action summaries contain `:`/`-`/`(` which FTS5 parses as operators (a bare
  `Bash: git…` query throws "no such column: Bash"). Don't pass raw user/action strings
  into a `MATCH` unquoted.
- **Layers**: `ground_truth` (confirmed) / `hypothesis` (in-progress, default) /
  `reflection` (syntheses, archived goals, compass-fires).
- The chronicle is **append-only today** — no row is updated or deleted, but the FTS
  delete/update triggers exist so the first future prune/redaction path won't silently
  desync the index.
