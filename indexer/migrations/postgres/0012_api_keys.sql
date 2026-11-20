-- Scoped API keys for analytics consumers, with per-key request quotas.
--
-- Only a SHA-256 hash of each secret is stored. Rotation keeps the previous
-- secret valid until `previous_expires_at` so consumers can switch without
-- downtime. `api_key_usage` holds one counter per key per fixed quota window
-- (`window_start` is the window's start in epoch seconds).

CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    previous_secret_hash TEXT,
    previous_expires_at TIMESTAMPTZ,
    scopes TEXT NOT NULL,
    quota_limit INTEGER NOT NULL CHECK (quota_limit >= 1),
    quota_window_seconds INTEGER NOT NULL CHECK (quota_window_seconds >= 1),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ,
    rotated_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS api_keys_status_idx ON api_keys (status, created_at);

CREATE TABLE IF NOT EXISTS api_key_usage (
    key_id TEXT NOT NULL,
    window_start BIGINT NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (key_id, window_start)
);
CREATE INDEX IF NOT EXISTS api_key_usage_window_idx ON api_key_usage (window_start);
