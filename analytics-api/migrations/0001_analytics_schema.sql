CREATE TABLE IF NOT EXISTS proposals (
    contract_id TEXT NOT NULL,
    proposal_id BIGINT NOT NULL CHECK (proposal_id >= 0),
    kind TEXT NOT NULL DEFAULT 'transfer',
    recipient TEXT NOT NULL DEFAULT '',
    amount TEXT NOT NULL DEFAULT '0',
    token TEXT NOT NULL DEFAULT 'XLM',
    description TEXT NOT NULL DEFAULT '',
    approvals INTEGER NOT NULL DEFAULT 0 CHECK (approvals >= 0),
    threshold INTEGER NOT NULL DEFAULT 0 CHECK (threshold >= 0),
    quorum_weight INTEGER,
    approval_weight INTEGER,
    total_weight INTEGER,
    approver_addresses JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'executed', 'expired', 'revoked')),
    deadline TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    proposer TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Other' CHECK (category IN ('Transfer', 'Payroll', 'Grant', 'Ops', 'Other')),
    executed_at TIMESTAMPTZ,
    PRIMARY KEY (contract_id, proposal_id)
);

CREATE INDEX IF NOT EXISTS proposals_created_at_idx ON proposals (created_at DESC);
CREATE INDEX IF NOT EXISTS proposals_status_category_idx ON proposals (status, category);
CREATE INDEX IF NOT EXISTS proposals_proposer_idx ON proposals (proposer);

CREATE TABLE IF NOT EXISTS events (
    contract_id TEXT NOT NULL,
    ledger BIGINT NOT NULL CHECK (ledger >= 0),
    tx_hash TEXT NOT NULL,
    event_index INTEGER NOT NULL CHECK (event_index >= 0),
    proposal_id BIGINT,
    topic TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT '',
    occurred_at TIMESTAMPTZ NOT NULL,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (contract_id, ledger, tx_hash, event_index)
);

CREATE INDEX IF NOT EXISTS events_proposal_timeline_idx
    ON events (contract_id, proposal_id, ledger, event_index);