#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, BytesN,
    Env, IntoVal, String, Symbol, Val, Vec,
};

// ─── Data Types ─────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum ProposalStatus {
    Pending,
    Ready,
    Executed,
    Expired,
    Revoked,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum ProposalKind {
    /// Transfer(to, amount, token)
    Transfer(Address, i128, Address),
    /// AddOwner(new_owner)
    AddOwner(Address),
    /// RemoveOwner(owner_to_remove)
    RemoveOwner(Address),
    /// ChangeThreshold(new_threshold)
    ChangeThreshold(u32),
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum ProposalCategory {
    Transfer,
    Payroll,
    Grant,
    Ops,
    Other,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub description: String,
    pub deadline: u64,
    pub approvals: u32,
    pub status: ProposalStatus,
    pub kind: ProposalKind,
    pub ready_at: u64,
    pub threshold: u32,
    pub category: ProposalCategory,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ProposalCreatedEvent {
    pub id: u64,
    pub proposer: Address,
    pub threshold: u32,
    pub category: ProposalCategory,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ProposalApprovedEvent {
    pub id: u64,
    pub approver: Address,
    pub approvals: u32,
    pub threshold: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ProposalRevokedEvent {
    pub id: u64,
    pub approver: Address,
    pub approvals: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ProposalExecutedEvent {
    pub id: u64,
    pub executor: Address,
}

// ─── Errors ──────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[contracterror]
#[repr(u32)]
pub enum ContractError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    InvalidThreshold = 4,
    InvalidOwners = 5,
    ProposalNotFound = 6,
    ProposalNotActive = 7,
    AlreadyApproved = 8,
    NotApproved = 9,
    ThresholdNotMet = 10,
    ProposalExpired = 11,
    InvalidAmount = 12,
    InvalidDeadline = 13,
    InvalidToken = 14,
    TransferFailed = 15,
    EmptyDescription = 16,
    DescriptionTooLong = 17,
    TooManyActiveProposals = 18,
    DuplicateOwner = 19,
    ArithmeticError = 20,
    InvalidDuration = 21,
    InvalidRecipient = 22,
    TimeLockActive = 23,
    WouldBreakThreshold = 24,
    OwnerNotFound = 25,
}

// ─── Storage Keys ────────────────────────────────────────────────────────────

fn init_key() -> Symbol {
    symbol_short!("INIT")
}

fn threshold_key() -> Symbol {
    symbol_short!("THRESH")
}

fn owners_key() -> Symbol {
    symbol_short!("OWNERS")
}

fn next_id_key() -> Symbol {
    symbol_short!("NEXT")
}

fn proposal_key(id: u64) -> (Symbol, u64) {
    (symbol_short!("PROP"), id)
}

fn approval_key(proposal_id: u64, owner: &Address) -> (Symbol, u64, Address) {
    (symbol_short!("APPR"), proposal_id, owner.clone())
}

fn active_count_key() -> Symbol {
    symbol_short!("ACTCNT")
}

fn timelock_key() -> Symbol {
    symbol_short!("TLOCK")
}

// ─── TTL Constants ───────────────────────────────────────────────────────────

// 518,400 ledgers ≈ 30 days at the current 5-second ledger close time.
// 30 days covers the full proposal lifecycle (create → approve → execute) even
// for slow-moving multisigs, while still expiring contracts that are genuinely
// abandoned on a human-perceivable timescale. Matches PERSISTENT_BUMP so the
// contract instance and all proposal data share the same expiry horizon.
const INSTANCE_BUMP: u32 = 518_400;

// When the instance entry's remaining TTL drops below this value (≈ 1 day),
// the next contract call triggers a bump back to INSTANCE_BUMP. Keeping the
// threshold at 1 day means rent is charged at most once per day rather than
// on every transaction, minimising unnecessary fee payments.
const INSTANCE_THRESHOLD: u32 = 17_280;

// Matches INSTANCE_BUMP so that each proposal and approval LedgerEntry expires
// on the same 30-day schedule as the contract instance. Without this alignment
// the instance could remain live while individual proposals silently expire and
// become unrecoverable from ledger state.
const PERSISTENT_BUMP: u32 = 518_400;

// Mirrors INSTANCE_THRESHOLD: bump a persistent entry only when its TTL falls
// below 1 day. For frequently accessed proposals this keeps per-call rent costs
// low while ensuring no entry expires mid-workflow.
const PERSISTENT_THRESHOLD: u32 = 17_280;

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
}

fn bump_persistent<K: IntoVal<Env, Val>>(env: &Env, key: &K) {
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_THRESHOLD, PERSISTENT_BUMP);
}

// ─── Validation Constants ────────────────────────────────────────────────────

/// Contract version, bumped on each release. Queried via `get_version`.
const CONTRACT_VERSION: u32 = 1;
/// Minimum amount: 0.1 stroops of whatever token is used.
const MIN_AMOUNT: i128 = 1;
/// Max description: 300 characters.
const MAX_DESCRIPTION_LEN: u32 = 300;
/// Maximum active (Pending + Ready) proposals at once to bound storage cost.
const MAX_ACTIVE_PROPOSALS: u32 = 50;
/// Maximum owners in a multisig wallet.
const MAX_OWNERS: u32 = 20;
/// Maximum proposal lifetime: 90 days.
const MAX_PROPOSAL_DURATION: u64 = 7_776_000;

// ─── Storage Helpers ─────────────────────────────────────────────────────────

fn is_initialized(env: &Env) -> bool {
    env.storage()
        .instance()
        .get::<_, bool>(&init_key())
        .unwrap_or(false)
}

fn read_threshold(env: &Env) -> Result<u32, ContractError> {
    env.storage()
        .instance()
        .get(&threshold_key())
        .ok_or(ContractError::NotInitialized)
}

fn read_owners(env: &Env) -> Result<Vec<Address>, ContractError> {
    let key = owners_key();
    let owners: Vec<Address> = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(ContractError::NotInitialized)?;
    bump_persistent(env, &key);
    Ok(owners)
}

fn read_next_id(env: &Env) -> u64 {
    let id = env.storage().instance().get(&next_id_key()).unwrap_or(1_u64);
    bump_instance(env);
    id
}

fn write_next_id(env: &Env, id: u64) {
    env.storage().instance().set(&next_id_key(), &id);
    bump_instance(env);
}

fn read_proposal(env: &Env, id: u64) -> Result<Proposal, ContractError> {
    let key = proposal_key(id);
    let proposal: Proposal = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(ContractError::ProposalNotFound)?;
    bump_persistent(env, &key);
    Ok(proposal)
}

fn write_proposal(env: &Env, proposal: &Proposal) {
    let key = proposal_key(proposal.id);
    env.storage().persistent().set(&key, proposal);
    bump_persistent(env, &key);
}

fn read_approval(env: &Env, proposal_id: u64, owner: &Address) -> bool {
    let key = approval_key(proposal_id, owner);
    let approved = env.storage().persistent().get(&key).unwrap_or(false);
    if env.storage().persistent().has(&key) {
        bump_persistent(env, &key);
    }
    approved
}

fn write_approval(env: &Env, proposal_id: u64, owner: &Address, approved: bool) {
    let key = approval_key(proposal_id, owner);
    env.storage().persistent().set(&key, &approved);
    bump_persistent(env, &key);
}

fn read_active_count(env: &Env) -> u32 {
    // Recompute active proposals (Pending + Ready) to ensure expired/ executed
    // proposals are not counted, guarding against any missed decrements.
    let next_id = env.storage().instance().get(&next_id_key()).unwrap_or(1_u64);
    let mut active: u32 = 0;
    for id in 1..next_id {
        if let Ok(proposal) = read_proposal(env, id) {
            // derive_status does not persist; we only count current derived active ones
            let status = derive_status(env, &proposal);
            if matches!(status, ProposalStatus::Pending | ProposalStatus::Ready) {
                active = active.saturating_add(1);
            }
        }
    }
    active
}

fn write_active_count(env: &Env, count: u32) {
    env.storage().instance().set(&active_count_key(), &count);
    bump_instance(env);
}

// ─── Business Logic Helpers ──────────────────────────────────────────────────

fn require_owner(env: &Env, address: &Address) -> Result<(), ContractError> {
    let owners = read_owners(env)?;
    for owner in owners.iter() {
        if owner == *address {
            return Ok(());
        }
    }
    Err(ContractError::Unauthorized)
}

fn derive_status(env: &Env, proposal: &Proposal) -> ProposalStatus {
    // Terminal statuses are never overridden.
    if matches!(
        proposal.status,
        ProposalStatus::Executed | ProposalStatus::Revoked
    ) {
        return proposal.status.clone();
    }
    let now = env.ledger().timestamp();
    if now > proposal.deadline {
        return ProposalStatus::Expired;
    }
    if proposal.approvals >= proposal.threshold {
        ProposalStatus::Ready
    } else {
        ProposalStatus::Pending
    }
}

fn validate_token(env: &Env, token_address: &Address) -> Result<(), ContractError> {
    let client = token::Client::new(env, token_address);
    // Require decimals, symbol, and name to all succeed to consider this a valid token.
    if client.try_decimals().is_err()
        || client.try_symbol().is_err()
        || client.try_name().is_err()
    {
        return Err(ContractError::InvalidToken);
    }
    Ok(())
}

// ─── Contract ────────────────────────────────────────────────────────────────

#[contract]
pub struct AccordContract;

#[contractimpl]
impl AccordContract {
    /// One-shot initializer. Sets the list of owners, the approval threshold,
    /// and an optional time-lock delay (in seconds). A delay of 0 means no
    /// time-lock is enforced.
    ///
    /// # Arguments
    /// * `owners` - Non-empty list of unique owner addresses (max 20).
    /// * `threshold` - Number of approvals required to execute a proposal (1 ≤ threshold ≤ owners.len()).
    /// * `time_lock_delay` - Seconds to wait after a proposal reaches threshold before it is executable.
    pub fn initialize(
        env: Env,
        owners: Vec<Address>,
        threshold: u32,
        time_lock_delay: u64,
    ) -> Result<(), ContractError> {
        if is_initialized(&env) {
            return Err(ContractError::AlreadyInitialized);
        }

        let n = owners.len();
        if n == 0 || n > MAX_OWNERS {
            return Err(ContractError::InvalidOwners);
        }
        if threshold == 0 || threshold > n {
            return Err(ContractError::InvalidThreshold);
        }

        // Reject duplicate addresses before requiring auth (duplicate require_auth aborts host).
        for i in 0..owners.len() {
            for j in (i + 1)..owners.len() {
                if owners.get(i).unwrap() == owners.get(j).unwrap() {
                    return Err(ContractError::DuplicateOwner);
                }
            }
        }

        // Require auth from all owners — they must all consent to being part of this multisig.
        for owner in owners.iter() {
            owner.require_auth();
        }

        let key = owners_key();
        env.storage().persistent().set(&key, &owners);
        bump_persistent(&env, &key);

        env.storage().instance().set(&threshold_key(), &threshold);
        env.storage().instance().set(&timelock_key(), &time_lock_delay);
        env.storage().instance().set(&init_key(), &true);
        bump_instance(&env);

        Ok(())
    }

    /// Creates a new transfer proposal.
    ///
    /// # Arguments
    /// * `proposer` - Owner proposing the transfer. Must authorize.
    /// * `to` - Recipient address. Must not be the contract's own address.
    /// * `amount` - Amount in the token's smallest unit. Must be > 0.
    /// * `token` - Token contract address implementing the Soroban token interface.
    /// * `description` - Human-readable description (max 300 chars).
    /// * `deadline` - Unix timestamp after which the proposal expires.
    pub fn create_proposal(
        env: Env,
        proposer: Address,
        to: Address,
        amount: i128,
        token: Address,
        description: String,
        deadline: u64,
        category: ProposalCategory,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_owner(&env, &proposer)?;

        if amount < MIN_AMOUNT {
            return Err(ContractError::InvalidAmount);
        }
        if description.is_empty() {
            return Err(ContractError::EmptyDescription);
        }
        if description.len() > MAX_DESCRIPTION_LEN {
            return Err(ContractError::DescriptionTooLong);
        }

        let now = env.ledger().timestamp();
        if deadline <= now {
            return Err(ContractError::InvalidDeadline);
        }
        if deadline - now > MAX_PROPOSAL_DURATION {
            return Err(ContractError::InvalidDuration);
        }

        validate_token(&env, &token)?;

        if to == env.current_contract_address() {
            return Err(ContractError::InvalidRecipient);
        }

        let active = read_active_count(&env);
        if active >= MAX_ACTIVE_PROPOSALS {
            return Err(ContractError::TooManyActiveProposals);
        }

        let threshold = read_threshold(&env)?;
        let id = read_next_id(&env);
        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

        let proposal = Proposal {
            id,
            proposer: proposer.clone(),
            description,
            deadline,
            approvals: 0,
            status: ProposalStatus::Pending,
            kind: ProposalKind::Transfer(to, amount, token),
            ready_at: 0,
            threshold,
            category: category.clone(),
        };
        write_proposal(&env, &proposal);
        write_active_count(&env, active + 1);

        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                id,
                proposer,
                threshold,
                category,
            },
        );

        Ok(id)
    }

    /// Creates a proposal to add a new owner to the multisig.
    pub fn create_add_owner_proposal(
        env: Env,
        proposer: Address,
        new_owner: Address,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_owner(&env, &proposer)?;

        let owners = read_owners(&env)?;
        for owner in owners.iter() {
            if owner == new_owner {
                return Err(ContractError::DuplicateOwner);
            }
        }

        if owners.len() >= MAX_OWNERS {
            return Err(ContractError::InvalidOwners);
        }

        if description.is_empty() {
            return Err(ContractError::EmptyDescription);
        }
        if description.len() > MAX_DESCRIPTION_LEN {
            return Err(ContractError::DescriptionTooLong);
        }

        let now = env.ledger().timestamp();
        if deadline <= now {
            return Err(ContractError::InvalidDeadline);
        }
        if deadline - now > MAX_PROPOSAL_DURATION {
            return Err(ContractError::InvalidDuration);
        }

        let active = read_active_count(&env);
        if active >= MAX_ACTIVE_PROPOSALS {
            return Err(ContractError::TooManyActiveProposals);
        }

        let threshold = read_threshold(&env)?;
        let id = read_next_id(&env);
        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

        let proposal = Proposal {
            id,
            proposer: proposer.clone(),
            description,
            deadline,
            approvals: 0,
            status: ProposalStatus::Pending,
            kind: ProposalKind::AddOwner(new_owner),
            ready_at: 0,
            threshold,
            category: ProposalCategory::Other,
        };
        write_proposal(&env, &proposal);
        write_active_count(&env, active + 1);

        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                id,
                proposer,
                threshold,
                category: ProposalCategory::Other,
            },
        );

        Ok(id)
    }

    /// Creates a proposal to remove an existing owner from the multisig.
    ///
    /// # Arguments
    /// * `proposer` - Owner proposing the removal. Must authorize.
    /// * `owner_to_remove` - Address of the owner to remove. Must be a current owner,
    ///   and removal must not leave fewer owners than the current threshold.
    pub fn create_remove_owner_proposal(
        env: Env,
        proposer: Address,
        owner_to_remove: Address,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_owner(&env, &proposer)?;

        let owners = read_owners(&env)?;
        let threshold = read_threshold(&env)?;

        let mut found = false;
        for owner in owners.iter() {
            if owner == owner_to_remove {
                found = true;
                break;
            }
        }
        if !found {
            return Err(ContractError::OwnerNotFound);
        }

        if owners.len() <= threshold {
            return Err(ContractError::WouldBreakThreshold);
        }

        if description.is_empty() {
            return Err(ContractError::EmptyDescription);
        }
        if description.len() > MAX_DESCRIPTION_LEN {
            return Err(ContractError::DescriptionTooLong);
        }

        let now = env.ledger().timestamp();
        if deadline <= now {
            return Err(ContractError::InvalidDeadline);
        }
        if deadline - now > MAX_PROPOSAL_DURATION {
            return Err(ContractError::InvalidDuration);
        }

        let active = read_active_count(&env);
        if active >= MAX_ACTIVE_PROPOSALS {
            return Err(ContractError::TooManyActiveProposals);
        }

        let id = read_next_id(&env);
        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

        let proposal = Proposal {
            id,
            proposer: proposer.clone(),
            description,
            deadline,
            approvals: 0,
            status: ProposalStatus::Pending,
            kind: ProposalKind::RemoveOwner(owner_to_remove),
            ready_at: 0,
            threshold,
            category: ProposalCategory::Other,
        };
        write_proposal(&env, &proposal);
        write_active_count(&env, active + 1);

        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                id,
                proposer,
                threshold,
                category: ProposalCategory::Other,
            },
        );

        Ok(id)
    }

    /// Creates a proposal to change the M-of-N approval threshold.
    ///
    /// # Arguments
    /// * `proposer` - Owner proposing the change. Must authorize.
    /// * `new_threshold` - The proposed new threshold. Must be ≥ 1 and ≤ current owner count.
    pub fn create_change_threshold_proposal(
        env: Env,
        proposer: Address,
        new_threshold: u32,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_owner(&env, &proposer)?;

        let owners = read_owners(&env)?;

        if new_threshold == 0 || new_threshold > owners.len() {
            return Err(ContractError::InvalidThreshold);
        }

        if description.is_empty() {
            return Err(ContractError::EmptyDescription);
        }
        if description.len() > MAX_DESCRIPTION_LEN {
            return Err(ContractError::DescriptionTooLong);
        }

        let now = env.ledger().timestamp();
        if deadline <= now {
            return Err(ContractError::InvalidDeadline);
        }
        if deadline - now > MAX_PROPOSAL_DURATION {
            return Err(ContractError::InvalidDuration);
        }

        let active = read_active_count(&env);
        if active >= MAX_ACTIVE_PROPOSALS {
            return Err(ContractError::TooManyActiveProposals);
        }

        let threshold = read_threshold(&env)?;
        let id = read_next_id(&env);
        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

        let proposal = Proposal {
            id,
            proposer: proposer.clone(),
            description,
            deadline,
            approvals: 0,
            status: ProposalStatus::Pending,
            kind: ProposalKind::ChangeThreshold(new_threshold),
            ready_at: 0,
            threshold,
            category: ProposalCategory::Other,
        };
        write_proposal(&env, &proposal);
        write_active_count(&env, active + 1);

        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                id,
                proposer,
                threshold,
                category: ProposalCategory::Other,
            },
        );

        Ok(id)
    }

    /// Approves a proposal. The approver must be an owner and must not have already approved.
    ///
    /// Automatically transitions the proposal to `Ready` when the approval count reaches threshold.
    /// Records `ready_at` the first time the threshold is crossed.
    pub fn approve(
        env: Env,
        approver: Address,
        proposal_id: u64,
    ) -> Result<(), ContractError> {
        approver.require_auth();
        require_owner(&env, &approver)?;

        let mut proposal = read_proposal(&env, proposal_id)?;

        // Refresh derived status so an already-expired proposal is caught here.
        proposal.status = derive_status(&env, &proposal);

        if !matches!(
            proposal.status,
            ProposalStatus::Pending | ProposalStatus::Ready
        ) {
            return Err(ContractError::ProposalNotActive);
        }

        if read_approval(&env, proposal_id, &approver) {
            return Err(ContractError::AlreadyApproved);
        }

        write_approval(&env, proposal_id, &approver, true);

        proposal.approvals = proposal
            .approvals
            .checked_add(1)
            .ok_or(ContractError::ArithmeticError)?;

        // Record the timestamp when the proposal first crosses the threshold.
        if proposal.ready_at == 0 && proposal.approvals >= proposal.threshold {
            proposal.ready_at = env.ledger().timestamp();
        }

        proposal.status = derive_status(&env, &proposal);
        write_proposal(&env, &proposal);

        env.events().publish(
            (symbol_short!("approved"),),
            ProposalApprovedEvent {
                id: proposal_id,
                approver,
                approvals: proposal.approvals,
                threshold: proposal.threshold,
            },
        );

        Ok(())
    }

    /// Revokes the caller's approval from a proposal that has not yet been executed.
    ///
    /// The proposal status is recalculated after the revoke: if approvals fall below
    /// threshold the status transitions back to `Pending`.
    pub fn revoke(
        env: Env,
        approver: Address,
        proposal_id: u64,
    ) -> Result<(), ContractError> {
        approver.require_auth();
        require_owner(&env, &approver)?;

        let mut proposal = read_proposal(&env, proposal_id)?;

        proposal.status = derive_status(&env, &proposal);

        if !matches!(
            proposal.status,
            ProposalStatus::Pending | ProposalStatus::Ready
        ) {
            return Err(ContractError::ProposalNotActive);
        }

        if !read_approval(&env, proposal_id, &approver) {
            return Err(ContractError::NotApproved);
        }

        write_approval(&env, proposal_id, &approver, false);

        proposal.approvals = proposal
            .approvals
            .checked_sub(1)
            .ok_or(ContractError::ArithmeticError)?;
        proposal.status = derive_status(&env, &proposal);
        write_proposal(&env, &proposal);

        env.events().publish(
            (symbol_short!("revoked"),),
            ProposalRevokedEvent {
                id: proposal_id,
                approver,
                approvals: proposal.approvals,
            },
        );

        Ok(())
    }

    /// Executes a `Ready` proposal. For transfer proposals, tokens are sent to the recipient.
    /// For governance proposals (AddOwner, RemoveOwner, ChangeThreshold), the corresponding
    /// state change is applied. Only owners may execute.
    ///
    /// Enforces the time-lock delay: execution is blocked until `ready_at + time_lock_delay`
    /// has elapsed.
    pub fn execute(
        env: Env,
        executor: Address,
        proposal_id: u64,
    ) -> Result<(), ContractError> {
        executor.require_auth();
        require_owner(&env, &executor)?;

        let mut proposal = read_proposal(&env, proposal_id)?;

        proposal.status = derive_status(&env, &proposal);

        if matches!(proposal.status, ProposalStatus::Expired) {
            // Persist the expired status and free up the active slot.
            write_proposal(&env, &proposal);
            let active = read_active_count(&env);
            if active > 0 {
                write_active_count(&env, active - 1);
            }
            return Err(ContractError::ProposalExpired);
        }

        if !matches!(proposal.status, ProposalStatus::Ready) {
            if proposal.approvals < proposal.threshold {
                return Err(ContractError::ThresholdNotMet);
            }
            return Err(ContractError::ProposalNotActive);
        }

        // Time-lock enforcement.
        let time_lock_delay: u64 = env
            .storage()
            .instance()
            .get(&timelock_key())
            .unwrap_or(0);
        if time_lock_delay > 0 {
            let now = env.ledger().timestamp();
            if now < proposal.ready_at.saturating_add(time_lock_delay) {
                return Err(ContractError::TimeLockActive);
            }
        }

        // Dispatch on proposal kind.
        match &proposal.kind {
            ProposalKind::Transfer(to, amount, token) => {
                if token::Client::new(&env, token)
                    .try_transfer(&env.current_contract_address(), to, amount)
                    .is_err()
                {
                    return Err(ContractError::TransferFailed);
                }
            }
            ProposalKind::AddOwner(new_owner) => {
                let mut owners = read_owners(&env)?;
                owners.push_back(new_owner.clone());
                let key = owners_key();
                env.storage().persistent().set(&key, &owners);
                bump_persistent(&env, &key);
            }
            ProposalKind::RemoveOwner(owner_to_remove) => {
                let owners = read_owners(&env)?;
                let mut new_owners = Vec::new(&env);
                for owner in owners.iter() {
                    if owner != *owner_to_remove {
                        new_owners.push_back(owner);
                    }
                }
                let key = owners_key();
                env.storage().persistent().set(&key, &new_owners);
                bump_persistent(&env, &key);
            }
            ProposalKind::ChangeThreshold(new_threshold) => {
                env.storage().instance().set(&threshold_key(), new_threshold);
                bump_instance(&env);
            }
        }

        proposal.status = ProposalStatus::Executed;
        write_proposal(&env, &proposal);

        let active = read_active_count(&env);
        if active > 0 {
            write_active_count(&env, active - 1);
        }

        env.events().publish(
            (symbol_short!("executed"),),
            ProposalExecutedEvent {
                id: proposal_id,
                executor,
            },
        );

        Ok(())
    }

    /// Bulk-sweeps a batch of proposals by counting which IDs currently derive
    /// to `Expired` and refreshing the active-proposal counter if needed.
    /// Expired status is derived at read time, so no per-proposal write-back is
    /// required here. Non-existent IDs and non-expired proposals are skipped.
    /// Only owners may call this function.
    ///
    /// Returns the number of proposals actually swept.
    pub fn cancel_expired(
        env: Env,
        caller: Address,
        ids: Vec<u64>,
    ) -> Result<u32, ContractError> {
        caller.require_auth();
        require_owner(&env, &caller)?;

        let mut swept: u32 = 0;

        for id in ids.iter() {
            let proposal = match read_proposal(&env, id) {
                Ok(p) => p,
                Err(_) => continue,
            };

            if matches!(derive_status(&env, &proposal), ProposalStatus::Expired) {
                swept = swept.saturating_add(1);
            }
        }

        if swept > 0 {
            let active = read_active_count(&env);
            if active > 0 {
                write_active_count(&env, active.saturating_sub(swept));
            }
        }

        Ok(swept)
    }

    // ─── Read-Only Queries ───────────────────────────────────────────────────

    /// Returns the addresses of owners who have currently approved `proposal_id`
    /// (i.e. approved and not subsequently revoked). Errors if the contract is
    /// not initialized or the proposal does not exist.
    pub fn get_approvers(env: Env, proposal_id: u64) -> Result<Vec<Address>, ContractError> {
        let owners = read_owners(&env)?;
        read_proposal(&env, proposal_id)?;

        let mut approvers = Vec::new(&env);
        for owner in owners.iter() {
            if read_approval(&env, proposal_id, &owner) {
                approvers.push_back(owner);
            }
        }
        Ok(approvers)
    }

    /// Returns the contract version. Useful for frontends and upgrade scripts
    /// that need to know which version of the contract is deployed.
    pub fn get_version(_env: Env) -> u32 {
        CONTRACT_VERSION
    }

    /// Returns the current state of a proposal with a derived status.
    pub fn get_proposal(env: Env, proposal_id: u64) -> Result<Proposal, ContractError> {
        let mut proposal = read_proposal(&env, proposal_id)?;
        proposal.status = derive_status(&env, &proposal);
        Ok(proposal)
    }

    /// Returns a page of proposals. `offset` is a 0-based index; `limit` is capped at 20.
    pub fn get_proposals_paged(env: Env, offset: u64, mut limit: u32) -> Vec<Proposal> {
        if limit > 20 {
            limit = 20;
        }
        let next_id = read_next_id(&env);

        let mut result = Vec::new(&env);
        let start = offset + 1;
        let end = (offset + u64::from(limit)).min(next_id.saturating_sub(1));

        for id in start..=end {
            if let Ok(mut proposal) = read_proposal(&env, id) {
                proposal.status = derive_status(&env, &proposal);
                result.push_back(proposal);
            }
        }
        result
    }

    /// Returns all current owners.
    pub fn get_owners(env: Env) -> Result<Vec<Address>, ContractError> {
        read_owners(&env)
    }

    /// Returns the current approval threshold.
    pub fn get_threshold(env: Env) -> Result<u32, ContractError> {
        read_threshold(&env)
    }

    /// Returns the time-lock delay in seconds. A value of 0 means no delay.
    pub fn get_time_lock_delay(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&timelock_key())
            .unwrap_or(0)
    }

    /// Returns the total number of proposals ever created.
    pub fn get_total_proposals(env: Env) -> u64 {
        read_next_id(&env).saturating_sub(1)
    }

    /// Returns whether `address` is a current owner.
    pub fn is_owner(env: Env, address: Address) -> bool {
        require_owner(&env, &address).is_ok()
    }

    /// Returns whether `owner` has approved `proposal_id`.
    pub fn has_approved(env: Env, proposal_id: u64, owner: Address) -> bool {
        read_approval(&env, proposal_id, &owner)
    }

    // ─── Upgrade ─────────────────────────────────────────────────────────────

    /// Replaces the contract WASM in-place. Keeps all storage (owners, proposals, approvals).
    /// Requires at least `threshold` distinct registered owners to co-sign the upgrade
    /// off-chain and be listed in `approvers`. Every address in `approvers` must call
    /// `require_auth()`, must be a registered owner, and must appear only once.
    ///
    /// # Arguments
    /// * `approvers` - List of owner addresses co-signing the upgrade (minimum: threshold).
    /// * `new_wasm_hash` - The SHA-256 hash of the new contract WASM to deploy.
    pub fn upgrade(
        env: Env,
        approvers: Vec<Address>,
        new_wasm_hash: BytesN<32>,
    ) -> Result<(), ContractError> {
        let threshold = read_threshold(&env)?;

        // Must have at least `threshold` approvers.
        if approvers.len() < threshold {
            return Err(ContractError::ThresholdNotMet);
        }

        // Check for duplicate addresses before requiring auth.
        for i in 0..approvers.len() {
            for j in (i + 1)..approvers.len() {
                if approvers.get(i).unwrap() == approvers.get(j).unwrap() {
                    return Err(ContractError::DuplicateOwner);
                }
            }
        }

        // Require auth from every approver and verify each is an owner.
        for approver in approvers.iter() {
            approver.require_auth();
            require_owner(&env, &approver)?;
        }

        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }
}

mod test;
