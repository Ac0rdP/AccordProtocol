-- Per-destination config for the multi-channel notification worker (email,
-- webhook, Slack, Discord), plus its own durable delivery outbox. Kept
-- separate from `webhook_deliveries` so the two dispatchers never compete to
-- claim each other's rows.

CREATE TABLE notification_destinations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('webhook', 'slack', 'discord', 'email')),
    config JSONB NOT NULL,
    topics JSONB,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE notification_deliveries (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    destination_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL,
    last_error TEXT,
    last_status_code INTEGER,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    delivered_at TIMESTAMPTZ,
    UNIQUE (destination_id, event_id)
);
CREATE INDEX notification_deliveries_due_idx ON notification_deliveries (status, next_attempt_at, id);
