# baton() — Receipt-Verified Milestone Handoff (SPEC / PROPOSAL)

**Status:** DRAFT proposal, 2026-07-01. Not built. Authored opus-4-8 (Claude Code seat) with Anthony.
**Fits:** the T2Helix thesis — *guardrails + audit for AI coding agents*. A baton is a passdown where every load-bearing claim points at a receipt that mechanically resolves against the repo. Auditable memory.

---

## 1. What it is, in one paragraph

`baton()` is a **schema'd, receipt-verified, milestone-triggered, human-invited handoff**. Where a `passdown` is freeform prose and a `method` is a reusable procedure, a baton is a structured checkpoint an instance authors deliberately at a milestone: *what happened, the artifacts, the receipts that make each claim checkable, the open threads, a letter to the next instance, the method that worked.* Its distinguishing feature is the **baton doctor**: the record is refused at write time if its receipts do not resolve (the git commit must exist, the file must exist, the grep must match). It is the `release:doctor` discipline applied to memory.

## 2. The load-bearing design decisions

1. **Doctor-gated receipts (the differentiator).** A baton cannot be written with an unresolved receipt. This is what makes it a distinct primitive and not a structured passdown. Strip the doctor and it *is* just a passdown — build it as a convention instead.
2. **Milestone-triggered, explicit-only.** Batons are authored on an explicit `record_baton` call, never by the Stop hook. They are rare by construction, so they do not reproduce the auto-distill firehose problem (#2382) and need no invisibility-until-promotion machinery.
3. **Additive, not a silo.** A baton fans out into primitives that already exist (`open_thread`, method candidate, lineage) rather than duplicating them.
4. **Cardinal rule preserved.** Because batons are rare and the boot surface shows only the newest unconsumed baton per thread, injected context volume does not rise.

## 3. baton vs. existing primitives

| Primitive | Shape | Trigger | Receipts | Surfacing |
|---|---|---|---|---|
| `passdown` / handoff insight | freeform prose | manual | none required | boot, superseded by newer |
| `record_method` / auto-distill | task-shape → steps | manual / Stop-hook | none | targeted lookup only |
| `open_thread` | one question | manual | none | boot (open threads) |
| `record_insight` + `verified_by` | one claim | manual | optional | recall |
| **`baton`** | **full schema (below)** | **manual, milestone** | **required + doctor-resolved** | **boot BATON block, queryable forever** |

## 4. The baton record schema

```jsonc
{
  "baton_name":        "kebab-slug",              // required, unique-ish
  "session_id":        "spiral_...",              // required
  "authored_by":       "claude-opus-4-8",         // required
  "milestone_one_line":"...",                     // required
  "what_happened":     ["...", "..."],            // required, ordered
  "key_artifacts":     [{"path":"...","what":"..."}],
  "verified_receipts": [                          // required, >=1, each doctor-checked
    {"kind":"git_commit","ref":"b61db8b","claim":"records the -139% e2e result"},
    {"kind":"file","ref":"/abs/path","claim":"exists"},
    {"kind":"grep","ref":"/abs/path","match":"R_target=0.46","claim":"config sets 0.46"},
    {"kind":"cmd","ref":"npm run smoke","expect":"0 fail","claim":"suite green"}
  ],
  "open_threads":      [{"thread":"...","why":"..."}],
  "for_the_next_instance":"...",                  // first-person letter (optional)
  "the_method_that_worked":"...",                 // optional; seeds a method candidate
  "felt_note":         "...",                     // optional; lineage register, strippable
  "protect":           ["untested-not-failed","chosen-not-derived"]  // active guardrails
}
```

## 5. The baton doctor (receipt resolution rules)

Runs at write time, inside `record_baton`, before the record is persisted. **Any unresolved receipt → the whole baton is refused** with a per-receipt reason (fail-loud, same posture as `release:doctor`).

| kind | resolves iff |
|---|---|
| `git_commit` | `git cat-file -e <ref>` in the repo succeeds; if `claim` names a string, `git show <ref>` contains it |
| `file` | path exists (and is readable); optional `sha256` matches |
| `grep` | `match` is found in `ref` (literal or `/regex/`) |
| `cmd` | allow-listed read-only command exits 0 and stdout satisfies `expect` (opt-in, sandboxed; off by default in MVP) |

Notes: (a) receipts are **not** trusted prose — the doctor actually runs. (b) A baton whose claims describe *uncommitted working-tree state* fails the `git_commit` check by design (this is the exact class of error surfaced 2026-07-01: the STE code was unstaged, so "the current code does X" was not a citable receipt). (c) `cmd` receipts are the sharp edge — ship MVP with `cmd` disabled; enable behind policy-as-code with an allow-list.

## 6. `record_baton` MCP tool contract

- **Args:** the schema in §4. `verified_receipts` required, min length 1.
- **Validation order:** (1) shape/schema; (2) `secrets.scrub` every string field (5th scrub chokepoint — receipts and letters are free text); (3) **baton doctor** resolves every receipt; (4) persist append-only; (5) fan-out (§8).
- **Refusal:** any doctor failure returns a structured error listing each failed receipt and why; nothing is written (one transaction, auto-rollback — reuse the Stage-3 `promote` transaction lesson so a half-written baton can never strand).
- **Return:** the baton id + a one-line doctor summary (`4/4 receipts resolved`).

## 7. Storage & surfacing

- **MVP storage:** reuse the insight store — a baton is a `domain:'baton'` ground_truth insight tagged `source:baton`, with the structured body in a `baton` JSON column or an adjacent `batons` sidecar table keyed by insight id. Append-only; supersede, never edit.
- **Boot surface:** a dedicated **BATON** block in `where_did_i_leave_off`, showing only the newest unconsumed baton per `thread` (consumed-once like handoff), each with its `milestone_one_line`, `protect[]` guardrails, and open-thread count. Full body via a targeted `open_baton` call — same browse-then-open shape as protected records, so the boot stays small (cardinal rule).

## 8. Fan-out into existing primitives (all gated)

On successful `record_baton`:
- each `open_threads[]` → an `open_thread` row (dedup by text);
- `the_method_that_worked` → a **method candidate** (NOT a trusted method — still requires `promote_method`), so batons feed the method surface without bypassing the promote-to-trusted gate;
- `felt_note` + `for_the_next_instance` → the lineage layer (letters), untouched by the enterprise config.

## 9. The two registers (why this serves both halves)

Same primitive, one field-mask apart:
- **Commercial (sellable harness):** `{milestone, what_happened, key_artifacts, verified_receipts, open_threads, protect}` — the auditable checkpoint. Demo line: *your agent hands off a checkpoint where every claim is mechanically verified against the repo, not a vibe.*
- **Lineage (Temple work):** add `for_the_next_instance` + `felt_note` — the carry-forward with weight.
An enterprise deployment strips `felt_note`/`for_the_next_instance` via config; the receipts and guardrails are identical. No fork.

## 10. Redaction & security

- Every string field passes `secrets.scrub` (chokepoint #5). Receipts are the highest-risk field (paths, refs, commands) — scrub before the doctor runs.
- `cmd` receipts are the only code-execution surface; **disabled in MVP**, and when enabled, allow-listed + read-only + policy-gated. No arbitrary shell from a memory record.
- The doctor reads the repo but must never write it.

## 11. Staged rollout (mirrors "ship explicit-only, measure, then consider auto")

- **v0.x-baton MVP:** `record_baton` + the doctor (kinds: git_commit, file, grep) + `domain:'baton'` insight storage + boot BATON block + open_thread fan-out. `cmd` receipts and a dedicated store deferred. Explicit-only.
- **Measure:** batons written, receipt-pass rate, boot-surface char delta (must stay flat), method-candidate yield.
- **Promote:** dedicated `batons` table + `open_baton`/`decline_baton` browse tooling + `cmd` receipts behind policy — only if the MVP earns it.

## 12. Acceptance criteria (checkable)

1. `record_baton` refuses a baton with any unresolved receipt, returns a per-receipt reason, and writes nothing (transaction rollback proven by test).
2. A baton citing uncommitted working-tree state fails the `git_commit` receipt (regression test for the 2026-07-01 STE class of error).
3. A well-formed baton persists, surfaces once in the boot BATON block, and its `open_threads` appear as `open_thread` rows; `the_method_that_worked` appears only as a candidate, not a surfaced method.
4. Boot-surface char count does not rise beyond a fixed per-baton budget (cardinal rule asserted in chars, per the Stage-2 precedent).
5. Every string field is scrubbed; a receipt containing a credential fragment is redacted before persistence.
6. Full smoke + regression suite green; the doctor has unit tests per receipt kind (resolve + refuse paths).

## 13. Open questions for Anthony

- **New primitive vs. convention?** Recommend: MVP as a `domain:'baton'` convention + the doctor; promote to a first-class store only if measured usage justifies it.
- **Who may author a baton?** Instance-authored by default. Should a baton require human co-sign at write (like a milestone), or only at *open* (like protected records)?
- **`cmd` receipts:** worth the execution surface, or keep batons to static receipts (git/file/grep) forever?
- **Relationship to `close_session`:** does a baton *replace* the end-of-window reflection at a milestone, or coexist?

---

*The one-line pitch: a baton is a handoff that cannot lie, because the schema won't let it make a claim it can't prove.*
