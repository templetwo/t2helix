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
