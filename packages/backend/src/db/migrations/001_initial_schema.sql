-- Migration 001 — Initial schema (Task 1.5)
-- Covers all entities required by the Admin Dashboard and the documented data model:
--   User, Role, Service, Environment, Alert, AlertEvidence, LogReference,
--   MetricSnapshot, AIAnalysis, UsageRecord, AuditEvent, Integration.
--
-- Design notes:
--  * The `alerts` table mirrors the documented UrbaniIncidentAlert contract and
--    the DynamoDB key design (service as partition, timestamp as sort key) so a
--    Phase 2 DynamoDBAdapter can map 1:1 without reshaping the domain.
--  * `data_source` columns record provenance (LIVE / MOCK / WAITING_FOR_INTEGRATION)
--    so nothing is ever silently presented as real AWS data.
--  * No AI-specific coupling: the alerts table stores AI *output*, not AI *logic*.

-- ---- Roles & Users ----------------------------------------------------------
CREATE TABLE roles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,          -- e.g. ADMIN, VIEWER
  description TEXT,
  permissions TEXT NOT NULL DEFAULT '[]',    -- JSON array of permission strings
  created_at  TEXT NOT NULL
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,               -- bcrypt; never store plaintext
  role_id       TEXT NOT NULL REFERENCES roles(id),
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at    TEXT NOT NULL
);

-- ---- Services & Environments (Epic 9) --------------------------------------
CREATE TABLE environments (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,           -- e.g. qa
  created_at TEXT NOT NULL
);

CREATE TABLE services (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,           -- e.g. main, payments
  environment       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'UNKNOWN', -- HEALTHY|DEGRADED|DOWN|UNKNOWN
  error_rate        REAL NOT NULL DEFAULT 0,
  last_telemetry_at TEXT,
  last_incident_at  TEXT,
  data_source       TEXT NOT NULL DEFAULT 'MOCK',
  created_at        TEXT NOT NULL,
  UNIQUE (name, environment)
);

-- ---- Alerts (UrbaniIncidentAlert contract) ---------------------------------
CREATE TABLE alerts (
  alert_id         TEXT PRIMARY KEY,          -- e.g. ALT-20260928-001
  timestamp        TEXT NOT NULL,             -- ISO-8601 (DynamoDB sort key analogue)
  service          TEXT NOT NULL,             -- (DynamoDB partition key analogue)
  environment      TEXT NOT NULL,
  severity         TEXT NOT NULL,             -- LOW|MEDIUM|HIGH|CRITICAL
  anomaly_type     TEXT NOT NULL,             -- GSI analogue (anomaly_type-index)
  summary          TEXT NOT NULL,
  probable_cause   TEXT NOT NULL,
  confidence       REAL,                      -- 0.0..1.0
  model_id         TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'OPEN', -- OPEN|ACKNOWLEDGED|RESOLVED|DISMISSED
  acknowledged_by  TEXT,
  acknowledged_at  TEXT,
  data_source      TEXT NOT NULL DEFAULT 'MOCK',
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_alerts_service_ts ON alerts (service, timestamp DESC);
CREATE INDEX idx_alerts_anomaly_type ON alerts (anomaly_type);
CREATE INDEX idx_alerts_severity ON alerts (severity);
CREATE INDEX idx_alerts_status ON alerts (status);

-- evidence[] and recommendedActions[] are 1:N children (ordered).
CREATE TABLE alert_evidence (
  id        TEXT PRIMARY KEY,
  alert_id  TEXT NOT NULL REFERENCES alerts(alert_id) ON DELETE CASCADE,
  ordinal   INTEGER NOT NULL,
  line      TEXT NOT NULL                     -- cited log line
);
CREATE INDEX idx_alert_evidence_alert ON alert_evidence (alert_id);

CREATE TABLE alert_recommended_actions (
  id        TEXT PRIMARY KEY,
  alert_id  TEXT NOT NULL REFERENCES alerts(alert_id) ON DELETE CASCADE,
  ordinal   INTEGER NOT NULL,
  action    TEXT NOT NULL                     -- advisory only; NO auto-remediation
);
CREATE INDEX idx_alert_actions_alert ON alert_recommended_actions (alert_id);

-- ---- Logs (Epic 6) ----------------------------------------------------------
CREATE TABLE log_references (
  id          TEXT PRIMARY KEY,
  timestamp   TEXT NOT NULL,
  level       TEXT NOT NULL,                  -- DEBUG|INFO|WARN|ERROR|FATAL
  service     TEXT NOT NULL,
  environment TEXT NOT NULL,
  message     TEXT NOT NULL,
  alert_id    TEXT REFERENCES alerts(alert_id) ON DELETE SET NULL, -- related-logs link
  data_source TEXT NOT NULL DEFAULT 'MOCK'
);
CREATE INDEX idx_logs_ts ON log_references (timestamp DESC);
CREATE INDEX idx_logs_service ON log_references (service);
CREATE INDEX idx_logs_level ON log_references (level);

-- ---- Metrics (Epic 7) -------------------------------------------------------
CREATE TABLE metric_snapshots (
  id                TEXT PRIMARY KEY,
  service           TEXT NOT NULL,
  environment       TEXT NOT NULL,
  timestamp         TEXT NOT NULL,
  cpu_percent       REAL NOT NULL DEFAULT 0,
  memory_percent    REAL NOT NULL DEFAULT 0,
  error_rate        REAL NOT NULL DEFAULT 0,
  request_count     INTEGER NOT NULL DEFAULT 0,
  latency_ms_p95    REAL NOT NULL DEFAULT 0,
  http_5xx_count    INTEGER NOT NULL DEFAULT 0,
  instance_restarts INTEGER NOT NULL DEFAULT 0,
  alert_id          TEXT REFERENCES alerts(alert_id) ON DELETE SET NULL,
  data_source       TEXT NOT NULL DEFAULT 'MOCK'
);
CREATE INDEX idx_metrics_service_ts ON metric_snapshots (service, timestamp DESC);

-- ---- AI Analyses (Epic 8) ---------------------------------------------------
-- Records each analysis run (provider-agnostic: Mock now, Bedrock later).
CREATE TABLE ai_analyses (
  id           TEXT PRIMARY KEY,
  alert_id     TEXT REFERENCES alerts(alert_id) ON DELETE SET NULL,
  timestamp    TEXT NOT NULL,
  service      TEXT NOT NULL,
  environment  TEXT NOT NULL,
  model_id     TEXT NOT NULL,
  provider     TEXT NOT NULL,                 -- e.g. MockAIProvider | BedrockAIProvider
  anomaly_type TEXT,
  confidence   REAL,
  finding_json TEXT NOT NULL,                 -- full UrbaniIncidentAlert JSON
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  data_source  TEXT NOT NULL DEFAULT 'MOCK',
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_ai_analyses_ts ON ai_analyses (timestamp DESC);

-- ---- Usage / Cost (Epic 10) -------------------------------------------------
CREATE TABLE usage_records (
  id                TEXT PRIMARY KEY,
  date              TEXT NOT NULL,            -- YYYY-MM-DD
  model_id          TEXT NOT NULL,
  ai_request_count  INTEGER NOT NULL DEFAULT 0,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  data_source       TEXT NOT NULL DEFAULT 'MOCK',
  UNIQUE (date, model_id)
);
CREATE INDEX idx_usage_date ON usage_records (date DESC);

-- ---- Audit / Activity (Epic 11) --------------------------------------------
CREATE TABLE audit_events (
  id         TEXT PRIMARY KEY,
  timestamp  TEXT NOT NULL,
  actor      TEXT NOT NULL,                   -- user email or "system"
  action     TEXT NOT NULL,                   -- LOGIN|LOGOUT|ALERT_VIEWED|...
  target     TEXT,
  metadata   TEXT,                            -- JSON blob (no secrets/PII)
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_ts ON audit_events (timestamp DESC);
CREATE INDEX idx_audit_action ON audit_events (action);

-- ---- Integrations (Epic 12 / Phase 2 boundary) -----------------------------
-- Tracks the configured state of each external integration. Secrets are NEVER
-- stored here — only non-sensitive config and connection status.
CREATE TABLE integrations (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,                  -- CLOUDWATCH|BEDROCK|DYNAMODB|URBANI_APP
  display_name TEXT NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'MOCK',   -- MOCK|AWS
  status      TEXT NOT NULL DEFAULT 'WAITING_FOR_INTEGRATION',
  config_json TEXT NOT NULL DEFAULT '{}',     -- non-sensitive placeholders only
  updated_at  TEXT NOT NULL
);
