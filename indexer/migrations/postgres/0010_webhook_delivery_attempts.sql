-- Per-attempt history for webhook deliveries, plus replay bookkeeping, so the
-- operations dashboard can show every attempt and when an operator replayed one.

ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS replay_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS last_replayed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS webhook_delivery_attempts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    delivery_id BIGINT NOT NULL REFERENCES webhook_deliveries (id) ON DELETE CASCADE,
    -- Attempt number within the current replay round (resets when a delivery is replayed).
    attempt INTEGER NOT NULL,
    replay_round INTEGER NOT NULL DEFAULT 0,
    outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'retry', 'dead')),
    status_code INTEGER,
    error TEXT,
    duration_ms INTEGER,
    attempted_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_delivery_attempts_delivery_idx
    ON webhook_delivery_attempts (delivery_id, id);
