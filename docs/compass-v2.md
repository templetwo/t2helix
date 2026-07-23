# Compass V2 (v0.12)

Action-aware Guard layer for T2Helix. Implements the frozen v0.12 slice of the
*T2Helix V2 Master Architecture and Implementation Blueprint*.

## Flow

```
tool input → adapter → Action IR → semantic predicates → decision + evidence
                ↘ legacy string rules (still authoritative in shadow mode)
```

## Two summaries — do not merge them

| Field | Role |
|-------|------|
| `action_summary` | **Identity.** The legacy raw-command summary. Hashed into the `action:<hash>` chain anchor, hashed into the pending-confirmation key, and used as the recall query for memory coupling. |
| `display_summary` | **Operator display only.** The IR rendering, used in deny messages. |

`hooks/post-tool-use.js` independently derives `action_summary` via
`compass.summarizeAction()`. If the two ever diverge the compass↔outcome chain
stops pairing with no error — recall simply returns one end. Never hash
`display_summary`, and never let the IR rendering become the identity.

## Mode (`T2HELIX_COMPASS_V2`)

| Value | Behavior |
|-------|----------|
| `shadow` (default) | Legacy enforces. Semantic runs beside it; comparison stored in `compass_log.shadow_json`. |
| `enforce` | Migrated families (**rm**, **credential-paste**) use semantic predicates. Non-migrated WITNESS rules stay on legacy. Documentation-only commands clear string false positives. |
| `off` | Legacy only; no IR parse. |

## Modules

| Path | Role |
|------|------|
| `lib/action-ir.js` | IR types, hash, `parseToIR` |
| `lib/action-ir/bash.js` | Conservative shell tokenizer/parser |
| `lib/action-ir/tools.js` | Edit/Write/MultiEdit/Grok adapters |
| `lib/compass-semantic.js` | Predicates + family merge |
| `lib/compass-v2.js` | Orchestrator |
| `lib/decision-message.js` | Operator message contract |
| `lib/safe-repeat.js` | Session leases (PAUSE only) |
| `scripts/replay-compass.js` | Historical replay / diff report |

## What enforce actually changes

| Action | legacy | enforce | why |
|--------|--------|---------|-----|
| `rm -rf <glob>` / `rm -r <glob>` | WITNESS | WITNESS | recursion makes the match set unbounded; `-f` only suppresses the prompt |
| `rm -f <glob>` (non-recursive) | WITNESS | **PAUSE** | the July 21 false-positive class — still gated, now overridable |
| `rm -rf /tmp/<session-dir>` | WITNESS | **OPEN** | session-created temp cleanup, no wildcard |
| `rm -f /abs/path/one.log` | WITNESS | **OPEN** | single named file, non-recursive |
| `echo`/`printf` of a dangerous string | WITNESS | **OPEN** | quoted prose executes nothing (see below) |

Everything else — force-push, reset --hard, drop-table, prod mutations,
`--no-verify` — stays on the legacy classifier untouched.

### The documentation-only clearance

An `echo`/`printf` whose text merely *contains* a gated command clears the false
positive, and this is the one place a semantic verdict overrides a rule it was
not migrated to reason about. It is deliberate: an echo executes nothing, and
when it redirects into a file it is a write — which the Write/Edit tools perform
ungated anyway, so gating it here would buy no safety while re-breaking the
documentation false positives. The clearance is not silent: the cleared rule id,
the basis, and any redirection are recorded in `compass_log.evidence_json`.

Any segment that could actually execute the text — a pipe into a shell, a nested
interpreter, command substitution, backticks — fails the documentation test and
stays gated.

## Enabling enforce

```bash
export T2HELIX_COMPASS_V2=enforce
```

Prefer a clean shadow observation window and `npm run replay-compass` before
making enforce the default for a seat. Read both counters the replay prints:
`weakenings` (non-migrated floor rules softened — fails `--strict`, should always
be zero) and `softenings` (migrated families softened — expected, but review the
listed rows against the table above).

## Safe-repeat leases

After a human confirms a PAUSE action, arm a lease with `arm_safe_repeat`
binding `normalized_action_hash` + `parser_version` + `cwd`. Never covers
WITNESS. Revoke with `revoke_safe_repeat`.

## Out of scope for v0.12

- Error Atlas repair cards (Decision D)
- Hybrid / vector retrieval (Decision E)
- Full rule-family migration beyond rm + credential
