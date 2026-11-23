-- Usage metering and billing event hooks.
--
-- `event_id` is the idempotency key: recording the same usage twice (a webhook
-- redelivery, a replay from any checkpoint) inserts nothing. `status` tracks
-- the billing hook hand-off so a crash or a failing hook resumes where it
-- stopped: pending -> emitted, or dead after the configured attempts.

CREATE TABLE IF NOT EXISTS usage_events (
    id BIGSERIAL PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('api_call', 'report', 'webhook')),
    subject TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
    occurred_at TIMESTAMPTZ NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'emitted', 'dead')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL,
    last_error TEXT,
    emitted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_events_due_idx ON usage_events (status, next_attempt_at, id);
CREATE INDEX IF NOT EXISTS usage_events_kind_idx ON usage_events (kind, occurred_at);
