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
npm test            # full suite: all 20 test files in package.json (661 tests at 0.14.0)
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
`NODE_MODULE_VERSION` mismatch). **Root trap:** `require('better-sqlite3')` only loads
the JS wrapper — the `.node` is dlopened inside `new Database(...)`. Any probe that stops
at `require()` reports false GREEN under the wrong ABI. `loadDriver()` /
`lib/native-binding.js` force a throwaway `:memory:` open. Hooks still load the driver
**lazily** (not at module top) so a throw cannot break the host CLI. MCP is fail-loud on
start and should launch via `scripts/mcp-launch.js` (re-execs a compatible Node when PATH
is wrong; writes/reads `.native-abi.json` via `npm run rebuild`). Do not move the driver
require to module top.

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

**The action-identity invariant.** Both hooks derive that hash independently —
PreToolUse from `classifyV2().action_summary`, PostToolUse from
`compass.summarizeAction()` — so those two strings must stay byte-identical. They are
also the pending-confirmation key and the recall query for the memory coupling. Nothing
that normalizes, reorders, or prettifies a command may be routed into `action_summary`;
Compass V2 keeps its IR rendering in a separate `display_summary` used only for operator
messages (see `docs/compass-v2.md`). Divergence here fails *silently* — no error, the
chain just stops pairing — which is why `test/compass-v2.js` asserts hash equality across
all three V2 modes.

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

### Auto-distill (v0.4, the "Stage 3" capability)

`lib/distill.js` (pure) lets the Stop hook write a method *without being asked* — it
distills a candidate from a successful session. The Stop hook is a **high-frequency
writer**, so the hard rule (from the v0.1 compass-fire pollution, chronicle #2381/#2382)
is that a distilled candidate must surface **nothing** until a human promotes it —
*invisibility until promotion*, not merely lower rank. Mechanism: candidates live in
their **own `method_candidates` table** (not `insights`), so they cannot enter recall /
FTS / the targeted method lookup at all; injected volume cannot rise from auto-distill.
`distillCandidate` is conservative (needs a goal with `acceptance_criteria`, real
`outcome:success` with **zero** `outcome:failure`, and a majority of criteria addressed —
most sessions distill nothing). The promote-to-trusted gate (`promote_method`) is the
only path onto the surfaced store and is **append-only**: it writes a fresh `ground_truth`
`domain:'method'` insight tagged `source:promoted` (CAS-guarded against double-promote),
never mutating a row. `list_method_candidates` is the review queue; `dismiss_method_candidate`
rejects. See `docs/stage3-auto-distill.md`. Auto-*promotion* is deliberately out of scope —
ship explicit-only, measure the generated-vs-promoted ratio first.

### Classifications

- `OPEN` — allowed (empty hook output).
- `NOT_EVALUATED` — **the compass reached no verdict**: unreadable payload, throwing
  classifier, or a rule budget that ran out mid-list. Denies, no override token, and
  writes a `compass_log` row so "never evaluated" is distinguishable from "allowed".
- `WITNESS` — **hard deny, no override**: `rm -rf` wildcards, `git push --force`,
  `git reset --hard`, `drop table/database`, prod-mutating `kubectl/terraform/helm/aws/
  gcloud` (read-only verbs like get/list/describe are deliberately *not* gated),
  `--no-verify`, a shell command that runs `approve-pending` (the human approval path;
  invocations only since 0.14.0, so `git add` / `git log --` / a commit message that
  mentions the file is not denied).
  Changing these requires editing `compass-rules.json`.
- `PAUSE` — **soft deny with a single-use token override** (credential-shaped patterns).
  See the override flow below.

### PAUSE override flow (the non-obvious part)

Under `defaultMode: bypassPermissions`, Claude Code silently overrides
`permissionDecision: ask`, so PAUSE cannot use `ask` and still mean anything. Instead
PreToolUse returns `deny` and mints a `pending_confirmations` row keyed by
`(session_id, sha256(action_summary))`, naming that request by **id** in the deny reason.
The token is not in the deny reason — that string is read by the party being denied, and
a gate does not hand over the credential that lifts it. To proceed: find the request with
`list_pending`, call `mcp__t2helix__confirm_pending` with its token, then **retry the
identical action within 10 minutes**. Approvals record where they came from
(`approved_origin`, `approved_tty`), and the retry's `compass_log` row carries
`user_override: "token:<id> origin=<origin>"`, so an approval that arrived over the
model-facing MCP surface is legible as one. The retry consumes the approval atomically
(`consumeApproval` is a compare-and-swap `status='approved' → 'used'`, so a token can
never be double-spent across racing hook processes), and re-logs the call as `OPEN`.

`T2HELIX_REQUIRE_HUMAN_CONFIRM=1` (default off; also `true`/`on`, read by
`lib/human-confirm.js`) makes `approveConfirmation` an allowlist of one origin, `cli`:
`mcp`, `unattributed` and every other origin is refused and the row stays pending. Under
the switch `list_pending` withholds tokens, and the PAUSE deny text, the coupling reason
and the Grok adapter say approval is a human's from a terminal (no script, path or token).
Each of those reads the switch in its own process, so it must be set wherever the MCP
server, the hooks and the adapter run. A human approves outside the agent session with
`T2HELIX_DATA_DIR="$HOME/.claude/plugins/data/t2helix-<marketplace>" node
scripts/approve-pending.js <token>` (origin `cli`; `--list` shows pending tokens; a bare
run is refused with exit 2, and so is any run without a TTY stdin or with a Claude Code
session marker such as `CLAUDECODE` set, before any store is opened). It closes every in-process route except the terminal one.
Against an agent with a shell and write access to the
store it is a speed bump, not a wall: the refusal text names neither the script nor the
listing, and the `approve-pending-script` WITNESS rule denies a shell command that runs
the script where the PreToolUse hook runs.

## The fail-open / fail-safe contract (the invariant that governs every hook)

Hooks must **never break the host CLI**. Every hook (`hooks/*.js`) has the same shape:
a `main()` wrapped in `try/catch` that always exits 0 with valid JSON, plus a
`main().catch()` last resort. When editing hooks, preserve this: an unexpected throw
becomes a decision, never a crash. `classify()` reads only the rules file, so even with
the DB dead the headline denials (`rm -rf /`, force-push, drop-table) still fire
(fail-*safe*), while the memory-coupling escalation merely degrades to silent.

**PreToolUse is the exception, and 0.13.0 changed it.** Every other hook writes `{}` on
an internal failure. PreToolUse cannot: `{}` is also the payload an evaluated OPEN emits,
so an unreadable payload, a throwing classifier and a hook the harness killed at its 5s
timeout were all reported in the same bytes as "looked at it, it's fine" — and wrote no
`compass_log` row at all, because the table's three classifications can only say what an
evaluation *found*. There is now a fourth, `NOT_EVALUATED` (`lib/compass.js`), for the
decision the compass did not reach. It denies, it writes the row that says evaluation did
not happen, and it mints **no override token** — a non-evaluation has nothing to override,
and a token there would let a caller stall the gate and then approve its way past it.
Use `compass.isClearance()` rather than `=== 'OPEN'` at any allow/block site so a
classification added later cannot default to allowed.

The four non-evaluation paths: `gate-input-unparseable`, `gate-payload-no-tool`,
`gate-classifier-failed`, `classify-budget-exceeded` / `gate-budget-exceeded`. The
timeout itself is not among them — a killed process emits nothing no matter what the code
says, so the defence there is the budget: `classify()` checks the clock before each rule
and stops with `NOT_EVALUATED` rather than reaching the end of a list it never finished,
and the hook refuses to hand back a clearance it took more than `T2HELIX_GATE_BUDGET_MS`
to produce. `T2HELIX_GATE_FAILURE_MODE=open` restores the old permissive behaviour for
these paths only — it never touches a real WITNESS or PAUSE — and the row is still written
so the hatch cannot hide a gap. It exists because a gate that denies everything and cannot
be switched off from outside the session is a brick, not a safeguard.

**The budget is a backstop, not the defence — CORRECTED 2026-07-30.** An earlier version
of this section claimed the pattern rewrite handled a slow bundled rule and the budget
handled the rest. An adversarial review falsified that twice. A budget is checked *between*
rules and cannot preempt a regex already entered, so a single slow pattern still burns the
whole 5s timeout; and the budget covered `classify()` only, while `classifyV2` then ran
`classifySemantic` unbudgeted — which is where the time actually went (1ms legacy vs
9,647ms semantic on a 100KB pad). Both are now closed at the source rather than by the
budget:

- **Patterns are linear.** `git-push-force` and `no-verify` refuse to scan across a later
  occurrence of their own trigger, so they cannot restart at every one (both proved
  equivalent to the shipped patterns by exhaustive enumeration, not by argument), and
  `lib/secrets.js` anchors its URL-scheme alternative so it cannot rescan an unbroken token
  from every offset. `deploy-prod` could not take that rewrite — its read-only carve-out can
  block an EARLIER trigger that a later one does not, so restarting later changes which
  commands match — so it keeps its `pattern` as the SPECIFICATION and declares
  `matcher_source`, evaluated by `lib/rules/deploy-prod-matcher.js` in linear time and held
  to the pattern by an equivalence walk over 2.28M generated inputs (0 lost, 0 widened).
  Use `compass.ruleTest(rule, s)` to run a rule, never `rule._regex.test` — a cost test that
  reaches past the engine measures code the gate does not run, which is how this one stayed
  a named residual in a suite watching for it. Repo-policy rules stay quadratic in trigger
  count and are named in `test/compass-fail-closed.js` as `KNOWN_SUPERLINEAR`.
- **A call the released gate never evaluated may not be made worse off.** Capability
  routing gates carriers fe8aa0c skipped entirely, so on those carriers a slow scan would
  turn a 55ms clearance into a denial or a killed hook — a regression dressed as a gate.
  `compass.capabilityOnlyCall()` reproduces fe8aa0c's eligibility line verbatim and is true
  only when NO rule is base-eligible; on such a call budget exhaustion returns `OPEN` /
  `capability-scan-declined` with the row still written, which is parity, not a fail-open.
  **Bash is excluded twice** — every bundled shell rule names it, and the predicate refuses
  it outright, so a user ruleset written entirely as `capability: "shell"` cannot put Bash
  on that path. Never widen this predicate to "every applying rule applies by capability":
  that is the shape that turns the shell gate off on Bash.
- **The semantic leg is skipped when it provably cannot move the verdict** — see
  `semanticSkipReason` in `lib/compass-v2.js`. `parseToIR` is kept unconditionally; it is
  linear and it carries the hash the token flow keys on.
- **`NOT_EVALUATED` is absorbing in `mergeDecisions`.** It may not be cleared (enforce mode
  was measured turning a non-evaluation into `OPEN` with `false_positive_cleared`) and may
  not be softened to `PAUSE`, which would hand back the override token the floor withholds.

`stderr` is used to make *dropped writes visible* without breaking flow (e.g. a dropped
`recordCompassFire` would otherwise leave a misleading half-chain). Keep that pattern:
fail open on the control path, but log the drop.

## Secret redaction — the ONE inverted fail-open path (v0.2)

`lib/secrets.js` is the single source of truth for credential patterns. One `PATTERNS`
table drives BOTH masking (`REDACTORS`) and classification (`DETECTION_REGEX`), so the
detector can't flag a credential value the redactor fails to mask — the invariant that
keeps "detected but persisted raw" from happening.

**That invariant is DIRECTIONAL, not equality — detection ⊆ redaction.** A pattern may
carry an optional `detectSrc` that is a *strict narrowing* of its `src`: `REDACTORS`
always compile `src`, `DETECTION_REGEX` prefers `detectSrc`. Everything flagged is still
maskable (the leak stays closed), but the masker is allowed to be WIDER than the gate.
The asymmetry is the point: over-masking a code expression costs a fingerprint in a
chronicle row, while over-*gating* it soft-denies a benign command — and since every
PAUSE mints a single-use confirm token, a gate that cries wolf on ordinary code trains
the operator to spend those tokens unread. `secret-assign` is the only pattern using it
(its `src` fires on any labelled assignment with an 8+ char value; its `detectSrc` adds a
lookahead rejecting expression-shaped values — `$VAR`, `$(cmd)`, `` `cmd` ``, `[expr]`,
`getpass()`, `os.environ["X"]`). **Never widen a `detectSrc` past its `src`** — that
reopens the v0.2.0 detect-but-don't-mask leak. `NAME_ONLY_DETECT` carries the same
narrowing in assignment position only, so a bare key-name mention still warns. The compass binds to it via
`"pattern_source": "secrets"` on the `credential-paste` rule. `secrets.scrub()` (pattern
redaction + a fixed-point backstop that coarse-masks any field still holding a maskable
secret) runs inside the **four** write chokepoints — `record()`, `logCompass()`,
`createPendingConfirmation()`, and `recordMethodCandidate()` (v0.4) — so every write to
`insights`, `compass_log`, `pending_confirmations`, and `method_candidates` is scrubbed
(a secret span becomes
`[REDACTED:<kind>:<8-hex of sha256(secret)>]`). **Here and only here we invert fail-open:
if `scrub` throws, the write is dropped/marked, never persisted raw.** If you add a write
path that bypasses those four, route it through `secrets.scrub` too. `createPendingConfirmation`
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
types) exposing fifteen tools (the 15 entries of `TOOLS` in `mcp/server.js` at 0.14.0) —
`recall`, `record`, `record_method`, `set_goal`, `open_thread`, `resolve_thread`,
`get_state`, `recall_compass`, `confirm_pending`, `list_pending`, (v0.4)
`list_method_candidates`, `promote_method`, `dismiss_method_candidate`, and (v0.12)
`dry_run_compass`, `explain_compass`. Safe-repeat leases (`lib/safe-repeat.js`) are not exposed as MCP tools. Each maps to a
`lib/chronicle.js` function. Default transport is `stdio` (the plugin path);
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
