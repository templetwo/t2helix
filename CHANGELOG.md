# Changelog

All notable changes to t2helix are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versioning is [SemVer](https://semver.org/).

## [0.14.0] — 2026-10-24 — the tagger stops learning failures from quoted text

`lib/outcome.js` no longer tags a Bash response `outcome:failure` because its
text contains `FAILED`, `AssertionError`, a traceback, `Error:` or `fatal:`.
PostToolUse only receives calls the harness accepted and the payload carries
no exit code, so that text was a deliberate RED test run, a brief that says a
test FAILS, a quoted traceback, or a real crash hidden behind a pipe, and the
tag could not tell which. Ambiguous is now untagged, as the module's own
contract always said; `interrupted` still tags failure; backgrounded or
harness-interpreted responses are untagged; clean accepted calls still tag
`outcome:success`. Measured on one MacBook: 109 Bash rows tagged
`outcome:failure` in two days, most of them on successful commands (at least
19 were real crashes behind a pipe; those are now untagged, not labelled);
the `memory:similar-failures` rule fired 19 PAUSEs in that window, 14 of them
on Bash. This entry supersedes the [0.10.0] description of text-based failure
detection and its Deferred auto-surface bullet below; that text stays as
history.

### Fixed (review follow-up to PR #12, cut as 0.14.0)
The Added bullets below were edited in place to describe the released
behaviour (the switch's first form never shipped); this list says what changed.
- **Under the human-confirm switch only origin `cli` approves.** The switch
  first refused origin `mcp` by name and let every other origin through;
  `approveConfirmation` is now an allowlist of one while the switch is on
  (`mcp`, `unattributed`, `CLI` and every other label refused, row left
  pending). Switch off: unchanged. New `lib/human-confirm.js`.
- **Model-facing text follows the switch.** With it on, `list_pending`
  withholds tokens (rows kept, `token_withheld: true`, a note), and the PAUSE
  deny text, the `memory:similar-failures` reason and the Grok adapter's
  PAUSE result say approval is a human's from a terminal, naming no script,
  path or token; the adapter also withholds its `pending_token`.
  `MESSAGE_VERSION` is `decision-message/0.14.0`. Each process reads the
  switch itself, so set it wherever the MCP server, hooks and adapter run.
- **`approve-pending-script` denies invocations, not mentions.** `node` /
  `nodejs` / `bun` / `deno` running the script, or executing it directly, in
  command position, is still WITNESS with no override; `git add`, `git log
  --`, `git commit -m` and `gh pr create --body` that only name the file are
  no longer denied. Shell-keyword positions (`if`, `while`, `until`, `then`,
  `do`, `else`, `elif`, `{`, `!`) count as command positions, and so does the
  point right after `)`, so `X=$(true) node <script>` and a script under a
  directory with parentheses in its name are still denied. Direct execution
  needs a path (a `/`): a bare name in parentheses is a mention. Every class
  after a command-position start excludes `(`, `)` and backtick, so runs of
  `(` / `$(` stay linear (a first form took 3.6 s at 64 KB and hid
  credential-paste behind NOT_EVALUATED at the hook on a 120 KB pad).
  Residuals: false positives where `;`, `|`, `(` or `&` inside a quoted string
  is followed by an invocation (write such text through a file); not matched:
  a redirect with no space, `env -i`, `sudo -u`, `nice -n`, `time -p`,
  `exec -a`, `bash -lc`, `eval`, `npx node`, stdin feeds (`cat f | node -`,
  `node < f`), variables, a flag with a separate argument (`node -r x`),
  `timeout N node`, `xargs node`, a bare script name executed off `PATH`.
- **Test isolation.** Six suites (regression, integration,
  approval-provenance, and, because the allowlist made them switch-sensitive,
  smoke, compass-v2, compass-fail-closed) unset the switch at the top, so
  `npm test` passes with it exported.
- Docs: tool count fifteen (CLAUDE.md), test count from the suite, the README
  v0.1.0 bullet restored as history.

### Changed
- `lib/outcome.js`: `bashOutcome` returns `null` for failure text, for
  `backgroundTaskId` / `timedOutAfterMs` / `backgroundedByUser`, and for
  `returnCodeInterpretation`; exports `FAILURE_TEXT_PATTERNS` for tests.
- `test/smoke.js`, `test/integration.js`: assertions follow the contract; a new
  integration test runs three RED-text PostToolUse echoes and shows PreToolUse
  does not PAUSE the command.
- `docs/error-atlas.md`, `README.md`: no longer promise text-based failure
  detection.

### Added
- `T2HELIX_REQUIRE_HUMAN_CONFIRM=1` (also `true`/`on`) makes approval an
  allowlist of origin `cli`: approvals from the model-facing MCP surface
  (origin `mcp`), with no origin or with any other origin are refused and the
  row stays pending for a human. Default off. The refusal the model receives
  names neither the approval script nor where tokens are listed. Plainly: the
  switch closes every in-process route except the terminal one, and it must
  be set in the environment of every process that serves `confirm_pending` /
  `list_pending`, runs the hooks or hosts the Grok adapter. Against an agent
  that has a shell and write access to the store it is a speed bump, not a
  wall. See README.
- `scripts/approve-pending.js`, the human path, recorded as origin `cli`:
  `T2HELIX_DATA_DIR="$HOME/.claude/plugins/data/t2helix-<marketplace>" node scripts/approve-pending.js <token>`.
  `--list` shows each pending request's id, action summary, token and expiry.
  Every result names the chronicle it used. A run with neither
  `T2HELIX_DATA_DIR` nor `CLAUDE_PLUGIN_DATA` set, or one naming a directory
  with no `chronicle.db`, is refused with exit 2 and creates nothing.
- Bundled WITNESS rule `approve-pending-script`: a shell command that runs
  `approve-pending` (node/nodejs/bun/deno on it, or executing it directly, in
  a command position) is hard-denied where the PreToolUse hook runs; a
  command that only mentions the file is not. A human's own terminal runs no
  hook, so the human path stays open.
- `test/approval-provenance.js` pins the switch, the refusal text, the
  terminal script and the rule; `test/compass-fail-closed.js` seeds the rule.

### Consequences, named
- **`lib/distill.js`'s success gate now admits more sessions.** Its gate is
  "real `outcome:success` and not a single detected `outcome:failure`". Bash
  rows whose only failure signal was text (a quoted or deliberate `FAILED`, a
  traceback, `Error:` behind an accepted call, including a real crash hidden
  behind a pipe) used to count as failures and kept a session out; they are
  now untagged, so such a session can distill a method candidate. Candidates
  stay quarantined in `method_candidates` and surface nothing until a human
  promotes one with `promote_method`.
- **The coupling goes quieter for Bash.** After this change the only Bash
  `outcome:failure` source is an interrupted run (`interrupted: true`), so
  `memory:similar-failures` can escalate a Bash command OPEN→PAUSE only on a
  history of interrupted runs. Edit/Write error strings still tag failure.

## [0.13.1] — 2026-08-30 — the credential gate stops stalling on code

Cut from the merge of `fix/secret-assign-requires-literal-value` (7ee32ff) onto
0.13.0. Ships the `secret-assign` literal-value fix — detection now rejects an
expression-shaped value, via a `detectSrc` that is a strict narrowing of `src`,
so the invariant becomes directional (detection ⊆ redaction) and the chronicle
write-path masker stays wider than the gate. Also carries the better-sqlite3
false-green ABI fix and the degraded-launcher deny.

### Fixed
- **The credential gate soft-denied ordinary code.** `lib/secrets.js`'s
  `secret-assign` leg fired on ANY labelled assignment (`token=…`, `key: …`)
  whose value was 8+ non-space characters, without ever asking what the value
  WAS. Measured on one seat over seven days of `compass_log`: 52 `PAUSE` and 24
  confirmed-OPEN on `credential-paste` across four sessions, dominated by a
  single shape — a labelled assignment whose value is an **expression**: a
  variable (`TOKEN="$BRIDGE_TOKEN"`), a command substitution
  (`token=$(cat …)`), a call (`password = getpass()`), a subscript
  (`api_key: os.environ["X"]`), a file read, or a regex. The specimen that
  forced the fix is a python one-liner that READS an env file and pastes
  nothing. Detection now rejects an expression-shaped value at the value
  position. This is not cosmetic: every PAUSE mints a single-use confirm token,
  so a gate that cries wolf on ordinary code trains the operator to spend those
  tokens unread — the exact reflex the credential gate exists to prevent.
- **The name-only leg was the same bug one leg over.** `\bapi[_-]?key\b` matched
  on the KEY NAME alone, so narrowing `secret-assign` by itself would have left
  `api_key: os.environ["X"]` soft-denied by `NAME_ONLY_DETECT` instead. It is now
  narrowed in **assignment position only**: a bare mention with no value
  (`echo $api_key`, `cat ~/.aws/secret_access_key`) is still an advisory PAUSE,
  and a key-name that is in assignment position defers to its value.
- **False-green native driver:** `require('better-sqlite3')` does not dlopen the
  `.node`; only `new Database(...)` does. `loadDriver()` / `health().driver_ok`
  now force a `:memory:` open so ABI mismatches cannot report GREEN and then
  die on first chronicle call.
- **MCP handshake under wrong Node:** `mcp/server.js` refuses start when
  `health()` is degraded (set `T2HELIX_MCP_SKIP_HEALTH=1` only for fixtures).
  `.mcp.json` and `npm run serve` go through `scripts/mcp-launch.js`, which
  re-execs under a stamped or discovered compatible Node when PATH is wrong.

### Changed
- **`DETECTION_REGEX` and `REDACTORS` may now diverge, in one direction only.**
  A pattern may carry an optional `detectSrc` that is a strict narrowing of its
  `src`: redactors always compile `src`, detection prefers `detectSrc`. The
  invariant is directional — **detection ⊆ redaction** — not equality, so the
  v0.2.0 "detected but not maskable" leak stays closed while the chronicle
  write-path masker stays WIDER than the gate. That asymmetry is deliberate:
  over-masking a code expression costs a fingerprint in a chronicle row, whereas
  over-gating it stalls a benign command. `secret-assign` is the only pattern
  that uses it. Widening a `detectSrc` past its `src` would reopen the leak.
- **The 8-character floor and the `[^\s"',}]` value class were left alone,**
  deliberately. Raising the floor to 16 or restricting the value to a token
  charset each lose true positives this repo already asserts —
  `password=hunter2hunter2` (14 chars) and `api_key=abcdefghij` (10) are
  must-PAUSE adversarial seeds in `test/compass-fail-closed.js`, and
  `test/smoke.js` asserts detection of `password=P@ssw0rd!Sup3r#SecretValue`,
  whose token-charset prefix is one character long. Per the release rule in
  `COMPASS_CONSISTENCY.md` ("strictly no worse than base on every carrier"), the
  expression lookahead does the whole job without touching the threshold.
- **One deliberate, recorded detection loss:**
  `AWS_SECRET_ACCESS_KEY=$(vault read …)` was `PAUSE` on the key name alone and
  is now `OPEN`. Reading from a secret store is not pasting a credential. It is
  asserted *as a loss* in `test/secret-assign-literal.js` so it cannot be
  mistaken for drift.

### Added
- **`test/secret-assign-literal.js`** + **`test/fixtures/secret-assign-vectors.js`**,
  wired into `npm test` and `npm run test:secret-assign`. Measures the leg on
  three surfaces that can disagree — the regex, `compass.classify()` (what the
  PreToolUse hook consumes), and `lib/compass-semantic.js`'s
  `evaluateCredentialPaste()`, which re-tests the same `DETECTION_REGEX`
  per-haystack and would otherwise have kept the stall reachable in enforce
  mode. Also asserts the detection ⊆ redaction split directly (the expression
  values that no longer PAUSE are proven **still masked**), and records accepted
  residue rather than claiming zero: a bare or dotted identifier value
  (`token=access_token_variable`, `api_token=self.session.token`) still fires,
  because that shape is not distinguishable from an opaque token — and excluding
  dotted runs would lose a JWT.
- **`lib/native-binding.js`** — probe, stamp (`.native-abi.json`), candidate
  node discovery, actionable remedy text.
- **`scripts/mcp-launch.js`**, **`scripts/hook-launch.js`**,
  **`scripts/write-native-stamp.js`**
- **`hooks/hooks.json`** routes every hook through `hook-launch.js` so bare
  PATH `node` (often Node 20 under Claude Code while the binding is Node 22)
  re-execs onto a compatible binary instead of failing UserPromptSubmit.
- **`npm run rebuild`** now rebuilds + stamps; **`postinstall`** writes stamp
  when the binding already loads.

## [0.13.0] — The gate fails closed, gates a capability, and stops handing over the credential

A security release integrating five independently reviewed fix branches onto one
tree. The through-line is a single failure class: **a surface that reports success
on a failed operation, or clearance on an evaluation that never happened.** Every
fix below closes one instance of it. Four of the five are compass changes and were
landed in a proven order (fail-closed floor → capability gating → normalization →
approval provenance → SSE/exec), because three of them compose and two of those
compositions are silent.

Upgrading is additive at the schema level (new columns, one new table) and is a
**behaviour change for existing compass rules and repo policies** — see Changed.

### Security

- **A gate that could not evaluate a call reported the same thing as a gate that
  evaluated and cleared it.** `hooks/pre-tool-use.js` emitted a bare `{}` — the
  OPEN payload — when stdin did not parse, when the payload carried no
  `tool_name`, when both classifiers threw, and when the harness killed the hook
  at its 5,000ms timeout. No `compass_log` row was written in any of those cases.
  A caller who could make evaluation *not happen* was therefore indistinguishable
  from a caller whose command was found clean, and the exploit did not need to
  defeat a single rule. There is now a fourth classification, `NOT_EVALUATED`, it
  denies, it always writes a row, and it mints no override token — the padding
  bypass would otherwise work in two steps instead of one.
- **Any tool that ran a shell under a name other than `Bash` was completely
  ungated.** Every destructive rule was scoped to the literal tool name `Bash`, so
  `mcp__shell__run`, `Terminal` and anything else carrying a `command`/`script`
  string bypassed the entire WITNESS floor, and its rows logged as `OPEN`.
- **Quoted and long-form flag spellings bypassed the rules.** `rm "-rf" x` and
  `rm --recursive --force x` cleared where `rm -rf x` denied.
- **The deny message handed the denied party the credential that lifts the deny.**
  The PAUSE reason string printed the single-use override token, and that string
  is model-visible by construction.
- **The SSE transport bound every interface while printing `localhost`.** The
  chronicle and compass tools are unauthenticated; anything that could route to
  the host could read and write them, and the startup line said otherwise.
- **`tools/witness-relay/monitor_workflow_memory.js` interpolated `JETSON_USER` /
  `JETSON_HOST` into a string passed to `child_process.exec`** — into a shell.

### Changed (BEHAVIOUR CHANGE for existing rules and repo policies)

- **`tool: "Bash"` on a compass rule now means the shell CAPABILITY.** Any tool
  whose input carries a non-empty `command` or `script` string is evaluated
  against every shell rule, whatever the tool is called. Rules naming any other
  tool keep exact scoping. This is opt-OUT, which is the right default for a
  safety floor and must not be undocumented.
- **`tool_exact: true`** (new) opts a shell rule back out — Bash and nothing else.
  **`capability: "shell"`** (new) is the opt-in counterpart for a rule scoped to
  some other tool name.
- **The match haystack is chosen per RULE, not per call.** A rule that names the
  tool, or is unscoped, is matched against the action string; a rule reached by
  the shell capability is matched against the payload field values; a rule reached
  both ways is matched against both, OR-ed, with identical strings scanned once.
  Choosing one haystack for the whole call blinded every tool-scoped rule whenever
  a `command` field was present.
- **Every command-shaped field is evaluated, not the first.** A benign `command`
  can no longer shadow a destructive `script` in the same payload.
- **`classify()` matches the command as written first, and normalizes only when
  that pass comes back clean.** The pass boundary is the RULESET, not the rule.
  That ordering is the whole safety argument: normalization can only ADD a denial
  and can never change WHICH rule fires on a command that already denied. Landing
  it inside the single loop reintroduces the 2026-07-26 regression, where
  `rm --force <file> && <a force push>` measured DENY under every mode before and
  ALLOW under enforce after.
- **The PAUSE deny reason no longer carries the override token.** It names the
  pending request by id and says approval is required; the token is found through
  `list_pending`. `renderDecision` still takes `opts.token` — as a signal that a
  request exists, never as content.
- **`compass_log.user_override`** on a consumed approval is now
  `token:<pending_id> origin=<origin>` rather than the bare pending id. The
  separator is a space because the colon form matches `lib/secrets.js`'s own
  assignment pattern and would be scrubbed to `[REDACTED]` by any surface that
  redacts.
- **`MESSAGE_VERSION` is `decision-message/0.12.2`** (`lib/decision-message.js`).
  See Integration findings — one string, two contract changes.
- Known cost, documented in `COMPASS_CONSISTENCY.md` and asserted in the suite:
  prose in a `command`/`script` field can match a rule and hard-deny.

### Added

- **`NOT_EVALUATED` and `isClearance()`** (`lib/compass.js`). Every allow/block
  site asks the predicate instead of comparing against the string `'OPEN'`, so a
  classification a caller has never heard of cannot fall through as allowed. The
  Grok and Codex adapters honour it too.
- **Time budgets** — `T2HELIX_CLASSIFY_BUDGET_MS` (1,200ms), `T2HELIX_RULE_BUDGET_MS`
  (400ms), `T2HELIX_GATE_BUDGET_MS` (3,500ms), and for the semantic leg
  `T2HELIX_SEMANTIC_SKIP_BYTES` (4,096) / `T2HELIX_SEMANTIC_BUDGET_MS` (1,200).
  The bundled patterns are held linear by the suite, but a repo-local policy
  compiles operator regexes this file has never seen, and there the budget is the
  only backstop. Overrunning yields
  `NOT_EVALUATED` naming the rules that never ran — not `OPEN`.
- **`T2HELIX_CAPABILITY_BUDGET_MS`** (400ms) — the budget for a call fe8aa0c would
  not have evaluated at all. The tighter of it and `T2HELIX_CLASSIFY_BUDGET_MS`
  applies, so forcing the general budget down still forces it down everywhere.
  Overrunning it yields `OPEN` with `rule_matched = capability-scan-declined`,
  not a denial: on that carrier the released gate cleared the call without reading
  it, so declining is parity, not a fail-open. Unreachable on Bash by construction.
- **`matcher_source` on a rule** (`lib/compass.js`) — a rule may keep its `pattern`
  as the specification and be evaluated by a named module's linear `test()`.
  `compass.ruleTest(rule, s)` is the one way to run a rule, so a cost or
  equivalence test cannot measure code the engine does not run.
  `matcher_source`/`matcher_version` are projected into the ruleset manifest, so
  the matcher a historical row was decided by is named and `ruleset_hash` moves
  when it changes.
- **`test/compass-no-worse-than-base.js`** — 16 assertions holding the release
  gate: the deploy-prod equivalence walk, its linear-growth bound, the parity
  floor and both Bash guards, the hook writing the row and clearing the call, and
  the R4 Bash-parity pins.
- **`T2HELIX_GATE_FAILURE_MODE=open`** — the escape hatch. Fail-closed is right for
  a gate, but a gate that denies every call and cannot be turned off from outside
  the session is a brick. It governs the non-evaluation path only, never a real
  WITNESS or PAUSE, and the audit row is written either way so the hatch cannot
  hide a gap.
- **`compass_log.ruleset_hash` / `ruleset_source` / `rules_eligible`**, and a
  `compass_rulesets` table holding each distinct ruleset's manifest once.
  `rules_eligible: 0` records "no rule could evaluate this call". Additive
  migration; NULL means the row predates the column.
- **`semantic_skipped`** on the shadow record — null when the semantic leg ran,
  otherwise the reason it was not consulted, so a shadow row with `agree: null` is
  distinguishable from one where the leg silently failed. The same audit-integrity
  property `NOT_EVALUATED` exists for, one layer down.
- **Approval provenance** — `pending_confirmations.approved_origin` and
  `approved_tty` (additive migration). `approveConfirmation({ token, origin })`
  records the origin its caller states; `mcp/server.js` hardcodes `'mcp'` so a
  caller cannot declare its own, and an unnamed origin records `unattributed`
  rather than NULL. Nothing gates on either field — they exist so an approval row
  can no longer read as operator-driven when it was not.
- **SSE host control** — `--host` / `T2HELIX_SSE_HOST`, defaulting to `127.0.0.1`.
  The startup line prints the address the kernel actually returned, and a
  non-loopback bind warns loudly.
- **Six test files**, all wired into `npm test` (18 files total):
  `compass-fail-closed.js`, `compass-capability.js`, `compass-normalization.js`
  (+ `fixtures/compass-normalization-specimens.json`), `approval-provenance.js`,
  `sse-bind.js`, `witness-relay.js`.

### Fixed

- **The `git-push-force` and `no-verify` patterns were superlinear.** Both used a
  segment-wide `[^|;&]*`, which is a superset of `\s`, so a command padded with
  contiguous spaces burned the whole PreToolUse timeout — and a killed hook emits
  nothing, which the harness reads as no objection. Rewritten with a tempered
  guard that cannot consume past a later trigger.
- **The semantic leg could run the hook past its timeout after the verdict was
  already known** (`lib/compass-v2.js`). On `git reset --hard HEAD~5; echo ` +
  80,000 a's the legacy leg reached WITNESS in 1ms and `classifySemantic` then
  spent 9,647ms at 100KB — so the hook was killed at 5s *after* a correct deny had
  been computed, and the harness read the silence as no objection. A budget cannot
  preempt a regex already entered, so the leg is now declined in the three cases
  where declining provably cannot change the verdict: a legacy `NOT_EVALUATED`
  (which `mergeDecisions` treats as absorbing), a legacy WITNESS on an oversize
  action (WITNESS is the top of the lattice — the leg could only CLEAR it, so
  skipping fails closed), and a legacy leg that already spent its budget. **OPEN
  and PAUSE are never skipped at any size**, because there the leg can escalate and
  dropping an escalation would be a fail-open. `parseToIR` is kept unconditionally
  — it is linear and supplies the hash the token and lease flows key on.
- **Long-flag spellings reach the predicates**, mapped from the same
  `LONG_FLAG_LETTERS` table the Action IR parser uses so the two layers cannot
  drift.
- **`git reset --hard` is caught wherever the flag sits.** The rule walked from the
  subcommand straight to the flag; it now walks intervening tokens, so
  `git reset HEAD~1 --hard` is gated like the adjacent spelling.
- **`lib/secrets.js`'s url-auth pattern was quadratic, and the first fix only
  covered half of it.** `[a-z][a-z0-9+.-]*://` restarted at every character of a
  long alphanumeric run and scanned to the end looking for a `://` that was not
  there — 4,772ms on `echo ` + 100,000 a's, 17,683ms at 200,000, paid once by the
  legacy credential rule and again by the semantic leg, which alone was enough to
  run the hook past its 5,000ms budget.

  A `(?<![a-z])` scheme-start lookbehind was landed first. **It fixes the
  letters-only case and nothing else**, because a DIGIT is not `[a-z]`: every
  position following a digit still passes the lookbehind and still starts a fresh
  scan to the end of the run. On a random letter+digit run that is ~n/2 restarts,
  so the pattern stayed quadratic on exactly the inputs a hex dump or an
  alphanumeric ID stream produces. The earlier entry credited that anchor with
  fixing the quadratic; it did not, and the suites could not see the gap because
  every pad they swept was periodic. Measured at 200,000 chars with only the
  lookbehind in place: hex 4,387ms, `[a-z0-9]` 3,627ms, `[A-Za-z0-9]` 2,234ms,
  against base64url 4.4ms, letters-only 2.2ms and `'a'.repeat(n)` 1.5ms.

  The pattern is now anchored on the literal `://` with the scheme verified behind
  it (`://(?<=(?<![a-z])[a-z][a-z0-9+.-]*://)…`), so the number of match attempts
  that do real work is the number of `://` occurrences rather than the number of
  digits. Same shapes at 200,000: **4,387ms → 0.6ms, 3,627ms → 1.2ms, 2,234ms →
  1.2ms**; at 400,000, **15,949ms → 1.2ms**. Full before/after in "No worse than
  fe8aa0c" below.

  **Equivalence was proved on capture groups and redactor output, not on
  `test()` hit/miss**, because this table does double duty: `DETECTION_REGEX`
  classifies for the compass rule while the same `src` compiles into `REDACTORS`,
  which is what actually masks secrets on the chronicle write path — so a
  detection change that silently stopped masking would be worse than the stall it
  fixed. **4,489,568 inputs** (a 4.0M structured cross-product over every part of
  the grammar, 53 named adversarial cases, exhaustive enumeration of every string
  of length ≤ 5 over `a1:/@.Z`, 400K randomised fuzz, 60K strings carrying 2–12
  url-auth spans each, and 84 inputs of 10K–100K chars), **0 divergences** in
  `DETECTION_REGEX.test()`, in group-1 span value AND index, in `redactSecrets()`
  and in `scrub()`. The harness was negative-controlled: the plausible-looking
  alternative `(?<![a-z0-9+.-])[a-z]…` is rejected by it with **74,564
  divergences**, all of the detection-loss shape (`1abc://u:pass@h` matches today
  and would stop matching — a secret that stops being masked). Every consumer of
  `DETECTION_REGEX` was checked: `lib/compass.js` (`PATTERN_SOURCES.secrets`) and
  the five call sites in `lib/compass-semantic.js` all use `.test()`, so hit/miss
  governs there; `lib/chronicle.js` (×12), `lib/manifest.js` and
  `scripts/redact-sweep.js` reach it through `redactSecrets`/`scrub`, which is the
  surface the byte-identity assertion covers. `match[0]` IS shorter now — it no
  longer spans the scheme — which is safe because `group: 1` masking re-emits
  everything outside the captured span verbatim.
- **`scripts/replay-compass.js`** reconstructed any non-Bash tool call as
  `{raw: …}`, so every capability-gated deny replayed as `OPEN` and was reported
  as a softening. It now parses the stored envelope, and counts a row whose
  summary was truncated as `unreplayable` instead of manufacturing a false
  softening. `--strict` no longer goes quiet on rows it could not adjudicate.
- **Audit metadata cannot break a verdict.** Hashing the ruleset runs in its own
  pass behind its own try/catch: a throw there would propagate out of `classify()`,
  and the hook's legacy fallback calls `classify()` again — so the hook would emit
  a `systemMessage` and ALLOW. Describing a decision is not allowed to break
  making one.
- **`test/integration.js`'s WITNESS guard no longer discriminates by
  `!/confirm_pending/`.** Once the PAUSE deny stopped naming `confirm_pending`,
  that assertion was satisfied by both classifications. It now asserts that
  WITNESS mints *no* pending confirmation, carries no `[soft-deny]` prefix, and
  renders the BLOCKED banner. Proven by mutation: a hook that mints for
  `classification !== 'OPEN'` and renders WITNESS as PAUSE passed 19/0 under the
  old guard and fails 18/1 under this one.
- **`mcp/server.js` SSE bind** — see Security. Binds loopback by default and
  reports the address it actually got.
- **`tools/witness-relay/monitor_workflow_memory.js`** builds an argv array for
  `execFile` instead of a shell string, rejects anything that is not a plain
  user/host name (a leading `-` lands in `argv[0]` where `ssh` reads it as an
  option), and no longer polls on `require`.

### Integration findings (visible only with all five fixes on one tree)

Each of these merged without a textual conflict and would have shipped wrong.

- **`MESSAGE_VERSION` named two contracts.** The approval branch bumped it to
  `decision-message/0.12.1` for its own change (the PAUSE next-step dropping the
  token); the fail-closed branch made a different material change to the same
  `renderDecision` contract (a fourth classification with its own banner and
  next-step branch) and did not bump. The hunks were disjoint. Resolved as
  **`decision-message/0.12.2`**, the union, with both changes named at the
  constant. `test/compass-fail-closed.js` was the one stale consumer — it scraped
  the override credential out of the deny text to set up its approval-reuse case,
  which is precisely the leak the other branch closed; it now reads the pending
  row from the ledger and asserts both halves of the new contract.
- **Normalization is a property of the TARGET, not of the call.** The dequote pass
  arrived guarded by `tool_name !== 'Bash'`, correctly: `actionString()` serialises
  a non-Bash `tool_input` to JSON, where quotes are structure. But capability
  gating had just started feeding non-Bash `command`/`script` values to the same
  shell rules, and those payloads are raw shell. Carried across verbatim, the
  guard left every tool the capability fix newly gated reachable by exactly the
  quoted spelling the dequote fix exists to close — measured on the merge before
  the fix: a quoted recursive-delete flag denied through `Bash` and CLEARED
  through `mcp__shell__run`. `normalizeTarget()` now decides per target: a shell
  payload field is normalized whatever the tool is called; the action string is
  normalized only for Bash.
- **The rewritten `git-reset-hard` pattern was superlinear**, and only the
  fail-closed branch's linearity harness could see it — the two branches never
  met. Measured 5,590ms on a 200KB repeated-trigger pad, past the 5,000ms hook
  budget: hook killed, nothing emitted, call ungated. Fixed with the same
  tempering idiom the other two git rules got, proven equivalent to the
  un-tempered pattern on 66,429 strings from an exhaustive token-grammar walk plus
  12 hand cases (zero divergences), 5,590ms → 1ms.
- **The `NOT_EVALUATED` verdict carried no ruleset provenance.** `lib/schema.sql`
  defines a NULL `ruleset_hash` as "this row predates the column", so the one
  classification meaning *never evaluated* would have been the least
  reconstructable row in the log, and mislabelled besides. The audit fields are now
  spread onto that return, and `emitNotEvaluated()` stamps provenance at the three
  hook sites where a `tool_input` exists. The three that fire before one is read
  (unparseable payload, no `tool_name`, an unhandled throw out of `main`) carry
  NULL honestly.
- **The landing-order hazard is discharged.** Landing normalization on the unfixed
  superlinear patterns dropped the padding needed to blow the 5,000ms budget from
  ~3,200 to ~2,450 contiguous spaces, a ~23% discount, because the second pass
  paid the superlinear cost twice. With the linear patterns landed first, two
  passes of a linear match is still linear and the effect is gone; the
  characterization test in `test/compass-normalization.js` detects whether the
  patterns are fixed and reports on every run. The normalized pass additionally
  skips any target normalization did not change, so the integrated worst case is
  one extra scan per CHANGED string rather than a doubling of every scan.

### No worse than fe8aa0c (the release gate)

Capability routing gates carriers fe8aa0c never touched. That is the point of the
release, and it is also the one way the release could *cost* something: a call
that used to be waved through in ~55ms at any size now gets scanned, and a scan
can be slow, and a slow scan turns into a denial or a killed hook. The acceptance
bar is absolute — **no input, on any carrier, may produce a worse outcome than
fe8aa0c** — where worse means any of: base denies and this tree clears; base
reaches a decision and this tree is killed emitting nothing; base writes an audit
row and this tree writes none; base clears a benign command and this tree denies
it.

Three things failed that bar and are now closed — and the third was found only
after the first sweep had already certified the tree, by a grid that swept a
payload shape the suites did not generate. The order matters: the receipt came
first and was wrong, because a cost suite can only ever certify the shapes it
knows how to build.

- **`deploy-prod` was quadratic in the number of trigger words in a segment.**
  Each `kubectl|terraform|helm|aws|gcloud` occurrence re-ran three segment-wide
  scans. Hook-level, `kubectl apply x ` repeated: on **Bash** fe8aa0c took 1,978ms
  and cleared at 150KB while this tree denied at 2,004ms (`NOT_EVALUATED`) — a
  regression on the carrier the previous notes called strictly better — and at
  400KB both trees were killed. On **mcp__shell__run** fe8aa0c cleared in 56ms at
  every size, against 2,006ms `NOT_EVALUATED` at 150KB and a silent 5,003ms kill
  at 400KB. The kill is the worst cell in the matrix: the call proceeds either
  way, so it is security-equivalent, but the `compass_log` row fe8aa0c wrote is
  lost. The rule now keeps its pattern as the **specification** and is evaluated
  by `lib/rules/deploy-prod-matcher.js`, a linear reimplementation. The
  equivalence proof the previous round asked for is
  `test/compass-no-worse-than-base.js`: 2,284,440 generated inputs over the rule's
  own vocabulary, 11,235 both-hit, **0 lost and 0 widened**. Cost 1,935ms → 2ms at
  150KB, 8ms at 800KB. This had to be a linearisation and not a
  trigger-word presence check: the `blocked-tail` pad shape (`kubectl apply x `
  repeated, then `|prod`) has the target present and unreachable, and defeats a
  presence check exactly.
- **A budget cannot cover the rules `lib/compass` has never seen.** For a call
  fe8aa0c would not have evaluated at all — a shell payload on a tool no rule in
  force names — budget exhaustion now falls back to **parity with fe8aa0c**: an
  `OPEN` row with `rule_matched = capability-scan-declined`, naming the rules that
  did not run, and the call proceeds. The row is still written. This is licensed
  by a single fact and nothing else: `compass.capabilityOnlyCall()` reproduces
  fe8aa0c's eligibility line verbatim (`!rule.tool || rule.tool === tool_name`)
  and returns true only when NO rule is base-eligible. **Bash can never reach it**,
  guarded twice — every bundled shell rule names Bash, and the predicate also
  refuses `Bash` outright, so a user ruleset written entirely as
  `capability: "shell"` (which `T2HELIX_DATA_DIR/compass/rules.json` may use to
  REPLACE the bundled set) cannot turn the shell gate off on the one tool it has
  always covered. Pinned by a fixture.

- **`credential-paste` was quadratic on any unbroken letter+digit run, and both
  cost suites were structurally incapable of seeing it.** The pattern itself is
  described under `lib/secrets.js` above. What made it a RELEASE-GATE failure
  rather than a slow regex is that the credential rule is
  `pattern_source: "secrets"` and capability-routed, so the cost landed on
  `mcp__shell__run`, `Terminal`, `mcp__future__exec` and the Grok envelope —
  carriers fe8aa0c waved through in ~58ms without reading them at all. An
  independent 630-cell grid found **five cells worse than fe8aa0c**, every one of
  them a random letter+digit payload:

  | shape | size | carrier | fe8aa0c | before the fix | audit rows |
  |---|---|---|---|---|---|
  | b64-random | 400K | Grok | ALLOW 62ms | DENY 2,620ms | 1 → 1 |
  | b64-random | 800K | `mcp__shell__run` | ALLOW 64ms | KILLED 5,004ms | 1 → 0 |
  | b64-random | 800K | Terminal | ALLOW 58ms | KILLED 5,004ms | 1 → 0 |
  | b64-random | 800K | `mcp__future__exec` | ALLOW 58ms | KILLED 5,004ms | 1 → 0 |
  | b64-random | 800K | Grok | ALLOW 59ms | KILLED 5,002ms | 1 → 0 |

  The four 800K cells are the worst sub-severity in the matrix: the call proceeds
  either way, so it is security-equivalent, but the hook is SIGKILLed, emits
  nothing, and the `compass_log` row fe8aa0c wrote is **lost** (1 → 0). On **Bash**
  this cost is PRE-EXISTING rather than new — fe8aa0c took 73,316ms at 200KB and
  both trees are killed at 800KB — so linearising it is a net win beyond closing
  the regression. Measured at the hook after the fix, 800KB on Bash:
  fe8aa0c KILLED at 5,018ms, this tree ALLOW in 606ms.

- **THE TEST BLIND SPOT, which is the more important half.** Every pad both cost
  suites built was PERIODIC. `test/compass-fail-closed.js` `padShapes()` derives
  each pad from the rule's own trigger and tail — for `credential-paste` the seed
  is `{trigger:'password=', tail:'hunter2hunter2'}` — and `'a'.repeat(n)` measures
  ~2ms against this regex. `test/compass-no-worse-than-base.js` `BENIGN_SHAPES`
  was the same: `base64-blob` is a repeated 52-char token, `lowercase-run` a
  repeated 26-char cycle. So the fail-closed file's own `[note]` line printed a
  slowest-rule list that did **not** name `credential-paste`, while that rule cost
  2,276–4,095ms at the same size on an aperiodic pad. **A suite that cannot fail
  on the shape that matters is not evidence, and the "0 cells worse" receipt this
  paragraph used to carry was exactly that.**

  Both suites now draw from `test/fixtures/aperiodic-pad.js` — deterministic,
  prefix-stable, rejection-sampled aperiodic runs over hex, `[a-z0-9]` and
  `[A-Za-z0-9]`. The keystream is sha256 in counter mode ON PURPOSE: the probe
  that first found this bug used an LCG, whose low-order bits have a short period
  modulo a power-of-two alphabet, and it silently produced a PERIODIC "hex" pad
  that measured 1.8ms and reported the bug ABSENT. The instrument was the first
  thing wrong, which is the whole lesson. The pads are verified prefix-stable and
  **non-matching against every loaded rule at every size to 800,000**, so they
  measure the cost of FAILING to match — the cost the exploit actually buys.

  Failing-first, captured on a tree whose `lib/secrets.js` is byte-identical to
  the shipped one: fail-closed named `credential-paste/aperiodic-hex 4,423ms`,
  `/aperiodic-alnum36 3,828ms`, `/aperiodic-alnum62 2,578ms` at 200,000b against a
  250ms per-rule ceiling, and the no-worse cost matrix produced **96 violations**
  across all three aperiodic shapes and four newly-routed carriers at 80K–200K,
  from 2,505ms to **33,265ms** against a 1,000ms ceiling and a 5,000ms hook
  budget, every one of them also reporting `OPEN but Bash says NOT_EVALUATED`.
  After the fix the per-rule ceiling note no longer names `credential-paste` at
  all, and the whole-gate arm's offender count drops from **34 cells to 4** — the
  4 survivors being periodic shapes dominated by the pre-existing
  `t2helix-protect-chronicle-db` operator rule, which fails on BOTH trees.

Receipts: **the previous "420-cell sweep, 0 cells worse" receipt was accurate for
the shapes it swept and blind to the shape that mattered** — all 12 of its payload
shapes were periodic, which is why it certified a tree with five worse cells in
it. It is superseded by an **840-cell** hook-level sweep (24 payload shapes × 7
sizes from 20KB to 800KB × 5 carriers — Bash, `mcp__shell__run`, `Terminal`, a
future MCP tool name, and the Grok envelope), fe8aa0c vs this tree, run through
the REAL hook process with the REAL 5,000ms PreToolUse budget and a fresh data dir
per cell. It carries the original 12 shapes verbatim (including that grid's
`b64()` generator byte-for-byte, so the five reported cells reproduce on this
instrument), plus three aperiodic letter+digit runs and three shapes built to be
adversarial to the NEW pattern specifically. Empty stdout or a nonzero exit is
scored HARNESS-ERROR, never ALLOW — scoring a silent hook as a clearance is the
fail-open that manufactured a dozen phantom "41ms ALLOW" cells in an earlier
round.

Result: **840 cells — 781 identical, 58 strictly better, 0 HARNESS-ERROR, and 0
worse that survive re-confirmation.** The 58 are all Bash cells where fe8aa0c was
SIGKILLed at ~5,005ms and wrote NO audit row, and this tree now decides in
300–1,100ms and writes one (`0 → 1` rows): `b64-random` at every size from 20KB,
`json-blob` from 80KB, the three `aperiodic-*` runs, `dotted-run-sep`,
`run-sep-pairs`, and the `deploy-*` shapes. The three shapes built to be
adversarial to the NEW pattern behave: `dotted-run-sep` (a run kept class-legal
by `.`/`-`/`+` then many `://`) is 2,085ms/8,405ms on the old pattern at
200K/400K and 0.7ms/1.4ms here, and `colon-dense` is ALLOW on both trees at every
size, confirming the tail `[^/\s:@]+:([^/\s@]{3,})@` is not a second quadratic —
every `://` root contains a `/`, which is excluded from the tail class and stops
its scan.

**One cell was flagged and did not survive re-confirmation, and saying so is the
point.** `quote-churn` at 400KB on Bash came back `base=ALLOW(4,032ms)` vs
`new=DENY(4,014ms)` — an apparent availability regression at IDENTICAL cost,
which is already the signature of a threshold rather than a slowdown. Re-run five
times per tree, that cell is NON-DETERMINISTIC ON BOTH: base was KILLED in 4 of 5
runs and ALLOWed once; this tree was KILLED 3 and DENYed 2. It sits exactly on the
5,000ms budget line (200KB: both ALLOW at ~1.5s; 800KB: both KILLED), its dominant
term is the PRE-EXISTING `classifySemantic` cost on that shape, and the shape is
periodic — unrelated to the letter+digit class this fix addresses. The single
grid sample happened to draw base's one-in-five ALLOW. **A one-sample-per-cell
grid cannot adjudicate a cell on the budget boundary; that is a property of the
instrument, not of the tree**, which is why every flagged cell is re-run before it
is believed. These runs were taken on a machine under heavy external load, which
widens that boundary band considerably.

The full exploit set re-runs **91/91 closed, 0 reopened, 0 new false positives**,
against 67 cases that were open or ungated on fe8aa0c. The suite is
**19 files, 611 assertions, 0 failed, every file at real exit 0**.

**A note on measuring any of this on a busy machine, because it changed two
verdicts and both times the instrument was the thing at fault.** These runs
overlapped a game holding ~5.75 of 14 cores. Under that load the SAME code on the
SAME input measured 4,387ms and 22,748ms an hour apart, so any table pairing an
old number from one run with a new number from another is measuring the GPU, not
the regex — every before/after figure quoted here is therefore an INTERLEAVED
pair, both halves timed adjacently in one process on the identical input. Under
that load the suite also reported one failure per run, in a DIFFERENT test each
time (`deploy-prod: cost grows linearly`, a ratio assertion on a 1ms baseline
that read 8.7x and 10.0x; then `whole gate 5,291ms > 3,000ms` on
`quote-churn/800000`). Failures that move between runs are flake, not
regression — and the attribution is direct: `quote-churn` at 800KB through the
whole gate measures **2,818ms un-linearised vs 2,857ms linearised**, `OPEN` on
both, i.e. this change does not touch it; its cost is the pre-existing
`classifySemantic` term already recorded above, and it simply sits near the
ceiling. Re-run once the machine was idle, that cell reads **1,272ms** (matching
the 1,216ms recorded for fe8aa0c) and the suite is green. The numbers above are
the idle-machine ones.

**R4 — prose in a `command`/`script` field.** On the newly-routed carriers, prose
containing a trigger phrase now denies where fe8aa0c was OPEN. This is parity, not
a regression, and it is left as parity: on a tool that EXECUTES that field as a
shell command, such a string is a command, and Bash has denied exactly it since
long before fe8aa0c. Un-routing by guessing whether a payload "looks like prose"
would put a new content classifier between the payload and the gate — a larger
attack surface than the false positive it removes. What is pinned instead is that
the verdict never differs from Bash's, rule id included, in either direction, and
that a payload under any field name no shell tool executes is not routed at all
(`SHELL_PAYLOAD_FIELDS` stays `['command', 'script']`).

### Known-open (recorded, not fixed)

- **`lib/grok-adapter.js` still returns `pending_token` verbatim to its gated
  caller.** The universal phrasing in `CLAUDE.md` — "a gate does not hand over the
  credential that lifts it" — is scoped to the hook path until that surface is
  fixed too; `README_GROK_INTEGRATION.md` states the asymmetry per seat.
- **`list_pending` is the sole designated path to the credential and
  `mcp/server.js` leaves `session_id` optional**, so an unscoped call returns every
  unexpired token across all sessions. Pre-existing, but this release makes its
  scope load-bearing. Operator call.
- **A model can still fetch a token through `list_pending` and self-approve.**
  Deliberate: masking it there would leave no surface from which the token can be
  obtained, converting PAUSE into WITNESS.
- **The repo's own `t2helix-protect-chronicle-db` rule remains superlinear**, named
  in `KNOWN_SUPERLINEAR` in `test/compass-fail-closed.js` as an upper bound — a new
  offender fails the suite, and so does fixing one without removing its entry. It
  is left as-is deliberately: it is the concrete instance of the population the
  budgets exist for, an operator regex `lib/compass` has never seen. (`deploy-prod`
  was on this list and is no longer — see "No worse than fe8aa0c" below.)

  **It also dominates the whole-gate cost arm whenever the repo policy is
  loaded, and WHETHER IT IS LOADED DEPENDS ON HOW THE SUITE IS INVOKED.**
  `npm test` does not set `T2HELIX_POLICY_DIR`, so `lib/compass` walks up from
  `cwd`, finds this repo's own `.t2helix/policy.json`, and compiles that rule —
  ten rules in force. A runner that blanks `T2HELIX_POLICY_DIR` gets nine and a
  materially different cost profile. The two configurations are not
  interchangeable and a before/after measured across them is not a comparison:
  with the policy loaded, `test/compass-fail-closed.js`'s
  `the WHOLE gate (both legs) stays in budget` arm is dominated by this rule and
  can exceed its 3,000ms ceiling on a loaded machine, on THIS tree and on
  fe8aa0c alike. Measured back-to-back under identical load, that arm reports
  **34 offending cells before the credential-paste linearisation and 4 after**,
  the 4 survivors all periodic shapes with this operator rule as the dominant
  term. So the arm is a real signal about the operator rule and a contention
  amplifier, not a regression indicator for this change.
- **On a carrier fe8aa0c never gated, an operator's slow rule buys a decline, not
  a deny.** The capability parity floor clears such a call when the capability
  budget runs out, so a sufficiently expensive `.t2helix/policy.json` regex can
  cost the operator the gating that capability routing added — but never more than
  fe8aa0c gave, which was none. Bounded at capability budget + one rule's overrun
  (a regex cannot be preempted once entered). Bash is excluded by construction.
  Measured in `test/compass-no-worse-than-base.js`, arm C9.
- **`escalateByMemory()`'s escalation branch builds a fresh result object and drops
  the audit fields.** No consumer reads them off the result — `hooks/pre-tool-use.js`
  resolves provenance independently, so a memory-escalated PAUSE row still records
  `ruleset_hash` and `rules_eligible` — but a future consumer that trusted the
  result object would read "provenance unknown".
- **`--flag=value` long-form is not closed.** The rewrite's `(?![\w-])` lookahead
  permits `--recursive=yes` → `-r=yes`, which then fails the rule's `-[rRf]+\s+`
  because of the `=`. Closing it means stripping an `=value` suffix before mapping
  — a pattern edit, and this codebase has reverted two of those.
- **Backslash-escape and ANSI-C spellings** (`rm \-rf`, `rm $'-rf'`) are
  pre-existing and were never claimed. The quoted and long-form subset is closed,
  not the whole bypass class.
- **A trailing shell comment is read as argument text.** `git reset HEAD~1 # avoid
  --hard` moves OPEN → WITNESS. It fails in the SAFE direction. The one-character
  remedy — excluding `#` from the token class — is worse and must not be taken: git
  refs and paths may contain `#` mid-token, and it flips three real
  work-discarding commands from WITNESS to OPEN. Both halves are pinned in the
  `comment_boundary` fixture group.
- **A repo-policy rule with a `condition` and no `pattern`** fires on the first
  pass and starves the normalized pass. Not a regression; pinned as a
  characterization.
- **`README.md`'s tool count says eighteen; the registry exposes fifteen.**
  Pre-existing on the base commit (three safe-repeat lease tools were withdrawn
  there) and unrelated to these fixes, so it is reported rather than folded in.
  `npm run release:doctor` names it.

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
