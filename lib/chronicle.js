'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CONTENT_BYTES = 100 * 1024;  // 100KB hard cap on insight content

const DEFAULT_DATA_DIR =
  process.env.T2HELIX_DATA_DIR ||
  process.env.CLAUDE_PLUGIN_DATA ||
  path.join(process.env.HOME || '', '.t2helix-data');

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
  fs.mkdirSync(dataDir(), { recursive: true });
  const conn = new Database(dbPath());
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
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
  const stmt = db().prepare(`
    INSERT INTO insights (session_id, content, domain, tags, intensity, layer, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    session_id,
    content,
    domain || null,
    tags ? JSON.stringify(tags) : null,
    typeof intensity === 'number' ? intensity : 0.5,
    layer || 'hypothesis',
    Date.now()
  );
  return { id: info.lastInsertRowid };
}

// Domains the hooks write to. Excluded from recall by default so curated
// content surfaces first; pass include_meta:true to opt back in.
const META_DOMAINS = ['session-action', 'session-synthesis'];

function recall({ query, topK = 5, recencyWeightDays = 30, layer, min_intensity, include_meta = false, since, until }) {
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

  if (!query || query.trim().length === 0) {
    const where = filterClauses.length ? `WHERE ${filterClauses.join(' AND ')}` : '';
    const sql = `SELECT i.id, i.content, i.domain, i.tags, i.intensity, i.layer, i.created_at FROM insights i ${where} ORDER BY i.created_at DESC LIMIT ?`;
    const rows = db().prepare(sql).all(...filterParams, topK);
    return rows.map(decorate);
  }
  const sanitized = query.replace(/["']/g, ' ').trim();
  const ftsQuery = sanitized.split(/\s+/).filter(Boolean).map(t => `${t}*`).join(' OR ');
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

function logCompass({ session_id, tool_name, action_summary, classification, rule_matched, reason }) {
  db().prepare(`
    INSERT INTO compass_log (session_id, tool_name, action_summary, classification, rule_matched, reason, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    session_id || null,
    tool_name,
    action_summary,
    classification,
    rule_matched || null,
    reason || null,
    Date.now()
  );
}

function getState(session_id) {
  return {
    goal: getGoal(session_id),
    open_threads: getOpenThreads({ limit: 5 }),
    recent_insights: db()
      .prepare(`SELECT id, content, domain, layer, created_at FROM insights ORDER BY created_at DESC LIMIT 5`)
      .all()
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
  const hash = actionHash(action_summary);
  const now = Date.now();
  const ttl = typeof ttl_ms === 'number' ? ttl_ms : PENDING_TTL_MS;
  db().prepare(`
    INSERT INTO pending_confirmations
      (token, session_id, action_hash, action_summary, rule_matched, reason, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(token, session_id, hash, String(action_summary || ''), rule_matched || null, reason || null, now, now + ttl);
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

function consumeApproval(id) {
  db().prepare(`UPDATE pending_confirmations SET status = 'used', used_at = ? WHERE id = ?`).run(Date.now(), id);
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
  getCompassHistory,
  actionHash,
  createPendingConfirmation,
  findApproval,
  consumeApproval,
  approveConfirmation,
  listPendingConfirmations,
  getState,
  close
};
