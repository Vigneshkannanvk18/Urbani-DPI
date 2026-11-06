-- Migration 006: DPI 2 item 9 (service health / uptime panel). Forward-only.
-- health_results: one probe result per (target, minute bucket); a later write in the same minute replaces it.
-- bucket = first 16 chars of the ISO timestamp (YYYY-MM-DDTHH:MM). error is redacted by the probe runner.
CREATE TABLE health_results (
  target_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('UP','DEGRADED','DOWN')),
  http_status INTEGER,
  latency_ms INTEGER,
  error TEXT,
  PRIMARY KEY (target_id, bucket)
);
CREATE INDEX idx_health_results_ts ON health_results (timestamp);
