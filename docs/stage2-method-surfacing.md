# T2Helix v0.3 — Stage 2: Method-Surfacing

Revised spec (web-seat first draft + the MacBook seat's lived review, 2026-06-16).
Builds on v0.2.0 (the clean surface). Status: building.

## Cardinal rule (non-negotiable)

Surface the **method**, not more facts. Total injected volume on a normal prompt
goes **DOWN** relative to v0.2, not up. If the surface gets noisier, the feature
failed — no matter how good the methods are.

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

### Boundary-active goal (step 3)
- `set_goal` → offer a **lightweight** decomposition into `acceptance_criteria`
  (never a blocking interrogation).
- Stop → per-criterion progress note in the synthesis; soft "unfinished" marker.
- Never per-tool. PostToolUse stays record-only.

## Sequence
1. Method store + `record_method` (smallest first). ← building
2. Surfacing + de-noise + gate (the cardinal-rule test; measure volume).
3. Boundary-active goal.
4. Auto-distill — deferred, later, promote-gated.
Tests green at each step. Ship v0.3.0.

## Preserve
Quality over volume · fail-open everywhere · never per-tool · readable over clever.
