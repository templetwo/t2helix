CREATE TABLE IF NOT EXISTS insights (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  content TEXT NOT NULL,
  domain TEXT,
  tags TEXT,
  intensity REAL DEFAULT 0.5,
  layer TEXT DEFAULT 'hypothesis',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_insights_session ON insights(session_id);
CREATE INDEX IF NOT EXISTS idx_insights_created ON insights(created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS insights_fts USING fts5(
  content,
  domain,
  tags,
  content='insights',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS insights_ai AFTER INSERT ON insights BEGIN
  INSERT INTO insights_fts(rowid, content, domain, tags)
  VALUES (new.id, new.content, new.domain, new.tags);
END;

-- External-content FTS5 stays consistent only if delete/update mirror into the
-- index. No row is currently ever updated or deleted, so these are purely
-- additive today — but they remove the silent-desync landmine for the first
-- future redaction/retention/prune path. Canonical SQLite external-content trio.
CREATE TRIGGER IF NOT EXISTS insights_ad AFTER DELETE ON insights BEGIN
  INSERT INTO insights_fts(insights_fts, rowid, content, domain, tags)
  VALUES ('delete', old.id, old.content, old.domain, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS insights_au AFTER UPDATE ON insights BEGIN
  INSERT INTO insights_fts(insights_fts, rowid, content, domain, tags)
  VALUES ('delete', old.id, old.content, old.domain, old.tags);
  INSERT INTO insights_fts(rowid, content, domain, tags)
  VALUES (new.id, new.content, new.domain, new.tags);
END;

CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY,
  question TEXT NOT NULL,
  domain TEXT,
  context TEXT,
  status TEXT DEFAULT 'open',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolution TEXT
);

CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status);

CREATE TABLE IF NOT EXISTS goals (
  session_id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  why TEXT,
  acceptance_criteria TEXT,
  started_at INTEGER NOT NULL,
  last_referenced INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS compass_log (
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  tool_name TEXT NOT NULL,
  action_summary TEXT NOT NULL,
  classification TEXT NOT NULL,
  rule_matched TEXT,
  reason TEXT,
  user_override TEXT,
  occurred_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_compass_session ON compass_log(session_id);
CREATE INDEX IF NOT EXISTS idx_compass_classification ON compass_log(classification);

CREATE TABLE IF NOT EXISTS pending_confirmations (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  action_hash TEXT NOT NULL,
  action_summary TEXT NOT NULL,
  rule_matched TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  used_at INTEGER,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_token ON pending_confirmations(token);
CREATE INDEX IF NOT EXISTS idx_pending_lookup ON pending_confirmations(session_id, action_hash, status);

-- Stage 3 auto-distill (v0.4). A QUARANTINE store for method candidates the Stop
-- hook distills from successful sessions. Deliberately its OWN table, NOT the
-- insights table: a candidate is therefore not an insight, cannot enter recall /
-- FTS / the targeted method lookup, and so can never raise injected volume — the
-- strongest guarantee of the cardinal rule given the Stop hook is a high-frequency
-- writer. status lifecycle: pending -> promoted | dismissed. NOT time-boxed (no
-- expires_at): a candidate persists until a human reviews it. promote_method is
-- the only path from here onto the surfaced method store (writes a fresh
-- domain:'method' insight and links it via promoted_insight_id).
CREATE TABLE IF NOT EXISTS method_candidates (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  shape TEXT NOT NULL,
  steps TEXT NOT NULL,
  acceptance TEXT,
  tool_classes TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  promoted_insight_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_method_candidates_status ON method_candidates(status, created_at);
