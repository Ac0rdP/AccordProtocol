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

CREATE TABLE IF NOT EXISTS events (
    contract_id TEXT NOT NULL,
    ledger BIGINT NOT NULL CHECK (ledger >= 0),
    tx_hash TEXT NOT NULL,
    event_index INTEGER NOT NULL CHECK (event_index >= 0),
    proposal_id BIGINT,
    schedule_id BIGINT,
    topic TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT '',
    occurred_at TIMESTAMPTZ NOT NULL,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (contract_id, ledger, tx_hash, event_index)
);

CREATE TABLE IF NOT EXISTS proposal_approvals (
    contract_id TEXT NOT NULL,
    proposal_id BIGINT NOT NULL CHECK (proposal_id >= 0),
    owner TEXT NOT NULL,
    weight INTEGER NOT NULL CHECK (weight >= 0),
    approval_count INTEGER NOT NULL CHECK (approval_count >= 0),
    ledger BIGINT NOT NULL CHECK (ledger >= 0),
    tx_hash TEXT NOT NULL,
    event_index INTEGER NOT NULL CHECK (event_index >= 0),
    occurred_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (contract_id, proposal_id, owner, ledger, tx_hash, event_index)
);

CREATE TABLE IF NOT EXISTS proposal_executions (
    contract_id TEXT NOT NULL,
    proposal_id BIGINT NOT NULL CHECK (proposal_id >= 0),
    executor TEXT NOT NULL,
    ledger BIGINT NOT NULL CHECK (ledger >= 0),
    tx_hash TEXT NOT NULL,
    event_index INTEGER NOT NULL CHECK (event_index >= 0),
    occurred_at TIMESTAMPTZ NOT NULL,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (contract_id, proposal_id, ledger, tx_hash, event_index)
);

CREATE TABLE IF NOT EXISTS transfers (
    contract_id TEXT NOT NULL,
    proposal_id BIGINT,
    schedule_id BIGINT,
    recipient TEXT NOT NULL DEFAULT '',
    token TEXT NOT NULL DEFAULT 'XLM',
    amount TEXT NOT NULL DEFAULT '0',
    ledger BIGINT NOT NULL CHECK (ledger >= 0),
    tx_hash TEXT NOT NULL,
    event_index INTEGER NOT NULL CHECK (event_index >= 0),
    occurred_at TIMESTAMPTZ NOT NULL,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (contract_id, ledger, tx_hash, event_index)
);

CREATE TABLE IF NOT EXISTS owner_weight_changes (
    contract_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    old_weight INTEGER NOT NULL CHECK (old_weight >= 0),
    new_weight INTEGER NOT NULL CHECK (new_weight >= 0),
    new_total_weight INTEGER NOT NULL CHECK (new_total_weight >= 0),
    ledger BIGINT NOT NULL CHECK (ledger >= 0),
    tx_hash TEXT NOT NULL,
    event_index INTEGER NOT NULL CHECK (event_index >= 0),
    occurred_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (contract_id, owner, ledger, tx_hash, event_index)
);

CREATE TABLE IF NOT EXISTS recurring_disbursements (
    contract_id TEXT NOT NULL,
    schedule_id BIGINT NOT NULL CHECK (schedule_id >= 0),
    recipient TEXT NOT NULL DEFAULT '',
    token TEXT NOT NULL DEFAULT 'XLM',
    amount TEXT NOT NULL DEFAULT '0',
    total_disbursed TEXT NOT NULL DEFAULT '0',
    periods_disbursed INTEGER NOT NULL DEFAULT 0 CHECK (periods_disbursed >= 0),
    ledger BIGINT NOT NULL CHECK (ledger >= 0),
    tx_hash TEXT NOT NULL,
    event_index INTEGER NOT NULL CHECK (event_index >= 0),
    occurred_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (contract_id, schedule_id, ledger, tx_hash, event_index)
);

CREATE TABLE IF NOT EXISTS delegations (
    contract_id TEXT NOT NULL,
    delegator TEXT NOT NULL,
    delegate TEXT NOT NULL,
    weight INTEGER NOT NULL CHECK (weight >= 0),
    expiry TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT true,
    ledger BIGINT NOT NULL CHECK (ledger >= 0),
    tx_hash TEXT NOT NULL,
    event_index INTEGER NOT NULL CHECK (event_index >= 0),
    occurred_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (contract_id, delegator, ledger, tx_hash, event_index)
);

CREATE TABLE IF NOT EXISTS role_changes (
    contract_id TEXT NOT NULL,
    target TEXT NOT NULL,
    role_name TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('granted', 'revoked')),
    ledger BIGINT NOT NULL CHECK (ledger >= 0),
    tx_hash TEXT NOT NULL,
    event_index INTEGER NOT NULL CHECK (event_index >= 0),
    occurred_at TIMESTAMPTZ NOT NULL,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (contract_id, target, role_name, ledger, tx_hash, event_index)
);

CREATE TABLE IF NOT EXISTS checkpoints (
    contract_id TEXT PRIMARY KEY,
    last_ledger BIGINT NOT NULL DEFAULT 0 CHECK (last_ledger >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS proposals_created_at_idx ON proposals (created_at DESC);
CREATE INDEX IF NOT EXISTS proposals_status_category_idx ON proposals (status, category);
CREATE INDEX IF NOT EXISTS proposals_proposer_idx ON proposals (proposer);
CREATE INDEX IF NOT EXISTS events_contract_ledger_event_idx ON events (contract_id, ledger, event_index);
CREATE INDEX IF NOT EXISTS events_proposal_timeline_idx ON events (contract_id, proposal_id, ledger, event_index);
CREATE INDEX IF NOT EXISTS events_schedule_timeline_idx ON events (contract_id, schedule_id, ledger, event_index);
CREATE INDEX IF NOT EXISTS approvals_proposal_idx ON proposal_approvals (contract_id, proposal_id, ledger, event_index);
CREATE INDEX IF NOT EXISTS executions_proposal_idx ON proposal_executions (contract_id, proposal_id, ledger, event_index);
CREATE INDEX IF NOT EXISTS transfers_proposal_idx ON transfers (contract_id, proposal_id, ledger, event_index);
CREATE INDEX IF NOT EXISTS transfers_schedule_idx ON transfers (contract_id, schedule_id, ledger, event_index);
CREATE INDEX IF NOT EXISTS owner_weight_changes_owner_idx ON owner_weight_changes (contract_id, owner, ledger, event_index);
CREATE INDEX IF NOT EXISTS recurring_disbursements_schedule_idx ON recurring_disbursements (contract_id, schedule_id, ledger, event_index);
CREATE INDEX IF NOT EXISTS delegations_delegate_idx ON delegations (contract_id, delegate, ledger, event_index);
CREATE INDEX IF NOT EXISTS role_changes_target_idx ON role_changes (contract_id, target, ledger, event_index);