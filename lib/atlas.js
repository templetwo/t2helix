'use strict';

// lib/atlas.js — load a curated error-resolution atlas (JSONL of
// {pattern, resolution}) into the chronicle as domain:'error-fix' ground_truth
// insights. The matching CLI is scripts/import-atlas.js.
//
// THREE design decisions, settled against the v0.9.1 source (build-spec, the
// chronicle entry under domain 't2helix,error-atlas,build-spec'):
//
//   1. STORAGE = the existing insights tier, NOT a parallel error_atlas table.
//      Writing through record() gets secrets.scrub() on the write path, the
//      insights_fts mirror trigger, and visibility to recall() + the
//      memory→compass coupling — all for free. A parallel table skips all three
//      and doubles the better-sqlite3 native surface, the system's one known
//      silent-failure landmine (the thing v0.5.x fail-loud + doctor hardened).
//
//   2. DOMAIN = 'error-fix' (a non-meta domain), layer 'ground_truth'. Methods
//      live in META_DOMAINS and surface ONLY via the targeted slug lookup;
//      error-fix is curated reference content that should surface through NORMAL
//      recall() when a prompt carries matching error tokens, so it must NOT be a
//      meta domain. The pattern text is the first line of content so its tokens
//      (ModuleNotFoundError, SyntaxError, …) land in FTS — that token overlap is
//      the failure→fix matcher. Wildcards (*) are FTS punctuation and drop out
//      of tokenization harmlessly.
//
//   3. PRE-PROMOTED, no method_candidates quarantine. The atlas entries are
//      HUMAN-CURATED and pre-vouched by deliberate authorship — not
//      machine-distilled guesses — so they skip the candidate quarantine and
//      load directly into the ground_truth tier in one reviewed batch. (The
//      Stop-hook auto-distill path still routes machine guesses through
//      method_candidates + promote_method; that path is unchanged.)

const crypto = require('crypto');

const ATLAS_DOMAIN = 'error-fix';
const ATLAS_SESSION = 'atlas-import';
const ATLAS_INTENSITY = 0.8;        // human-vouched ground_truth (matches promoted-method trust)
const ATLAS_LAYER = 'ground_truth';
// Reference knowledge carries ZERO recency weight. recall() ranks on
// `-(bm25) + recencyBoost`; a fresh row gets recencyBoost ≈ 1.0 and would crowd
// out genuinely-recent user notes on any weak common-word overlap ("git", "setup",
// "to"). Backdating to the epoch makes recencyBoost 0 for any recencyWeightDays, so
// an atlas entry surfaces ONLY on strong error-token FTS overlap (where its bm25
// term dominates), never on a generic query. This also sinks atlas rows to the
// bottom of get_state()'s "recent insights" (ORDER BY created_at DESC), where
// reference data belongs.
const ATLAS_CREATED_AT = 0;

// Stable identity for idempotent re-runs. Hash the RAW source fields (pre-scrub)
// so the fingerprint is invariant even if the scrubber or content rendering
// changes later — a re-run always recognizes an already-loaded entry.
function fingerprint(pattern, resolution) {
  return crypto.createHash('sha256')
    .update(String(pattern) + '\n' + String(resolution))
    .digest('hex')
    .slice(0, 12);
}

// Parse JSONL text into validated {pattern, resolution} records. Returns
// { records, errors }; each error carries the 1-based line number + reason so a
// malformed corpus reports precisely instead of failing opaquely. Blank lines
// are skipped silently (not errors).
function parseAtlas(text) {
  const records = [];
  const errors = [];
  const lines = String(text == null ? '' : text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    let o;
    try {
      o = JSON.parse(raw);
    } catch (e) {
      errors.push({ line: i + 1, reason: `invalid JSON: ${e.message}` });
      continue;
    }
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      errors.push({ line: i + 1, reason: 'not a JSON object' });
      continue;
    }
    const pattern = typeof o.pattern === 'string' ? o.pattern.trim() : '';
    const resolution = typeof o.resolution === 'string' ? o.resolution.trim() : '';
    if (!pattern) { errors.push({ line: i + 1, reason: 'missing or empty "pattern"' }); continue; }
    if (!resolution) { errors.push({ line: i + 1, reason: 'missing or empty "resolution"' }); continue; }
    records.push({ pattern, resolution });
  }
  return { records, errors };
}

// Canonical insight shape for one atlas entry, ready to hand to chronicle.record().
// `_fp` is the idempotency fingerprint (also embedded as a tag).
function buildInsight({ pattern, resolution }) {
  const fp = fingerprint(pattern, resolution);
  const content = `[error-fix] ${pattern}\n\n${resolution}`;
  return {
    session_id: ATLAS_SESSION,
    content,
    domain: ATLAS_DOMAIN,
    tags: ['error-fix', 'source:atlas', `fp:${fp}`],
    intensity: ATLAS_INTENSITY,
    layer: ATLAS_LAYER,
    created_at: ATLAS_CREATED_AT,
    _fp: fp
  };
}

// Has an atlas entry with this fingerprint already been loaded? Matches the
// JSON-encoded tag the same way recall()/getSessionInsights() do
// (tags LIKE '%"<token>"%'). fp is 12 hex chars, so there are no LIKE
// metacharacters to escape. Scoped to session_id = ATLAS_SESSION so the query
// rides idx_insights_session (an O(atlas-rows) index seek instead of an
// O(all-rows) table scan as the chronicle grows) AND so the substring tag match
// can only ever match atlas rows — never a same-substring tag on an unrelated
// insight in another session.
function fingerprintExists(ch, fp) {
  const row = ch.db()
    .prepare(`SELECT 1 FROM insights WHERE session_id = ? AND domain = ? AND tags LIKE ? LIMIT 1`)
    .get(ATLAS_SESSION, ATLAS_DOMAIN, `%"fp:${fp}"%`);
  return !!row;
}

// Detect same-pattern / different-resolution entries within a batch — the atlas
// asserting two DIVERGENT fixes for one error signature. Returns
// [{ pattern, count, fps }] for every pattern carrying >1 distinct resolution.
// Pure (no DB), scoped to the input batch (intra-file) — the unit an operator
// loads and curates at once. SURFACED, never blocked: an error can legitimately
// have more than one valid fix, so both still load (append-only); the point is to
// not bury the divergence silently. The resolution TEXT is deliberately NOT
// returned — it is the field most likely to carry a secret and a conflict report
// reaches stdout/stderr, so only the pattern (an error signature, the public FTS
// surface that becomes recallable content anyway) + the fingerprints are exposed,
// which is enough to locate both rows in the source file. Trims the same way
// parseAtlas does so "x" and "x " are not counted as two distinct resolutions.
function detectConflicts(records) {
  const byPattern = new Map();
  for (const r of (Array.isArray(records) ? records : [])) {
    if (!r || typeof r.pattern !== 'string' || typeof r.resolution !== 'string') continue;
    const pattern = r.pattern.trim();
    const resolution = r.resolution.trim();
    if (!pattern || !resolution) continue;
    let byRes = byPattern.get(pattern);
    if (!byRes) { byRes = new Map(); byPattern.set(pattern, byRes); }
    if (!byRes.has(resolution)) byRes.set(resolution, fingerprint(pattern, resolution));
  }
  const conflicts = [];
  for (const [pattern, byRes] of byPattern) {
    if (byRes.size > 1) conflicts.push({ pattern, count: byRes.size, fps: [...byRes.values()] });
  }
  return conflicts;
}

// Idempotent batch load. For each record: skip if its fingerprint is already
// present, otherwise record() it (→ scrub + FTS mirror fire automatically).
// `dryRun` runs the existence checks but writes nothing, so an operator can
// preview exactly what a real run would insert vs skip against the real target
// db. Returns { counts, dropped }. The pre-check/insert pair is not
// transactionally atomic against a concurrent importer, but atlas import is a
// one-shot manual operation (documented in the CLI). A record() that drops
// (scrub threw) is counted, not silently lost; idempotency makes a re-run safe.
function importAtlas({ ch, records, dryRun = false } = {}) {
  const list = Array.isArray(records) ? records : [];
  const counts = { total: list.length, inserted: 0, skipped: 0, dropped: 0 };
  const dropped = [];
  // Surface divergent-resolution conflicts within this batch (non-blocking — both
  // entries still load below; this only makes the divergence visible to the caller).
  const conflicts = detectConflicts(list);
  // Fingerprints already accounted for in THIS run. Used in both modes so a
  // dry-run predicts the real run exactly on intra-file duplicates: in a real run
  // the first of two identical lines commits and the second's fingerprintExists
  // skips it; without this set a dry-run (which writes nothing) would count both as
  // would-insert and diverge. Checked before the DB so a repeated line is O(1).
  const seenThisRun = new Set();
  for (const record of list) {
    const ins = buildInsight(record);
    if (seenThisRun.has(ins._fp) || fingerprintExists(ch, ins._fp)) { counts.skipped++; continue; }
    seenThisRun.add(ins._fp);
    if (dryRun) { counts.inserted++; continue; } // would-insert
    let res;
    try {
      res = ch.record({
        session_id: ins.session_id,
        content: ins.content,
        domain: ins.domain,
        tags: ins.tags,
        intensity: ins.intensity,
        layer: ins.layer,
        created_at: ins.created_at
      });
    } catch (e) {
      // record() THREW on this one row — e.g. content exceeds MAX_CONTENT_BYTES
      // (the 100KB cap in chronicle.record), or a transient driver error. Isolate
      // it: a single bad entry must NOT abort the whole batch and strand the valid
      // entries that follow it — that would break the loader's "load the valid
      // subset, report the rest" contract (the same contract the CLI exit code
      // upholds for malformed parse lines). Count as dropped, fingerprint ONLY: the
      // raw fields may carry whatever tripped the throw (size, or a secret that grew
      // the row past the cap under scrub), so never echo content into a return value
      // or a log — identical no-leak rule to the scrub-drop path below.
      counts.dropped++;
      dropped.push({ fp: ins._fp });
      continue;
    }
    if (!res || res.dropped || !res.id) {
      // A drop means scrub threw on this row (the inverted fail-open path) — the
      // raw fields may carry the very secret that tripped it, so record ONLY the
      // fingerprint here. Never the pattern/content: a dropped row must not leak
      // its secret into a return value, a log, or any downstream consumer.
      counts.dropped++;
      dropped.push({ fp: ins._fp });
    } else {
      counts.inserted++;
    }
  }
  return { counts, dropped, conflicts };
}

module.exports = {
  ATLAS_DOMAIN,
  ATLAS_SESSION,
  fingerprint,
  parseAtlas,
  buildInsight,
  fingerprintExists,
  detectConflicts,
  importAtlas
};
