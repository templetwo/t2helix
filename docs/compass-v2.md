# Compass V2 (v0.12)

Action-aware Guard layer for T2Helix. Implements the frozen v0.12 slice of the
*T2Helix V2 Master Architecture and Implementation Blueprint*.

## Flow

```
tool input → adapter → Action IR → semantic predicates → decision + evidence
                ↘ legacy string rules (still authoritative in shadow mode)
```

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

## Enabling enforce

```bash
export T2HELIX_COMPASS_V2=enforce
```

Prefer a clean shadow observation window and `npm run replay-compass` before
making enforce the default for a seat.

## Safe-repeat leases

After a human confirms a PAUSE action, arm a lease with `arm_safe_repeat`
binding `normalized_action_hash` + `parser_version` + `cwd`. Never covers
WITNESS. Revoke with `revoke_safe_repeat`.

## Out of scope for v0.12

- Error Atlas repair cards (Decision D)
- Hybrid / vector retrieval (Decision E)
- Full rule-family migration beyond rm + credential
