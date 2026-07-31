# Changelog

All notable changes to t2helix are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versioning is [SemVer](https://semver.org/).

## [Unreleased] — Compass gates a capability, not a tool name

### Changed (BEHAVIOUR CHANGE for existing rules and repo policies)
- **`tool: "Bash"` on a compass rule now means the shell CAPABILITY.** Any tool
  whose input carries a non-empty `command` or `script` string is evaluated
  against every shell rule, whatever the tool is called. Previously a tool that
  ran a shell under any other name was completely ungated and its rows logged as
  `OPEN`, indistinguishable from evaluated-and-cleared. Rules naming any other
  tool keep exact scoping.
- **`tool_exact: true`** (new) opts a shell rule back out — Bash and nothing else.
  **`capability: "shell"`** (new) is the opt-in counterpart for a rule scoped to
  some other tool name.
- **The match haystack is chosen per RULE, not per call.** A rule that names the
  tool, or is unscoped, is matched against the action string; a rule reached by
  the shell capability is matched against the payload field values; a rule
  reached both ways is matched against both, OR-ed, with identical strings
  scanned once. Choosing one haystack for the whole call blinded every
  tool-scoped rule whenever a `command` field was present.
- **Every command-shaped field is evaluated, not the first.** A benign `command`
  can no longer shadow a destructive `script` in the same payload.
- Known cost, documented in `COMPASS_CONSISTENCY.md` and asserted in the test
  suite: prose in a `command`/`script` field can match a rule and hard-deny.

### Added
- `compass_log.ruleset_hash` / `ruleset_source` / `rules_eligible`, and a
  `compass_rulesets` table holding each distinct ruleset's manifest once.
  `rules_eligible: 0` records "no rule could evaluate this call".
- `test/compass-capability.js`, wired into `npm test` and `npm run test:capability`.

### Fixed
- `scripts/replay-compass.js` reconstructed any non-Bash tool call as
  `{raw: …}`, so every capability-gated deny replayed as `OPEN` and was reported
  as a softening. It now parses the stored envelope, and counts a row whose
  summary was truncated as `unreplayable` instead of replaying it and
  manufacturing a false softening.

## [Unreleased] — Haystack normalization (finding F) + reset flag position (finding J)

> **LANDING ORDER — READ BEFORE MERGING. Land finding D before or together with
> this branch.**
>
> The normalized second pass re-runs every rule pattern. That is free against a
> linear pattern and it is not free against finding D's unfixed `git-push-force`
> pattern, `git\s+push\s+(?:[^|;&]*\s+)?(?:--force…)`, where `[^|;&]` is a
> superset of `\s` and the quantifiers compete for one contiguous whitespace run.
> A command padded with contiguous spaces is already superlinear on that pattern;
> adding **one quoted token or one long flag** defeats the `normalized ===
> haystack` skip, so that superlinear cost is paid **twice**.
>
> Measured against the 5000ms PreToolUse budget (two machines, agreeing):
>
> | padding | pure padding (pass 2 skipped) | + one quoted token (pass 2 runs) |
> |---|---|---|
> | 2000 sp | 1243–1275 ms | 2606–2658 ms |
> | 2600 sp | 2749 ms | **5656 ms — over budget** |
> | 3000 sp | 4220 ms | 9198 ms |
>
> Effect: the padding needed to blow the budget drops from **~3,200 to ~2,450
> contiguous spaces, roughly a 23% discount on the C+D chain**, and a blown
> budget is finding C's fail-open (hook killed, nothing emitted, call proceeds
> ungated). Pure padding is unaffected — pass 2 is skipped, 2792 ms vs 2749 ms —
> so the discount requires the extra token.
>
> This is a **composition hazard with a sibling branch, not a defect in F+J**.
> With D's linear pattern landed, two passes of a linear match is still linear
> and the effect vanishes completely. Landing F+J alone is a knowingly-accepted
> discount, not a surprise. The hazard is pinned in
> `test/compass-normalization.js` → `CHARACTERIZATION: LANDING ORDER`, which
> detects whether D has landed and reports it on every run.

### Fixed
- **Quoted and long-form flag spellings are no longer a bypass** (finding F).
  `lib/compass.js` matches the command **as written** first and normalizes only
  when that pass comes back clean. That ordering is the whole safety argument:
  normalization can only ADD a denial and can never change WHICH rule fires on a
  command that already denied.
- **`git reset --hard` is caught wherever the flag sits** (finding J). The rule
  walked from the subcommand straight to the flag; it now walks intervening
  tokens, so `git reset HEAD~1 --hard` is gated like `git reset --hard HEAD~1`.

### Added
- **`test/compass-normalization.js` + `test/fixtures/compass-normalization-specimens.json`**
  — the bypass specimens, a 40-command prose corpus that must not move, a
  monotonicity property over the whole corpus, and the cost characterizations.

### Known limitation (recorded, not fixed)
- **A trailing shell comment is read as argument text.** `git reset HEAD~1 #
  avoid --hard` and `git reset --soft HEAD~1 # not --hard` move OPEN → WITNESS in
  all three modes. It fails in the SAFE direction, and the legacy string layer
  already cannot tell an invocation from an echo of one.
  The one-character remedy — excluding `#` from the token class — is **worse and
  must not be taken**: git refs and paths may contain `#` mid-token, and it flips
  `git reset refs/heads/topic#1 --hard`, `git reset feature#42 --hard` and
  `git reset HEAD~1 -- a#b.txt --hard` from WITNESS to OPEN. Two fail-safe
  denials traded for three fail-open passes on commands that actually discard
  work. Both halves are pinned in the `comment_boundary` fixture group; the
  real-catch half is the guard that goes red if someone reaches for it.

### Known-open bypasses (out of scope for this branch, not introduced by it)
Verdicts below were measured on this branch (bundled rules only,
`T2HELIX_POLICY_DIR=''`), not carried over from prose. **`shadow` is the shipped
default**, so an OPEN there is an ungated command.

| command | legacy | shadow | enforce |
|---|---|---|---|
| `rm --recursive=yes /tmp/*` | OPEN | OPEN | WITNESS |
| `rm --recursive=yes --force /tmp/*` | OPEN | OPEN | WITNESS |
| `rm --force=1 /tmp/*` | OPEN | OPEN | PAUSE |
| `rm \-rf /tmp/*` | OPEN | OPEN | PAUSE |
| `rm $'-rf' /tmp/*` | OPEN | OPEN | WITNESS |

- The `--flag=value` long-form is in scope for finding F's class and is **not
  closed**: the rewrite's `(?![\w-])` lookahead permits `--recursive=yes` →
  `-r=yes`, which then fails the rule's `-[rRf]+\s+` because of the `=`. Closing
  it means stripping an `=value` suffix before mapping — a pattern edit, and this
  codebase has reverted two of those, so it deserves its own adversarial pass
  rather than being tacked on here.
- The backslash-escape and ANSI-C spellings are pre-existing and were never
  claimed. F closes the quoted and long-form subset, not the whole bypass class.
- A repo-policy rule with a `condition` and no `pattern` fires on the first pass
  and starves the normalized pass. Not a regression (the same command returned
  the same verdict before normalization existed); pinned as a CHARACTERIZATION.

## [Unreleased] — Approval credential and approval provenance

### Changed
- **The PAUSE deny reason no longer carries the override token.** It names the
  pending request by id and says approval is required; the token is found through
  `list_pending`. The deny string is read by the party being denied, so the gate
  was volunteering the credential that lifts it. `renderDecision` still takes
  `opts.token` — as a signal that a request exists, never as content.
- **`compass_log.user_override`** on a consumed approval is now
  `token:<pending_id> origin=<origin>` rather than the bare pending id, so the log
  states which surface the approval came from. The separator is a space because
  the colon form matches `lib/secrets.js`'s own assignment pattern and would be
  scrubbed to `[REDACTED]` by any surface that redacts.

### Added
- **Approval provenance** — `pending_confirmations.approved_origin` and
  `approved_tty` (additive migration). `approveConfirmation({ token, origin })`
  records the origin its caller states; `mcp/server.js` hardcodes `'mcp'` so a
  caller cannot declare its own, and an unnamed origin records `unattributed`
  rather than NULL. Nothing gates on either field — they exist so an approval row
  can no longer read as operator-driven when it was not.
- **`test/approval-provenance.js`** — the deny/message strings carry no token, the
  override loop still closes through `list_pending`, and every approval records
  where it came from.
- **`MESSAGE_VERSION` bumped to `decision-message/0.12.1`** (`lib/decision-message.js`).
  The message contract changed materially, and this identifier is what lets a
  `compass_log` row be read back against the contract that produced it. It is a
  contract version, independent of the package version; nothing pins the literal
  (tests compare against the exported constant).

### Fixed
- **The WITNESS guard in `test/integration.js` no longer discriminates by
  `!/confirm_pending/`.** Once the PAUSE deny stopped naming `confirm_pending`,
  that assertion was satisfied by both classifications and could no longer tell a
  WITNESS floor from a soft-deny. It now asserts that WITNESS mints *no* pending
  confirmation, carries no `[soft-deny]` prefix, and renders the BLOCKED banner.
  Proven by mutation: a hook that mints for `classification !== 'OPEN'` and
  renders WITNESS as PAUSE passed 19/0 under the old guard and fails 18/1 under
  this one.

### Known-open (recorded, not fixed)
- `lib/grok-adapter.js:149` still returns `pending_token` verbatim to its gated
  caller. The universal phrasing in `CLAUDE.md` — "a gate does not hand over the
  credential that lifts it" — is scoped to the hook path until that surface is
  fixed too.
- `list_pending` is now the sole designated path to the credential and
  `mcp/server.js` leaves `session_id` optional, so an unscoped call returns every
  unexpired token across all sessions. Pre-existing, but this change makes its
  scope load-bearing. Operator call.
- A model can still fetch a token through `list_pending` and self-approve.
  Deliberate: masking it there would leave no surface from which the token can be
  obtained, converting PAUSE into WITNESS.

## [0.12.0] — Compass V2: Action IR, semantic Guard, safe-repeat leases

Turns the compass from raw-string gating into an action-aware Guard layer while
keeping the legacy classifier as the default authority in shadow mode. Implements
the frozen v0.12 slice of the Master Architecture blueprint (Action IR, two
migrated rule families, decision messages, shadow/replay, lease plumbing).
Repair cards and hybrid vectors remain out of scope.

### Added
- **`lib/action-ir.js` + `lib/action-ir/{bash,tools}.js`** — conservative Action
  Intermediate Representation (`parser_version: action-ir/0.12.0`). Tokenizes
  shell operators, quotes, nested interpreters (`bash -c`, `eval`, `xargs`,
  command substitution), and structured Edit/Write/MultiEdit inputs. Produces a
  stable `normalized_action_hash` that includes parser version.
- **`lib/compass-semantic.js`** — predicate evaluation over Action IR for the
  migrated **rm** and **credential-paste** families, with evidence, predicate
  IDs, and documentation-only false-positive clearance.
- **`lib/compass-v2.js`** — orchestrator. Mode via `T2HELIX_COMPASS_V2`:
  `shadow` (default, legacy authoritative + shadow compare), `enforce`
  (family-migrated merge), or `off`.
- **`lib/decision-message.js`** — versioned operator message contract
  (`decision-message/0.12.0`): PAUSE / BLOCKED banner, action, why, next step.
- **`lib/safe-repeat.js`** — session-scoped, TTL/use-bounded leases for one exact
  normalized action after human confirmation. Never overrides WITNESS.
- **Schema (additive)** — compass_log semantic columns; pending_confirmations
  semantic identity; `safe_repeat_leases` table; `schema_migrations` ledger.
- **MCP tools** — `dry_run_compass`, `explain_compass`, `arm_safe_repeat`,
  `revoke_safe_repeat`, `list_safe_repeat`.
- **`scripts/replay-compass.js`** (`npm run replay-compass`) — replay historical
  compass_log under V2 and report diffs.
- **Tests** — `test/action-ir.js`, `test/compass-v2.js`, July 21 + adversarial
  fixtures.

### Changed
- **`hooks/pre-tool-use.js`** — Compass V2 classify/log; semantic pending
  approvals; safe-repeat leases on PAUSE; versioned decision messages.
- **Default remains safe:** shadow mode does not change host enforcement until
  `T2HELIX_COMPASS_V2=enforce` is set.
- **Action identity and operator display are separate strings.** `action_summary`
  stays the legacy raw-command summary — it is hashed into the `action:<hash>`
  chain anchor that PostToolUse independently recomputes, and it is the recall
  query for memory coupling. The IR rendering is `display_summary`, used only in
  deny messages. Review caught an earlier cut that used the IR summary for both,
  which silently unpaired the compass↔outcome chain for most commands in the
  default mode; `test/compass-v2.js` now pins the identity across all three modes.
- **`summarizeIR` renders argv in written order and drops no operands.** It
  previously hoisted flags ahead of subcommands and truncated to three operands,
  so a deny message could show a command the operator never typed.
- **`shadow.agree` measures classification agreement, not rule-id equality.**
  Legacy and semantic often reach the same verdict under different rule names;
  counting that as disagreement made the shadow window — the signal that gates
  turning on enforce — permanently pessimistic. `shadow.same_rule` keeps the
  finer detail.

### Fixed
- **WITNESS floor held for recursive wildcard deletes.** `rm -r <glob>` was
  softening to PAUSE (token-overridable and lease-eligible) because the predicate
  required both `-r` and `-f`. Recursion is what makes a wildcard delete
  unbounded; `-f` only suppresses the prompt. Non-recursive wildcards remain the
  intended PAUSE softening.
- **GNU long-form flags now reach the predicates.** `--recursive` / `--force`
  were never mapped to their short letters, so long-flag deletes bypassed every
  rm predicate.
- **`shadow_json` is scrubbed** like every other write into `compass_log`.
- **Cleared floor rules stay auditable** — a false-positive clearance now records
  the rule it cleared, the basis, and any redirection into `evidence_json`.
  Previously it logged as a plain OPEN, indistinguishable from an action that
  never tripped a rule.
- **`replay-compass --strict` is no longer blind to the migrated families.** It
  excluded exactly the rules this release changes; migrated softenings are now
  reported separately instead of dropped, and the rule list is imported from
  `ALL_MIGRATED_RULE_IDS` rather than duplicated (it had already drifted, 3 ids
  vs 5).
- **Safe-repeat leases work for memory-escalated PAUSEs.** `escalateByMemory`
  returns a fresh object with no IR fields, and the lease lookup was the one call
  site without the IR-hash fallback, so escalated decisions were silently
  lease-ineligible.
- **`getCompassHistory` selects the v0.12 audit columns**, so shadow observation
  no longer requires raw SQL.
- **`schema.sql` declares the v0.12 columns** it had been leaving to
  `migrateSchema` alone.

## [0.11.0] — Compass Observatory dashboard + chronicle→stack sync

Two additive features; the recall/compass engine, hooks, and MCP server are
unchanged and backward compatible.

### Added
- **`scripts/sync-stack.js`** (`npm run sync-stack`) — pushes new local
  `ground_truth`, `t2helix`-domain insights past a per-data-dir cursor
  (`<dataDir>/.stack_sync_cursor`) to the shared Sovereign Stack, verbatim,
  tagging the domain `,mirrored-from-local` plus a provenance header. Built to
  close the drift where build-sessions log to the local chronicle only while
  lineage-sessions write the stack. Idempotent (cursor advances only across a
  contiguous run of successes); safe first run initialises the cursor and pushes
  nothing unless `--backfill`; `--dry-run` / `--since` / `--limit` / `--data-dir`
  flags; refuses a bare non-dry run against the `~/.t2helix-data` fallback. The
  bridge token is read from `BRIDGE_TOKEN` / the bridge env file and is never
  logged or written into a payload.
- **`test/sync-stack.js`** (17 assertions, wired into `npm test`) — selection
  filter, cursor honouring, dry-run-writes-nothing, and a full push against a
  local stub stack asserting mirror-domain + provenance + verbatim content +
  token-absent-from-payload + cursor-advance + idempotent re-run.

### Changed
- **Dashboard redesign — "Compass Observatory".** `dashboard/public/index.html`
  reskinned as a HUD instrument panel: gradient-mesh + grain background, a
  reactor that lights when the SSE link is live, Chakra Petch + IBM Plex Mono
  typography, the OPEN/PAUSE/WITNESS verdicts as a green/amber/red phosphor triad
  with glowing class-colored spines, glass cards, and a header telemetry readout.
- **Live feed now renders newest-at-top and flows downward** (was
  append-at-bottom): each new fire slides in with a class-colored glow,
  reading-position is preserved when scrolled into history, and a floating
  "N new fires" pill replaces the old bottom scroll-lock button.
- **`dashboard/server.js`** — the dashboard-only CSP is widened to allow the
  Google Fonts CDN and `data:` URIs (HUD fonts + inline grain). Engine and hooks
  are untouched; all dynamic data still flows over `connect-src 'self'`.

## [0.10.1] — Release-truth doctor + error-atlas acceptance harness

Hardening and self-verification produced by dogfooding v0.10.0 against this repo.
No behavior change to existing features; all additions are backward compatible.

### Added
- **`scripts/release-doctor.js`** (`npm run release:doctor`) — verifies the
  project's prose claims against machine-readable sources: package ↔ CHANGELOG
  version, README version currency, MCP tool count (static `TOOLS` registry
  parse), hook count, test count (live or non-brittle), Node range vs `engines`,
  error-atlas-documented, and the plugin-manifest version. Exits non-zero on any
  drift, so stale docs become a repeatable check.
- **`test/atlas-acceptance.js`** (15 tests, wired into `npm test`) — an explicit
  12-case acceptance matrix for the error-atlas loader: valid minimal / dense
  (extra fields ignored) / duplicate same-resolution / duplicate **conflicting**
  resolution / missing pattern / missing resolution / non-string pattern /
  non-string resolution / **huge entry** / malformed JSON / empty array + file /
  mixed valid+invalid, plus two CLI end-to-end cases.

### Fixed
- **`lib/atlas.js` — a single oversized entry no longer aborts the whole load.**
  `importAtlas()` now isolates a throwing `record()` (e.g. content over the 100KB
  `MAX_CONTENT_BYTES` cap) as a counted `dropped` row (fingerprint only, no
  content leak) instead of failing the batch and stranding the valid entries
  after it — restoring the loader's "load the valid subset, report the rest"
  contract.
- **Divergent-resolution conflicts are surfaced, not silently buried.** A new
  pure `detectConflicts()` reports same-pattern / different-resolution entries
  (both still load — append-only, an error can have more than one valid fix); the
  CLI warns on stderr without changing the exit code.
- **README release-truth:** corrected the stale hardcoded test count, the
  `npm test` suite list, and added a current-release pointer — `release:doctor`
  now reports `STATUS: TRUE`.

### Tests
- Suite **268 green** (was 253).

## [0.10.0] — Error-resolution atlas loader

A curated atlas of common error→fix pairs, loaded into the chronicle as
first-class recallable knowledge. The system already *detects* failure
(`lib/outcome.js` recognizes `Traceback` / `SyntaxError` / `TypeError` /
`ModuleNotFoundError` / `AssertionError` / `fatal:`); the one gap was that it
could not yet say *how to fix* what it detected. This fills that gap.

### Added
- **`lib/atlas.js`** — parse + fingerprint + import logic for a JSONL atlas of
  `{pattern, resolution}` entries. Loads each as a `domain:'error-fix'`,
  `layer:'ground_truth'` insight **through the existing `record()` path**, so
  `secrets.scrub()` and the `insights_fts` mirror trigger fire automatically — no
  new table, no new write path, no second native-module surface. Idempotent: each
  entry carries a content-derived `fp:<12hex>` tag and a re-run skips any
  fingerprint already present.
- **`scripts/import-atlas.js`** — CLI (`npm run import-atlas`). Mirrors
  `redact-sweep`: `--file <atlas.jsonl>`, `--data-dir <dir>`, `--dry-run`, and the
  same refuse-the-bare-fallback safety so the atlas can't be loaded into the empty
  `~/.t2helix-data` standalone dir by accident. Append-only and non-destructive.
- **`test/import-atlas.js`** — 18 tests (parse/validation, stable fingerprint,
  canonical shape, idempotent re-import, scrub-on-write, recall visibility,
  dry-run writes nothing, backdated-recency non-pollution, dry-run/real parity on
  duplicates, and the CLI exit-code contract). Wired into `npm test`.

### Recall hygiene (second pre-merge review — findings 1–4)
- **Atlas entries carry zero recency weight (finding 1, Medium).** `recall()` ranks
  on `-(bm25) + recencyBoost`; loading 147 entries at the current time gave each a
  `recencyBoost ≈ 1.0` that would crowd genuinely-recent user notes out of the top
  slots on any weak common-word overlap. Entries are now written with `created_at
  = 0` (recencyBoost → 0): a strong error-token match still ranks high, a generic
  query no longer rides a recency bump. `record()` gained an optional internal
  `created_at` param (default `Date.now()`, not exposed via the MCP tool) so the
  fix keeps the scrub chokepoint and the append-only invariant intact — no
  post-insert UPDATE, no INSERT that bypasses `record()`.
- **No secret leak to stdout on a dropped row (finding 2).** A row drops when
  `scrub` throws, so its raw text may hold the secret that tripped the drop. The
  CLI dropped-row report and the `importAtlas` return value now carry the
  fingerprint only — never the pattern/content.
- **Dry-run matches the real run on intra-file duplicates (finding 3).** An
  in-memory seen-set dedups within a run in both modes, so `--dry-run` predicts the
  real insert/skip counts exactly.
- **Idempotency check uses the session index (finding 4).** `fingerprintExists`
  now filters by `session_id = 'atlas-import'`, so the lookup rides
  `idx_insights_session` instead of a full table scan — and the substring tag match
  can only ever match atlas rows.

### Honesty of surface (pre-merge review findings 1 + 3)
- **Exit code reflects partial loads.** The CLI now exits `1` (not `0`) when any
  line was malformed or any row was scrub-dropped — the valid subset still loads,
  but `$?` no longer reports a partial load as success. Exit `2` stays reserved for
  misuse (missing or not-found `--file`, or a real run refused for want of an
  explicit data dir). Consistent with the "make dropped writes visible" ethos.

### Design (settled, not re-litigated)
- **Storage = the insights tier, not a parallel `error_atlas` table.** A parallel
  table would skip `scrub()`, skip the FTS triggers, be invisible to `recall()` +
  the memory→compass coupling, and double the `better-sqlite3` native surface (the
  system's one known silent-failure landmine). The insights tier gives the same
  millisecond FTS lookup with none of that.
- **`error-fix` is a non-meta domain.** Unlike `method` (META, surfaced only via
  the targeted slug lookup), error-fix is reference content that should surface via
  **normal `recall()`** when a prompt carries matching error tokens. The pattern
  text leads the insight content so its tokens land in FTS — wildcards (`*`) are
  FTS punctuation and drop out of tokenization harmlessly.
- **Pre-promoted, no `method_candidates` quarantine.** The atlas entries are
  human-curated and pre-vouched by deliberate authorship, so they load directly
  into the ground_truth tier in one reviewed batch (the human-promotion bottleneck
  satisfied once, not 147 times). The Stop-hook auto-distill path for *machine*
  guesses still routes through quarantine + `promote_method`, unchanged.
- **Authority unchanged.** The PostToolUse hook stays record-only and silent; no
  hard-block was added. Fixes surface via `recall()` and the existing
  `coupling.escalateByMemory()` (OPEN→PAUSE only) — steering authority stays in
  compass/coupling so every gate decision still lands in `compass_log`.

### Deferred (follow-up)
- **Auto-surface at failure time.** Today an error-fix entry surfaces when its
  tokens appear in a prompt (paste a traceback → the fix recalls). Wiring
  PostToolUse `outcome:failure` → recall the matching error-fix → inject the
  resolution is additive and stays within the record-only/coupling authority model
  (no hook hard-block). Pattern wildcards may want a normalization/LIKE pass to
  complement FTS-token matching for the variable spans.

### Changed
- `package.json` — version `0.9.1 → 0.10.0` (minor: additive feature, no breaking
  change). `record()` gained an optional internal `created_at` (default
  `Date.now()`), not exposed on the MCP tool surface.
- Tests: **+18** new (`test/import-atlas.js`); full suite **235 → 253**
  (smoke 155 + regression 52 + integration 19 + sse 9 + import-atlas 18).

## [0.9.1] — Pre-merge hardening (license + dashboard security + scrub invariant)

Hardening pass on the feature-complete v0.9.0, driven by an adversarial pre-merge
review. No new capability: it corrects the license text, locks the dashboard to
loopback, and closes the one real break of the four-scrub-chokepoint invariant.

### Security
- **Dashboard is loopback-only.** `dashboard/server.js` now binds `127.0.0.1`
  explicitly (was the Node default `0.0.0.0`/`::`, reachable on every interface —
  LAN, Tailscale, any port-forward). The `localhost` startup log is now true.
- **Dashboard CORS removed.** Dropped `Access-Control-Allow-Origin: *` from
  `/events`, `/api/state`, `/api/candidates`; same-origin is correct for a
  loopback developer tool, closing drive-by cross-origin reads of chronicle content.
- **Dashboard stored-XSS closed.** `dashboard/public/index.html` HTML-escapes
  (`esc()`) every chronicle field rendered via `innerHTML` (action summaries,
  goal/insight/candidate text); a `Content-Security-Policy` header was added.
- **Manifest import scrubs tags.** `record()` scrubs content but stores tags raw
  (tags are controlled-vocab on every internal write path); manifest import sourced
  tags externally and wrote them unscrubbed — the one place a credential could
  bypass the four scrub chokepoints. Import now scrubs each tag at the call site
  via `secrets.scrub`; a scrub throw drops the write, never persists raw. +1
  regression test (`smoke`).

### Fixed
- **`LICENSE` is now verbatim Apache-2.0.** The v0.5.0 relicense (and a first
  hand-patch) shipped a paraphrased TERMS body — dropped MERCHANTABILITY from the
  §7 disclaimer, `contract` → `strict liability` and `consequential` → `exemplary`
  in §8, a grammatically broken §1 "Contribution" definition, and a removed §4
  paragraph. The whole TERMS block was replaced with the canonical apache.org text;
  the filled APPENDIX/copyright (Anthony Vasquez Sr. / The Temple of Two) is
  preserved. Acceptance: TERMS-region diff against canonical returns zero lines.

### Changed
- `package.json` — version `0.9.0 → 0.9.1`.
- Tests: **+1** (smoke 154 → 155); full suite **235** (smoke 155 + regression 52 +
  integration 19 + sse-contract 9), all green.

### Deferred (non-blocking, tracked for a later patch)
- `doctor` data-dir resolution / false-GREEN honesty and read-only diagnosis.
- Manifest method provenance stamp (`source:imported`) and dedup normalization.
- Policy-as-code: assert the bundled WITNESS floor as non-removable in code, and
  extend the `policy-guard` CI gate to diff the bundled `compass-rules.json`.

## [0.9.0] — Local real-time dashboard

Zero-hook standalone HTTP server on port 3743. Tail-polls `compass_log` every
2s, pushes new rows to connected browsers over SSE. Three panels: Live Feed
(OPEN/PAUSE/WITNESS color-coded, filter toggles, scroll-lock), Review Queue
(method candidates), Recent Insights (goal + chronicle snapshot).

### Added
- **`dashboard/server.js`** — standalone HTTP server: GET `/` → HTML page,
  GET `/events` → SSE tail of `compass_log`, GET `/api/state` → chronicle
  snapshot (goal + threads + recent insights), GET `/api/candidates` → method
  candidate queue. Zero hook changes.
- **`dashboard/public/index.html`** — self-contained; no build step; dark
  UI, EventSource, three-tab layout, filter toggles, 500-entry ring buffer,
  scroll-lock for manual review.
- **`lib/chronicle.js: getCompassSince({ since_id, limit })`** — cursor-based
  ascending fetch used by the dashboard poll loop; returns `[]` on DB error
  (fail-open). Initializes `lastSeenId` to current MAX(id) on start so only
  new rows stream after the server boots.
- **`npm run dashboard`** script alias; optional `--port` and
  `T2HELIX_DASHBOARD_PORT` env override.
- 3 new smoke tests for `getCompassSince` cursor monotonicity + limit.

## [0.8.0] — Audit→Review→Promote→Reuse slash commands

Exposes the full method loop as five user-invokable Claude Code slash commands,
installed via `npm run install-commands` into `~/.claude/commands/t2helix/`.

### Added
- **`commands/audit-queue.md`** — `/t2helix:audit-queue`: list all pending
  method candidates with shape, acceptance criteria, and next-action hints.
- **`commands/promote-method.md`** — `/t2helix:promote-method <id>`: show
  candidate details, confirm, then call `promote_method`.
- **`commands/dismiss-method.md`** — `/t2helix:dismiss-method <id>`: show
  candidate details, confirm, then call `dismiss_method_candidate`.
- **`commands/recall-audit.md`** — `/t2helix:recall-audit [WITNESS|PAUSE]`:
  compass audit trail — PAUSE/WITNESS history with rule + reason + timestamp;
  optional classification filter.
- **`commands/recall-method.md`** — `/t2helix:recall-method <query>`: search
  the trusted method store by keyword/slug; the Reuse step of the loop.
- **`scripts/install-commands.js`** — copies commands to
  `~/.claude/commands/t2helix/`; `--uninstall` removes them.
- `npm run install-commands` script alias.

## [0.7.0] — Model Swap Test + Manifest Export

Proves the same 13-tool contract over SSE as over stdio; adds a published
compatibility matrix; ships `t2helix export-manifest` / `import-manifest` for
portable, round-trippable chronicle snapshots.

### Added
- **CI (`ci.yml`)** — Node 20/22/24/26 matrix runs the full suite (smoke +
  regression + integration + **sse-contract**) on every push and PR; rebuilds
  `better-sqlite3` for each ABI before testing.
- **SSE contract test (`test/sse-contract.js`)** — spawns the SSE server on an
  ephemeral port (port 0), drives the full MCP initialize handshake, then
  asserts the same 13-tool list + core round-trips (record/recall, set_goal,
  open_thread) that the stdio regression suite covers.
- **Manifest export/import (`scripts/export.js`, `scripts/import.js`,
  `lib/manifest.js`)** — `t2helix export-manifest` writes a portable JSON
  `{ manifest_version, t2helix_version, created_at, rules, promoted_methods,
  audit_schema_version }`; `t2helix import-manifest <file>` loads promoted
  methods into a fresh chronicle with content-equality dedup; `--snapshot` on
  export writes a WAL-safe `db.backup()` companion.
- **`lib/chronicle.js: getMethodInsights()`** — new query that returns all
  `domain='method' layer='ground_truth'` insights; used by manifest export and
  the Audit/Review/Promote commands (item 5).
- **Compatibility matrix (`docs/compatibility-matrix.md`)** — Node versions,
  transports, clients, and manifest portability with CI-tested / supported
  status annotations.
- **Smoke round-trip tests** — 6 new tests in `test/smoke.js` covering manifest
  shape, rule validation, export→fresh-dir→import→verify round-trip, dedup
  on re-import, and dry-run safety.

### Changed
- `mcp/server.js` — SSE listen callback now emits `httpServer.address().port`
  instead of the configured PORT, so `--port 0` correctly reports the OS-assigned
  ephemeral port in the stderr "listening on" line.
- `package.json` — version `0.6.0 → 0.7.0`; added `sse-contract`,
  `export-manifest`, `import-manifest` scripts; `test` script extended to
  include `sse-contract`.

## [0.5.0] — Relicense Apache-2.0

Relicensed from CC BY-NC-SA 4.0 to Apache-2.0 to unblock the commercial path.
The moat is the learning layer (promoted methods + memory→compass coupling), not the
license. No code changes — metadata + legal text only.

### Changed
- `LICENSE` — replaced CC BY-NC-SA 4.0 text with Apache License 2.0 canonical text
- `package.json` — `license` field changed from `"CC-BY-NC-SA-4.0"` to `"Apache-2.0"`
- `README.md` — added License section

### Added
- `NOTICE` — attribution file carrying the Apache-2.0 copyright notice (re-homes the
  attribution that CC's Attribution clause provided; propagated to downstream redistributors)

## [0.4.0] — Auto-Distill (Stage 3)

Stage 3 closes the method loop: instead of only recording methods by hand
(`record_method`), the Stop hook now **distills** a candidate method from a
successful session automatically. But the Stop hook is a *high-frequency writer*,
and the chronicle's own lived lesson (the v0.1 compass-fire pollution) is that the
highest-frequency writer drowns the signal — "amplify successes the way the compass
amplifies failures" is the firehose trap. So Stage 3 ships **explicit-only first**:
a distilled candidate is **quarantined** and surfaces *nothing* until a human
explicitly promotes it. The cardinal rule therefore holds by construction — injected
volume cannot rise from auto-distill — and the candidate-generated-vs-promoted ratio
becomes the measurement we wanted before ever automating promotion.

### Added
- **Quarantine candidate store — its own table, not `insights`.** New
  `method_candidates` table (`status`: `pending → promoted | dismissed`, **no TTL** —
  persists until reviewed). A candidate is therefore *not* an insight: it can never
  enter `recall()` / FTS / the targeted method lookup, so it cannot raise injected
  volume. This is the strongest possible guarantee of the cardinal rule given the
  Stop hook fires every session.
- **Pure distiller (`lib/distill.js`, DI-tested like `goal-progress.js`/`surface.js`).**
  `distillCandidate({ goal, assessment, actions })` is deliberately **conservative**:
  it returns a candidate only when a goal with `acceptance_criteria` was set, the
  session shows real `outcome:success` signal and **zero** `outcome:failure`, and a
  majority of criteria are addressed (reuses the Stop `assessCriteria` signal). Most
  sessions distill nothing. The candidate (shape from the goal, a deduped/​capped
  step skeleton from session-action rows, tool classes) is a rough draft — that
  roughness is exactly why it is gated rather than auto-surfaced.
- **Stop-hook wiring.** A new, independent `try/catch` block (fail-open, never blocks
  session close) calls the distiller and writes any candidate to quarantine via
  `recordMethodCandidate` — the **fourth scrub chokepoint** (candidate fields bypass
  `record()`, so they are scrubbed here with the same redact-or-drop fail-safe).
- **Promote-to-trusted gate + three MCP tools** (the server now exposes **thirteen**
  tools): `list_method_candidates` (the review queue), `promote_method` (the *only*
  path from quarantine onto the surfaced store — writes a fresh `ground_truth`
  `domain:'method'` insight tagged `source:promoted`, **append-only**, never mutating
  a row; CAS-guarded against double-promote), and `dismiss_method_candidate`.
- **`recordMethod` provenance.** `source:'promoted'` now counts as trusted alongside
  `source:'explicit'` (both `ground_truth`/0.8); the `source:` tag preserves whether a
  method was hand-authored or promoted from a distilled candidate.
- Tests: **+19** (smoke 135, regression 52, integration 16 = **203**, all green) —
  the distiller gates (incl. tolerating sparse `actions`), credential scrubbing, the
  quarantine-never-surfaces invariant (generic recall, the `tag:method` lookup, and
  `surface.selectInjection`), promote→trusted-surfaceable, double-promote/dismiss
  refusal, promote **rollback-leaves-candidate-recoverable**, and the Stop-hook
  end-to-end (success distills, a failure distills nothing).

### Reviewed
- Hardened after a five-lens adversarial review (each finding independently verified):
  the promote gate now runs the method write + the `pending→promoted` flip in a
  **single transaction** (better-sqlite3 auto-rollback), so a failed/raced write can
  never strand a candidate mid-promote or write a duplicate method — and the
  intermediate `promoting` state is gone. Also: `tool_classes` now flows through the
  scrub chokepoint; the distiller tolerates `null` elements in `actions`; and the
  Stop hook reads the session corpus once instead of twice.

## [0.3.0] — Method-Surfacing (Stage 2)

Stage 2 builds on the clean v0.2 surface. v0.2 removed the noise (and the leak);
v0.3 adds the one thing recall still couldn't do — *"for this shape of task, here
is the procedure that worked last time."* The **cardinal rule** governs the whole
stage: total injected volume on a normal prompt goes **DOWN**, not up. Methods are
sharp, procedure-bearing injections that **replace** generic-recall noise; if the
surface got noisier, the feature failed. The injected block is at most a goal line
+ ≤1 relevant method + ≤3 relevance-filtered insights, and a conversational prompt
suppresses the generic insights entirely.

### Added
- **Method store — no new table.** A method is a `domain:'method'` insight:
  `[method] <shape>` + numbered steps + `Acceptance:`, tagged `method` /
  `shape:<slug>` / `source:explicit` / `tool:<class>`. It flows through `record()`,
  so Stage-1 redaction scrubs any credential in the steps. `method` is a META
  domain, so methods **never** enter the generic recall firehose — they surface
  only via the targeted lookup below.
- **`record_method` MCP tool** (the server now exposes **ten** tools): capture a
  reusable procedure keyed to a task shape. Explicit methods are `ground_truth`;
  the deferred auto-distill path would land lower-confidence `hypothesis` methods.
- **Targeted method surfacing + de-noised recall** (`lib/surface.js`, pure/testable;
  the UserPromptSubmit hook is thin wiring). On each prompt: look up a method by
  similarity to the goal/prompt above a slug-overlap relevance bar (a weak match
  surfaces nothing — a wrong method is worse than none); shrink generic recall
  (`topK 5 → 3`, harder when a goal already anchors context) and relevance-filter
  it; **gate** conversational / acknowledgment / verb-led-ack prompts so they draw
  no generic dump. A smoke test asserts the volume claim in **characters** (v0.3
  block ≤ the v0.2 5-hit firehose), not item counts.
- **Boundary-active goal.** `set_goal` with no `acceptance_criteria` returns a
  lightweight, **non-blocking** `decomposition_hint` (the model may act or ignore;
  the goal is already committed); with criteria it returns `acceptance_criteria_count`.
  The Stop synthesis emits a **soft** per-criterion note (`lib/goal-progress.js`):
  token overlap against the session's own insights, rendered `[~] … (related: #id)`
  / `[ ] … (no related insight)` — "mentioned", never a verdict. Runs once at Stop;
  **never per-tool** (PostToolUse stays record-only). Per-prompt injection is
  unchanged, so criteria surface only at the two boundaries (goal-set, session-end).

### Hardened after adversarial review
A five-lens review (cardinal-rule/volume, security/redaction, fail-open, correctness,
contract) found one blocker, two major correctness bugs, and several hardening items:
- **Blocker — phantom criterion evidence.** `setGoal` archives a prior goal as an
  insight embedding its `Acceptance: […]` text; that archived copy token-matched the
  *current* criteria, so any goal change reported criteria "addressed" with zero work
  done. The evidence corpus (`getSessionInsights`) now excludes `archived-goal` rows.
- **Major — cosmetic re-state dropped criteria.** Goal-change was an exact string
  compare; `"ship it "` vs `"ship it"` reset the live boundary. Now compared on
  normalized (trim / case-fold / whitespace-collapse) text.
- **Major — `acceptance_criteria: []` wiped the boundary** and re-fired the offer.
  Criteria are now cleaned/deduped; an empty/all-junk array is treated as "omitted"
  (preserve), and the stored count matches the assessed count.
- Soft-marker wording made honest on both sides (`[~]` + "related", not `[x]` +
  "evidence"); verb-led short prompts (`run tests`, `rebuild`) are no longer silenced;
  defense-in-depth drop of `domain:'method'` from generic hits; Stop catch-fallback
  guards a non-array criteria value.

### Tests
- **184 total** (122 smoke + 48 regression + 14 integration): the method store and
  its firehose-exclusion, surface selection (gate, relevance bar, caps, fail-open,
  verb-escape, method-drop, char-volume), the boundary lifecycle (offer, clean/dedupe,
  `[]`-preserve, cosmetic-re-state, phantom-evidence exclusion), and the Stop
  per-criterion synthesis end-to-end.

### Deferred
- **Auto-distill** (a Stop-time method writer) — deferred behind an explicit
  promote-to-trusted gate. A new high-frequency writer is exactly the v0.1
  compass-fire pollution risk; ship explicit-only, measure injected volume, add it
  later (the cardinal rule outranks the convenience).
- The `goals` table is the one remaining unscrubbed write surface (`goal` / `why` /
  `acceptance_criteria` persisted raw, read back into context). Pre-existing (not a
  Stage 2 regression); flagged for a follow-up that routes the three fields through
  `secrets.scrub`.

## [0.2.0] — Security & Clean Surface

Stage 1 of v0.2: a recall surface with zero credential leakage. The
`credential-paste` PAUSE rule was self-defeating — when it fired, the hook logged
the very command it was warning about (credential and all) to two tables in
cleartext via `recordCompassFire()` and `logCompass()`, and because compass-fire
insights sat in the default recall surface, `recall()` re-injected the secret into
later model context. A dogfood session on the MacBook seat confirmed two real
credentials leaked this way (a Sovereign Bridge bearer token and a `~/.claude.json`
token) and re-surfaced in-context. This release closes the leak at the source,
de-noises the recall surface, and scrubs what already leaked.

### Security
- **Redact-or-drop on the write path.** New `lib/secrets.js` is the single source
  of truth for credential patterns (shared with the compass rule). `redactSecrets()`
  replaces each secret span with a fingerprint — `[REDACTED:<kind>:<8-hex of
  sha256(secret)>]` — keeping entries diagnosable and linkable without storing the
  value. It is applied at the two lowest write chokepoints, `record()` and
  `logCompass()`, so every path into `insights` and `compass_log` is covered. This
  is the **one place the fail-open default is inverted**: if redaction throws, the
  write is dropped, never persisted raw. Widened coverage beyond the old rule:
  `Authorization: Bearer`, `sk-`, `ghp_/gho_/.../github_pat_`, `AKIA…`, and
  labelled `password/secret/token/api_key=` assignments. Bare hashes (e.g. a 40-char
  git SHA) are deliberately **not** redacted — only labelled/prefixed secrets are.
- **`scripts/redact-sweep.js` (`npm run redact-sweep`)** — one-shot, per-machine
  scrub of rows that leaked before the fix. Checkpoints the WAL, backs up the db,
  rewrites matching `insights.content` / `compass_log.{action_summary,reason}`
  through the same redactor (FTS stays consistent via the existing triggers), then
  verifies no row still matches. Supports `--dry-run` and `--data-dir`. NOTE:
  resolves the standalone data dir by default — point it at the live plugin
  chronicle explicitly (the resolved path is printed before any write).

### Changed
- **`compass-fire` is now a META domain.** It is excluded from the default
  `recall()` and `getState()` surfaces (it was high-frequency reflection noise that
  crowded out curated insights — and embedded any credential-shaped command). The
  helix coupling that reads the `action:<hash>` chain already passes
  `include_meta: true`, so the OPEN→PAUSE escalation is unaffected.
- The compass `credential-paste` rule now resolves its regex from `lib/secrets.js`
  via `"pattern_source": "secrets"` instead of an inline pattern — detection and
  redaction share one vocabulary.

### Added
- **Retention/pruning** (`prune()`, called from the Stop hook) bounds the
  previously-unbounded operational tables: `compass_log` keeps the union of the
  last 30 days and the newest 5000 rows; `pending_confirmations` drops used/expired
  rows. Fail-open, in its own try/catch.
- `recall()` `tag` filter now escapes `LIKE` metacharacters (`% _ \`).
- 26 new tests (redaction unit + false-positive guard, write-path redaction at all
  three chokepoints, compass-fire recall/getState exclusion, redact-or-drop fail-safe,
  retention, the detection⊇redaction invariant, every token format below, and an
  end-to-end `redact-sweep` scrub across insights + compass_log + pending_confirmations).
  **161 tests total.**

### Hardened after adversarial review
A multi-lens review surfaced that the first cut's detector was broader than its
redactors — so a command could be classified PAUSE while its secret slipped through
unmasked (the v0.1 leak, reopened). Fixes:
- **Detection is now derived from the masking patterns**, so any credential *value*
  that is flagged is also maskable. (A few bare key-NAMES remain detection-only for an
  advisory PAUSE — they carry no value, so nothing leaks.)
- **JSON-embedded secrets** (`"token":"…"`), **URL basic-auth** (`scheme://user:pass@`),
  **HTTP Basic** headers, **special-char password values** (`@!#$%`), **short/truncated
  bearer tokens**, and major **cloud/SaaS formats** (Slack `xox*`, Stripe `sk_live_`,
  Google `AIza`, npm `npm_`, SendGrid `SG.`) are now masked + detected. The
  most-common carrier — JSON-serialized MCP/WebFetch `tool_input` — was the critical miss.
- **Third write site closed:** `createPendingConfirmation()` now scrubs the stored
  summary/reason (hash still over the raw value, so the override match holds), and the
  sweep covers `pending_confirmations`.
- **False positive fixed:** `tokenizer=` / `tokens=` no longer redact (a `(?![A-Za-z])`
  boundary after the keyword).
- **scrub() fixed-point backstop:** the write path coarse-masks any field that still
  holds a maskable secret after pattern redaction — a detected secret is never persisted raw.
- **redact-sweep safety:** consistent online `db.backup()` (replacing a swallowed
  `wal_checkpoint`+copy that could back up a corrupt db under concurrency); residual-leak
  verify now gates on the redactor (not the looser detector), fixing both false alarms and
  mislabeled real leaks; a non-dry run refuses the default fallback dir unless explicit.
- compass `pattern_source` fails loud if it doesn't resolve to a RegExp (no silent
  OPEN downgrade of the credential rule); the MCP `record` tool surfaces a dropped write
  instead of `{ok:true,id:null}`.

### Deferred to a later pass
- MCP error sanitization / `isError` on logical-failure tool results.
- A recall triviality gate (skip injection on trivial prompts) — borders Stage 2's
  method-surfacing and is deferred with it.

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
