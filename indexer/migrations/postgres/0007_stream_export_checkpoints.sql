-- Tracks durable export checkpoints for Kafka and NATS event stream exporters.

CREATE TABLE IF NOT EXISTS stream_exporter_checkpoints (
    exporter TEXT PRIMARY KEY,
    last_event_id TEXT,
    last_ledger INTEGER,
    events_published BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL
);
