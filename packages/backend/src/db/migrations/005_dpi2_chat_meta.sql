-- Migration 005 — DPI 2 items 8/9: per-message metadata (grounding note, logs source, providerMs, error flag). Forward-only.
ALTER TABLE chat_messages ADD COLUMN meta_json TEXT;
CREATE INDEX idx_chat_messages_created ON chat_messages (created_at);
CREATE INDEX idx_chat_feedback_updated ON chat_feedback (updated_at);
