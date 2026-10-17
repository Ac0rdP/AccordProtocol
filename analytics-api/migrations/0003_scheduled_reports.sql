-- History of generated treasury reports, one row per (period, format) attempt.
-- `attempts` records how many delivery attempts the run needed, so a schedule
-- can tell a report delivered on the second try from one that gave up.

CREATE TABLE IF NOT EXISTS report_runs (
    id BIGSERIAL PRIMARY KEY,
    network TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('csv', 'pdf')),
    trigger_source TEXT NOT NULL DEFAULT 'scheduled' CHECK (trigger_source IN ('scheduled', 'manual')),
    status TEXT NOT NULL CHECK (status IN ('generated', 'delivered', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
    byte_size BIGINT NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
    file_path TEXT,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS report_runs_scope_created_at_idx
    ON report_runs (network, contract_id, created_at DESC);
CREATE INDEX IF NOT EXISTS report_runs_period_idx
    ON report_runs (network, contract_id, period_start, period_end, format);
