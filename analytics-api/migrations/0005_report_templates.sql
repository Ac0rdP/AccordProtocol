-- Per-workspace branding for scheduled and manual treasury reports. A workspace
-- is one (network, contract) pair; it has at most one template, and a pair
-- without a row keeps rendering the unbranded default report.

CREATE TABLE IF NOT EXISTS report_templates (
    id BIGSERIAL PRIMARY KEY,
    network TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    brand_name TEXT,
    title TEXT,
    header_text TEXT,
    footer_text TEXT,
    logo_url TEXT,
    accent_color TEXT CHECK (accent_color IS NULL OR accent_color ~ '^#[0-9a-f]{6}$'),
    sections JSONB NOT NULL DEFAULT '["summary","token_totals","category_totals","transactions"]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (network, contract_id)
);
