'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

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
  if (!content || !session_id) throw new Error('record: session_id and content required');
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

function recall({ query, topK = 5, recencyWeightDays = 30 }) {
  if (!query || query.trim().length === 0) {
    const rows = db()
      .prepare(`SELECT id, content, domain, tags, intensity, layer, created_at FROM insights ORDER BY created_at DESC LIMIT ?`)
      .all(topK);
    return rows.map(decorate);
  }
  const sanitized = query.replace(/["']/g, ' ').trim();
  const ftsQuery = sanitized.split(/\s+/).filter(Boolean).map(t => `${t}*`).join(' OR ');
  let rows = [];
  try {
    rows = db()
      .prepare(`
        SELECT i.id, i.content, i.domain, i.tags, i.intensity, i.layer, i.created_at,
               bm25(insights_fts) AS score
        FROM insights_fts
        JOIN insights i ON i.id = insights_fts.rowid
        WHERE insights_fts MATCH ?
        ORDER BY score
        LIMIT ?
      `)
      .all(ftsQuery, topK * 3);
  } catch (e) {
    rows = db()
      .prepare(`SELECT id, content, domain, tags, intensity, layer, created_at, 0 AS score FROM insights ORDER BY created_at DESC LIMIT ?`)
      .all(topK * 3);
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

function close() {
  if (_db) { _db.close(); _db = null; }
}

module.exports = {
  dataDir,
  dbPath,
  db,
  record,
  recall,
  setGoal,
  getGoal,
  openThread,
  getOpenThreads,
  logCompass,
  getState,
  close
};
