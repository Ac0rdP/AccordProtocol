-- Persisted state of the chain-tip lag / finality-depth monitor. One row per
-- monitor. It lets checkpoint age and alert levels survive a restart, so a
-- restarted indexer neither resets its age to zero nor re-fires an alert that
-- is already active.

CREATE TABLE IF NOT EXISTS lag_monitor_state (
    monitor TEXT PRIMARY KEY,
    latest_ledger INTEGER,
    indexed_ledger INTEGER,
    checkpoint_advanced_at TIMESTAMPTZ,
    levels TEXT NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL
);
