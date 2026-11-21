-- Per-workspace white-label branding and custom domain configuration.
-- A workspace is identified by (network, contract_id), keeping shared contract
-- infrastructure while allowing teams to customize logos, colors, and domains.

CREATE TABLE IF NOT EXISTS workspace_branding (
    id BIGSERIAL PRIMARY KEY,
    network TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    brand_name TEXT,
    logo_url TEXT,
    primary_color TEXT CHECK (primary_color IS NULL OR primary_color ~ '^#[0-9a-f]{6}$'),
    accent_color TEXT CHECK (accent_color IS NULL OR accent_color ~ '^#[0-9a-f]{6}$'),
    custom_domain TEXT,
    domain_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (domain_status IN ('pending', 'verified', 'failed')),
    verification_token TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (network, contract_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_branding_custom_domain_idx
    ON workspace_branding (LOWER(custom_domain))
    WHERE custom_domain IS NOT NULL;
