-- Migration 004: DPI 2 item 6 (automatic alert notifications). Forward-only.
-- notification_rules: who is notified about what. services / anomaly_types / channels are JSON arrays (empty = all).
-- notification_settings: single row (id = 1): dedup window, per-channel hourly cap, engine watermark.
-- notification_claims: atomic dedup claims keyed by (dedup_key, channel).
-- notification_log: delivery log (no webhook URL is ever stored).
CREATE TABLE notification_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  min_severity TEXT NOT NULL CHECK (min_severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  services TEXT NOT NULL DEFAULT '[]',
  anomaly_types TEXT NOT NULL DEFAULT '[]',
  channels TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE notification_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  dedup_window_minutes INTEGER NOT NULL DEFAULT 30,
  max_per_hour_per_channel INTEGER NOT NULL DEFAULT 30,
  engine_enabled_at TEXT,
  default_rule_seeded INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT
);
INSERT INTO notification_settings (id) VALUES (1);

CREATE TABLE notification_claims (
  dedup_key TEXT NOT NULL,
  channel TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (dedup_key, channel)
);

CREATE TABLE notification_log (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  alert_id TEXT,
  rule_id TEXT,
  channel TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SENT','FAILED','DRY_RUN','SKIPPED_DEDUP','SKIPPED_RATE_LIMIT','SKIPPED_NOT_CONFIGURED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  provider_message_id TEXT,
  is_test INTEGER NOT NULL DEFAULT 0,
  summary TEXT
);
CREATE INDEX idx_notification_log_ts ON notification_log (timestamp DESC);
CREATE INDEX idx_notification_log_channel_ts ON notification_log (channel, timestamp);
CREATE INDEX idx_notification_log_alert ON notification_log (alert_id);
