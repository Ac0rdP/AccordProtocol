-- Workspace billing and usage plans scoped by (network, contract_id).
-- Tracks plan tier, quota limits for workspaces/API usage/reports/integrations,
-- and current period usage counters with self-serve upgrade support.

CREATE TABLE IF NOT EXISTS workspace_plans (
    id BIGSERIAL PRIMARY KEY,
    network TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    plan_tier TEXT NOT NULL DEFAULT 'free'
        CHECK (plan_tier IN ('free', 'pro', 'enterprise')),
    workspaces_limit INTEGER NOT NULL DEFAULT 1 CHECK (workspaces_limit >= 1),
    api_requests_used BIGINT NOT NULL DEFAULT 0 CHECK (api_requests_used >= 0),
    api_requests_limit BIGINT NOT NULL DEFAULT 10000 CHECK (api_requests_limit >= 0),
    reports_used INTEGER NOT NULL DEFAULT 0 CHECK (reports_used >= 0),
    reports_limit INTEGER NOT NULL DEFAULT 5 CHECK (reports_limit >= 0),
    integrations_used INTEGER NOT NULL DEFAULT 0 CHECK (integrations_used >= 0),
    integrations_limit INTEGER NOT NULL DEFAULT 2 CHECK (integrations_limit >= 0),
    billing_email TEXT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'past_due', 'canceled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (network, contract_id)
);
