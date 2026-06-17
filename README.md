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
- **PreToolUse** → compass: matches the proposed tool action against a rule set. **WITNESS** classifications (rm -rf wildcards, `git push --force`, `drop table`, prod-context deploys, `--no-verify`) are hard-denied. **PAUSE** classifications (credential-shaped patterns) are soft-denied with an override token — see "PAUSE override flow" below. As of v0.2, any credential that reaches the chronicle is redacted to a fingerprint on the way in (`lib/secrets.js`), at the `record()` / `logCompass()` write chokepoints.

Plus an in-process MCP server exposing thirteen tools:

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
| `confirm_pending` | Approve a pending PAUSE confirmation by token. Single-use; the retry consumes the approval. |
| `list_pending` | Review unexpired pending/approved/used confirmation requests. |
| `list_method_candidates` | (v0.4) Review the queue of auto-distilled method **candidates** the Stop hook produced from successful sessions. Quarantined — they never surface in recall until promoted. Filter by `status` (`pending`/`promoted`/`dismissed`). |
| `promote_method` | (v0.4) Promote a candidate (by `id`) to a trusted, surfaceable `domain:'method'` insight (`source:promoted`). The only path from quarantine onto the recalled surface. |
| `dismiss_method_candidate` | (v0.4) Reject a candidate (by `id`) so it leaves the review queue without becoming a method. |

## PAUSE override flow

Under `defaultMode: bypassPermissions` (the typical Claude Code config), `permissionDecision: ask` is silently overridden by the harness. To preserve a real safety surface for PAUSE-classified actions, T2Helix routes PAUSE through `deny` with a token-based override:

1. Tool call matches a PAUSE rule (e.g., a `-----BEGIN RSA PRIVATE KEY-----` pattern in a Bash command).
2. Hook creates a `pending_confirmations` row keyed by `(session_id, sha256(action_summary))`, returns `deny` with the token in the reason text.
3. To approve: call `mcp__t2helix__confirm_pending` with the token.
4. Retry the original action within 10 minutes. Hook finds the matching approval, consumes it, lets the call through, and re-logs in `compass_log` as OPEN with `reason: "approved via token X (consumed)"`.
5. The approval is single-use. A new approval is needed for another retry.

WITNESS has no override path — those operations require manual rule edits.

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

Then register `http://localhost:3742/sse` (or your tunnel URL) as an MCP connector in your client. The tool surface is identical to the Claude Code plugin — same thirteen tools, same chronicle, same data dir.

The stdio path (Claude Code plugin) is unaffected. Both can run simultaneously from the same data dir.

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

The chronicle is backed by `better-sqlite3`, a native module compiled against your Node ABI. If a Node major-version upgrade leaves recall/compass silently inactive (an `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` mismatch), rebuild the binding:

```bash
npm run rebuild       # npm rebuild better-sqlite3
npm run redact-sweep  # one-shot scrub of credentials that leaked into the chronicle pre-0.2 (see CHANGELOG)
```

The hooks **fail safe**: if the binding can't load, rules-based gating (deny `rm -rf /`, force-push, drop-table) still runs and you'll see a one-line "run `npm rebuild better-sqlite3`" hint instead of a crash or a silently-disabled gate.

## Status

**Current release: v0.10.0** — see [CHANGELOG.md](./CHANGELOG.md) for the full v0.5.0 → v0.10.0 history: Apache-2.0 relicense, fail-loud + `doctor`, git-bound policy-as-code, model-swap CI + manifest export/import, audit→promote commands, the local real-time dashboard, and the error-resolution atlas loader (`lib/atlas.js`, `npm run import-atlas`). The highlights below cover v0.4.0 and earlier; run `npm run release:doctor` to check these docs against the code.

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
