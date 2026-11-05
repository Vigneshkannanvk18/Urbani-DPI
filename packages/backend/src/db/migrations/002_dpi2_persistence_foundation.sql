-- Migration 002 — DPI 2 persistence foundation (item 1). Forward-only.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'SUPER_ADMIN'
  CHECK (role IN ('SUPER_ADMIN','INFRA_ADMIN','QA_OPERATOR','READER_AUDITOR'));

ALTER TABLE audit_events ADD COLUMN result TEXT NOT NULL DEFAULT 'SUCCESS'
  CHECK (result IN ('SUCCESS','FAILURE','DENIED'));
-- Failed chat turns were recorded with metadata.outcome = 'unavailable'. The CASE guard keeps
-- malformed JSON from aborting the migration (json_extract throws on it).
UPDATE audit_events SET result = 'FAILURE'
 WHERE CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.outcome') END = 'unavailable';
CREATE INDEX idx_audit_actor_ts ON audit_events (actor, timestamp DESC);

-- user_id deliberately has NO foreign key to users, so no write to users can cascade into
-- preferences/chats. That includes DPI 1 code's INSERT OR REPLACE on a migrated DB. It also
-- matches DynamoDB, which has no cascades. Both drivers check user existence explicitly.
CREATE TABLE user_preferences (
  user_id            TEXT PRIMARY KEY,
  theme              TEXT CHECK (theme IN ('light','dark')),
  widget_layout_json TEXT,
  updated_at         TEXT NOT NULL
);

CREATE TABLE chat_sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  title         TEXT,
  service       TEXT,
  environment   TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_chat_sessions_user ON chat_sessions (user_id, updated_at DESC, id DESC);

CREATE TABLE chat_messages (
  id             TEXT PRIMARY KEY,  -- time-ordered: <13-digit epoch ms>-<uuid>
  session_id     TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role           TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content        TEXT NOT NULL,
  citations_json TEXT NOT NULL DEFAULT '[]',
  provider       TEXT,
  model_id       TEXT,
  data_source    TEXT CHECK (data_source IN ('LIVE','MOCK','WAITING_FOR_INTEGRATION')),
  latency_ms     INTEGER,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_chat_messages_session ON chat_messages (session_id, id);

CREATE TABLE chat_feedback (
  message_id TEXT PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  rating     TEXT NOT NULL CHECK (rating IN ('LIKE','DISLIKE')),
  comment    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_chat_feedback_session ON chat_feedback (session_id, message_id);
