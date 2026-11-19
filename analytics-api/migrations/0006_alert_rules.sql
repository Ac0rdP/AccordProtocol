-- Alert rules managed through the API. Rules from ALERT_RULES stay in the
-- deployment configuration and are not stored here. `definition` holds the full
-- rule (the same JSON ALERT_RULES takes); `kind` and `severity` are copies kept
-- for filtering. A paused rule is `enabled = false`: kept, but not evaluated.

CREATE TABLE IF NOT EXISTS alert_rules (
    id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 64),
    kind TEXT NOT NULL CHECK (kind IN ('spend_threshold', 'approval_burst', 'off_hours_approval')),
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    definition JSONB NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
