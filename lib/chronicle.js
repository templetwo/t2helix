'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
// Imported as a module object (not destructured) so the redact-or-drop fail-safe
// is exercisable in tests by monkeypatching secrets.redactSecrets to throw.
const secrets = require('./secrets');

// better-sqlite3 is a native module. Load it LAZILY and defensively rather than
// at module top: every hook and the MCP server require this module at load
// time, so a top-level throw (ABI mismatch / NODE_MODULE_VERSION / missing
// binding) would escape their main() try/catch and break the host CLI — the
// exact opposite of the "hooks must fail-open" contract. Instead we defer the
// require to first db() touch and surface a tagged, actionable error that the
// callers already catch and fail-open on.
let Database = null;
function loadDriver() {
  if (Database) return Database;
  try {
    Database = require('better-sqlite3');
  } catch (e) {
    const err = new Error(
      `t2helix: SQLite native binding unavailable (${e.code || e.message}) — ` +
      'run `npm rebuild better-sqlite3` in the t2helix plugin dir'
    );
    err.code = 'T2HELIX_DRIVER_UNAVAILABLE';
    err.cause = e;
    throw err;
  }
  return Database;
}

const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CONTENT_BYTES = 100 * 1024;  // 100KB hard cap on insight content

// Retention bounds for the append-only operational tables (v0.2). compass_log
// and pending_confirmations grew unbounded pre-0.2 (a 0.1.0-audit deferral).
// compass_log keeps the UNION of "last N days" and "newest M rows" — whichever
// is more permissive — so neither a quiet week nor a busy hour loses recent
// history. Pruning is best-effort and fail-open (called from the Stop hook).
const COMPASS_LOG_RETAIN_DAYS = 30;
const COMPASS_LOG_RETAIN_ROWS = 5000;

const DEFAULT_DATA_DIR =
  process.env.T2HELIX_DATA_DIR ||
  process.env.CLAUDE_PLUGIN_DATA ||
  // os.homedir() resolves the real home even when $HOME is unset (passwd
  // lookup), and never returns '' the way process.env.HOME can — which would
  // otherwise join to a CWD-relative '.t2helix-data' and splinter state.
  // os.tmpdir() is an absolute last resort so the path is always absolute.
  path.join(os.homedir() || os.tmpdir(), '.t2helix-data');

let _db = null;

function dataDir() {
  return DEFAULT_DATA_DIR;
}

function dbPath() {
  return path.join(dataDir(), 'chronicle.db');
}

function currentSessionFile() {
  return path.join(dataDir(), '.current_session');
}

function writeCurrentSession(session_id) {
  if (!session_id) return;
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(currentSessionFile(), String(session_id), 'utf8');
  } catch (_) {}
}

function readCurrentSession() {
  try {
    const v = fs.readFileSync(currentSessionFile(), 'utf8').trim();
    return v || null;
  } catch {
    return null;
  }
}

function db() {
  if (_db) return _db;
  const Driver = loadDriver();
  fs.mkdirSync(dataDir(), { recursive: true });
  const conn = new Driver(dbPath());
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  // Bound lock waits well under the 5s PreToolUse/UserPromptSubmit hook budget
  // so a contended write fails-open through the caller's try/catch instead of
  // being killed mid-write by the host hook timeout (which is the worst case
  // for the PreToolUse "crash == deny" behavior). Explicit, not version-default.
  conn.pragma('busy_timeout = 1500');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  conn.exec(schema);
  _db = conn;
  return _db;
}

function record({ session_id, content, domain, tags, intensity, layer }) {
  if (!session_id) throw new Error('record: session_id required');
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('record: content must be a non-empty string');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    throw new Error(`record: content exceeds ${MAX_CONTENT_BYTES} bytes (got ${Buffer.byteLength(content, 'utf8')})`);
  }
  // Redact-or-drop (the one place we INVERT fail-open). recordCompassFire(),
  // PostToolUse, and the MCP record tool all flow through here, so redacting at
  // this single chokepoint covers every write to the insights table. If
  // redaction itself throws, drop the row rather than persist a possible secret
  // in cleartext — a lost insight is recoverable, a leaked credential is not.
  let safeContent;
  try {
    safeContent = secrets.scrub(content);
  } catch (e) {
    process.stderr.write(`[t2helix] record dropped (redaction failed): ${e.message}\n`);
    return { id: null, dropped: true };
  }
  const stmt = db().prepare(`
    INSERT INTO insights (session_id, content, domain, tags, intensity, layer, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    session_id,
    safeContent,
    domain || null,
    tags ? JSON.stringify(tags) : null,
    typeof intensity === 'number' ? intensity : 0.5,
    layer || 'hypothesis',
    Date.now()
  );
  return { id: info.lastInsertRowid };
}

// Domains the hooks write to. Excluded from recall by default so curated
// content surfaces first; pass include_meta:true to opt back in. 'compass-fire'
// is here (v0.2) because the criterion-#3 compass writes are high-frequency
// reflection noise that crowded out curated insights in the default recall
// surface — and, worse, embedded any credential-shaped command. The helix
// coupling that reads the action:<hash> chain already passes include_meta:true
// (hooks/pre-tool-use.js), so excluding compass-fire here does not break it.
const META_DOMAINS = ['session-action', 'session-synthesis', 'compass-fire', 'method'];

function recall({ query, topK = 5, recencyWeightDays = 30, layer, min_intensity, include_meta = false, since, until, tag }) {
  const filterClauses = [];
  const filterParams = [];

  if (!include_meta) {
    const placeholders = META_DOMAINS.map(() => '?').join(',');
    filterClauses.push(`(i.domain IS NULL OR i.domain NOT IN (${placeholders}))`);
    filterParams.push(...META_DOMAINS);
  }
  if (layer) {
    const layers = Array.isArray(layer) ? layer : [layer];
    if (layers.length > 0) {
      filterClauses.push(`i.layer IN (${layers.map(() => '?').join(',')})`);
      filterParams.push(...layers);
    }
  }
  if (typeof min_intensity === 'number') {
    filterClauses.push('i.intensity >= ?');
    filterParams.push(min_intensity);
  }
  if (typeof since === 'number') {
    filterClauses.push('i.created_at >= ?');
    filterParams.push(since);
  }
  if (typeof until === 'number') {
    filterClauses.push('i.created_at <= ?');
    filterParams.push(until);
  }
  if (tag) {
    // tags column is JSON-encoded (e.g. '["a","outcome:failure","b"]').
    // Match the literal quoted token so 'outcome:fail' doesn't accidentally
    // match 'outcome:failure' as a prefix. Escape LIKE metacharacters (% _ \) in
    // the tag so a tag containing them can't widen the match (v0.2 hardening).
    const escTag = String(tag).replace(/([\\%_])/g, '\\$1');
    filterClauses.push("i.tags LIKE ? ESCAPE '\\'");
    filterParams.push(`%"${escTag}"%`);
  }

  if (!query || query.trim().length === 0) {
    const where = filterClauses.length ? `WHERE ${filterClauses.join(' AND ')}` : '';
    const sql = `SELECT i.id, i.content, i.domain, i.tags, i.intensity, i.layer, i.created_at FROM insights i ${where} ORDER BY i.created_at DESC LIMIT ?`;
    const rows = db().prepare(sql).all(...filterParams, topK);
    return rows.map(decorate);
  }
  // Build the FTS5 MATCH query defensively. action_summary-shaped queries
  // (e.g. "Bash: git commit -m foo") contain ':' / '-' / '(' which FTS5 parses
  // as operators — ':' as a column filter — and throws "no such column: Bash".
  // Before the fix that throw fell through to a recency-only fallback, silently
  // turning the memory→compass coupling (criterion #2) into "most recent"
  // instead of "most similar". Quoting each token as an FTS5 string literal
  // forces those chars to be treated as content; tokens with no alphanumeric
  // payload (bare flags/punctuation) are dropped so they can't error or add noise.
  const terms = query
    .split(/\s+/)
    .map(t => t.replace(/"/g, ''))
    .filter(t => /[\p{L}\p{N}]/u.test(t))
    .map(t => `"${t}"*`);

  if (terms.length === 0) {
    // No searchable tokens (query was all punctuation/flags) — behave like the
    // no-query recency listing rather than constructing an empty MATCH.
    const where = filterClauses.length ? `WHERE ${filterClauses.join(' AND ')}` : '';
    const sql = `SELECT i.id, i.content, i.domain, i.tags, i.intensity, i.layer, i.created_at FROM insights i ${where} ORDER BY i.created_at DESC LIMIT ?`;
    return db().prepare(sql).all(...filterParams, topK).map(decorate);
  }
  const ftsQuery = terms.join(' OR ');
  let rows = [];
  try {
    const ftsExtra = filterClauses.length ? ` AND ${filterClauses.join(' AND ')}` : '';
    rows = db()
      .prepare(`
        SELECT i.id, i.content, i.domain, i.tags, i.intensity, i.layer, i.created_at,
               bm25(insights_fts) AS score
        FROM insights_fts
        JOIN insights i ON i.id = insights_fts.rowid
        WHERE insights_fts MATCH ?${ftsExtra}
        ORDER BY score
        LIMIT ?
      `)
      .all(ftsQuery, ...filterParams, topK * 3);
  } catch (e) {
    // FTS should no longer throw on command-shaped queries; if it still does,
    // make the degradation VISIBLE rather than indistinguishable from "no hits".
    process.stderr.write(`[t2helix] recall FTS degraded to recency (${e.message}); ${terms.length} term(s)\n`);
    const where = filterClauses.length ? `WHERE ${filterClauses.join(' AND ')}` : '';
    rows = db()
      .prepare(`SELECT i.id, i.content, i.domain, i.tags, i.intensity, i.layer, i.created_at, 0 AS score FROM insights i ${where} ORDER BY i.created_at DESC LIMIT ?`)
      .all(...filterParams, topK * 3);
  }
  const now = Date.now();
  const dayMs = 86400000;
  const ranked = rows.map(r => {
    const ageDays = (now - r.created_at) / dayMs;
    const recencyBoost = Math.max(0, 1 - ageDays / recencyWeightDays);
    const composite = -(r.score || 0) + recencyBoost;
    return { ...r, _composite: composite };
  });
  ranked.sort((a, b) => b._composite - a._composite);
  return ranked.slice(0, topK).map(decorate);
}

function decorate(r) {
  return {
    id: r.id,
    content: r.content,
    domain: r.domain || null,
    tags: r.tags ? safeParse(r.tags) : null,
    intensity: r.intensity,
    layer: r.layer,
    created_at: r.created_at
  };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}

function setGoal({ session_id, goal, why, acceptance_criteria }) {
  if (!session_id || !goal) throw new Error('setGoal: session_id and goal required');
  const now = Date.now();

  // Preserve prior goal as an archived insight before overwriting (Entry 1 fix).
  // Skip when the new goal is identical (idempotent re-set should not archive).
  // On archive failure, emit a stderr warning rather than swallowing silently —
  // we still proceed with the overwrite, but the failure becomes visible.
  try {
    const prior = getGoal(session_id);
    if (prior && prior.goal && prior.goal !== goal) {
      const archiveContent = `[archived-goal] ${prior.goal}` +
        (prior.why ? `\n\nWhy: ${prior.why}` : '') +
        (prior.acceptance_criteria ? `\n\nAcceptance: ${JSON.stringify(prior.acceptance_criteria)}` : '');
      record({
        session_id,
        content: archiveContent,
        domain: 't2helix',
        tags: ['archived-goal'],
        intensity: 0.4,
        layer: 'reflection'
      });
    }
  } catch (e) {
    process.stderr.write(`[t2helix] setGoal preserve-prior failed: ${e.message}\n`);
  }

  db().prepare(`
    INSERT INTO goals (session_id, goal, why, acceptance_criteria, started_at, last_referenced)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      goal = excluded.goal,
      why = COALESCE(excluded.why, goals.why),
      acceptance_criteria = COALESCE(excluded.acceptance_criteria, goals.acceptance_criteria),
      last_referenced = excluded.last_referenced
  `).run(
    session_id,
    goal,
    why || null,
    acceptance_criteria ? JSON.stringify(acceptance_criteria) : null,
    now,
    now
  );
  return { ok: true };
}

function getGoal(session_id) {
  if (!session_id) return null;
  const row = db().prepare(`SELECT * FROM goals WHERE session_id = ?`).get(session_id);
  if (!row) return null;
  return {
    goal: row.goal,
    why: row.why,
    acceptance_criteria: row.acceptance_criteria ? safeParse(row.acceptance_criteria) : null,
    started_at: row.started_at,
    last_referenced: row.last_referenced
  };
}

function openThread({ question, domain, context }) {
  if (!question) throw new Error('openThread: question required');
  const info = db().prepare(`
    INSERT INTO threads (question, domain, context, status, created_at)
    VALUES (?, ?, ?, 'open', ?)
  `).run(question, domain || null, context || null, Date.now());
  return { id: info.lastInsertRowid };
}

function resolveThread({ id, resolution }) {
  if (!id) throw new Error('resolveThread: id required');
  if (typeof resolution !== 'string' || resolution.trim().length === 0) {
    throw new Error('resolveThread: resolution must be a non-empty string');
  }
  const row = db().prepare(`SELECT id, status FROM threads WHERE id = ?`).get(id);
  if (!row) throw new Error(`resolveThread: thread id ${id} not found`);
  if (row.status === 'resolved') {
    return { ok: true, id, already_resolved: true };
  }
  db().prepare(`
    UPDATE threads
    SET status = 'resolved', resolved_at = ?, resolution = ?
    WHERE id = ?
  `).run(Date.now(), resolution, id);
  return { ok: true, id };
}

function getOpenThreads({ limit = 10, domain } = {}) {
  let rows;
  if (domain) {
    rows = db().prepare(`SELECT * FROM threads WHERE status = 'open' AND domain = ? ORDER BY created_at DESC LIMIT ?`).all(domain, limit);
  } else {
    rows = db().prepare(`SELECT * FROM threads WHERE status = 'open' ORDER BY created_at DESC LIMIT ?`).all(limit);
  }
  return rows;
}

// Compass → memory coupling (helix criterion #3). When PreToolUse fires
// PAUSE or WITNESS, write a chronicle entry tagged with action_hash so the
// event is linkable to the eventual outcome (PostToolUse writes the same
// action_hash tag on its entries). Recall by tag='action:<hash>' returns both
// ends of the chain — the compass's judgment and what actually happened.
function recordCompassFire({ session_id, action_summary, classification, rule_matched, reason }) {
  if (!session_id) session_id = 'unknown';
  const hash = actionHash(action_summary);
  const tags = ['compass-fire', `classification:${classification}`, `action:${hash}`];
  if (rule_matched) tags.push(`rule:${rule_matched}`);
  const content = `[compass-fire] ${classification}: ${action_summary || '(no action)'}\n` +
    `Reason: ${reason || '(no reason)'}\nAction-hash: ${hash}`;
  return record({
    session_id,
    content,
    domain: 'compass-fire',
    tags,
    intensity: 0.7,
    layer: 'reflection'
  });
}

// Method store (v0.3 / Stage 2). A method is an insight with domain 'method':
// an ordered, reusable procedure keyed to a task shape, surfaced ONLY via the
// targeted lookup in user-prompt-submit (never the generic recall firehose —
// hence 'method' is in META_DOMAINS). No new table, no new write path: it flows
// through record(), so Stage-1 redaction scrubs any credential in the steps.
function recordMethod({ session_id, shape, steps, acceptance, tool_classes, source }) {
  if (typeof shape !== 'string' || shape.trim().length === 0) {
    throw new Error('recordMethod: shape (a task-shape slug) required');
  }
  const stepList = (Array.isArray(steps) ? steps : [steps])
    .filter(s => typeof s === 'string' && s.trim().length > 0)
    .map((s, i) => `${i + 1}. ${s.trim()}`);
  if (stepList.length === 0) throw new Error('recordMethod: at least one step required');
  const src = source === 'auto-distill' ? 'auto-distill' : 'explicit';
  const content = `[method] ${shape.trim()}\n` + stepList.join('\n') +
    (acceptance && String(acceptance).trim() ? `\nAcceptance: ${String(acceptance).trim()}` : '');
  const tags = ['method', `shape:${shape.trim()}`, `source:${src}`];
  for (const tc of (Array.isArray(tool_classes) ? tool_classes : [])) {
    if (typeof tc === 'string' && tc.trim()) tags.push(`tool:${tc.trim().toLowerCase()}`);
  }
  // Explicit methods are trusted (ground_truth, higher intensity); auto-distilled
  // ones (deferred for now) would land as lower-confidence hypotheses.
  return record({
    session_id: session_id || 'unknown',
    content,
    domain: 'method',
    tags,
    intensity: src === 'explicit' ? 0.8 : 0.5,
    layer: src === 'explicit' ? 'ground_truth' : 'hypothesis'
  });
}

function logCompass({ session_id, tool_name, action_summary, classification, rule_matched, reason }) {
  // Redact-or-drop the two free-text columns. compass_log was the second leak
  // site: action_summary is the raw command (credential and all), and reason can
  // echo it. tool_name / classification / rule_matched are controlled vocabulary,
  // never secret-bearing. If redaction throws, drop the log row — a missing
  // compass_log entry is acceptable; a persisted secret is not.
  let safeSummary, safeReason;
  try {
    safeSummary = secrets.scrub(action_summary);
    safeReason = secrets.scrub(reason);
  } catch (e) {
    process.stderr.write(`[t2helix] logCompass dropped (redaction failed): ${e.message}\n`);
    return;
  }
  db().prepare(`
    INSERT INTO compass_log (session_id, tool_name, action_summary, classification, rule_matched, reason, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    session_id || null,
    tool_name,
    safeSummary,
    classification,
    rule_matched || null,
    safeReason || null,
    Date.now()
  );
}

function getState(session_id) {
  return {
    goal: getGoal(session_id),
    open_threads: getOpenThreads({ limit: 5 }),
    // Mirror recall()'s default surface: exclude hook-noise META_DOMAINS so the
    // boot / PreCompact view matches what recall() shows (open thread, 2026-06).
    recent_insights: db()
      .prepare(`SELECT id, content, domain, layer, created_at FROM insights
                WHERE (domain IS NULL OR domain NOT IN (${META_DOMAINS.map(() => '?').join(',')}))
                ORDER BY created_at DESC LIMIT 5`)
      .all(...META_DOMAINS)
      .map(r => ({ ...r, snippet: r.content.length > 200 ? r.content.slice(0, 200) + '…' : r.content }))
  };
}

function getCompassHistory({ limit = 20, classification, matched_only } = {}) {
  const clauses = [];
  const params = [];
  if (classification) {
    clauses.push('classification = ?');
    params.push(classification);
  }
  if (matched_only) {
    clauses.push('rule_matched IS NOT NULL');
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const sql = `SELECT id, session_id, tool_name, action_summary, classification, rule_matched, reason, occurred_at FROM compass_log ${where} ORDER BY occurred_at DESC LIMIT ?`;
  params.push(limit);
  return db().prepare(sql).all(...params);
}

function actionHash(action_summary) {
  return crypto.createHash('sha256').update(String(action_summary || '')).digest('hex').slice(0, 32);
}

function createPendingConfirmation({ session_id, action_summary, rule_matched, reason, ttl_ms }) {
  if (!session_id) throw new Error('createPendingConfirmation: session_id required');
  const token = crypto.randomBytes(8).toString('hex');
  // Hash the RAW summary — findApproval() hashes the raw live summary on retry,
  // so both ends must digest the same unredacted string for the match to hold.
  const hash = actionHash(action_summary);
  // But the credential-paste PAUSE path stores the very command that tripped the
  // rule, and list_pending / confirm_pending read these columns back into model
  // context — so the STORED summary/reason must be scrubbed (the third write
  // site, missed in the v0.2.0 first cut). On a scrub failure, store a marker
  // rather than the raw text; the hash still matches so the override works.
  let safeSummary, safeReason;
  try {
    safeSummary = secrets.scrub(String(action_summary || ''));
    safeReason = secrets.scrub(reason);
  } catch (_) {
    safeSummary = '[REDACTED:redaction-error]';
    safeReason = null;
  }
  const now = Date.now();
  const ttl = typeof ttl_ms === 'number' ? ttl_ms : PENDING_TTL_MS;
  db().prepare(`
    INSERT INTO pending_confirmations
      (token, session_id, action_hash, action_summary, rule_matched, reason, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(token, session_id, hash, safeSummary, rule_matched || null, safeReason || null, now, now + ttl);
  return { token, action_hash: hash, expires_at: now + ttl };
}

function findApproval({ session_id, action_summary }) {
  if (!session_id) return null;
  const hash = actionHash(action_summary);
  const now = Date.now();
  const row = db().prepare(`
    SELECT * FROM pending_confirmations
    WHERE session_id = ? AND action_hash = ? AND status = 'approved' AND expires_at > ?
    ORDER BY approved_at DESC LIMIT 1
  `).get(session_id, hash, now);
  return row || null;
}

// Atomically claim a single-use approval. The `status = 'approved'` guard makes
// this a compare-and-swap: only one caller can flip the row to 'used', so a
// token can never be double-spent across racing PreToolUse processes (the prior
// unguarded UPDATE let two processes both read 'approved' and both consume it).
// Returns true if THIS call claimed it, false if it was already consumed.
function consumeApproval(id) {
  const info = db()
    .prepare(`UPDATE pending_confirmations SET status = 'used', used_at = ? WHERE id = ? AND status = 'approved'`)
    .run(Date.now(), id);
  return info.changes === 1;
}

function approveConfirmation({ token }) {
  if (!token) return { ok: false, error: 'token required' };
  const now = Date.now();
  const row = db().prepare(`
    SELECT * FROM pending_confirmations WHERE token = ? AND status = 'pending' AND expires_at > ?
  `).get(token, now);
  if (!row) {
    return { ok: false, error: 'token not found, already used, or expired' };
  }
  db().prepare(`UPDATE pending_confirmations SET status = 'approved', approved_at = ? WHERE id = ?`).run(now, row.id);
  return {
    ok: true,
    action_summary: row.action_summary,
    rule_matched: row.rule_matched,
    expires_at: row.expires_at
  };
}

function listPendingConfirmations({ session_id, limit = 20 } = {}) {
  const now = Date.now();
  if (session_id) {
    return db().prepare(`
      SELECT id, token, session_id, action_summary, rule_matched, reason, status, created_at, expires_at, approved_at, used_at
      FROM pending_confirmations
      WHERE session_id = ? AND expires_at > ?
      ORDER BY created_at DESC LIMIT ?
    `).all(session_id, now, limit);
  }
  return db().prepare(`
    SELECT id, token, session_id, action_summary, rule_matched, reason, status, created_at, expires_at, approved_at, used_at
    FROM pending_confirmations
    WHERE expires_at > ?
    ORDER BY created_at DESC LIMIT ?
  `).all(now, limit);
}

// Bound the unbounded operational tables. Returns the delete counts. Safe to
// call repeatedly; cheap enough for the Stop-hook budget. `now` is injectable
// for tests.
function prune({ now = Date.now(), retainDays = COMPASS_LOG_RETAIN_DAYS, retainRows = COMPASS_LOG_RETAIN_ROWS } = {}) {
  const cutoff = now - retainDays * 86400000;
  // Delete compass_log rows that are BOTH older than the cutoff AND outside the
  // newest `retainRows` — i.e. keep the union of the two windows.
  const cl = db().prepare(`
    DELETE FROM compass_log
    WHERE occurred_at < ?
      AND id NOT IN (SELECT id FROM compass_log ORDER BY occurred_at DESC LIMIT ?)
  `).run(cutoff, retainRows);
  // Pending confirmations are single-use and time-boxed: once used or expired
  // they are dead weight.
  const pc = db().prepare(`
    DELETE FROM pending_confirmations
    WHERE status = 'used' OR expires_at < ?
  `).run(now);
  return { compass_log_deleted: cl.changes, pending_deleted: pc.changes };
}

function close() {
  if (_db) { _db.close(); _db = null; }
}

module.exports = {
  dataDir,
  dbPath,
  db,
  currentSessionFile,
  writeCurrentSession,
  readCurrentSession,
  record,
  recall,
  setGoal,
  getGoal,
  openThread,
  resolveThread,
  getOpenThreads,
  logCompass,
  recordCompassFire,
  recordMethod,
  getCompassHistory,
  actionHash,
  createPendingConfirmation,
  findApproval,
  consumeApproval,
  approveConfirmation,
  listPendingConfirmations,
  getState,
  prune,
  close
};
