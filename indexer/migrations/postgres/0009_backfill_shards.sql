-- Per-shard checkpoints for resumable parallel backfill. Each shard is an
-- independent ledger window with its own RPC cursor, so one failed shard can be
-- retried without redoing the others.

CREATE TABLE IF NOT EXISTS backfill_shards (
    job_id TEXT NOT NULL,
    shard_index INTEGER NOT NULL,
    start_ledger INTEGER NOT NULL,
    end_ledger INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
    cursor TEXT NOT NULL DEFAULT '',
    last_ledger INTEGER,
    pages INTEGER NOT NULL DEFAULT 0,
    events_indexed BIGINT NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (job_id, shard_index)
);

CREATE INDEX IF NOT EXISTS backfill_shards_status_idx ON backfill_shards (job_id, status);
