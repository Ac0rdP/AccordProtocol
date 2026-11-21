-- Workflow automation subscriptions for Zapier and generic webhooks.
-- Scoped per workspace (network, contract_id) so teams can automate proposal,
-- approval, and treasury notifications without leaking secrets.

CREATE TABLE IF NOT EXISTS workflow_webhooks (
    id BIGSERIAL PRIMARY KEY,
    network TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    target_type TEXT NOT NULL CHECK (target_type IN ('zapier', 'generic')),
    url TEXT NOT NULL,
    events JSONB NOT NULL,
    signing_secret TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workflow_webhooks_scope_idx
    ON workflow_webhooks (network, contract_id, created_at DESC);

CREATE TABLE IF NOT EXISTS workflow_deliveries (
    id BIGSERIAL PRIMARY KEY,
    webhook_id BIGINT NOT NULL REFERENCES workflow_webhooks(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
