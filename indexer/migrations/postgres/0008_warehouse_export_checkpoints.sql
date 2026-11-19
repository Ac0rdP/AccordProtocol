-- Tracks checkpoint state and schema versions for BigQuery and Snowflake warehouse export jobs.

CREATE TABLE IF NOT EXISTS warehouse_export_checkpoints (
    warehouse TEXT NOT NULL,
    table_name TEXT NOT NULL,
    last_exported_id BIGINT NOT NULL DEFAULT 0,
    last_ledger INTEGER,
    rows_exported BIGINT NOT NULL DEFAULT 0,
    schema_version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (warehouse, table_name)
);
