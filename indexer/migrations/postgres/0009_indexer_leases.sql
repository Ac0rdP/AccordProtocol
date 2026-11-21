-- Leader-election leases for multi-region indexer failover. One row per named
-- lease; the holder owns the row until `expires_at`. `fencing_token` increases on
-- every change of ownership so a deposed leader can be told apart from the current one.

CREATE TABLE IF NOT EXISTS indexer_leases (
    name TEXT PRIMARY KEY,
    holder_id TEXT NOT NULL,
    region TEXT NOT NULL DEFAULT '',
    fencing_token BIGINT NOT NULL DEFAULT 1,
    acquired_at TIMESTAMPTZ NOT NULL,
    renewed_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);
