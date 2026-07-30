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

-- The trailing eight columns are v0.12 (five for Compass V2, three for ruleset
-- provenance). Fresh installs get them here; older databases get them from
-- migrateSchema() in chronicle.js, which is a no-op when they already exist.
-- Keep the two in step — this file is meant to describe the real shape of the
-- table, and a drift makes fresh installs and upgrades disagree.
--
-- ruleset_hash / ruleset_source / rules_eligible answer the question the other
-- columns cannot: WHICH rules produced this verdict, and was any rule eligible
-- to evaluate the call at all. rules_eligible = 0 means "never evaluated", which
-- an OPEN classification alone cannot express. NULL in any of the three means
-- the row predates the column — provenance unknown, never assume.
CREATE TABLE IF NOT EXISTS compass_log (
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  tool_name TEXT NOT NULL,
  action_summary TEXT NOT NULL,
  classification TEXT NOT NULL,
  rule_matched TEXT,
  reason TEXT,
  user_override TEXT,
  occurred_at INTEGER NOT NULL,
  normalized_action_hash TEXT,
  evidence_json TEXT,
  parser_version TEXT,
  message_version TEXT,
  shadow_json TEXT,
  ruleset_hash TEXT,
  ruleset_source TEXT,
  rules_eligible INTEGER
);

CREATE INDEX IF NOT EXISTS idx_compass_session ON compass_log(session_id);
CREATE INDEX IF NOT EXISTS idx_compass_classification ON compass_log(classification);

-- One row per distinct ruleset ever in force, so compass_log.ruleset_hash
-- resolves to the actual rules rather than naming a set nobody kept. The
-- manifest lists every rule in LOAD ORDER (classify() returns on first match, so
-- order is part of the decision) with a digest of its unredacted pattern.
CREATE TABLE IF NOT EXISTS compass_rulesets (
  ruleset_hash TEXT PRIMARY KEY,
  source TEXT,
  rule_count INTEGER,
  manifest_json TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL
);

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
  expires_at INTEGER NOT NULL,
  -- v0.12 semantic identity (see the compass_log note above).
  normalized_action_hash TEXT,
  parser_version TEXT
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

-- Compass V2 (v0.12): schema ledger for additive migrations applied in chronicle.db().
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- Safe-repeat leases (v0.12). Session-scoped, TTL/use-bounded permission to
-- repeat one exact normalized action after human confirmation. Never overrides
-- WITNESS. Fresh installs get the full table here; upgraded DBs get it via
-- migrateSchema() in chronicle.js.
CREATE TABLE IF NOT EXISTS safe_repeat_leases (
  lease_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  normalized_action_hash TEXT NOT NULL,
  executable TEXT NOT NULL,
  cwd TEXT NOT NULL DEFAULT '',
  parser_version TEXT NOT NULL DEFAULT 'action-ir/0.12.0',
  expires_at INTEGER NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 10,
  uses_count INTEGER NOT NULL DEFAULT 0,
  classification_ceiling TEXT NOT NULL DEFAULT 'PAUSE',
  issued_from_compass_log_id INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leases_lookup
  ON safe_repeat_leases(session_id, normalized_action_hash, parser_version, cwd);
CREATE INDEX IF NOT EXISTS idx_leases_session ON safe_repeat_leases(session_id, expires_at);
