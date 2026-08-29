#![no_std]
#![allow(deprecated)]
pub mod validate;

use soroban_sdk::{Map, 
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env,
    IntoVal, String, Symbol, Val, Vec,
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
pub struct Transfer {
    pub to: Address,
    pub token: Address,
    pub amount: i128,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum ProposalKind {
    /// Transfer(transfers)
    Transfer(Vec<Transfer>),
    /// AddOwner(new_owner)
    AddOwner(Address),
    /// RemoveOwner(owner_to_remove)
    RemoveOwner(Address),
    /// ChangeThreshold(new_threshold)
    ChangeThreshold(u32),
    /// SetSpendingLimit(owner, token, limit) — per-owner cap on the amount that
    /// `owner` may propose for `token`. A limit of 0 blocks that token entirely.
    SetSpendingLimit(Address, Address, i128),
    /// ChangeOwnerWeight(target_owner, new_weight) — updates an existing owner's
    /// voting weight. Zero is never valid: remove an owner instead of leaving a
    /// listed owner unable to participate in governance.
    ChangeOwnerWeight(Address, u32),
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct SpentTracker {
    pub spent: i128,
    pub epoch: u64,
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
    pub quorum_weight: u32,
    pub category: ProposalCategory,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ProposalApprovalProgress {
    pub approval_weight: u32,
    pub quorum_weight: u32,
    pub total_weight: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ProposalCreatedEvent {
    pub id: u64,
    pub proposer: Address,
    pub threshold: u32,
    pub category: ProposalCategory,
    pub transfers: Vec<Transfer>,
    /// The weighted quorum this proposal must reach to become `Ready`. Snapshotted
    /// at creation so auditors can reconstruct the exact approval requirement even
    /// after the threshold changes via a later governance proposal.
    pub quorum_weight: u32,
    /// Sum of all owner weights at the moment this proposal was created. Because
    /// owners can be added, removed, or re-weighted after creation, this field is
    /// the only way to recover the original total-weight context from the event
    /// log alone — it is not derivable from current contract state once ownership
    /// changes.
    pub total_weight_at_creation: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum RecurringStatus {
    Active,
    Cancelled,
    Completed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct RecurringSchedule {
    pub id: u64,
    pub proposer: Address,
    pub transfers: Vec<Transfer>,
    pub interval_secs: u64,
    pub last_disbursed_at: u64,
    pub remaining_occurrences: u32,
    pub status: RecurringStatus,
    pub description: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct RecurringPayment {
    pub id: u64,
    pub recipient: Address,
    pub token: Address,
    pub amount_per_period: i128,
    pub interval_secs: u64,
    pub start_time: u64,
    pub end_time: Option<u64>,
    pub cliff_time: Option<u64>,
    pub total_cap: Option<i128>,
    pub last_disbursed_at: u64,
    pub total_disbursed: i128,
    pub periods_disbursed: u32,
    pub status: RecurringStatus,
    pub proposer: Address,
    pub category: ProposalCategory,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ProposalApprovedEvent {
    pub id: u64,
    pub approver: Address,
    pub approvals: u32,
    pub threshold: u32,
    pub weight: u32,
    pub cumulative_weight: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ProposalRevokedEvent {
    pub id: u64,
    pub approver: Address,
    pub approvals: u32,
    pub weight: u32,
    pub cumulative_weight: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ProposalExecutedEvent {
    pub id: u64,
    pub executor: Address,
    pub transfers: Vec<Transfer>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct GuardianSetEvent {
    pub guardian: Address,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct FrozenEvent {
    pub guardian: Address,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct UnfrozenEvent {
    pub approvers: Vec<Address>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct UpgradeExecutedEvent {
    pub caller: Address,
    pub new_wasm_hash: BytesN<32>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct AddOwnerExecutedEvent {
    pub new_owner: Address,
    pub owner_count: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct RemoveOwnerExecutedEvent {
    pub removed_owner: Address,
    pub owner_count: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ChangeThresholdExecutedEvent {
    pub previous_threshold: u32,
    pub new_threshold: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct SetSpendingLimitExecutedEvent {
    pub owner: Address,
    pub token: Address,
    pub previous_limit: Option<i128>,
    pub new_limit: i128,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct GovernanceMigratedEvent {
    pub owner_count: u32,
    pub total_weight: u32,
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
    ContractFrozen = 26,
    NoGuardian = 27,
    SpendingLimitExceeded = 28,
    InvalidWeight = 29,
    InvalidWeightsLength = 30,
    SingleOwnerWeightCapExceeded = 31,
    TargetOwnerNoLongerExists = 32,
    AlreadyMigrated = 33,
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

// Recurring schedules
fn recurring_next_key() -> Symbol {
    symbol_short!("RNEXT")
}

fn recurring_key(id: u64) -> (Symbol, u64) {
    (symbol_short!("RSCH"), id)
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

fn guardian_key() -> Symbol {
    symbol_short!("GUARD")
}

fn frozen_key() -> Symbol {
    symbol_short!("FROZEN")
}

fn spending_limit_key(owner: &Address, token: &Address) -> (Symbol, Address, Address) {
    (symbol_short!("SLIMIT"), owner.clone(), token.clone())
}

fn total_weight_key() -> Symbol {
    symbol_short!("TWGT")
}

// Tracks whether this contract's owners already carry real per-owner voting
// weights — either because it was initialized directly with weights, or
// because `migrate_to_weighted_governance` has already run. Missing key means
// the contract predates this flag entirely (a genuinely legacy, flat-count
// deployment), which is exactly the state `migrate_to_weighted_governance` is
// meant to run against.
fn governance_version_key() -> Symbol {
    symbol_short!("GOVVER")
}

fn max_single_owner_weight_pct_key() -> Symbol {
    symbol_short!("MAXOWNP")
}

fn read_max_single_owner_weight_pct(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&max_single_owner_weight_pct_key())
        .unwrap_or(DEFAULT_MAX_SINGLE_OWNER_WEIGHT_PCT)
}

fn owner_weight_within_cap(env: &Env, owner_weight: u32, total_weight: u32) -> bool {
    (owner_weight as u64) * 100
        <= (total_weight as u64) * (read_max_single_owner_weight_pct(env) as u64)
}

fn spent_tracking_key(owner: &Address, token: &Address) -> (Symbol, Address, Address) {
    (symbol_short!("SPENT"), owner.clone(), token.clone())
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

/// Minimum owner weight.
const MIN_OWNER_WEIGHT: u32 = 1;
/// Maximum owner weight.
const MAX_OWNER_WEIGHT: u32 = 100_000;
/// Highest configurable share of total voting weight any one owner may receive
/// via a weight-change proposal. A strict majority would permit unilateral quorum.
const MAX_SINGLE_OWNER_WEIGHT_PCT: u32 = 50;
const DEFAULT_MAX_SINGLE_OWNER_WEIGHT_PCT: u32 = MAX_SINGLE_OWNER_WEIGHT_PCT;

/// Spending window: 30 days in seconds. The cumulative spent amount per (owner, token)
/// resets when this window elapses since the first tracked spend in the window.
/// Epoch-based window: the window clock starts ticking from the timestamp of the first
/// spend (or when the limit was set). This is deterministic — two contracts with the
/// same set of operations will arrive at identical window boundaries. A rolling window
/// (sliding per-transaction) was considered but rejected because it would make the
/// "available limit" view depend on the exact time of each prior transaction, producing
/// non-deterministic behavior across nodes executing the same transaction sequence.
const SPENDING_WINDOW: u64 = 2_592_000;

// ─── Storage Helpers ─────────────────────────────────────────────────────────

fn is_initialized(env: &Env) -> bool {
    env.storage()
        .instance()
        .get::<_, bool>(&init_key())
        .unwrap_or(false)
}

fn governance_migrated(env: &Env) -> bool {
    env.storage()
        .instance()
        .get::<_, bool>(&governance_version_key())
        .unwrap_or(false)
}

fn write_governance_migrated(env: &Env, migrated: bool) {
    env.storage()
        .instance()
        .set(&governance_version_key(), &migrated);
    bump_instance(env);
}

fn read_threshold(env: &Env) -> Result<u32, ContractError> {
    env.storage()
        .instance()
        .get(&threshold_key())
        .ok_or(ContractError::NotInitialized)
}

fn read_owners_map(env: &Env) -> Result<Map<Address, u32>, ContractError> {
    let key = owners_key();
    let owners: Map<Address, u32> = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(ContractError::NotInitialized)?;
    bump_persistent(env, &key);
    Ok(owners)
}

fn read_total_weight(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&total_weight_key())
        .unwrap_or(0)
}

fn write_total_weight(env: &Env, weight: u32) {
    env.storage().instance().set(&total_weight_key(), &weight);
    bump_instance(env);
}






fn read_next_id(env: &Env) -> u64 {
    let id = env
        .storage()
        .instance()
        .get(&next_id_key())
        .unwrap_or(1_u64);
    bump_instance(env);
    id
}

fn write_next_id(env: &Env, id: u64) {
    env.storage().instance().set(&next_id_key(), &id);
    bump_instance(env);
}

fn read_recurring_next_id(env: &Env) -> u64 {
    let id = env
        .storage()
        .instance()
        .get(&recurring_next_key())
        .unwrap_or(1_u64);
    bump_instance(env);
    id
}

fn write_recurring_next_id(env: &Env, id: u64) {
    env.storage().instance().set(&recurring_next_key(), &id);
    bump_instance(env);
}

fn read_recurring_schedule(env: &Env, id: u64) -> Result<RecurringSchedule, ContractError> {
    let key = recurring_key(id);
    let s: RecurringSchedule = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(ContractError::ProposalNotFound)?;
    bump_persistent(env, &key);
    Ok(s)
}

fn write_recurring_schedule(env: &Env, s: &RecurringSchedule) {
    let key = recurring_key(s.id);
    env.storage().persistent().set(&key, s);
    bump_persistent(env, &key);
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

/// Reads the per-owner spending limit for a token. Returns `None` when no limit
/// is set, meaning the owner is unrestricted for that token.
fn read_spending_limit(env: &Env, owner: &Address, token: &Address) -> Option<i128> {
    let key = spending_limit_key(owner, token);
    let limit: Option<i128> = env.storage().persistent().get(&key);
    if limit.is_some() {
        bump_persistent(env, &key);
    }
    limit
}

fn write_spending_limit(env: &Env, owner: &Address, token: &Address, limit: i128) {
    let key = spending_limit_key(owner, token);
    env.storage().persistent().set(&key, &limit);
    bump_persistent(env, &key);
}

fn read_spent_tracker(env: &Env, owner: &Address, token: &Address) -> SpentTracker {
    let key = spent_tracking_key(owner, token);
    env.storage()
        .persistent()
        .get(&key)
        .unwrap_or(SpentTracker { spent: 0, epoch: 0 })
}

fn write_spent_tracker(env: &Env, owner: &Address, token: &Address, tracker: &SpentTracker) {
    let key = spent_tracking_key(owner, token);
    env.storage().persistent().set(&key, tracker);
    bump_persistent(env, &key);
}

/// Returns the amount effectively spent within the current spending window.
/// If no window is active (epoch == 0) or the window has expired, returns 0.
fn effective_spent(env: &Env, owner: &Address, token: &Address) -> i128 {
    let tracker = read_spent_tracker(env, owner, token);
    if tracker.epoch == 0 {
        return 0;
    }
    let now = env.ledger().timestamp();
    if now > tracker.epoch.saturating_add(SPENDING_WINDOW) {
        return 0;
    }
    tracker.spent
}

fn read_active_count(env: &Env) -> u32 {
    // Recompute active proposals (Pending + Ready) to ensure expired/ executed
    // proposals are not counted, guarding against any missed decrements.
    let next_id = env
        .storage()
        .instance()
        .get(&next_id_key())
        .unwrap_or(1_u64);
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

fn read_guardian(env: &Env) -> Option<Address> {
    env.storage().instance().get(&guardian_key())
}

fn write_guardian(env: &Env, guardian: &Address) {
    env.storage().instance().set(&guardian_key(), guardian);
    bump_instance(env);
}

fn is_frozen_state(env: &Env) -> bool {
    env.storage()
        .instance()
        .get::<_, bool>(&frozen_key())
        .unwrap_or(false)
}

fn write_frozen(env: &Env, frozen: bool) {
    env.storage().instance().set(&frozen_key(), &frozen);
    bump_instance(env);
}

fn require_not_frozen(env: &Env) -> Result<(), ContractError> {
    if is_frozen_state(env) {
        return Err(ContractError::ContractFrozen);
    }
    Ok(())
}

// ─── Business Logic Helpers ──────────────────────────────────────────────────

fn require_owner_and_weight(env: &Env, address: &Address) -> Result<u32, ContractError> {
    let owners = read_owners_map(env)?;
    owners.get(address.clone()).ok_or(ContractError::Unauthorized)
}

/// Validates privileged co-signers by distinct address and cumulative voting
/// weight. Each address is added at most once, so an owner's weight cannot be
/// counted repeatedly.
fn require_weighted_approvers(env: &Env, approvers: &Vec<Address>) -> Result<(), ContractError> {
    for i in 0..approvers.len() {
        for j in (i + 1)..approvers.len() {
            if approvers.get(i).unwrap() == approvers.get(j).unwrap() {
                return Err(ContractError::DuplicateOwner);
            }
        }
    }

    let threshold = read_threshold(env)?;
    let mut weight: u32 = 0;
    for approver in approvers.iter() {
        approver.require_auth();
        let approver_weight = require_owner_and_weight(env, &approver)?;
        weight = weight
            .checked_add(approver_weight)
            .ok_or(ContractError::ArithmeticError)?;
    }
    if weight < threshold {
        return Err(ContractError::ThresholdNotMet);
    }
    Ok(())
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
    if proposal.approvals >= proposal.quorum_weight {
        ProposalStatus::Ready
    } else {
        ProposalStatus::Pending
    }
}

fn validate_token(env: &Env, token_address: &Address) -> Result<(), ContractError> {
    let client = token::Client::new(env, token_address);
    // Require decimals, symbol, and name to all succeed to consider this a valid token.
    if client.try_decimals().is_err() || client.try_symbol().is_err() || client.try_name().is_err()
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
        weights: Vec<u32>,
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

        if owners.len() != weights.len() {
            return Err(ContractError::InvalidWeightsLength);
        }

        if threshold == 0 {
            return Err(ContractError::InvalidThreshold);
        }

        let mut total_weight: u32 = 0;
        // Reject duplicate addresses before requiring auth (duplicate require_auth aborts host).
        for i in 0..owners.len() {
            for j in (i + 1)..owners.len() {
                if owners.get(i).unwrap() == owners.get(j).unwrap() {
                    return Err(ContractError::DuplicateOwner);
                }
            }
        }

        // Require auth from all owners and validate/store weights.
        let mut owners_map = Map::new(&env);
        for i in 0..owners.len() {
            let owner = owners.get(i).unwrap();
            let weight = weights.get(i).unwrap();
            if !(MIN_OWNER_WEIGHT..=MAX_OWNER_WEIGHT).contains(&weight) {
                return Err(ContractError::InvalidWeight);
            }
            owner.require_auth();
            owners_map.set(owner.clone(), weight);
            total_weight = total_weight
                .checked_add(weight)
                .ok_or(ContractError::ArithmeticError)?;
        }

        // Validate threshold against total weight, not owner count. The threshold
        // is an absolute weight value — a proposal requires this many weight-units
        // of approval, not this many individual owners. Validating against
        // total_weight ensures the threshold is achievable given the current
        // weight distribution.
        if threshold == 0 || threshold > total_weight {
            return Err(ContractError::InvalidThreshold);
        }
        if threshold > total_weight {
            return Err(ContractError::InvalidThreshold);
        }

        write_total_weight(&env, total_weight);
        env.storage().instance().set(
            &max_single_owner_weight_pct_key(),
            &DEFAULT_MAX_SINGLE_OWNER_WEIGHT_PCT,
        );

        let key = owners_key();
        env.storage().persistent().set(&key, &owners_map);
        bump_persistent(&env, &key);

        env.storage().instance().set(&threshold_key(), &threshold);
        env.storage()
            .instance()
            .set(&timelock_key(), &time_lock_delay);
        env.storage().instance().set(&init_key(), &true);
        // A contract initialized through this function already has real,
        // explicit per-owner weights from the start, so it never needs (and
        // must never accept) `migrate_to_weighted_governance`.
        env.storage()
            .instance()
            .set(&governance_version_key(), &true);
        bump_instance(&env);

        Ok(())
    }

    /// One-time migration for a multisig that was deployed before per-owner
    /// voting weights existed (a flat M-of-N approval count). Assigns every
    /// current owner a weight of one and sets the total weight equal to the
    /// owner count — mathematically identical to the prior flat-count model,
    /// so the weighted quorum comparison behaves exactly like the old one for
    /// the same sequence of approvals.
    ///
    /// Guarded the same way `initialize`'s `AlreadyInitialized` check works:
    /// the governance-version flag is inspected before any weight data is
    /// touched, and a contract that already has real per-owner weights —
    /// whether because it was already migrated, or because it was initialized
    /// directly through the weighted `initialize` — rejects the call with
    /// `AlreadyMigrated` outright.
    ///
    /// # Arguments
    /// * `approvers` - Distinct owner addresses co-signing the migration. The
    ///   pre-migration threshold is a flat approval count (not a weight), so
    ///   authorization here requires that many *distinct* registered owners,
    ///   not a summed weight.
    pub fn migrate_to_weighted_governance(
        env: Env,
        approvers: Vec<Address>,
    ) -> Result<(), ContractError> {
        if !is_initialized(&env) {
            return Err(ContractError::NotInitialized);
        }
        if governance_migrated(&env) {
            return Err(ContractError::AlreadyMigrated);
        }

        for i in 0..approvers.len() {
            for j in (i + 1)..approvers.len() {
                if approvers.get(i).unwrap() == approvers.get(j).unwrap() {
                    return Err(ContractError::DuplicateOwner);
                }
            }
        }

        let owners = read_owners_map(&env)?;
        let threshold = read_threshold(&env)?;

        let mut approver_count: u32 = 0;
        for approver in approvers.iter() {
            approver.require_auth();
            if !owners.contains_key(approver.clone()) {
                return Err(ContractError::Unauthorized);
            }
            approver_count = approver_count
                .checked_add(1)
                .ok_or(ContractError::ArithmeticError)?;
        }
        if approver_count < threshold {
            return Err(ContractError::ThresholdNotMet);
        }

        let mut migrated_owners = Map::new(&env);
        let mut total_weight: u32 = 0;
        for owner in owners.keys().iter() {
            migrated_owners.set(owner.clone(), MIN_OWNER_WEIGHT);
            total_weight = total_weight
                .checked_add(MIN_OWNER_WEIGHT)
                .ok_or(ContractError::ArithmeticError)?;
        }
        let owner_count = migrated_owners.len();

        let key = owners_key();
        env.storage().persistent().set(&key, &migrated_owners);
        bump_persistent(&env, &key);
        write_total_weight(&env, total_weight);

        // Set last: a second call (or a call against a contract that never
        // needed migration) must be caught by the guard at the top of this
        // function before any weight data is touched.
        write_governance_migrated(&env, true);

        env.events().publish(
            (symbol_short!("migrated"),),
            GovernanceMigratedEvent {
                owner_count,
                total_weight,
            },
        );

        Ok(())
    }

    /// Create a recurring schedule for periodic disbursements.
    pub fn create_recurring_schedule(
        env: Env,
        proposer: Address,
        transfers: Vec<Transfer>,
        interval_secs: u64,
        occurrences: u32,
        description: String,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_owner_and_weight(&env, &proposer)?;
        require_not_frozen(&env)?;

        if transfers.len() == 0 {
            return Err(ContractError::InvalidAmount);
        }
        for transfer in transfers.iter() {
            if transfer.amount < MIN_AMOUNT {
                return Err(ContractError::InvalidAmount);
            }
            validate_token(&env, &transfer.token)?;
            if transfer.to == env.current_contract_address() {
                return Err(ContractError::InvalidRecipient);
            }
        }
        if occurrences == 0 {
            return Err(ContractError::InvalidDuration);
        }
        if description.len() > MAX_DESCRIPTION_LEN {
            return Err(ContractError::DescriptionTooLong);
        }

        let id = read_recurring_next_id(&env);
        let next = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_recurring_next_id(&env, next);

        let schedule = RecurringSchedule {
            id,
            proposer: proposer.clone(),
            transfers: transfers.clone(),
            interval_secs,
            last_disbursed_at: 0,
            remaining_occurrences: occurrences,
            status: RecurringStatus::Active,
            description,
        };
        write_recurring_schedule(&env, &schedule);
        Ok(id)
    }

    /// Cancel a recurring schedule (owner-only action).
    pub fn cancel_recurring_schedule(
        env: Env,
        caller: Address,
        id: u64,
    ) -> Result<(), ContractError> {
        caller.require_auth();
        require_owner_and_weight(&env, &caller)?;
        let mut s = read_recurring_schedule(&env, id)?;
        s.status = RecurringStatus::Cancelled;
        write_recurring_schedule(&env, &s);
        Ok(())
    }

    /// Disburse a recurring schedule (permissionless crank). Reject if schedule
    /// is in a terminal status (Cancelled or Completed) or called too early.
    pub fn disburse_recurring(env: Env, id: u64) -> Result<(), ContractError> {
        let mut s = read_recurring_schedule(&env, id)?;
        if !matches!(s.status, RecurringStatus::Active) {
            return Err(ContractError::ProposalNotActive);
        }
        let now = env.ledger().timestamp();
        if s.last_disbursed_at != 0 && now < s.last_disbursed_at.saturating_add(s.interval_secs) {
            return Err(ContractError::ProposalNotActive);
        }
        s.last_disbursed_at = now;
        if s.remaining_occurrences > 0 {
            s.remaining_occurrences = s.remaining_occurrences.saturating_sub(1);
        }
        if s.remaining_occurrences == 0 {
            s.status = RecurringStatus::Completed;
        }
        write_recurring_schedule(&env, &s);
        Ok(())
    }

    /// Creates a new transfer proposal with one or more asset transfers.
    ///
    /// # Arguments
    /// * `proposer` - Owner proposing the transfer. Must authorize.
    /// * `transfers` - Asset transfers to execute (1-3). Each must have a valid token and amount ≥ 1.
    /// * `description` - Human-readable description (max 300 chars).
    /// * `deadline` - Unix timestamp after which the proposal expires.
    pub fn create_proposal(
        env: Env,
        proposer: Address,
        transfers: Vec<Transfer>,
        description: String,
        deadline: u64,
        category: ProposalCategory,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_owner_and_weight(&env, &proposer)?;
        require_not_frozen(&env)?;

        let transfers_len = transfers.len();
        if transfers_len == 0 || transfers_len > 3 {
            return Err(ContractError::InvalidAmount);
        }

        for transfer in transfers.iter() {
            if transfer.amount < MIN_AMOUNT {
                return Err(ContractError::InvalidAmount);
            }
            validate_token(&env, &transfer.token)?;
            if transfer.to == env.current_contract_address() {
                return Err(ContractError::InvalidRecipient);
            }
        }

        {
            let mut checked_tokens: Vec<Address> = Vec::new(&env);
            let mut checked_totals: Vec<i128> = Vec::new(&env);
            for transfer in transfers.iter() {
                let mut found = false;
                for i in 0..checked_tokens.len() {
                    if checked_tokens.get(i).unwrap() == transfer.token {
                        let total = checked_totals.get(i).unwrap() + transfer.amount;
                        checked_totals.set(i, total);
                        found = true;
                        break;
                    }
                }
                if !found {
                    checked_tokens.push_back(transfer.token.clone());
                    checked_totals.push_back(transfer.amount);
                }
            }
            for i in 0..checked_tokens.len() {
                let token = checked_tokens.get(i).unwrap();
                if let Some(limit) = read_spending_limit(&env, &proposer, &token) {
                    let already_spent = effective_spent(&env, &proposer, &token);
                    let cumulative = checked_totals
                        .get(i)
                        .unwrap()
                        .checked_add(already_spent)
                        .ok_or(ContractError::ArithmeticError)?;
                    if cumulative > limit {
                        return Err(ContractError::SpendingLimitExceeded);
                    }
                }
            }
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
            kind: ProposalKind::Transfer(transfers.clone()),
            ready_at: 0,
            quorum_weight: threshold,
            category: category.clone(),
        };
        write_proposal(&env, &proposal);
        write_active_count(&env, active + 1);

        let total_weight = read_total_weight(&env);
        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                id,
                proposer,
                threshold,
                category,
                transfers,
                quorum_weight: threshold,
                total_weight_at_creation: total_weight,
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
        require_owner_and_weight(&env, &proposer)?;
        require_not_frozen(&env)?;

        let owners = read_owners_map(&env)?;
        if owners.contains_key(new_owner.clone()) {
            return Err(ContractError::DuplicateOwner);
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
            quorum_weight: threshold,
            category: ProposalCategory::Other,
        };
        write_proposal(&env, &proposal);
        write_active_count(&env, active + 1);

        let total_weight = read_total_weight(&env);
        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                id,
                proposer,
                threshold,
                category: ProposalCategory::Other,
                transfers: Vec::new(&env),
                quorum_weight: threshold,
                total_weight_at_creation: total_weight,
            },
        );

        Ok(id)
    }

    /// Creates a proposal to set (or change) a per-owner spending limit for a
    /// token. The limit caps the amount `owner` may propose for `token`; a limit
    /// of 0 blocks that token for that owner. Enforced in `create_proposal`.
    pub fn create_spending_limit_proposal(
        env: Env,
        proposer: Address,
        owner: Address,
        token: Address,
        limit: i128,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_owner_and_weight(&env, &proposer)?;
        require_not_frozen(&env)?;

        if limit < 0 {
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
            kind: ProposalKind::SetSpendingLimit(owner, token, limit),
            ready_at: 0,
            quorum_weight: threshold,
            category: ProposalCategory::Other,
        };
        write_proposal(&env, &proposal);
        write_active_count(&env, active + 1);

        let total_weight = read_total_weight(&env);
        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                id,
                proposer,
                threshold,
                category: ProposalCategory::Other,
                transfers: Vec::new(&env),
                quorum_weight: threshold,
                total_weight_at_creation: total_weight,
            },
        );

        Ok(id)
    }

    /// Creates a proposal to change an existing owner's voting weight.
    ///
    /// # Arguments
    /// * `proposer` - Owner proposing the change. Must authorize.
    /// * `target_owner` - Address of the owner whose weight to change. Must be
    ///   a current owner.
    /// * `new_weight` - The new voting weight. Must be nonzero, within
    ///   [MIN_OWNER_WEIGHT, MAX_OWNER_WEIGHT], and no more than the configured
    ///   share of the resulting total weight. Use `RemoveOwner` to revoke voting.
    pub fn create_change_weight_proposal(
        env: Env,
        proposer: Address,
        target_owner: Address,
        new_weight: u32,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_owner_and_weight(&env, &proposer)?;
        require_not_frozen(&env)?;

        if !(MIN_OWNER_WEIGHT..=MAX_OWNER_WEIGHT).contains(&new_weight) {
            return Err(ContractError::InvalidWeight);
        }

        let owners = read_owners_map(&env)?;
        if !owners.contains_key(target_owner.clone()) {
            return Err(ContractError::OwnerNotFound);
        }

        let target_weight = owners.get(target_owner.clone()).unwrap();

        let current_total = read_total_weight(&env);
        let resulting_total = current_total
            .checked_sub(target_weight)
            .ok_or(ContractError::ArithmeticError)?
            .checked_add(new_weight)
            .ok_or(ContractError::ArithmeticError)?;
        if !owner_weight_within_cap(&env, new_weight, resulting_total) {
            return Err(ContractError::SingleOwnerWeightCapExceeded);
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
            kind: ProposalKind::ChangeOwnerWeight(target_owner, new_weight),
            ready_at: 0,
            quorum_weight: threshold,
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
                transfers: Vec::new(&env),
                quorum_weight: threshold,
                total_weight_at_creation: current_total,
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
        require_owner_and_weight(&env, &proposer)?;
        require_not_frozen(&env)?;

        let owners = read_owners_map(&env)?;
        let threshold = read_threshold(&env)?;

        if !owners.contains_key(owner_to_remove.clone()) {
            return Err(ContractError::OwnerNotFound);
        }

        // Guard: removing this owner must not make the threshold unachievable.
        // With the absolute-weight model the correct check is whether the
        // remaining total weight would still be >= threshold.
        let mut owners = read_owners_map(&env)?;
        let removed_weight = owners.get(owner_to_remove.clone()).ok_or(ContractError::OwnerNotFound)?;
        let total_weight = read_total_weight(&env);
        let remaining_weight = total_weight
            .checked_sub(removed_weight)
            .ok_or(ContractError::ArithmeticError)?;
        if remaining_weight < threshold {
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
            quorum_weight: threshold,
            category: ProposalCategory::Other,
        };
        write_proposal(&env, &proposal);
        write_active_count(&env, active + 1);

        let total_weight = read_total_weight(&env);
        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                id,
                proposer,
                threshold,
                category: ProposalCategory::Other,
                transfers: Vec::new(&env),
                quorum_weight: threshold,
                total_weight_at_creation: total_weight,
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
        require_owner_and_weight(&env, &proposer)?;
        require_not_frozen(&env)?;

        let total_weight = read_total_weight(&env);

        // The threshold is an absolute weight value. Validate it against the
        // current total weight so the proposed threshold is always achievable
        // given the current weight distribution.
        if new_threshold == 0 || new_threshold > total_weight {
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
            quorum_weight: threshold,
            category: ProposalCategory::Other,
        };
        write_proposal(&env, &proposal);
        write_active_count(&env, active + 1);

        let total_weight = read_total_weight(&env);
        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                id,
                proposer,
                threshold,
                category: ProposalCategory::Other,
                transfers: Vec::new(&env),
                quorum_weight: threshold,
                total_weight_at_creation: total_weight,
            },
        );

        Ok(id)
    }

    /// Approves a proposal. The approver must be an owner and must not have already approved.
    ///
    /// Automatically transitions the proposal to `Ready` when the approval count reaches threshold.
    /// Records `ready_at` the first time the threshold is crossed.
    pub fn approve(env: Env, approver: Address, proposal_id: u64) -> Result<(), ContractError> {
        approver.require_auth();
        let weight = require_owner_and_weight(&env, &approver)?;
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
            .checked_add(weight)
            .ok_or(ContractError::ArithmeticError)?;

        // Record the timestamp when the proposal first crosses the threshold.
        if proposal.ready_at == 0 && proposal.approvals >= proposal.quorum_weight {
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
                threshold: proposal.quorum_weight,
                weight,
                cumulative_weight: proposal.approvals,
            },
        );

        Ok(())
    }

    /// Revokes the caller's approval from a proposal that has not yet been executed.
    ///
    /// The proposal status is recalculated after the revoke: if approvals fall below
    /// threshold the status transitions back to `Pending`.
    pub fn revoke(env: Env, approver: Address, proposal_id: u64) -> Result<(), ContractError> {
        approver.require_auth();
        let weight = require_owner_and_weight(&env, &approver)?;
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
            .checked_sub(weight)
            .ok_or(ContractError::ArithmeticError)?;
        proposal.status = derive_status(&env, &proposal);
        write_proposal(&env, &proposal);

        env.events().publish(
            (symbol_short!("revoked"),),
            ProposalRevokedEvent {
                id: proposal_id,
                approver,
                approvals: proposal.approvals,
                weight,
                cumulative_weight: proposal.approvals,
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
    pub fn execute(env: Env, executor: Address, proposal_id: u64) -> Result<(), ContractError> {
        executor.require_auth();
        require_owner_and_weight(&env, &executor)?;
        require_not_frozen(&env)?;

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
            if proposal.approvals < proposal.quorum_weight {
                return Err(ContractError::ThresholdNotMet);
            }
            return Err(ContractError::ProposalNotActive);
        }

        // Time-lock enforcement.
        let time_lock_delay: u64 = env.storage().instance().get(&timelock_key()).unwrap_or(0);
        if time_lock_delay > 0 {
            let now = env.ledger().timestamp();
            if now < proposal.ready_at.saturating_add(time_lock_delay) {
                return Err(ContractError::TimeLockActive);
            }
        }

        // Dispatch on proposal kind.
        match &proposal.kind {
            ProposalKind::Transfer(transfers) => {
                for transfer in transfers.iter() {
                    if token::Client::new(&env, &transfer.token)
                        .try_transfer(
                            &env.current_contract_address(),
                            &transfer.to,
                            &transfer.amount,
                        )
                        .is_err()
                    {
                        return Err(ContractError::TransferFailed);
                    }
                }
                // Track cumulative spending per token for the proposer.
                let proposer = proposal.proposer.clone();
                let mut tracked_tokens: Vec<Address> = Vec::new(&env);
                let mut tracked_amounts: Vec<i128> = Vec::new(&env);
                for transfer in transfers.iter() {
                    let mut found = false;
                    for j in 0..tracked_tokens.len() {
                        if tracked_tokens.get(j).unwrap() == transfer.token {
                            let total = tracked_amounts
                                .get(j)
                                .unwrap()
                                .checked_add(transfer.amount)
                                .ok_or(ContractError::ArithmeticError)?;
                            tracked_amounts.set(j, total);
                            found = true;
                            break;
                        }
                    }
                    if !found {
                        tracked_tokens.push_back(transfer.token.clone());
                        tracked_amounts.push_back(transfer.amount);
                    }
                }
                let now = env.ledger().timestamp();
                for j in 0..tracked_tokens.len() {
                    let token = tracked_tokens.get(j).unwrap();
                    let amount = tracked_amounts.get(j).unwrap();
                    let tracker = read_spent_tracker(&env, &proposer, &token);
                    let epoch = if tracker.epoch == 0 {
                        now
                    } else {
                        tracker.epoch
                    };
                    let spent = if now > epoch.saturating_add(SPENDING_WINDOW) {
                        amount
                    } else {
                        tracker
                            .spent
                            .checked_add(amount)
                            .ok_or(ContractError::ArithmeticError)?
                    };
                    write_spent_tracker(&env, &proposer, &token, &SpentTracker { spent, epoch });
                }
            }
            ProposalKind::AddOwner(new_owner) => {
                let mut owners = read_owners_map(&env)?;
                let prev_count = owners.len();
                owners.set(new_owner.clone(), MIN_OWNER_WEIGHT);
                let key = owners_key();
                env.storage().persistent().set(&key, &owners);
                bump_persistent(&env, &key);
                // New owners start at MIN_OWNER_WEIGHT; keep the counter in
                // lockstep with the implicit default returned by read_owner_weight.
                write_total_weight(
                    &env,
                    read_total_weight(&env)
                        .checked_add(MIN_OWNER_WEIGHT)
                        .ok_or(ContractError::ArithmeticError)?,
                );
                env.events().publish(
                    (symbol_short!("a_own"),),
                    AddOwnerExecutedEvent {
                        new_owner: new_owner.clone(),
                        owner_count: prev_count + 1,
                    },
                );
            }
            ProposalKind::RemoveOwner(owner_to_remove) => {
                let mut owners = read_owners_map(&env)?;
                let prev_count = owners.len();
                let weight = owners.get(owner_to_remove.clone()).unwrap_or(0);
                owners.remove(owner_to_remove.clone());
                let key = owners_key();
                env.storage().persistent().set(&key, &owners);
                bump_persistent(&env, &key);

                let current_total = read_total_weight(&env);
                write_total_weight(
                    &env,
                    current_total
                        .checked_sub(weight)
                        .ok_or(ContractError::ArithmeticError)?,
                );

                env.events().publish(
                    (symbol_short!("r_own"),),
                    RemoveOwnerExecutedEvent {
                        removed_owner: owner_to_remove.clone(),
                        owner_count: prev_count - 1,
                    },
                );
            }
            ProposalKind::ChangeThreshold(new_threshold) => {
                let old_threshold = env
                    .storage()
                    .instance()
                    .get::<_, u32>(&threshold_key())
                    .unwrap_or(0);
                env.storage()
                    .instance()
                    .set(&threshold_key(), new_threshold);
                bump_instance(&env);
                env.events().publish(
                    (symbol_short!("c_thr"),),
                    ChangeThresholdExecutedEvent {
                        previous_threshold: old_threshold,
                        new_threshold: *new_threshold,
                    },
                );
            }
            ProposalKind::SetSpendingLimit(owner, token, limit) => {
                let prev_limit = read_spending_limit(&env, owner, token);
                write_spending_limit(&env, owner, token, *limit);
                // Reset cumulative spending tracking when a new limit is set.
                let now = env.ledger().timestamp();
                write_spent_tracker(
                    &env,
                    owner,
                    token,
                    &SpentTracker {
                        spent: 0,
                        epoch: now,
                    },
                );
                env.events().publish(
                    (symbol_short!("s_lim"),),
                    SetSpendingLimitExecutedEvent {
                        owner: owner.clone(),
                        token: token.clone(),
                        previous_limit: prev_limit,
                        new_limit: *limit,
                    },
                );
            }
            ProposalKind::ChangeOwnerWeight(target_owner, new_weight) => {
                if !(MIN_OWNER_WEIGHT..=MAX_OWNER_WEIGHT).contains(new_weight) {
                    return Err(ContractError::InvalidWeight);
                }
                let mut owners = read_owners_map(&env)?;
                let old_weight = owners
                    .get(target_owner.clone())
                    .ok_or(ContractError::TargetOwnerNoLongerExists)?;
                let current_total = read_total_weight(&env);
                let new_total = current_total
                    .checked_sub(old_weight)
                    .ok_or(ContractError::ArithmeticError)?
                    .checked_add(*new_weight)
                    .ok_or(ContractError::ArithmeticError)?;

                if !owner_weight_within_cap(&env, *new_weight, new_total) {
                    return Err(ContractError::SingleOwnerWeightCapExceeded);
                }

                // Invariant: ensure no active (Pending/Ready) proposal would
                // become un-quorumable (quorum_weight > new_total_weight).
                let next_id = read_next_id(&env);
                for id in 1..next_id {
                    if let Ok(active_proposal) = read_proposal(&env, id) {
                        let status = derive_status(&env, &active_proposal);
                        if matches!(status, ProposalStatus::Pending | ProposalStatus::Ready)
                            && active_proposal.quorum_weight > new_total
                        {
                            return Err(ContractError::WouldBreakThreshold);
                        }
                    }
                }

                owners.set(target_owner.clone(), *new_weight);
                env.storage().persistent().set(&owners_key(), &owners);
                write_total_weight(&env, new_total);
            }
        }

        proposal.status = ProposalStatus::Executed;
        write_proposal(&env, &proposal);

        let active = read_active_count(&env);
        if active > 0 {
            write_active_count(&env, active - 1);
        }

        let transfers = match &proposal.kind {
            ProposalKind::Transfer(transfers) => transfers.clone(),
            _ => Vec::new(&env),
        };

        env.events().publish(
            (symbol_short!("executed"),),
            ProposalExecutedEvent {
                id: proposal_id,
                executor,
                transfers,
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
    pub fn cancel_expired(env: Env, caller: Address, ids: Vec<u64>) -> Result<u32, ContractError> {
        caller.require_auth();
        require_owner_and_weight(&env, &caller)?;

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
        let owners = read_owners_map(&env)?;
        read_proposal(&env, proposal_id)?;

        let mut approvers = Vec::new(&env);
        for owner in owners.keys().iter() {
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

    pub fn get_total_weight(env: Env) -> u32 {
        read_total_weight(&env)
    }

    /// Returns whether this contract's owners already carry real per-owner
    /// voting weights — `true` for any contract initialized directly through
    /// the weighted `initialize`, or for a legacy contract that has already
    /// run `migrate_to_weighted_governance`. A deployer verifying whether
    /// migration is still needed should call this before invoking it.
    pub fn is_governance_migrated(env: Env) -> bool {
        governance_migrated(&env)
    }

    /// Returns a current owner's voting weight, or `OwnerNotFound` otherwise.
    pub fn get_owner_weight(env: Env, owner: Address) -> Result<u32, ContractError> {
        let owners = read_owners_map(&env)?;
        owners.get(owner).ok_or(ContractError::OwnerNotFound)
    }

    /// Returns the configured maximum percentage of total weight that one owner
    /// may receive through a ChangeOwnerWeight proposal.
    pub fn get_max_single_owner_weight_pct(env: Env) -> u32 {
        read_max_single_owner_weight_pct(&env)
    }

    /// Updates the maximum single-owner weight percentage (1..=50). The same
    /// weighted, distinct-owner quorum required for other sensitive operations
    /// authorizes this parameter change.
    pub fn set_max_single_owner_weight_pct(
        env: Env,
        approvers: Vec<Address>,
        max_pct: u32,
    ) -> Result<(), ContractError> {
        // The parameter may be tightened, but never relaxed above 50%: a
        // higher cap would allow a weight change to grant a strict majority.
        if max_pct == 0 || max_pct > MAX_SINGLE_OWNER_WEIGHT_PCT {
            return Err(ContractError::InvalidWeight);
        }
        require_weighted_approvers(&env, &approvers)?;
        env.storage()
            .instance()
            .set(&max_single_owner_weight_pct_key(), &max_pct);
        bump_instance(&env);
        Ok(())
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
        Ok(read_owners_map(&env)?.keys())
    }

    /// Returns the spending limit for an (owner, token) pair, or `None` if no
    /// limit is set (the owner is unrestricted for that token).
    pub fn get_spending_limit(env: Env, owner: Address, token: Address) -> Option<i128> {
        read_spending_limit(&env, &owner, &token)
    }

    /// Returns the remaining spending limit (limit minus cumulative spent within
    /// the current window) for an `(owner, token)` pair. Returns `None` if no
    /// limit is set (the owner is unrestricted for that token).
    pub fn get_remaining_spending_limit(env: Env, owner: Address, token: Address) -> Option<i128> {
        let limit = read_spending_limit(&env, &owner, &token)?;
        let spent = effective_spent(&env, &owner, &token);
        Some(limit.saturating_sub(spent))
    }

    /// Returns the current approval threshold.
    pub fn get_threshold(env: Env) -> Result<u32, ContractError> {
        read_threshold(&env)
    }

    /// Returns the quorum weight a newly created proposal would currently be assigned.
    pub fn get_required_quorum_weight(env: Env) -> Result<u32, ContractError> {
        read_threshold(&env)
    }

    /// Returns the time-lock delay in seconds. A value of 0 means no delay.
    pub fn get_time_lock_delay(env: Env) -> u64 {
        env.storage().instance().get(&timelock_key()).unwrap_or(0)
    }

    /// Returns the total number of proposals ever created.
    pub fn get_total_proposals(env: Env) -> u64 {
        read_next_id(&env).saturating_sub(1)
    }

    /// Returns whether `address` is a current owner.
    pub fn is_owner(env: Env, address: Address) -> bool {
        require_owner_and_weight(&env, &address).is_ok()
    }

    /// Returns whether `owner` has approved `proposal_id`.
    pub fn has_approved(env: Env, proposal_id: u64, owner: Address) -> bool {
        read_approval(&env, proposal_id, &owner)
    }

    /// Returns the current approval progress for a proposal: the cumulative
    /// approval weight, the required quorum weight, and the total weight of
    /// all owners.
    pub fn get_proposal_approval_progress(
        env: Env,
        proposal_id: u64,
    ) -> Result<ProposalApprovalProgress, ContractError> {
        let proposal = read_proposal(&env, proposal_id)?;
        Ok(ProposalApprovalProgress {
            approval_weight: proposal.approvals,
            quorum_weight: proposal.quorum_weight,
            total_weight: read_total_weight(&env),
        })
    }

    // ─── Guardian ─────────────────────────────────────────────────────────────

    /// Assigns or replaces the guardian address. Requires distinct registered
    /// owners whose combined weight reaches `threshold`.
    pub fn set_guardian(
        env: Env,
        approvers: Vec<Address>,
        new_guardian: Address,
    ) -> Result<(), ContractError> {
        require_weighted_approvers(&env, &approvers)?;

        write_guardian(&env, &new_guardian);

        env.events().publish(
            (symbol_short!("guard_set"),),
            GuardianSetEvent {
                guardian: new_guardian,
            },
        );

        Ok(())
    }

    /// Immediately freezes the contract, blocking new proposals and execution.
    /// Only the current guardian may call this.
    pub fn freeze(env: Env, guardian: Address) -> Result<(), ContractError> {
        guardian.require_auth();

        let stored = read_guardian(&env).ok_or(ContractError::NoGuardian)?;
        if stored != guardian {
            return Err(ContractError::Unauthorized);
        }

        write_frozen(&env, true);

        env.events()
            .publish((symbol_short!("frozen"),), FrozenEvent { guardian });

        Ok(())
    }

    /// Resumes normal operation after a freeze. Requires distinct registered
    /// owners whose combined weight reaches `threshold`.
    pub fn unfreeze(env: Env, approvers: Vec<Address>) -> Result<(), ContractError> {
        require_weighted_approvers(&env, &approvers)?;

        write_frozen(&env, false);

        env.events().publish(
            (symbol_short!("unfrozen"),),
            UnfrozenEvent {
                approvers: approvers.clone(),
            },
        );

        Ok(())
    }

    /// Returns whether the contract is currently frozen.
    pub fn is_frozen(env: Env) -> bool {
        is_frozen_state(&env)
    }

    /// Returns the current guardian address, or `None` if no guardian is set.
    pub fn get_guardian(env: Env) -> Option<Address> {
        read_guardian(&env)
    }

    // ─── Upgrade ─────────────────────────────────────────────────────────────

    /// Replaces the contract WASM in-place. Keeps all storage (owners, proposals, approvals).
    /// Requires distinct registered owners whose combined weight reaches
    /// `threshold` to co-sign the upgrade. Every address in `approvers` must call
    /// `require_auth()`, be a registered owner, and appear only once.
    ///
    /// # Arguments
    /// * `approvers` - Distinct owner addresses co-signing the upgrade with combined weight at least threshold.
    /// * `new_wasm_hash` - The SHA-256 hash of the new contract WASM to deploy.
    pub fn upgrade(
        env: Env,
        approvers: Vec<Address>,
        new_wasm_hash: BytesN<32>,
    ) -> Result<(), ContractError> {
        require_weighted_approvers(&env, &approvers)?;

        let caller = approvers.get(0).unwrap();
        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());

        env.events().publish(
            (symbol_short!("upgraded"),),
            UpgradeExecutedEvent {
                caller,
                new_wasm_hash,
            },
        );

        Ok(())
    }

}

mod test;
