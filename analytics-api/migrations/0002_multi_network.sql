-- Tag every indexed record with the network it came from, so one deployment can
-- serve several contracts across several networks. Existing rows predate
-- multi-network indexing and all belong to the repository's default network.

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'testnet';
ALTER TABLE events ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'testnet';
ALTER TABLE proposal_approvals ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'testnet';
ALTER TABLE proposal_executions ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'testnet';
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'testnet';
ALTER TABLE owner_weight_changes ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'testnet';
ALTER TABLE recurring_disbursements ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'testnet';
ALTER TABLE delegations ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'testnet';
ALTER TABLE role_changes ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'testnet';
ALTER TABLE checkpoints ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'testnet';

-- A proposal id is only unique within one contract on one network, so every
-- primary key gains the network column.
ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_pkey;
ALTER TABLE proposals ADD PRIMARY KEY (network, contract_id, proposal_id);

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_pkey;
ALTER TABLE events ADD PRIMARY KEY (network, contract_id, ledger, tx_hash, event_index);

ALTER TABLE proposal_approvals DROP CONSTRAINT IF EXISTS proposal_approvals_pkey;
ALTER TABLE proposal_approvals
    ADD PRIMARY KEY (network, contract_id, proposal_id, owner, ledger, tx_hash, event_index);

ALTER TABLE proposal_executions DROP CONSTRAINT IF EXISTS proposal_executions_pkey;
ALTER TABLE proposal_executions
    ADD PRIMARY KEY (network, contract_id, proposal_id, ledger, tx_hash, event_index);

ALTER TABLE transfers DROP CONSTRAINT IF EXISTS transfers_pkey;
ALTER TABLE transfers ADD PRIMARY KEY (network, contract_id, ledger, tx_hash, event_index);

ALTER TABLE owner_weight_changes DROP CONSTRAINT IF EXISTS owner_weight_changes_pkey;
ALTER TABLE owner_weight_changes
    ADD PRIMARY KEY (network, contract_id, owner, ledger, tx_hash, event_index);

ALTER TABLE recurring_disbursements DROP CONSTRAINT IF EXISTS recurring_disbursements_pkey;
ALTER TABLE recurring_disbursements
    ADD PRIMARY KEY (network, contract_id, schedule_id, ledger, tx_hash, event_index);

ALTER TABLE delegations DROP CONSTRAINT IF EXISTS delegations_pkey;
ALTER TABLE delegations
    ADD PRIMARY KEY (network, contract_id, delegator, ledger, tx_hash, event_index);

ALTER TABLE role_changes DROP CONSTRAINT IF EXISTS role_changes_pkey;
ALTER TABLE role_changes
    ADD PRIMARY KEY (network, contract_id, target, role_name, ledger, tx_hash, event_index);

-- Checkpoints are tracked per contract and per network.
ALTER TABLE checkpoints DROP CONSTRAINT IF EXISTS checkpoints_pkey;
ALTER TABLE checkpoints ADD PRIMARY KEY (network, contract_id);

CREATE INDEX IF NOT EXISTS proposals_scope_created_at_idx
    ON proposals (network, contract_id, created_at DESC);
CREATE INDEX IF NOT EXISTS events_scope_ledger_idx
    ON events (network, contract_id, ledger, event_index);
CREATE INDEX IF NOT EXISTS transfers_scope_occurred_at_idx
    ON transfers (network, contract_id, occurred_at DESC);
