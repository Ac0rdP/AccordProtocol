-- Quarantine for contract events that failed schema validation: unknown topics,
-- unknown schema versions, malformed payloads and undecodable events. The raw
-- event (topic and value as base64 XDR) is kept so it can be re-validated later.
-- `dedupe_key` is the chain-position key, so replaying a range quarantines each
-- event once.

CREATE TABLE IF NOT EXISTS quarantined_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dedupe_key TEXT NOT NULL UNIQUE,
    event_id TEXT NOT NULL,
    contract_id TEXT,
    topic TEXT,
    schema_version BIGINT,
    reason TEXT NOT NULL CHECK (reason IN ('unknown_topic', 'unknown_version', 'invalid_payload', 'undecodable')),
    errors TEXT NOT NULL,
    raw TEXT NOT NULL,
    ledger INTEGER NOT NULL,
    transaction_hash TEXT,
    occurred_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'quarantined' CHECK (status IN ('quarantined', 'released', 'discarded')),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS quarantined_events_status_idx ON quarantined_events (status, id);
CREATE INDEX IF NOT EXISTS quarantined_events_ledger_idx ON quarantined_events (ledger);
