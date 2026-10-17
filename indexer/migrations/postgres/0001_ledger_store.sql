-- Core indexer store: token ledger, protocol events, checkpoints, reconciliation.
-- Mirrors the SQLite schema in src/store/sqlite.js.

CREATE TABLE ledger_entries (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    token TEXT NOT NULL,
    token_address TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('inflow', 'outflow')),
    amount TEXT NOT NULL,
    balance TEXT NOT NULL,
    ledger INTEGER NOT NULL,
    transaction_hash TEXT,
    occurred_at TIMESTAMPTZ NOT NULL,
    from_address TEXT NOT NULL,
    to_address TEXT NOT NULL
);
CREATE INDEX ledger_entries_time_idx ON ledger_entries (occurred_at, id);
CREATE INDEX ledger_entries_token_time_idx ON ledger_entries (token, occurred_at, id);
CREATE INDEX ledger_entries_ledger_idx ON ledger_entries (ledger, id);

CREATE TABLE token_balances (
    token TEXT PRIMARY KEY,
    balance TEXT NOT NULL
);

CREATE TABLE accord_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    topic TEXT NOT NULL,
    payload JSONB NOT NULL,
    ledger INTEGER NOT NULL,
    transaction_hash TEXT,
    occurred_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX accord_events_time_idx ON accord_events (occurred_at, id);
CREATE INDEX accord_events_topic_time_idx ON accord_events (topic, occurred_at, id);
CREATE INDEX accord_events_ledger_idx ON accord_events (ledger, id);

CREATE TABLE indexer_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE reconciliation_results (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    token TEXT NOT NULL,
    token_address TEXT NOT NULL,
    checked_at TIMESTAMPTZ NOT NULL,
    implied_balance TEXT NOT NULL,
    actual_balance TEXT NOT NULL,
    drift TEXT NOT NULL
);
CREATE INDEX reconciliation_token_time_idx ON reconciliation_results (token, checked_at DESC);
