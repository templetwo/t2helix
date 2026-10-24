# T2Helix

Persistent recall and pre-action compass for Claude Code, running locally on your machine.

## Install

**Requires Node 20–26.** `better-sqlite3` is a native module compiled against your Node ABI — see [Native module](#native-module) if recall/compass go quiet after a Node upgrade.

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
- **PreToolUse** → compass: matches the proposed tool action against a rule set. **WITNESS** classifications (rm -rf wildcards, `git push --force`, `drop table`, prod-context deploys, `--no-verify`, a shell command that runs `approve-pending`) are hard-denied. **PAUSE** classifications (credential-shaped patterns) are soft-denied with an override token — see "PAUSE override flow" below. As of v0.2, any credential that reaches the chronicle is redacted to a fingerprint on the way in (`lib/secrets.js`), at the `record()` / `logCompass()` write chokepoints. As of **v0.12 (Compass V2)**, PreToolUse also builds an Action IR, runs semantic predicates in **shadow** mode by default (`T2HELIX_COMPASS_V2=shadow|enforce|off`), and can honor safe-repeat leases for confirmed PAUSE actions.

Plus an in-process MCP server exposing fifteen tools:

| Tool | Purpose |
|------|---------|
| `recall` | Search the chronicle for past insights by query (FTS5 + recency-weighted). Filters: `layer` (`ground_truth`/`hypothesis`/`reflection`, single or array), `min_intensity`, `include_meta`, `since`/`until` (epoch ms). Hook-generated entries (`session-action`, `session-synthesis`, `compass-fire`, `method`) are excluded by default; pass `include_meta:true` to see them. |
| `record` | Write a new insight inline. |
| `record_method` | (v0.3) Capture a reusable procedure keyed to a task shape (`shape`, `steps`, `acceptance`, `tool_classes`). Stored as a `domain:'method'` insight; surfaced only via the targeted method lookup, never the generic recall firehose. |
| `set_goal` | Anchor a session goal. Archives any prior goal as a `reflection`-layer insight tagged `archived-goal`. (v0.3) Optionally takes `acceptance_criteria`; with none, returns a non-blocking `decomposition_hint`. |
| `open_thread` | Capture an unresolved question to revisit later. |
| `resolve_thread` | Close an open thread by id with a resolution. Stamps `resolved_at` + `resolution`; thread drops out of `get_state.open_threads`. |
| `get_state` | Read current goal + recent open threads + recent insights. |
| `recall_compass` | Query the compass log of past PreToolUse classifications (filter by classification, matched_only, limit). |
| `confirm_pending` | Approve a pending PAUSE confirmation by token (from `list_pending`, not from the deny message). Single-use; the retry consumes the approval. The origin of every approval is recorded. |
| `list_pending` | Review unexpired pending/approved/used confirmation requests, including the origin each approval arrived from. |
| `list_method_candidates` | (v0.4) Review the queue of auto-distilled method **candidates** the Stop hook produced from successful sessions. Quarantined — they never surface in recall until promoted. Filter by `status` (`pending`/`promoted`/`dismissed`). |
| `promote_method` | (v0.4) Promote a candidate (by `id`) to a trusted, surfaceable `domain:'method'` insight (`source:promoted`). The only path from quarantine onto the recalled surface. |
| `dismiss_method_candidate` | (v0.4) Reject a candidate (by `id`) so it leaves the review queue without becoming a method. |
| `dry_run_compass` | (v0.12) Classify a hypothetical action through Compass V2 without enforcing. Returns legacy, semantic, active, IR, and shadow compare. |
| `explain_compass` | (v0.12) Explain parser version, predicates, evidence, and the operator message for a proposed action. |
| `arm_safe_repeat` | (v0.12) Arm a session-scoped lease for one exact normalized action (PAUSE ceiling only; never overrides WITNESS). |
| `revoke_safe_repeat` | (v0.12) Revoke one lease or all active leases for the session. |
| `list_safe_repeat` | (v0.12) List active safe-repeat leases. |

## Compass V2 (v0.12)

Action Intermediate Representation sits between hook input and policy:

`tool input → adapter → Action IR → semantic predicates → decision + evidence`

- **Default mode is `shadow`:** legacy string rules still enforce; semantic decisions are computed and logged (`shadow_json` on `compass_log`) for comparison.
- **`T2HELIX_COMPASS_V2=enforce`:** migrated families (**rm**, **credential-paste**) use semantic predicates; non-migrated WITNESS rules (force-push, drop-table, deploy-prod, …) still come from the legacy classifier. Documentation-only commands (`echo "rm -rf /"`) clear string false positives.
- **Safe-repeat leases** bind to `normalized_action_hash` + `parser_version` + `cwd`, are session-scoped and use-bounded, and never cover WITNESS.
- Replay historical fires: `npm run replay-compass -- --limit 50`

## Compass rules gate a CAPABILITY, not a tool name

A rule's `tool` field names the surface it guards. `tool: "Bash"` means **shell
execution**, not "the tool literally named Bash": any tool whose input carries a
non-empty `command` or `script` string is evaluated against the same WITNESS
floor. A tool that runs a shell under a different name (`mcp__shell__run`,
`Terminal`, …) is no longer ungated.

| field | meaning |
|---|---|
| `tool: "Bash"` | guards shell execution wherever it happens |
| `tool: "X"` (anything else) | exact tool scoping, matched against the tool's input envelope |
| `tool_exact: true` | opts a shell rule back out — Bash and nothing else |
| `capability: "shell"` | opt-in: match this rule against shell payloads too |

Which string a rule is matched against is decided **per rule**: a rule that names
the tool (or is unscoped) sees the action string; a rule reached by the shell
capability sees every `command`/`script` value; a rule reached both ways sees
both. Every command-shaped field is evaluated, so a benign `command` cannot hide
a destructive `script`.

Cost, stated rather than claimed to be zero: prose sitting in a `command` or
`script` field can match a rule and hard-deny (`WITNESS`, no override token).
Measured specimens and the operator levers are in `COMPASS_CONSISTENCY.md`. The
only lever over the bundled floor itself is `T2HELIX_DATA_DIR/compass/rules.json`,
which replaces it wholesale — a repo `.t2helix/policy.json` is additive and can
never override a bundled rule ID.

`compass_log` records `ruleset_hash`, `ruleset_source` and `rules_eligible` for
every verdict; `rules_eligible: 0` means no rule could evaluate the call, which
is distinct from evaluated-and-cleared.

## PAUSE override flow

Under `defaultMode: bypassPermissions` (the typical Claude Code config), `permissionDecision: ask` is silently overridden by the harness. To preserve a real safety surface for PAUSE-classified actions, T2Helix routes PAUSE through `deny` with a token-based override:

1. Tool call matches a PAUSE rule (e.g., a `-----BEGIN RSA PRIVATE KEY-----` pattern in a Bash command).
2. Hook creates a `pending_confirmations` row keyed by `(session_id, sha256(action_summary))` and returns `deny`. The reason text names the request by **id** and says approval is required; it does **not** carry the token. The deny string is read by the party being denied, so the gate does not volunteer the credential that lifts it.
3. Find the request: `list_pending` shows what is awaiting approval, with its token (withheld while the human-confirm switch below is on).
4. To approve: call `mcp__t2helix__confirm_pending` with that token. The approval is recorded with the origin it arrived from (`mcp` for this surface, `unattributed` when a caller names none) and whether it came from a TTY. Nothing is gated on either — they are recorded so the row states what it is.
5. Retry the original action within 10 minutes. Hook finds the matching approval, consumes it, lets the call through, and re-logs in `compass_log` as OPEN with `user_override: "token:<id> origin=<origin>"`.
6. The approval is single-use. A new approval is needed for another retry.

**The human-confirm switch, default off.** Set `T2HELIX_REQUIRE_HUMAN_CONFIRM=1` (or `true`, `on`) and only origin `cli`, the terminal path, may approve: approvals arriving from the model-facing MCP surface (origin `mcp`), with no origin (`unattributed`) or with any other origin are refused (an allowlist since 0.14.0; the first, unreleased form of the switch refused `mcp` alone). With the switch on, `list_pending` returns the rows with the token withheld and a note, and the PAUSE deny text, the memory-coupling reason and the Grok adapter's PAUSE result say that approval is a human's, from a terminal, naming no script, path or token (the adapter also withholds the token). The request stays pending until a human approves it from a terminal, outside the agent session, with `T2HELIX_DATA_DIR="$HOME/.claude/plugins/data/t2helix-<marketplace>" node scripts/approve-pending.js <token>`, run from the plugin root (under Claude Code, `~/.claude/plugins/cache/<marketplace>/t2helix/<version>/`) or a clone. `--list` in place of the token shows each pending request's id, action summary, token and expiry. The script refuses to run (exit 2, one-line reason, no store opened) unless stdin is a terminal and no Claude Code session marker (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT`) is set, `--list` included. Past that check every result names the chronicle it used, and a run without `T2HELIX_DATA_DIR` is refused (exit 2) instead of reading the standalone fallback. The approval is recorded as origin `cli`.

Plainly: the switch closes every in-process approval route except the terminal one, and nothing more. It is read in each process at call time: the one that serves `confirm_pending` and `list_pending` (the plugin's MCP server, an SSE server, the Codex connector), the PreToolUse hook (for the deny text), and the Grok adapter's host, so it has to be set in the environment of each one, at once. Against an agent that has a shell and write access to the store it is a speed bump, not a wall: such an agent can call the approval code claiming origin `cli` or write the row itself. The bundled `approve-pending-script` WITNESS rule denies a shell command that runs the script (`node`, `nodejs`, `bun` or `deno` on it, or executing it directly, in command position) where the PreToolUse hook runs; since 0.14.0 a command that only mentions the file (`git add`, `git log --`, a commit message) is not denied, and a quoted string whose line itself begins with an invocation still is, so write such text through a file (the Codex connector has no hook enforcement), and the refusal the model receives names neither the script nor where tokens are listed. `approved_tty` is not proof of a human either: a pseudo-terminal records 1.

WITNESS has no override path — those operations require manual rule edits.

## When the gate cannot decide (v0.13.0)

A PreToolUse hook that fails internally used to emit `{}`, which is the same payload an
evaluated OPEN emits — so an unreadable payload or a hook killed at its 5s timeout was
indistinguishable from a cleared call, and left no `compass_log` row. Those paths now
classify `NOT_EVALUATED`: the call is denied, the row is written, and no override token is
issued (there is no verdict to override). `classify()` also runs on a time budget and
stops with `NOT_EVALUATED` rather than finishing a rule list it never got through, so one
slow pattern cannot starve the rules after it.

| Env var | Default | Effect |
| --- | --- | --- |
| `T2HELIX_GATE_FAILURE_MODE` | `deny` | `open` restores the pre-0.13.0 permissive behaviour for non-evaluation paths only. Never affects a real WITNESS or PAUSE; the audit row is written either way. |
| `T2HELIX_GATE_BUDGET_MS` | `3500` | Above this, the hook will not return a clearance it spent too long producing. |
| `T2HELIX_CLASSIFY_BUDGET_MS` | `1200` | Wall clock for the whole rule loop. |
| `T2HELIX_RULE_BUDGET_MS` | `400` | A rule slower than this is named in the row's evidence. |
| `T2HELIX_SEMANTIC_SKIP_BYTES` | `4096` | Above this size, an action the legacy rules already classified WITNESS skips the semantic leg. WITNESS is the top of the lattice, so that leg could only clear it — skipping fails closed. PAUSE and OPEN are never skipped at any size, because for those the semantic leg can escalate. |
| `T2HELIX_SEMANTIC_BUDGET_MS` | `1200` | If the legacy leg already spent this long, the semantic leg is not entered and the legacy verdict stands. |
| `T2HELIX_CAPABILITY_BUDGET_MS` | `400` | Budget for a call the released gate would not have evaluated at all — a shell payload on a tool no rule in force names. The tighter of this and `T2HELIX_CLASSIFY_BUDGET_MS` applies. Overrunning it clears the call with `rule_matched = capability-scan-declined` rather than denying: on that carrier the previous release cleared it without reading it, so declining is parity, not a fail-open. Unreachable on `Bash`. |

A budget cannot interrupt a regex already running, so the second half of the defence is
that the patterns themselves are linear. `git-push-force` and `no-verify` are written so
they cannot restart on every occurrence of their own trigger, and `lib/secrets.js` anchors
the URL-scheme alternative so it cannot rescan a long unbroken token from every offset.
`deploy-prod` could not be rewritten that way — its read-only carve-out can block an
earlier trigger that a later one does not, so restarting later changes which commands
match — so it keeps its pattern as the specification and is evaluated by
`lib/rules/deploy-prod-matcher.js`, a linear reimplementation held to the pattern by an
equivalence walk over 2.28M generated inputs (`test/compass-no-worse-than-base.js`). One
rule remains quadratic in trigger count — this repo's own `.t2helix/policy.json` entry —
and is named in `test/compass-fail-closed.js` (`KNOWN_SUPERLINEAR`) rather than left
implicit. On a tool the previous release did not gate, such a rule can only cost a
decline, never a denial: see `T2HELIX_CAPABILITY_BUDGET_MS` above.

## The credential gate requires a literal value (v0.13.1)

The `secret-assign` leg of `lib/secrets.js` fired on ANY labelled assignment
(`token=...`, `key: ...`) whose value was 8+ non-space characters, without ever asking what
the value WAS. Ordinary code was therefore soft-denied as a credential paste: a shell
variable expansion, a command substitution, a bare call such as a getpass prompt, or an
environment-lookup subscript. Measured on one seat over seven days: 52 PAUSE and 24
confirmed-OPEN on `credential-paste`. Every PAUSE mints a single-use confirm token, so a
gate that cries wolf on ordinary code trains the operator to spend those tokens unread --
the exact reflex the gate exists to prevent.

Detection now rejects an expression-shaped value at the value position. The masking side is
unchanged: a pattern may carry a `detectSrc` that is a **strict narrowing** of its `src`,
and `REDACTORS` always compile `src`. The invariant is directional -- **detection is a
subset of redaction** -- so everything the gate flags is still maskable, while the chronicle
masker stays wider than the gate. The 8-character floor and the value class are unchanged,
deliberately: raising either loses short literal passwords the suite already asserts.

One deliberate, recorded detection loss: an AWS secret-key NAME assigned from a secret-store
read was PAUSE on the key name alone and is now OPEN. Reading from a secret store is not
pasting a credential. It is asserted *as a loss* in `test/secret-assign-literal.js` so it
cannot be mistaken for drift.

## Where state lives

Under Claude Code (the normal install path), data lives under:

```
~/.claude/plugins/data/t2helix-<marketplace>/   # e.g. t2helix-templetwo-t2helix
```

(Older Claude Code versions named this dir `t2helix-inline`; the exact suffix is chosen by Claude Code, not the plugin.)

The full resolution order (highest precedence first):

1. `T2HELIX_DATA_DIR` — manual override
2. `CLAUDE_PLUGIN_DATA` — set by Claude Code when running as a plugin; resolves to `~/.claude/plugins/data/t2helix-<marketplace>/` (current Claude Code) or `t2helix-inline` (older)
3. `~/.t2helix-data/` — standalone fallback when neither env var is set (not the path you want under Claude Code)

Inside the data dir: `chronicle.db` (SQLite, WAL mode, FTS5 indexed) and `.current_session` (the active `session_id`, written by the hooks so the MCP server can use the same signature). The path lives outside the plugin install, so it survives plugin updates and Claude Code session boundaries.

## Session signature

Every chronicle write (goal, insight, thread, compass log row, pending confirmation) is keyed by a `session_id`. The hooks receive Claude Code's real session UUID from stdin and persist it to `.current_session`. The MCP server reads that file in its `sessionId()` resolution chain, so MCP tool calls write under the same signature the hooks use. Without this unification, MCP-side writes (like `set_goal`) would key under a fallback constant and be invisible to hook-side reads (the recall hook's "no session goal" pathology in pre-0.0.4 builds).

## SSE mode (any MCP client)

The default `stdio` transport is used automatically by the Claude Code plugin. For any other MCP client — Claude.ai web connectors, other AI tools, or custom integrations — run the server in SSE mode:

```bash
# Start the SSE server on port 3742
npm run serve

# For web access, expose via Cloudflare tunnel
cloudflare tunnel --url http://localhost:3742
```

Then register `http://localhost:3742/sse` (or your tunnel URL) as an MCP connector in your client. The tool surface is identical to the Claude Code plugin — same fifteen tools, same chronicle, same data dir.

The stdio path (Claude Code plugin) is unaffected. Both can run simultaneously from the same data dir.

## Grok Heavy equal co-partnership

T2 Helix is model-agnostic at the core. As of the Grok integration layer:

- Grok seats can `require("./lib/grok-adapter")` or call the MCP tools directly.
- Same chronicle, same compass rules, same recall/record surface.
- `npm run grok:boot`, `npm run grok:witness`, `npm run grok:test` provide convenient entry points.
- Historical cross-agent (Grok ↔ other) relay entries already live in the chronicle.

See `README_GROK_INTEGRATION.md` and `T2_HELIX_GROK_INTEGRATION_SPEC.md`.

## Tests

```bash
npm test              # smoke + regression + integration + SSE contract + atlas
npm run smoke         # library + compass unit tests
npm run regression    # MCP tool contract (stdio JSON-RPC)
npm run integration   # spawns the real hooks, asserts the shipped wiring
npm run release:doctor # check README/docs claims against the code (versions, counts, Node)
```

Each suite runs against an isolated temp data dir. Coverage: compass rule classifications (incl. read-only-vs-mutating prod ops), chronicle CRUD, FTS similarity retrieval, session-state round-trip, `setGoal` preserve-prior, `getCompassHistory` filters, the full `pending_confirmations` lifecycle + atomic single-use enforcement, cross-session isolation, the MCP contract + argument coercion, and — in the integration suite — the live PreToolUse/PostToolUse hooks: the PAUSE override loop, fail-open on adversarial input, and fail-safe gating when the native binding is unavailable, plus (v0.2) secret redaction at the write chokepoints, compass-fire recall exclusion, redact-or-drop fail-safe, retention pruning, and an end-to-end `redact-sweep` scrub, plus (v0.3) the method store + firehose-exclusion, recall-surface selection (gate/relevance/caps/char-volume), and the boundary-active goal lifecycle + Stop per-criterion synthesis, and — (v0.4) — the auto-distill pure distiller (conservative gating), the quarantine candidate store with the never-surfaces invariant, and the promote-to-trusted / dismiss gate (incl. transactional rollback recoverability) end-to-end through the Stop hook, plus (v0.10) the error-atlas loader acceptance matrix (parse + validation, idempotent fingerprinting, conflict surfacing, huge-entry isolation, and the CLI exit-code contract). Run `npm test` for the current total.

## Native module

The chronicle is backed by `better-sqlite3`, a native module compiled against your Node ABI. **Important:** `require('better-sqlite3')` alone is not a health check — the `.node` is only dlopened inside `new Database(...)`. T2Helix probes with a throwaway `:memory:` open.

If a Node major-version upgrade leaves recall/compass inactive (`ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` mismatch):

```bash
npm run rebuild       # rebuild better-sqlite3 for THIS node + write .native-abi.json stamp
npm run doctor        # must show GREEN for native + DB + schema
npm run redact-sweep  # one-shot scrub of credentials that leaked pre-0.2 (see CHANGELOG)
```

**MCP clients** should launch via `scripts/mcp-launch.js` (also what `.mcp.json` uses). The launcher re-execs under a compatible Node when PATH points at the wrong major version, instead of advertising tools while every DB call fails.

The hooks **fail safe**: if the binding can't load, rules-based gating (deny `rm -rf /`, force-push, drop-table) still runs and you'll see a rebuild hint instead of a crash or a silently-disabled gate. The MCP server **fails loud** on start when the driver is degraded.

## Status

**Current release: v0.14.0** — see [CHANGELOG.md](./CHANGELOG.md) for the full v0.5.0 → v0.14.0 history: Apache-2.0 relicense, fail-loud + `doctor`, git-bound policy-as-code, model-swap CI + manifest export/import, audit→promote commands, the local real-time dashboard (v0.11 "Compass Observatory" HUD redesign with a newest-at-top feed), the error-resolution atlas loader (`lib/atlas.js`, `npm run import-atlas`), the release-truth doctor + atlas acceptance harness (`npm run release:doctor`), and the local→stack chronicle sync (`npm run sync-stack`). The highlights below cover v0.14.0, then v0.4.0 and earlier; run `npm run release:doctor` to check these docs against the code.

**v0.14.0 — the tagger stops learning failures from quoted text; human-confirm review fixes.**

- **Helix coupling, as of v0.14.0:** PostToolUse tags outcomes `outcome:success` for clean accepted calls and `outcome:failure` only for interrupted calls and Edit/Write errors; ambiguous Bash text (`FAILED`, a traceback, `Error:` behind an accepted call) is untagged, so for Bash the coupling now escalates only on interrupted runs and goes quieter. The v0.1.0 bullet below is history and keeps its original wording.
- **Human-confirm switch** (`T2HELIX_REQUIRE_HUMAN_CONFIRM`, default off): an allowlist of origin `cli` while on, tokens withheld from `list_pending`, switch-aware model-facing text; the `approve-pending-script` WITNESS rule denies invocations, not mentions. See "PAUSE override flow" above.

**v0.4.0 — Auto-Distill (Stage 3).** The Stop hook now distills a method *candidate* from a successful session automatically — but because the Stop hook is a high-frequency writer, candidates are **quarantined** and surface nothing until explicitly promoted.

- **Quarantine store** (`method_candidates`, its own table — not `insights`): a candidate can never enter recall/FTS/the method lookup, so injected volume cannot rise from auto-distill. `status`: `pending → promoted | dismissed`, no TTL.
- **Conservative distiller** (`lib/distill.js`, pure): a candidate only when a goal with `acceptance_criteria` was set, the session shows `outcome:success` with **zero** failures, and a majority of criteria are addressed. Most sessions distill nothing. The fourth scrub chokepoint (`recordMethodCandidate`) keeps credentials out.
- **Promote-to-trusted gate** (`promote_method`, the only path onto the surfaced store; append-only — writes a fresh `ground_truth` method tagged `source:promoted`, CAS-guarded). Plus `list_method_candidates` (review queue) and `dismiss_method_candidate`. Auto-*promotion* deferred — ship explicit-only, measure the generated-vs-promoted ratio first.

**v0.3.0 — Method-Surfacing (Stage 2).** Recall learns to surface the *procedure*, not just facts — under a strict cardinal rule that total injected volume goes *down*.

- **Method store** (`record_method` → `domain:'method'` insights): `[method] <shape>` + steps + `Acceptance:`, surfaced *only* via a targeted slug-overlap lookup, never the generic firehose. Flows through `record()`, so redaction still applies.
- **De-noised recall** (`lib/surface.js`, pure): ≤1 method + ≤3 relevance-filtered insights; conversational/ack prompts draw no generic dump; trims harder when a goal anchors context. The volume claim is asserted in characters, not item counts.
- **Boundary-active goal** (`lib/goal-progress.js`): `set_goal` offers a non-blocking `acceptance_criteria` decomposition; the Stop synthesis emits a *soft* per-criterion note (`[~] … (related: #id)` — "mentioned", not a verdict). Once at Stop, never per-tool.
- **Hardened after a five-lens adversarial review:** fixed a phantom-evidence blocker (archived-goal text no longer counts as criterion evidence), a cosmetic-re-state criteria drop, and an `acceptance_criteria:[]` boundary wipe. Auto-distill deferred behind a promote gate.

**v0.2.0 — Security & Clean Surface.** The recall surface no longer leaks credentials.

- **Redact-or-drop on write:** `lib/secrets.js` (single source of truth, shared with the compass rule) fingerprints any secret span at the `record()` / `logCompass()` chokepoints. The one place fail-open is inverted: redaction failure drops the write rather than persisting raw. `npm run redact-sweep` retro-scrubs pre-0.2 rows.
- **`compass-fire` is a META domain** — excluded from default recall/getState (it was noise, and it embedded credential-shaped commands); the helix coupling reads it via `include_meta`.
- **Retention:** `prune()` (Stop hook) bounds `compass_log` + `pending_confirmations`.

## License

Apache-2.0 — see [LICENSE](./LICENSE). Copyright 2026 Anthony Vasquez Sr. (The Temple of Two).

**v0.1.0** — the helix couples: memory and compass feed each other end-to-end.

- Five hooks: recall (UserPromptSubmit), compass (PreToolUse), action-record (PostToolUse), archive (PreCompact), synthesis (Stop)
- **Helix coupling (criteria 1–4):** PostToolUse tags outcomes (`outcome:success|failure`); PreToolUse recalls *similar* past actions (real FTS5 similarity, not recency) and escalates OPEN→PAUSE when their outcome history warrants it; compass-fires and outcomes share an `action:<hash>` tag so recall returns both ends of the chain
- MCP server with nine tools (incl. `recall_compass`, `confirm_pending`, `list_pending`, `resolve_thread`)
- PAUSE soft-deny with an **atomic single-use** token override
- Session ID unification via `.current_session`
- Hardened: lazy/guarded native load (the gate survives a DB outage), portable data dir, bounded `busy_timeout`, FTS query sanitization, MCP argument validation
- 161 tests (smoke + regression + integration)
