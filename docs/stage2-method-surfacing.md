# T2Helix v0.3 — Stage 2: Method-Surfacing

Revised spec (web-seat first draft + the MacBook seat's lived review, 2026-06-16).
Builds on v0.2.0 (the clean surface). Status: feature-complete (steps 1-3); adversarial review next, then ship.

## Cardinal rule (non-negotiable)

Surface the **method**, not more facts. Total injected volume on a normal prompt
goes **DOWN** relative to v0.2, not up. If the surface gets noisier, the feature
failed — no matter how good the methods are.

**Metric (made explicit after review):** "volume" is rendered **characters/tokens**,
not raw line count. A matched method is intentional, high-signal content that
*replaces* generic hits (worst case: goal + 1 method + 3 hits, vs v0.2's goal + 5
hits); a multi-line method is denser per line but smaller overall. The claim is
checkable, not asserted: a smoke test (`surface volume (cardinal rule)`) renders
the worst-case v0.3 block and asserts it does not exceed the v0.2 5-hit firehose in
characters. Item-count caps (≤1 method, ≤3 hits) are a coarse proxy; the char test
is the real guard.

## The gap

The instance has action-shape (compass, per-call) and content recall (FTS, facts).
Missing: *"for this shape of task, here is the procedure that worked last time."*

## Resolved design decisions (from the lived review)

- **Q1 — gate on task-shaped content, not length.** Suppress generic recall when a
  prompt is conversational / acknowledgment / pure-meta with no domain noun
  (lived examples that drew only noise this session: "try hq again", "nice", "what
  models", "is the repo synced"). Keep recall when the prompt names an
  artifact/concept/verb-on-artifact. **When a goal is active, trim generic recall
  harder regardless** — the goal anchors context better than FTS-on-prompt.
- **Q2 — shape key = intent slug × tool-class overlap.** Goal-text alone misfires
  ("fix the auth bug" vs "fix the parser bug" are textually close, want different
  methods). Combine a `<verb>-<object>` slug from the goal/intent with the
  successful run's dominant tool classes. Retrieve only above a relevance bar:
  **a weak/wrong method is worse than none** — fail to "no method" gracefully.
- **Q3 — ship explicit-only; defer auto-distill.** Auto-distill is a new
  high-frequency writer — the v0.1 compass-fire pollution was its preview. Ship
  v0.3.0 with `record_method` only, measure injected volume, and only later add
  auto-distill behind an explicit promote-to-trusted gate. The cardinal rule
  outranks the convenience.

## Design

### Method store (no new table)
Methods are insights with `domain: 'method'`, reusing FTS, `recall()`, the Stage-1
redaction chokepoint, and retention. Content: `[method] <shape>` + numbered steps +
`Acceptance:`. Tags: `method`, `shape:<slug>`, `source:explicit|auto-distill`,
`tool:<class>...`. `method` is added to `META_DOMAINS` so methods never appear in the
generic firehose — they surface ONLY via the targeted lookup (step 2).

### Capture
- **`record_method` MCP tool** (primary, explicit, high quality): `{ shape, steps,
  acceptance, tool_classes }` → a `domain:'method'`, `source:explicit` insight.
- Auto-distill at Stop: **deferred (Q3).**

### Surfacing + de-noise (the core change, step 2)
In `hooks/user-prompt-submit.js`:
- Targeted method lookup: query methods (`include_meta:true`, tag `method`) by
  similarity to `goal.goal || prompt`, `topK:1` (2 max), above a relevance bar.
  Surface as a leading `**Method for this kind of task:**` section, or nothing.
- Shrink generic recall `topK 5 → 3`, raise the relevance bar.
- Gate: conversational/trivial prompts skip generic recall entirely (goal + a
  strong method may still show).
- Cap total: 1 method + ≤3 insights, deduped, smaller than v0.2. Measure before/after.

### Boundary-active goal (step 3) — built
- `set_goal` → when the goal has no `acceptance_criteria`, the return carries a
  **lightweight, non-blocking** `decomposition_hint` (the model may act on it or
  ignore it; the goal is already committed). With criteria, it returns
  `acceptance_criteria_count` and no hint. The model is the decomposer — the data
  layer only makes the boundary visible. Surfaced through the `set_goal` MCP result.
- **Boundary lifecycle:** the criteria belong to *this* goal. Explicit criteria
  win; an idempotent re-set (same goal text, no criteria) preserves them; a
  genuinely new goal starts unbounded so stale criteria don't bleed across and the
  offer can fire. The prior goal + its criteria are archived first, so nothing is
  lost. (This corrected the pre-0.3 `COALESCE` that let old criteria stick to a new
  goal — discovered via a shared-session regression.)
- Stop → soft per-criterion progress note in the synthesis (`lib/goal-progress.js`,
  pure): token overlap against THIS session's own non-meta insights, explicitly
  labelled, never a verdict. Each criterion gets `[x] … (evidence #id)` or
  `[ ] … (unfinished, no recorded evidence)`, plus a soft tally of open criteria.
- **Per-prompt injection is unchanged** — criteria surface only at the two
  boundaries (goal-set, session-end), never added to the recall block, so the
  cardinal rule (volume down) holds.
- Never per-tool. PostToolUse stays record-only.

## Sequence
1. Method store + `record_method` (smallest first). ✓ done
2. Surfacing + de-noise + gate (the cardinal-rule test; measure volume). ✓ done
3. Boundary-active goal. ✓ done
4. Auto-distill — deferred, later, promote-gated.
Tests green at each step (179: 117 smoke + 48 regression + 14 integration).
Next: adversarial review, then ship v0.3.0 behind a review-before-merge PR.

## Known limitations (accepted, soft by design)
Surfaced by the adversarial review; kept as heuristics rather than over-engineered:
- **Relevance is literal token overlap.** Synonyms miss (`cycle the API key` won't
  find `shape:rotate-credential`); a shared common noun can over-fire (`review-parser`
  for a "rewrite the parser" goal). Errs toward *less* surfacing, never a cardinal-rule
  violation. Semantic similarity is a future option, not a v0.3 need.
- **Trivial gate** catches acks, verb-led acks, and short identifier-less prompts.
  Conversational chatter >4 words (`thanks, that makes sense`) still passes the gate
  and is caught downstream by the relevance filter, not the gate itself.
- **Per-criterion progress is "mentioned", not "done"** — token overlap can't read
  negation or completion, and assesses only the newest ~100 non-meta session insights.
  Rendered as `[~] (related: #id)` so it never reads as a verdict; over-reports
  "unfinished" (the safe direction) past the cap.
- **`goals` table is unscrubbed** (`goal`/`why`/`acceptance_criteria` persisted raw,
  read back into context). Pre-existing, not a Stage-2 regression — flagged for a
  follow-up that routes the three fields through `secrets.scrub`.

## Preserve
Quality over volume · fail-open everywhere · never per-tool · readable over clever.
