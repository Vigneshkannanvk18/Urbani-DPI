-- Migration 003: DPI 2 item 5 (MFA TOTP + SSO). Forward-only.
-- auth_source: 'local' (password) or 'sso' (OIDC, no usable local password).
-- mfa_secret_encrypted: AES-256-GCM envelope of the TOTP secret (never plaintext).
-- mfa_recovery_hashes: JSON array of SHA-256 hashes of the unused one-time recovery codes.
-- mfa_last_step: last accepted TOTP time-step (replay protection).
ALTER TABLE users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local' CHECK (auth_source IN ('local','sso'));
ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN mfa_secret_encrypted TEXT;
ALTER TABLE users ADD COLUMN mfa_enrolled_at TEXT;
ALTER TABLE users ADD COLUMN mfa_recovery_hashes TEXT NOT NULL DEFAULT '[]';
ALTER TABLE users ADD COLUMN mfa_last_step INTEGER;
ALTER TABLE users ADD COLUMN mfa_failed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN mfa_locked_until TEXT;
