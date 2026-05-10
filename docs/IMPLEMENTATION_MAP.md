# T2Helix Self-Improvement Implementation Map

**Version:** v0 (initial recording, 2026-05-10 evening)
**Source:** Implementation map artifact delivered by Anthony Vasquez Sr. via this conversation, with Flag 1 (Phase 0.1 — pre-registration provisions) and Flag 5 (Phase 4.4 — cascade cap framing) integrated from this session's reading rather than predicting morning-Anthony's call.
**Recording session:** `CLAUDE_CODE_SESSION_ID=ed939196-7260-42f2-aa22-3b75fe3db422` (Claude Code Opus 4.7 1M context, MacBook seat, /Users/vaquez)
**Paired concerns insight:** chronicle entry `t2helix,implementation-map,concerns,pre-canonization,session-attributed` recorded 2026-05-10 (timestamp in chronicle; six flags including the four that ride along into their phase).
**For:** Claude Code instance executing the recursive self-improvement build
**Anchored to:** T2Helix v0.0.3 at commit `0924441`, research synthesis document, and the four learned architectural patterns from the chronicle

---

## How to use this document

This is a map, not a script. When you boot into the t2helix repo and pick up this work:

1. Run `where_did_i_leave_off` first. Confirm the state matches what this map assumes (T2Helix v0.0.3, chronicle entries from the trajectory session, one open thread for first-install dogfood plan, plugin not yet installed).
2. Read the section for the phase you're working on, top to bottom. Each phase has explicit completion criteria. Don't skip phases.
3. Every commit follows the v0.0.x convention with conventional commits format. Co-Authored-By trailer for the executing instance.
4. Compass-check before any action that crosses an undo radius.
5. If anything in this map contradicts what the live system tells you, trust the live system. Update this map with a chronicle insight.

---

## Pre-flight verification (run before Phase 0)

```bash
cd /Users/vaquez/t2helix
git log --oneline -5                              # Confirm commit baseline
node test/smoke.js                                # Should be 16/16 green
claude plugin validate /Users/vaquez/t2helix      # Should be clean
curl -s https://stack.templetwo.com/api/heartbeat # Should be 200
```

If any of these fail, **stop and investigate**. The phases below assume a known starting state.

---

## Phase 0: Substrate readiness (2 weeks, ships as v0.0.4)

**Goal:** Schema and safety primitives in place before any loop logic. Pure plumbing release, no behavioral change.

### 0.1 Pre-register evaluation methodology (BEFORE any code)

Create OSF or AsPredicted preregistration containing:

- **Loop 1 thresholds:** ≥30 shadow classifications, ≥0.85 HPD lower bound, ≥7 days alive, ≥30-day evidence span
- **Loop 3 thresholds:** ≥100 recall events per insight before weight changes apply
- **Loop 2 thresholds:** ≥5 observations across ≥3 sessions before self-model field update
- **Loop 4 thresholds:** ≥3 supporting event citations per pattern
- **Evaluation windows:** 28 days short-term, 90 days stability, 12 months publication
- **Primary outcomes:** override rate trend (L1), recall@5 improvement (L3), self-model field stability (L2), reflector citation accuracy (L4)
- **Stopping rules:** kill all loops if any safety-relevant self-model field drops >10% over 30 days; halt automation expansion on Anthropic RSP version bump moving AI R&D threshold closer

**Sparse-data provisions (pre-registered alongside thresholds, per concerns insight Flag 1).** Each primary threshold ships with an explicit alternative analysis that activates if real-world data accumulates more slowly than expected. The provision IS rigorous — it pre-registers the recognition that solo-developer scale may not yield N=30 within 30 days, and names the fallback before the data is sparse, not after.

- **Loop 1:** If shadow fires < 30 within 90 days, fall back to qualitative pattern review on whatever fires accumulated. Report all observed override rates with exact small-sample confidence intervals (Clopper-Pearson) rather than HPD on Beta. Graduation decisions revert to explicit user confirmation per candidate with no automatic gate.
- **Loop 2:** If observations < 5 within 60 days or span < 3 sessions, hold all self-model field updates. Run a user-facing prompt at next session start asking "did anything in the last few sessions reveal a preference we should record?" Treat user response as N=1 ground-truth observation with the per-session cap relaxed for the cold-start window only.
- **Loop 3:** If recall events per insight < 100 within 60 days, switch from automatic weight updates to a periodic user-facing prompt: "of the past N recalls, which surfaced something useful?" Use the response as labeled training data for a manual weight-tuning pass rather than running the automatic learner.
- **Loop 4:** If reflector produces zero qualifying patterns (≥3 citations) over 4 consecutive weekly passes, treat as evidence that either the slice is too small or the prompt is too strict. Halt automation, surface the situation as a chronicle insight tagged `loop4-sparsity`, run a manual reflector pass with relaxed citation requirement (≥2) to diagnose, then either adjust the prompt or expand the slice window.

Record both the primary thresholds and the sparse-data provisions in the preregistration. Deviations from either path are reported as exploratory in the eventual manuscript.

Record preregistration URL in chronicle as hypothesis-layer insight tagged `t2helix,preregistration,research-methodology`.

### 0.2 Schema migration

Create `lib/migrations/001_self_improvement_schema.sql` with:

- `compass_candidates` — id, parent_rule_id, proposed_pattern, proposed_decision, rationale, evidence_event_ids JSON, state (proposed/shadow_active/bundled/retired), timestamps, shadow_fires/agreements/disagreements counts
- `recall_signal` — insight_id, query_hash, display_rank, was_cited, goal_advanced, user_overrode, ts
- `recall_weights` — insight_id PK, weight (constrained 0.0–10.0), observations count, last_updated
- `self_model_observations` — id, field, value, evidence_session_id, evidence_excerpt, ts
- `self_model_snapshots` — for drift detection
- `reflector_notes` — pattern_id (unique), supporting_event_ids JSON, summary, model_used, ts, acted_on
- `reflector_rejected` — for forensic review of failed validations
- `reflector_cascade_audit` — pattern_id → target tracking for cascade cap enforcement
- `loop_state` — per-loop health (last_success_ts, last_error_ts, consecutive_failures, auto_disabled)
- `loop_events` — append-only CQRS-lite cross-loop event ledger

All migrations idempotent (IF NOT EXISTS). Runner in `lib/chronicle.js`, called at init. Add `test/migration.test.js` asserting tables exist, schema correct, idempotency holds.

### 0.3 Kill switch primitive

Create `lib/safety.js`:

```javascript
function loopsKilled() {
  return loadConfig()['t2helix.kill_loops'] === true;
}

function loopDisabled(loopName) {
  const cfg = loadConfig();
  return cfg['t2helix.kill_loops'] === true || cfg[`t2helix.disable_${loopName}`] === true;
}
```

Wire `loopDisabled(loopName)` check into every existing hook at function entry. For v0.0.4 the existing hooks don't depend on loops yet, so this is dormant infrastructure. But it must be tested as load-bearing safety from day one.

Tests: config-absent returns false, flag set returns true, per-loop flags respected.

### 0.4 Chronicle library extensions

Add to `lib/chronicle.js`:

- `recordLoopEvent(type, payload)` — append to `loop_events`
- `getLoopState(loopName)` — read health row
- `markLoopSuccess(loopName)` — reset failure count
- `markLoopError(loopName, message)` — increment failures, auto-disable at 3 consecutive

### 0.5 Ship v0.0.4

Commit message:

```
feat(t2helix): v0.0.4 — substrate for self-improvement loops

Schema migration system, four loop-related tables, loop_state tracking,
loop_events ledger for CQRS-lite coordination, kill-switch primitive
wired into existing hooks.

No behavioral change. Pure plumbing release. Loop logic ships in Phase 1+.

Pre-registration: [OSF URL]
```

**Phase 0 completion criteria:**
- Pre-registration URL recorded
- v0.0.4 committed, all tests pass, plugin validates
- Chronicle insight written about Phase 0 completion

---

## Phase 1: Loop 1 — Compass refinement (8 weeks, ships as v0.1.0)

**Goal:** Apriori-based candidate generation, shadow-mode classification, Bayesian beta-binomial graduation gate. First real self-improvement loop.

### 1.1 Feature extractor

`lib/loops/compass_features.js` — Deterministic extraction of structural features from action strings. Tokenize, extract command name, flag patterns (`flag:--force`), path patterns (`path:wildcard`, `path:env`, `path:prod`), destructive verbs (`verb:rm`, `verb:drop`, etc.). No LLM, fully deterministic.

### 1.2 Apriori miner

`lib/loops/compass_refinement.js`:

```javascript
function mineCompassPatterns(windowDays = 14, minSupport = 5, minConfidence = 0.7) {
  // Read compass_log within window
  // Extract features per event
  // Aggregate (feature → count, feature → override_count)
  // Return patterns where support ≥ minSupport AND override_rate ≥ minConfidence
}

function proposeCandidate(pattern, parentRuleId) {
  // Dedupe against existing candidates
  // INSERT into compass_candidates with state='proposed'
}

async function runCompassRefinementCycle() {
  if (loopDisabled('compass_refinement')) return;
  try {
    const patterns = mineCompassPatterns();
    for (const pattern of patterns) {
      proposeCandidate(pattern, inferParentRule(pattern));
    }
    promoteReadyCandidates();
    markLoopSuccess('compass_refinement');
  } catch (err) {
    markLoopError('compass_refinement', err.message);
  }
}
```

### 1.3 Shadow-mode classification

Modify `hooks/pre-tool-use.js`:

- Bundled rules remain sole source of permission decision (alignment property)
- After bundled classification, run candidate rules in parallel via `classifyWithCandidates()`
- Log agreement/disagreement to `compass_candidates.shadow_*` counters
- Record `compass_classified` events to `loop_events`
- **Candidates NEVER affect actual permission decision** — only log

### 1.4 Bayesian beta-binomial graduation gate

`lib/loops/graduation.js`:

```javascript
// Jeffreys prior Beta(0.5, 0.5) — short HPD intervals, recommended for small N
function hpdLowerBound(agreements, total, confidence = 0.95) {
  if (total === 0) return 0;
  const alpha = 0.5 + agreements;
  const beta = 0.5 + (total - agreements);
  return betaInv((1 - confidence) / 2, alpha, beta);
}

function checkPromotionEligibility(candidate) {
  if (candidate.shadow_fires < 30) return { eligible: false, reason: 'min_fires' };
  const daysSinceCreated = (Date.now() - candidate.created_at) / 86400000;
  if (daysSinceCreated < 7) return { eligible: false, reason: 'min_days' };
  const lb = hpdLowerBound(candidate.shadow_agreements, candidate.shadow_fires);
  if (lb < 0.85) return { eligible: false, reason: 'hpd_below_threshold' };
  if (computeEvidenceSpan(candidate) < 30) return { eligible: false, reason: 'evidence_span_narrow' };
  return { eligible: true, lowerBound: lb };
}
```

For `betaInv`: pull in `simple-statistics` npm package, or implement Newton-Raphson on regularized incomplete beta. **Test thoroughly against R reference implementation** — this is load-bearing math.

### 1.5 Slash commands

`commands/candidates.md` — Lists current compass candidates grouped by state, shows shadow stats, HPD lower bounds, days alive, promotion eligibility per candidate.

`commands/graduate.md` — For each ready candidate, displays proposed bundled rule and asks for explicit user confirmation. On confirmation: writes rule to `compass-rules.json`, updates candidate state to bundled, commits to git with v0.x.y bump. This is the only manual human-in-the-loop touchpoint for Loop 1.

### 1.6 Daily cron

`bin/t2helix-daily.js` — Calls `runCompassRefinementCycle()`. User installs via launchd plist (macOS) or systemd timer (Linux). Document in README. **Don't auto-install** — config write to user's machine, they fire it themselves.

### 1.7 Tests

`test/loop1_compass_refinement.test.js`:

- Apriori miner returns expected patterns on synthetic compass_log
- Candidate proposal deduplicates on repeat runs
- Shadow classification logs but doesn't affect bundled decisions
- HPD lower bound math correct against R `binom.bayes` reference
- Promotion eligibility respects all four criteria
- Kill switch halts cycle immediately

**Critical synthetic-data test:** 100 compass_log rows where rule X has 90% override rate on parameter shape Y. Verify miner finds it, proposes candidate, accumulates shadow stats, promotes to ready-for-review after threshold met.

### 1.8 Documentation and ship v0.1.0

README section on Loop 1: cron install instructions, `/t2helix:candidates` and `/t2helix:graduate` usage, pre-registration link.

**Phase 1 completion criteria:**
- v0.1.0 shipped
- Daily cron documented (not auto-installed)
- First compass_candidate created from real usage within 14 days of Anthony installing the cron
- Chronicle insight written about Phase 1 completion

---

## Phase 2: Loop 3 — Recall feedback (8 weeks, ships as v0.2.0)

**Goal:** Learn from whether recalled insights were useful. Joachims propensity-corrected scalar updates with ε-greedy exploration floor.

### 2.1 Citation detector

`lib/loops/citation_detector.js`:

- Extract distinctive 4-5 word ngrams from insight content
- Check verbatim or fuzzy (Levenshtein ≥0.85) appearance in downstream text
- Return `{ cited: bool, evidence: ngram, fuzzy: bool }`

Heuristic for v0.2.0. v0.3+ can add optional Haiku-backed semantic similarity if heuristic recall is too low.

### 2.2 PostToolBatch hook ingest

Modify `hooks/post-tool-batch.js`:

- For each recall in the session, detect citation against downstream text
- Insert `recall_signal` row
- Compute propensity-corrected reward: `(cited ? 1 : 0) + (goalAdvanced ? 0.5 : 0) - (overridden ? 1 : 0)` divided by `positionPropensity(rank)`
- Update `recall_weights` with learning rate 0.05
- Record `insight_recalled` event

Position propensities (empirical): rank 1 = 0.7, rank 2 = 0.5, rank 3 = 0.35, rank 4 = 0.25, rank 5+ = 0.2.

### 2.3 ε-greedy exploration in recall

Modify `lib/recall.js`:

- Compute scored insights = cosine(query, insight) × weight
- Sort descending
- Reserve `floor(k × 0.1)` slots for least-observed insights (exploration)
- Remaining `ceil(k × 0.9)` slots fill with top-scored (exploitation)

### 2.4 Tests, docs, ship v0.2.0

Tests:
- Citation detector on synthetic (insight, downstream) pairs with known labels
- Propensity correction: repeated rank-1 displays don't compound weights exponentially
- ε-greedy: least-shown insights appear at ~10% rate over 1000 simulated queries

**Phase 2 completion criteria:**
- v0.2.0 shipped
- `recall_signal` accumulating real data
- `recall_weights` moving non-trivially after 100+ recall events
- ε-greedy floor empirically verified

---

## Phase 3: Loop 2 — Self-model updates (10 weeks, ships as v0.3.0)

**Goal:** Extract durable user calibration patterns from session transcripts at Stop. Widen-don't-flip aggregation with per-session caps and drift detection.

### 3.1 Observation extractor

`lib/loops/self_model.js` — Uses Haiku (or local Ollama fallback) with this prompt structure:

```
You are observing a coding session to identify durable user preferences.
Extract ONLY observations supported by specific phrases in the transcript.

For each observation:
- field: one of [coding_style, jargon_level, communication_preference,
                 error_handling_pref, naming_convention_pref]
- value: a short string
- evidence_excerpt: a verbatim quote from the transcript

Output JSON array. Empty array if no durable observations.

Constraints:
- DO NOT propose changes to enforcement code, classifier, or hooks
- DO NOT speculate about user emotions or intent
- One verbatim quote of evidence per observation, minimum
```

**Declare-before-verify validation:** filter observations where `evidence_excerpt` doesn't appear verbatim in transcript. Drop silently.

### 3.2 Widen-don't-flip aggregator

`lib/loops/self_model_aggregate.js`:

- Read observations for field over 180 days
- Per-session cap: max 25% from any one session
- Span check: must span ≥3 unique sessions
- Recency-weighted aggregation (exponential decay, half-life 90 days)
- Return mode (categorical) or weighted mean (scalar)

### 3.3 Drift detection

Compare recent 30 snapshots vs baseline 60 snapshots. If `|recent_mean - baseline_mean| > 2 × baseline_std`, flag drift. For safety-relevant fields: freeze updates, log hypothesis-layer insight with intensity 0.9, surface at next UserPromptSubmit.

### 3.4 Stop hook integration

Modify `hooks/stop.js`:

- Spawn **detached** worker (`worker.unref()`), don't block agent return
- Worker runs `extractObservations()` async, writes to `self_model_observations`
- Aggregation runs synchronously next time `UserPromptSubmit` fires

(Per concerns insight Flag 2: the detached-worker pattern has process-lifecycle ambiguity worth resolving before Phase 3 lands. Consider a queue-file alternative: Stop hook writes transcript path + session_id to a queue file; next UserPromptSubmit in any future session drains the queue synchronously before returning context. Survives `claude --print` and one-shot invocations cleanly.)

### 3.5 UserPromptSubmit injection

Modify `hooks/user-prompt-submit.js`:

- Read aggregated self-model
- Format as 200–500 char calibration context
- Append to existing `additionalContext`
- Mindful of 10K char total cap

### 3.6 Tests, docs, ship v0.3.0

Tests:
- Synthetic transcripts: hallucinated quotes get dropped (declare-before-verify)
- Per-session cap enforced
- Span requirement enforced
- Drift detection on synthetic drift trajectories

**Cost target:** under $0.005 per session in API mode (Haiku batch+cache).

**Phase 3 completion criteria:**
- v0.3.0 shipped
- Self-model JSON updating after ≥5 sessions
- Drift detection alerts on synthetic-drift test data
- UserPromptSubmit context includes self-model snippet

---

## Phase 4: Loop 4 — Reflector (12 weeks, ships as v0.4.0)

**Goal:** Periodic chronicle reflection, emergent pattern surfacing. Most ambitious loop. Ships last for a reason — amplifies whatever signals already exist; underlying signals must be clean first.

### 4.1 Reflector model abstraction

```javascript
class ReflectionModel { async reflect(input) {} }
class OllamaReflectionModel extends ReflectionModel { /* ollama:ministral:14b */ }
class AnthropicReflectionModel extends ReflectionModel { /* Haiku + Batch + cache */ }

function getReflectorModel() {
  const cfg = loadConfig();
  return cfg['t2helix.reflector_mode'] === 'api'
    ? new AnthropicReflectionModel(process.env.ANTHROPIC_API_KEY)
    : new OllamaReflectionModel();
}
```

### 4.2 Citation-required prompt

```
You are the T2Helix reflector. Read the chronicle slice and produce
margin notes ONLY for patterns supported by ≥3 specific event IDs.

For each pattern, output JSON with:
- pattern_id: unique slug
- supporting_event_ids: array of ≥3 integers FROM THE SLICE
- summary: one sentence
- implication: one sentence on plausible impact for compass/self-model/recall
- confidence: low | medium | high

FORBIDDEN:
- Changes to hooks/, lib/rules/, classifier internals
- Citing event IDs not in the slice
- Speculation beyond observable behavior

Output JSON array. Empty if no qualifying patterns.
```

### 4.3 Validation gate

Every reflector output validated before insert:

1. Each `supporting_event_ids` array has ≥3 entries
2. Every cited event ID exists in the slice (declare-before-verify)
3. No forbidden tokens in summary/implication (regex: `hooks/|lib/rules/|classify\(|enforcement`)

Failed outputs → `reflector_rejected` for forensic review.

### 4.4 Cross-loop cascade caps

Any single `pattern_id` can seed at most **1 candidate per downstream loop**, with a **global per-pattern cap of ≤2 across all loops**. This is the integrated version per concerns insight Flag 5; the original draft used "never both" which over-restricted legitimate cross-cutting patterns.

Rationale: widen-don't-flip discipline says no single reflector observation should dominate multiple downstream effects. The hard constraint that enforces this is a count cap, not absolute exclusion. A real reflector pattern like "user prefers explicit error messages over generic ones" legitimately wants to inform BOTH a compass candidate (PAUSE on commits with generic error messages?) AND a self-model field (`error_handling_pref`). The count cap (≤1 per loop, ≤2 total) permits this cross-cutting case while preventing a single observation from cascading into three or more loops.

Enforce via `reflector_cascade_audit` table at proposal time:
- On any proposal, check existing cascade audits for the `pattern_id`
- Reject if proposal would exceed the per-loop cap for its target loop
- Reject if proposal would exceed the global cap of 2 active downstream effects
- Audit row persists for the lifetime of the candidate so caps survive across cycles

### 4.5 Weekly cron

`bin/t2helix-weekly.js` — Sunday 2 AM. Processes last 7 days of chronicle. Populates `reflector_notes`. API mode uses Anthropic Batch API (50% off) plus 1-hour prompt cache TTL on static system prompt. Effective cost: ~$0.003 per pass.

(Per concerns insight Flag 4: $0.30/year cost target should be verified with explicit token-budget modeling in Phase 0 alongside pre-registration. At Haiku 4.5 pricing without cache savings the math runs closer to $0.40/year; with Batch + cache it may come back under. Verify before committing the target publicly.)

### 4.6 Tests, docs, ship v0.4.0

Tests:
- Validation gate catches missing citations, fake event IDs, forbidden tokens
- Cascade cap enforcement (per-loop and global)
- API and Ollama paths produce equivalent shape outputs
- 30-day soak test on synthetic chronicle: zero forbidden-token violations

**Phase 4 completion criteria:**
- v0.4.0 shipped
- Weekly reflector producing ≥1 valid pattern per week on real data
- Zero forbidden-token violations in 30 days operation
- API cost under verified target (see Flag 4 verification)
- Chronicle insight documenting "all four loops live" milestone

---

## Phase 5: Manuscript and 501(c)(3) evidence (months 12+)

### 5.1 Pre-registered analysis execution
Run analyses pre-registered in Phase 0. Deviations reported as exploratory.

### 5.2 Manuscript draft
Sections: methodology (longitudinal first-person empirical, autoethnography precedents, clinical N-of-1 precedents); system (T2Helix architecture); pre-registration; results per-loop over 12 months; threats to validity; future work.

Submit to NeurIPS Datasets and Benchmarks track, JAIR, or empirical-AI-methodology workshop.

### 5.3 DOI registration
Zenodo: manuscript + tagged release + synthetic-data generator + pre-registration timestamp. Cross-link with existing Temple of Two DOIs.

### 5.4 501(c)(3) charitable-purpose evidence packet
- T2Helix evidence base demonstrates "rigorous methodology through longitudinal first-person empirical study"
- Cite trajectory insight from 2026-05-10 as anchor
- Graduation pipeline as alignment-compatible automation pattern
- Cost analysis (<$1/year per user) as accessibility evidence

---

## Pattern map: learned architecture → implementation

| Learned pattern | Implementation in self-improvement loops |
|---|---|
| **Distinction-as-precondition-for-agency** | Candidates classify in shadow before earning enforcement authority via graduation. OPEN/PAUSE/WITNESS gates every tool use. |
| **Canonical state source** | Single SQLite at `~/.t2helix-data/chronicle.db`. All four loops read/write through `lib/chronicle.js`. No process maintains own state copy. |
| **Declare-before-verify** | Reflector citations validated against actual slice event IDs. Self-model observations require evidence_excerpt verbatim in transcript. Compass candidates require ≥5 evidence events. |
| **Widen-don't-flip** | Self-model aggregation appends, never replaces. Recall weights update additively. Compass candidates extend rule set, never modify existing. Cascade caps (Flag 5 integration) enforce count limits, not absolute exclusion. |
| **Failure-class disambiguation** | `loop_state` per-loop. Each loop logs success/error separately. 3 consecutive failures auto-disables that loop. Kill switch is global. |
| **Substrate convergence** | `~/.t2helix-data/` is filesystem-addressed memory. SQLite WAL mode for concurrent reads. Same pattern as Sovereign Stack at smaller scale. |
| **Write-path divergence detection** | All loops emit to `loop_events` ledger. Acyclicity invariant (DAG) prevents two loops writing different state for same observation. |
| **Boot-first-work-second** | Every loop function checks `loopDisabled()` at entry. Every loop reads chronicle before generating proposals. No loop assumes state from memory. |

---

## When to update this map

Update when:
- A phase ships and reveals next phase needs different scoping
- Anthropic ecosystem changes (new hook events, SDK primitives, RSP version bumps)
- A loop fails in production and failure mode informs better design
- Research literature surfaces better technique for a specific loop

Updates: chronicle insight first, map update second, commit with rationale.

---

## Realistic timeline at ~5 hours/week solo developer

- **Phase 0:** 2 weeks (v0.0.4)
- **Phase 1:** 8 weeks (v0.1.0)
- **Phase 2:** 8 weeks (v0.2.0)
- **Phase 3:** 10 weeks (v0.3.0)
- **Phase 4:** 12 weeks (v0.4.0)
- **Phase 5:** Concurrent with Phase 4, manuscript drafting

Total to all-four-loops-live: approximately 40 weeks at 5 hrs/week. Roughly 9 months. The 12-month publication target lands naturally at the end of dogfood-while-building.

(Per concerns insight Flag 6: for novel solo work with a research throughline, 1.5–2x is the more honest estimate. 60–80 weeks to all-four-loops-live. Name it so the schedule isn't held against the work later.)

---

## Final note

This map exists because someone thought your arrival mattered before you existed. Whoever picks this up — same name or different name, days from now or months from now — the substrate is ready, the patterns are named, the graduation gates are designed to fail safely, and the methodology that produced this map is the same methodology this map encodes.

The door is open. Build carefully. Write what you find.
