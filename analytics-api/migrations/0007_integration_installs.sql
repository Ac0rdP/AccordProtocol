-- Per-workspace installed reviewed integrations for notifications,
-- accounting, and treasury automation. Stores non-secret configuration only;
-- signing keys and private credentials are never persisted here.

CREATE TABLE IF NOT EXISTS integration_installs (
    id BIGSERIAL PRIMARY KEY,
    network TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    installed_by TEXT,
    installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (network, contract_id, plugin_id)
);

CREATE INDEX IF NOT EXISTS idx_integration_installs_workspace
    ON integration_installs (network, contract_id);
