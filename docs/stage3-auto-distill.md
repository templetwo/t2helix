# Stage 3 — Auto-Distill (v0.4)

## The gap Stage 3 closes

Stage 2 gave t2helix a method store and targeted surfacing, but methods only got
there one way: a human (or model) calling `record_method` deliberately. The
session that *did* the work rarely stops to write the playbook. Stage 3 distills
that playbook automatically, at the moment the session closes.

## The trap it must not fall into

The Stop hook fires every session — it is a **high-frequency writer**. The
chronicle already lived through what happens when a high-frequency writer feeds the
recall surface: in v0.1 the compass-fire writer (one entry per PAUSE) polluted
recall and even leaked credentials (`#2381`), and the v0.2 lived read named the
exact risk for this feature (`#2382`):

> "amplify successes the way the compass flags failures" risks doubling down on the
> injection-pollution problem. The win is fewer, better-targeted, procedure-bearing
> injections — not a second firehose. Quality over volume.

So the design constraint is non-negotiable: **a distilled method must surface
nothing until a human reviews it.** Lower confidence is not enough — an
`auto-distill` method written straight to the `domain:'method'` store would still be
reachable by the targeted lookup (just lower-ranked), which still lets the
high-frequency writer feed the surface. The gate has to be *invisibility until
promotion*, not *lower rank*.

## The shape: quarantine → explicit promote

```
  session closes
       │
       ▼
  Stop hook ──► distillCandidate()  ── conservative, returns null for most sessions
       │              │
       │              ▼ (a clean, goal-bounded success)
       │        recordMethodCandidate()  ──►  method_candidates table  (QUARANTINE)
       │                                          • not an insight
       │                                          • never in recall / FTS / surface
       │                                          • status: pending
       ▼
   (nothing surfaces)

  ── later, a human reviews ──
  list_method_candidates   →  review the pending queue
  promote_method <id>      →  writes a fresh ground_truth domain:'method' insight
                              (source:promoted) — NOW surfaceable. candidate→promoted.
  dismiss_method_candidate <id>  →  candidate→dismissed, never becomes a method.
```

### Why a separate table, not a `domain:'method-candidate'` insight

A candidate lives in its **own** `method_candidates` table, not in `insights`. That
makes the cardinal-rule guarantee *structural* rather than *configural*: a candidate
is not an insight at all, so there is no recall path, FTS row, or `include_meta`
flag that could ever surface it. It also keeps the `insights` table append-only-pure
(no deletes, no in-place trust flips), and it mirrors the proven, already-in-tree
`pending_confirmations` machinery (a `status` lifecycle with CAS claims). The one
cost — candidate fields bypass `record()`'s scrub — is paid explicitly:
`recordMethodCandidate` is the **fourth scrub chokepoint**, scrubbing every
free-text field with the same redact-or-drop fail-safe.

## The distiller (`lib/distill.js`, pure)

`distillCandidate({ goal, assessment, actions })` returns a candidate or `null`. It
is conservative by design — most sessions distill nothing:

- a **goal with `acceptance_criteria`** must exist (need a bounded goal to distill against);
- the session must show **real success** (`≥1 outcome:success`) and **zero
  `outcome:failure`** among its `session-action` rows — a session that hit a failure
  is not a clean "this worked" to amplify;
- a **majority of criteria** must be addressed (reuses the Stop `assessCriteria`
  soft signal — same humility: "related", never "done").

The candidate it builds is a **rough skeleton**: a `<verb>-<object>` shape slug from
the goal, a chronological/​deduped/​capped (`≤8`) list of steps from the session's
`session-action` summaries, the joined criteria as the acceptance signal, and the
distinct tool classes. It is explicitly a *draft* — refinement happens on promote.

## Promotion is append-only

`promoteMethodCandidate` never mutates an insight row. It **claims** the candidate
with a compare-and-swap (`pending → promoting`, so two racing promotes can't both
write), then writes a fresh trusted `domain:'method'` insight via
`recordMethod({ source: 'promoted' })` (re-scrubbed through `record()`), and finally
links the new insight id on the candidate (`promoted`). This is supersession, the
same pattern `setGoal` uses to archive a prior goal — consistent with the chronicle's
append-only ethos.

## Measurement before automation

Because candidates are quarantined, **injected volume cannot rise** from
auto-distill until a human promotes. That makes the candidates-generated vs
candidates-promoted ratio a clean signal:noise measurement. Ship explicit-only,
watch that ratio, and only then decide whether a future stage should auto-promote
high-confidence shapes. Auto-promotion is deliberately **out of scope** for v0.4.

## What did not change

- `record_method` still writes trusted, hand-authored methods (`source:explicit`).
- `lib/surface.js` is untouched: methods (explicit or promoted) surface through the
  same single targeted lookup and the same char budget. The cardinal-rule char
  assertion stays green.
- The fail-open contract holds: the distill block is its own `try/catch`; a distill
  failure never costs the synthesis write or blocks session close.
