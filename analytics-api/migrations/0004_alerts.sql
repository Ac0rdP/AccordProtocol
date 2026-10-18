-- Alerts raised by the analytics alerting engine, plus the per-source cursors
-- that remember how far the watcher has read. `dedupe_key` identifies a rule,
-- subject and triggering event, so re-evaluating an event can never store (or
-- notify) the same alert twice.

CREATE TABLE IF NOT EXISTS alerts (
    id BIGSERIAL PRIMARY KEY,
    dedupe_key TEXT NOT NULL UNIQUE,
    rule_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    network TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    fired_at TIMESTAMPTZ NOT NULL,
    delivered_channels JSONB NOT NULL DEFAULT '[]'::jsonb,
    failed_channels JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS alerts_scope_fired_at_idx
    ON alerts (network, contract_id, fired_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS alerts_rule_idx ON alerts (rule_id, fired_at DESC);

CREATE TABLE IF NOT EXISTS alert_cursors (
    source TEXT NOT NULL,
    network TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    last_ledger BIGINT NOT NULL DEFAULT 0 CHECK (last_ledger >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (source, network, contract_id)
);
