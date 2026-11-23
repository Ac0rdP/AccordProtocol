-- Daily treasury KPI snapshots, one row per (network, contract, token, day).
--
-- Snapshots are derived from the indexed `transfers` and `events` tables and
-- rewritten with INSERT .. ON CONFLICT DO UPDATE, so recomputing a day (after a
-- replay or a late-indexed event) is idempotent and always converges on the
-- same row. `balance` is the cumulative net flow (deposits - transfers) up to
-- and including the day; `net_burn_rate` is the trailing 30-day average of
-- (spend - inflow) per day; `runway_days` is NULL unless the treasury is both
-- burning and holding a positive balance.

CREATE TABLE IF NOT EXISTS treasury_kpi_snapshots (
    network TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    token TEXT NOT NULL,
    snapshot_date DATE NOT NULL,
    balance NUMERIC NOT NULL DEFAULT 0,
    inflow NUMERIC NOT NULL DEFAULT 0 CHECK (inflow >= 0),
    spend NUMERIC NOT NULL DEFAULT 0 CHECK (spend >= 0),
    spend_count BIGINT NOT NULL DEFAULT 0 CHECK (spend_count >= 0),
    net_burn_rate NUMERIC NOT NULL DEFAULT 0,
    runway_days NUMERIC CHECK (runway_days IS NULL OR runway_days >= 0),
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (network, contract_id, token, snapshot_date)
);

CREATE INDEX IF NOT EXISTS treasury_kpi_snapshots_date_idx
    ON treasury_kpi_snapshots (snapshot_date DESC, network, contract_id);
