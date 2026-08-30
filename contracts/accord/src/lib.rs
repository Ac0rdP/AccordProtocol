#![no_std]
#![allow(deprecated)]
pub mod validate;
use validate::{validate_deadline, validate_description, validate_recurring_schedule};

use soroban_sdk::{
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
pub enum RecurringStatus {
    Active,
    Paused,
    Completed,
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum RecurringKind {
    FixedAmountPerPeriod,
    LinearVesting,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct RecurringPayment {
    pub id: u64,
    pub proposer: Address,
    pub recipient: Address,
    pub token: Address,
    pub amount: i128,
    pub interval_secs: u64,
    pub start_time: u64,
    pub end_time: u64,
    pub cliff_time: u64,
    pub total_cap: i128,
    pub total_disbursed: i128,
    pub last_disbursed_at: u64,
    pub status: RecurringStatus,
    pub kind: RecurringKind,
    pub category: ProposalCategory,
    pub description: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct CreateRecurringParams {
    pub recipient: Address,
    pub token: Address,
    pub amount: i128,
    pub interval_secs: u64,
    pub start_time: u64,
    pub end_time: u64,
    pub cliff_time: u64,
    pub total_cap: i128,
    pub kind: RecurringKind,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum ProposalKind {
    /// Transfer(transfers)
    Transfer(Vec<Transfer>),
    /// AddOwner(new_owner, weight)
    AddOwner(Address, u32),
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
    /// CreateRecurringPayment
    CreateRecurringPayment(CreateRecurringParams),
    /// CancelRecurringPayment(schedule_id)
    CancelRecurringPayment(u64),
    /// PauseRecurringPayment(schedule_id)
    PauseRecurringPayment(u64),
    /// ResumeRecurringPayment(schedule_id)
    ResumeRecurringPayment(u64),
    /// ModifyRecurringPayment(params)
    ModifyRecurringPayment(ModifyRecurringParams),
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ModifyRecurringParams {
    pub schedule_id: u64,
    pub new_amount: Option<i128>,
    pub new_interval_secs: Option<u64>,
    pub new_end_time: Option<u64>,
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
    pub approval_weight: u32,
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
pub struct OwnerWeight {
    pub owner: Address,
    pub weight: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct SpendingLimitEntry {
    pub token: Address,
    pub limit: i128,
}

/// An owner's delegation of (part of) their voting weight to another owner.
/// An owner may hold at most one outgoing delegation at a time; creating a
/// new one replaces the previous.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct Delegation {
    pub delegator: Address,
    pub delegate: Address,
    pub weight: u32,
    /// Ledger timestamp (seconds) after which this delegation is no longer active.
    pub expiry: Option<u64>,
}

/// A delegator's outgoing delegation alongside every delegation received
/// from other owners, as returned by `get_delegations`.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct DelegationInfo {
    pub outgoing: Vec<Delegation>,
    pub incoming: Vec<Delegation>,
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
pub struct SpendingLimit {
    pub limit: i128,
    pub spent: i128,
    pub window_started_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct RecurringPaymentSchedule {
    pub id: u64,
    pub proposer: Address,
    pub recipient: Address,
    pub amount: i128,
    pub token: Address,
    pub interval: u64,
    pub start: u64,
    pub cliff: Option<u64>,
    pub end: Option<u64>,
    pub cap: Option<i128>,
    pub category: ProposalCategory,
    pub last_disbursed_at: u64,
    pub total_disbursed: i128,
    pub periods_disbursed: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct RecurringPaymentDisbursedEvent {
    pub schedule_id: u64,
    pub recipient: Address,
    pub token: Address,
    pub amount: i128,
    pub total_disbursed: i128,
    pub periods_disbursed: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct RecurringPaymentPausedEvent {
    pub id: u64,
    pub caller: Address,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct RecurringPaymentResumedEvent {
    pub id: u64,
    pub caller: Address,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct RecurringPaymentModifiedEvent {
    pub schedule_id: u64,
    pub previous_amount: i128,
    pub new_amount: i128,
    pub previous_interval: u64,
    pub new_interval: u64,
    pub previous_end_time: u64,
    pub new_end_time: u64,
}

/// Emitted when a recurring payment schedule is created through the execution
/// of a `CreateRecurringPayment` proposal. Carries the full set of schedule
/// parameters so that indexers and frontends can reconstruct the schedule from
/// the event log alone without querying contract state.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct RecurringPaymentCreatedEvent {
    /// The new schedule's ID, assigned sequentially at creation time.
    pub id: u64,
    /// The owner whose proposal was executed to create this schedule.
    pub proposer: Address,
    /// The address that will receive each period's disbursement.
    pub recipient: Address,
    /// The token contract address used for disbursements.
    pub token: Address,
    /// The amount transferred per period.
    pub amount: i128,
    /// The minimum number of seconds that must elapse between disbursements.
    pub interval_secs: u64,
    /// The earliest timestamp at which the first disbursement may occur.
    pub start_time: u64,
    /// Optional hard end timestamp; disbursements after this point are rejected.
    pub end_time: u64,
    /// Optional cliff timestamp; the first disbursement is not due until this
    /// time even if `start_time` has already passed.
    pub cliff_time: u64,
    /// Optional cumulative cap; disbursements stop once `total_disbursed` would
    /// exceed this value.
    pub total_cap: i128,
    /// The schedule's disbursement kind (fixed-amount or linear-vesting).
    pub kind: RecurringKind,
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
    InvalidInterval = 28,
    InvalidSchedule = 29,
    InvalidCap = 30,
    SpendingLimitExceeded = 31,
    RecurringPaymentNotFound = 32,
    RecurringPaymentNotDue = 33,
    RecurringPaymentComplete = 34,
    RecurringPaymentInactive = 35,
    RecurringIntervalNotElapsed = 36,
    TooManyActiveRecurring = 37,
    ScheduleAlreadyCancelled = 38,
    ScheduleAlreadyPaused = 39,
    ScheduleNotPaused = 40,
    ScheduleTerminal = 41,
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

fn active_ids_key() -> Symbol {
    symbol_short!("ACTIDS")
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

fn recurring_next_id_key() -> Symbol {
    symbol_short!("RPNEXT")
}

fn recurring_payment_key(id: u64) -> (Symbol, u64) {
    (symbol_short!("RPAY"), id)
}

fn spending_limit_key(owner: &Address, token: &Address) -> (Symbol, Address, Address) {
    (symbol_short!("SPLIM"), owner.clone(), token.clone())
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
/// Minimum recurring payment interval: 1 second.
const MIN_RECURRING_INTERVAL: u64 = 1;
/// Maximum recurring payment interval: 365 days.
const MAX_RECURRING_INTERVAL: u64 = 31_536_000;
/// Spending-limit accounting window: 30 days.
const SPENDING_LIMIT_WINDOW: u64 = 2_592_000;

/// Minimum owner weight.
const MIN_OWNER_WEIGHT: u32 = 1;
/// Maximum owner weight.
const MAX_OWNER_WEIGHT: u32 = 100_000;
/// Maximum possible total voting weight when every owner is at the maximum
/// allowed weight. With the current bounds this is 20 × 100_000 = 2_000_000,
/// which fits comfortably within u32 and keeps all running-total weight sums
/// safe from overflow.
const MAX_TOTAL_WEIGHT: u32 = MAX_OWNERS * MAX_OWNER_WEIGHT;
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

/// Minimum interval for recurring payments: 1 minute (60s).
const MIN_INTERVAL_SECS: u64 = 60;
/// Maximum interval for recurring payments: 1 year (31,536,000s).
const MAX_INTERVAL_SECS: u64 = 31_536_000;
/// Maximum concurrent active recurring schedules.
const MAX_ACTIVE_RECURRING: u32 = 20;

fn recur_key(id: u64) -> (Symbol, u64) {
    (symbol_short!("RECUR"), id)
}

fn recur_next_id_key() -> Symbol {
    symbol_short!("RNEXT")
}

fn active_recur_count_key() -> Symbol {
    symbol_short!("ACTREC")
}

fn read_recurring_payment(env: &Env, id: u64) -> Result<RecurringPayment, ContractError> {
    let key = recur_key(id);
    let schedule: RecurringPayment = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(ContractError::RecurringPaymentNotFound)?;
    bump_persistent(env, &key);
    Ok(schedule)
}

fn write_recurring_payment(env: &Env, schedule: &RecurringPayment) {
    let key = recur_key(schedule.id);
    env.storage().persistent().set(&key, schedule);
    bump_persistent(env, &key);
}

fn read_next_recurring_id(env: &Env) -> u64 {
    let id = env
        .storage()
        .instance()
        .get(&recur_next_id_key())
        .unwrap_or(1_u64);
    bump_instance(env);
    id
}

fn write_next_recurring_id(env: &Env, id: u64) {
    env.storage().instance().set(&recur_next_id_key(), &id);
    bump_instance(env);
}

fn read_active_recurring_count(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&active_recur_count_key())
        .unwrap_or(0)
}

fn write_active_recurring_count(env: &Env, count: u32) {
    env.storage().instance().set(&active_recur_count_key(), &count);
    bump_instance(env);
}

fn derive_recurring_status(env: &Env, schedule: &RecurringPayment) -> RecurringStatus {
    if schedule.status == RecurringStatus::Cancelled {
        return RecurringStatus::Cancelled;
    }
    if schedule.status == RecurringStatus::Paused {
        return RecurringStatus::Paused;
    }

    let now = env.ledger().timestamp();
    let time_completed = schedule.end_time > 0 && now >= schedule.end_time;
    let cap_completed = schedule.total_cap > 0 && schedule.total_disbursed >= schedule.total_cap;

    if time_completed || cap_completed {
        return RecurringStatus::Completed;
    }

    RecurringStatus::Active
}

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

fn read_delegation(env: &Env, delegator: &Address) -> Option<Delegation> {
    let key = delegation_key(delegator);
    let delegation: Option<Delegation> = env.storage().persistent().get(&key);
    if delegation.is_some() {
        bump_persistent(env, &key);
    }
    delegation
}

fn write_delegation(env: &Env, delegation: &Delegation) {
    let key = delegation_key(&delegation.delegator);
    env.storage().persistent().set(&key, delegation);
    bump_persistent(env, &key);
}

fn remove_delegation(env: &Env, delegator: &Address) {
    env.storage().persistent().remove(&delegation_key(delegator));
}

fn is_delegation_active(env: &Env, delegation: &Delegation) -> bool {
    match delegation.expiry {
        Some(expiry) => expiry > env.ledger().timestamp(),
        None => true,
    }
}

/// Computes `owner`'s effective weight given their already-known raw weight:
/// raw weight, minus an active outgoing delegation, plus any active incoming
/// delegations. Shared by the `get_effective_weight` view and by `approve`,
/// so approvals are always counted using the same delegation-aware weight
/// that callers can independently verify.
fn compute_effective_weight(
    env: &Env,
    owners: &Map<Address, u32>,
    owner: &Address,
    raw_weight: u32,
) -> Result<u32, ContractError> {
    let mut effective = raw_weight;

    if let Some(outgoing) = read_delegation(env, owner) {
        if is_delegation_active(env, &outgoing) {
            effective = checked_weight_sub(effective, outgoing.weight)?;
        }
    }

    for other in owners.keys().iter() {
        if other == *owner {
            continue;
        }
        if let Some(delegation) = read_delegation(env, &other) {
            if delegation.delegate == *owner && is_delegation_active(env, &delegation) {
                effective = checked_weight_add(effective, delegation.weight)?;
            }
        }
    }

    Ok(effective)
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

/// Returns the effective weight that was counted for this owner's approval of
/// `proposal_id`, or 0 if they have not approved (or have since revoked). The
/// exact weight is stored — rather than recomputed from current delegation
/// state — so `revoke` and owner-removal cleanup always reverse precisely
/// what `approve` added, even if delegations have changed in between.
fn read_approval_weight(env: &Env, proposal_id: u64, owner: &Address) -> u32 {
    let key = approval_key(proposal_id, owner);
    let weight: u32 = env.storage().persistent().get(&key).unwrap_or(0);
    if weight > 0 {
        bump_persistent(env, &key);
    }
    weight
}

fn write_approval_weight(env: &Env, proposal_id: u64, owner: &Address, weight: u32) {
    let key = approval_key(proposal_id, owner);
    if weight == 0 {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, &weight);
        bump_persistent(env, &key);
    }
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
    limit
}

fn write_spending_limit(env: &Env, owner: &Address, token: &Address, limit: i128) {
    let key = spending_limit_key(owner, token);
    env.storage().persistent().set(&key, &limit);
    bump_persistent(env, &key);
}

fn read_owner_spending_limits(env: &Env, owner: &Address) -> Vec<SpendingLimitEntry> {
    let key = owner_spending_limits_key(owner);
    let limits: Vec<SpendingLimitEntry> = env.storage().persistent().get(&key).unwrap_or(Vec::new(env));
    if env.storage().persistent().has(&key) {
        bump_persistent(env, &key);
    }
    limits
}

fn write_owner_spending_limits(env: &Env, owner: &Address, limits: &Vec<SpendingLimitEntry>) {
    let key = owner_spending_limits_key(owner);
    env.storage().persistent().set(&key, limits);
    bump_persistent(env, &key);
}

fn upsert_owner_spending_limit(env: &Env, owner: &Address, token: &Address, limit: i128) {
    let mut limits = read_owner_spending_limits(env, owner);
    let mut updated = false;
    for idx in 0..limits.len() {
        let mut entry = limits.get(idx).unwrap();
        if entry.token == *token {
            entry.limit = limit;
            limits.set(idx, entry);
            updated = true;
            break;
        }
    }

    if !updated {
        limits.push_back(SpendingLimitEntry {
            token: token.clone(),
            limit,
        });
    }

    write_owner_spending_limits(env, owner, &limits);
}

fn read_recurring_next_id(env: &Env) -> u64 {
    let id = env
        .storage()
        .instance()
        .get(&recurring_next_id_key())
        .unwrap_or(1_u64);
    bump_instance(env);
    id
}

fn write_recurring_next_id(env: &Env, id: u64) {
    env.storage().instance().set(&recurring_next_id_key(), &id);
    bump_instance(env);
}

fn read_recurring_payment(env: &Env, id: u64) -> Result<RecurringPaymentSchedule, ContractError> {
    let key = recurring_payment_key(id);
    let schedule = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(ContractError::RecurringPaymentNotFound)?;
    bump_persistent(env, &key);
    Ok(schedule)
}

fn write_recurring_payment(env: &Env, schedule: &RecurringPaymentSchedule) {
    let key = recurring_payment_key(schedule.id);
    env.storage().persistent().set(&key, schedule);
    bump_persistent(env, &key);
}

fn read_spending_limit(env: &Env, owner: &Address, token: &Address) -> Option<SpendingLimit> {
    let key = spending_limit_key(owner, token);
    let limit = env.storage().persistent().get(&key);
    if env.storage().persistent().has(&key) {
        bump_persistent(env, &key);
    }
    limit
}

fn write_spending_limit(env: &Env, owner: &Address, token: &Address, limit: &SpendingLimit) {
    let key = spending_limit_key(owner, token);
    env.storage().persistent().set(&key, limit);
    bump_persistent(env, &key);
}

fn require_not_frozen(env: &Env) -> Result<(), ContractError> {
    if is_frozen_state(env) {
        return Err(ContractError::ContractFrozen);
    }
    Ok(())
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

/// Returns the current number of active proposals read directly from the persisted `ACTCNT` storage.
///
/// Quietly expired proposals (proposals whose deadline passed without an explicit `execute` or
/// `cancel_expired`) are lazily purged from the tracked active set (`ACTIDS`) during proposal
/// creation (`register_active_proposal`) and removal, ensuring `ACTCNT` and `TooManyActiveProposals`
/// checks stay exact and bounded without scanning full proposal history.
fn read_active_count(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&active_count_key())
        .unwrap_or(0)
}

fn write_active_count(env: &Env, count: u32) {
    env.storage().instance().set(&active_count_key(), &count);
    bump_instance(env);
}

fn read_active_ids(env: &Env) -> Vec<u64> {
    let key = active_ids_key();
    let ids: Vec<u64> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env));
    if env.storage().persistent().has(&key) {
        bump_persistent(env, &key);
    }
    ids
}

fn write_active_ids(env: &Env, ids: &Vec<u64>) {
    let key = active_ids_key();
    env.storage().persistent().set(&key, ids);
    bump_persistent(env, &key);
}

fn register_active_proposal(env: &Env, new_id: u64) -> Result<(), ContractError> {
    let active_ids = read_active_ids(env);
    let mut filtered_ids = Vec::new(env);

    for id in active_ids.iter() {
        if let Ok(proposal) = read_proposal(env, id) {
            let status = derive_status(env, &proposal);
            if matches!(status, ProposalStatus::Pending | ProposalStatus::Ready) {
                filtered_ids.push_back(id);
            }
        }
    }

    if filtered_ids.len() >= MAX_ACTIVE_PROPOSALS {
        return Err(ContractError::TooManyActiveProposals);
    }

    filtered_ids.push_back(new_id);
    let count = filtered_ids.len();
    write_active_ids(env, &filtered_ids);
    write_active_count(env, count);
    Ok(())
}

fn remove_active_proposals(env: &Env, remove_ids: &Vec<u64>) {
    let active_ids = read_active_ids(env);
    let mut filtered_ids = Vec::new(env);

    for id in active_ids.iter() {
        let mut should_remove = false;
        for rid in remove_ids.iter() {
            if id == rid {
                should_remove = true;
                break;
            }
        }
        if !should_remove {
            if let Ok(proposal) = read_proposal(env, id) {
                let status = derive_status(env, &proposal);
                if matches!(status, ProposalStatus::Pending | ProposalStatus::Ready) {
                    filtered_ids.push_back(id);
                }
            }
        }
    }

    let count = filtered_ids.len();
    write_active_ids(env, &filtered_ids);
    write_active_count(env, count);
}

fn remove_active_proposal(env: &Env, remove_id: u64) {
    let mut remove_ids = Vec::new(env);
    remove_ids.push_back(remove_id);
    remove_active_proposals(env, &remove_ids);
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

// `proposal.approvals` is a running sum of each approver's effective
// (delegation-aware) weight at the moment they approved — see `approve` —
// so this comparison is already a quorum check against effective weight.
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

fn validate_recurring_payment(
    env: &Env,
    recipient: &Address,
    amount: i128,
    token_address: &Address,
    interval: u64,
    start: u64,
    cliff: &Option<u64>,
    end: &Option<u64>,
    cap: &Option<i128>,
) -> Result<(), ContractError> {
    if amount < MIN_AMOUNT {
        return Err(ContractError::InvalidAmount);
    }
    if interval < MIN_RECURRING_INTERVAL || interval > MAX_RECURRING_INTERVAL {
        return Err(ContractError::InvalidInterval);
    }
    validate_token(env, token_address)?;
    if recipient == &env.current_contract_address() {
        return Err(ContractError::InvalidRecipient);
    }
    if let Some(end_at) = end {
        if *end_at <= start {
            return Err(ContractError::InvalidSchedule);
        }
        if let Some(cliff_at) = cliff {
            if cliff_at > end_at {
                return Err(ContractError::InvalidSchedule);
            }
        }
    }
    if let Some(total_cap) = cap {
        if *total_cap < amount {
            return Err(ContractError::InvalidCap);
        }
    }
    Ok(())
}

fn reserve_spending_limit(
    env: &Env,
    owner: &Address,
    token_address: &Address,
    amount: i128,
) -> Result<(), ContractError> {
    let Some(mut limit) = read_spending_limit(env, owner, token_address) else {
        return Ok(());
    };

    let now = env.ledger().timestamp();
    if now.saturating_sub(limit.window_started_at) >= SPENDING_LIMIT_WINDOW {
        limit.window_started_at = now;
        limit.spent = 0;
    }

    let next_spent = limit
        .spent
        .checked_add(amount)
        .ok_or(ContractError::ArithmeticError)?;
    if next_spent > limit.limit {
        return Err(ContractError::SpendingLimitExceeded);
    }

    limit.spent = next_spent;
    write_spending_limit(env, owner, token_address, &limit);
    Ok(())
}

fn recurring_payment_due_at(schedule: &RecurringPaymentSchedule) -> Result<u64, ContractError> {
    if schedule.periods_disbursed == 0 {
        return Ok(match schedule.cliff {
            Some(cliff) if cliff > schedule.start => cliff,
            _ => schedule.start,
        });
    }
    schedule
        .last_disbursed_at
        .checked_add(schedule.interval)
        .ok_or(ContractError::ArithmeticError)
}

// ─── Contract ────────────────────────────────────────────────────────────────

#[contract]
pub struct AccordContract;

#[contractimpl]
impl AccordContract {
    /// One-shot initializer. Sets the list of owners with their individual
    /// voting weights, the approval threshold, and an optional time-lock delay
    /// (in seconds). A delay of 0 means no time-lock is enforced.
    ///
    /// # Arguments
    /// * `owners` - Non-empty list of unique owner addresses (max 20).
    /// * `weights` - Per-owner voting weights, one per owner, in the same order
    ///   as `owners`. Each weight must be within `[MIN_OWNER_WEIGHT,
    ///   MAX_OWNER_WEIGHT]`. The list length must exactly match `owners.len()`.
    ///   The sum of all weights becomes the initial total-weight counter used
    ///   for quorum calculations.
    /// * `threshold` - Absolute weight value required to execute a proposal
    ///   (1 ≤ threshold ≤ sum of all owner weights). A proposal becomes
    ///   `Ready` once its cumulative approval weight meets or exceeds this
    ///   value.
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
            if weight < MIN_OWNER_WEIGHT {
                return Err(ContractError::WeightBelowMinimum);
            }
            if weight > MAX_OWNER_WEIGHT {
                return Err(ContractError::InvalidWeight);
            }
            owner.require_auth();
            owners_map.set(owner.clone(), weight);
            total_weight = checked_weight_add(total_weight, weight)?;
        }

        if total_weight > MAX_TOTAL_WEIGHT {
            return Err(ContractError::ArithmeticError);
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

        let threshold = read_threshold(&env)?;
        let id = read_next_id(&env);

        let proposal = Proposal {
            id,
            proposer: proposer.clone(),
            description,
            deadline,
            approvals: 0,
            approval_weight: 0,
            status: ProposalStatus::Pending,
            kind: ProposalKind::Transfer(transfers.clone()),
            ready_at: 0,
            quorum_weight: threshold,
            category: category.clone(),
        };
        write_proposal(&env, &proposal);
        register_active_proposal(&env, id)?;

        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

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

    /// Sets or replaces a 30-day spending limit for an owner/token pair.
    pub fn set_spending_limit(
        env: Env,
        caller: Address,
        owner: Address,
        token: Address,
        limit: i128,
    ) -> Result<(), ContractError> {
        caller.require_auth();
        require_owner(&env, &caller)?;
        require_owner(&env, &owner)?;
        require_not_frozen(&env)?;

        if limit < MIN_AMOUNT {
            return Err(ContractError::InvalidAmount);
        }
        validate_token(&env, &token)?;

        let spending_limit = SpendingLimit {
            limit,
            spent: 0,
            window_started_at: env.ledger().timestamp(),
        };
        write_spending_limit(&env, &owner, &token, &spending_limit);

        Ok(())
    }

    /// Creates an active recurring payment schedule after validating the
    /// proposer's current spending-limit window against the first period.
    pub fn create_recurring_payment(
        env: Env,
        proposer: Address,
        recipient: Address,
        amount: i128,
        token: Address,
        interval: u64,
        start: u64,
        cliff: Option<u64>,
        end: Option<u64>,
        cap: Option<i128>,
        category: ProposalCategory,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_owner(&env, &proposer)?;
        require_not_frozen(&env)?;

        let active = read_active_recurring_count(&env);
        if active >= MAX_ACTIVE_RECURRING {
            return Err(ContractError::TooManyActiveRecurring);
        }

        validate_recurring_payment(
            &env, &recipient, amount, &token, interval, start, &cliff, &end, &cap,
        )?;
        reserve_spending_limit(&env, &proposer, &token, amount)?;

        let id = read_recurring_next_id(&env);
        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_recurring_next_id(&env, next_id);

        let schedule = RecurringPaymentSchedule {
            id,
            proposer,
            recipient,
            amount,
            token,
            interval,
            start,
            cliff,
            end,
            cap,
            category,
            last_disbursed_at: 0,
            total_disbursed: 0,
            periods_disbursed: 0,
        };
        write_recurring_payment(&env, &schedule);
        write_active_recurring_count(
            &env,
            active
                .checked_add(1)
                .ok_or(ContractError::ArithmeticError)?,
        );

        Ok(id)
    }

    /// Disburses one due period for a recurring payment schedule.
    ///
    /// **Catch-up policy: one period per call.**
    /// If multiple intervals have elapsed since the last disbursement (e.g.
    /// because no one cranked the schedule, or because it was paused for
    /// several intervals), each call to `disburse_recurring` transfers exactly
    /// one period's amount. The caller must invoke this function once per
    /// missed period to "catch up". The alternative — disbursing all missed
    /// periods in a single call — was rejected because it would allow a single
    /// transaction to drain an arbitrarily large share of the contract's
    /// treasury, making the disbursement cost unpredictable and opening a
    /// denial-of-service vector if the accumulated debt is large enough to
    /// exhaust the transaction's resource budget. One-period-per-call keeps
    /// each call's cost bounded and gives the multisig owners the opportunity
    /// to cancel or pause a misbehaving schedule between periods.
    ///
    /// Non-retroactive pause/resume policy:
    /// Paused schedules cannot disburse, and `last_disbursed_at` does not advance while paused.
    /// When resumed, the schedule continues from its pre-pause `last_disbursed_at`, requiring
    /// a full interval to elapse before the next disbursement. Missed periods during pause are
    /// not retroactively granted.
    pub fn disburse_recurring(
        env: Env,
        caller: Address,
        schedule_id: u64,
    ) -> Result<(), ContractError> {
        caller.require_auth();
        require_owner(&env, &caller)?;
        require_not_frozen(&env)?;

        let mut schedule = read_recurring_payment(&env, schedule_id)?;

        // Paused schedules cannot disburse and must not mutate state or advance last_disbursed_at
        if schedule.status == RecurringStatus::Paused {
            return Err(ContractError::RecurringPaymentInactive);
        }

        let now = env.ledger().timestamp();
        let due_at = recurring_payment_due_at(&schedule)?;

        if now < due_at {
            return Err(ContractError::RecurringIntervalNotElapsed);
        }
        if let Some(end_at) = schedule.end {
            if due_at > end_at || now > end_at {
                return Err(ContractError::RecurringPaymentComplete);
            }
        }
        let projected_total = schedule
            .total_disbursed
            .checked_add(schedule.amount)
            .ok_or(ContractError::ArithmeticError)?;
        if let Some(total_cap) = schedule.cap {
            if projected_total > total_cap {
                return Err(ContractError::RecurringPaymentComplete);
            }
        }

        let token_client = token::Client::new(&env, &schedule.token);
        let treasury = env.current_contract_address();
        let balance = token_client.balance(&treasury);
        if balance < schedule.amount {
            return Err(ContractError::TransferFailed);
        }
        if token_client
            .try_transfer(&treasury, &schedule.recipient, &schedule.amount)
            .is_err()
        {
            return Err(ContractError::TransferFailed);
        }

        // Attribute each disbursement to the schedule's original proposer in the spent tracker
        let tracker = read_spent_tracker(&env, &schedule.proposer, &schedule.token);
        let epoch = if tracker.epoch == 0 {
            now
        } else {
            tracker.epoch
        };
        let spent = if now > epoch.saturating_add(SPENDING_WINDOW) {
            schedule.amount
        } else {
            tracker
                .spent
                .checked_add(schedule.amount)
                .ok_or(ContractError::ArithmeticError)?
        };
        write_spent_tracker(&env, &schedule.proposer, &schedule.token, &SpentTracker { spent, epoch });

        schedule.last_disbursed_at = now;
        schedule.total_disbursed = projected_total;
        schedule.periods_disbursed = schedule
            .periods_disbursed
            .checked_add(1)
            .ok_or(ContractError::ArithmeticError)?;
        write_recurring_payment(&env, &schedule);

        env.events().publish(
            (symbol_short!("rpay"),),
            RecurringPaymentDisbursedEvent {
                schedule_id,
                recipient: schedule.recipient.clone(),
                token: schedule.token.clone(),
                amount: schedule.amount,
                total_disbursed: schedule.total_disbursed,
                periods_disbursed: schedule.periods_disbursed,
            },
        );

        Ok(())
    }

    /// Returns a recurring payment schedule by ID.
    pub fn get_recurring_payment(
        env: Env,
        schedule_id: u64,
    ) -> Result<RecurringPaymentSchedule, ContractError> {
        read_recurring_payment(&env, schedule_id)
    }

    /// Returns an owner's current spending-limit window for a token, if set.
    pub fn get_spending_limit(env: Env, owner: Address, token: Address) -> Option<SpendingLimit> {
        read_spending_limit(&env, &owner, &token)
    }

    /// Returns the current spent tracker for an owner and token.
    pub fn get_spent_tracker(env: Env, owner: Address, token: Address) -> SpentTracker {
        read_spent_tracker(&env, &owner, &token)
    }

    /// Creates a proposal to add a new owner to the multisig.
    pub fn create_add_owner_proposal(
        env: Env,
        proposer: Address,
        new_owner: Address,
        weight: u32,
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

        if !(MIN_OWNER_WEIGHT..=MAX_OWNER_WEIGHT).contains(&weight) {
            return Err(ContractError::InvalidWeight);
        }

        let current_total = read_total_weight(&env);
        let resulting_total = checked_weight_add(current_total, weight)?;
        if !owner_weight_within_cap(&env, weight, resulting_total) {
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

        let threshold = read_threshold(&env)?;
        let id = read_next_id(&env);

        let proposal = Proposal {
            id,
            proposer: proposer.clone(),
            description,
            deadline,
            approvals: 0,
            approval_weight: 0,
            status: ProposalStatus::Pending,
            kind: ProposalKind::AddOwner(new_owner, weight),
            ready_at: 0,
            quorum_weight: threshold,
            category: ProposalCategory::Other,
        };
        write_proposal(&env, &proposal);
        register_active_proposal(&env, id)?;

        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

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

        let threshold = read_threshold(&env)?;
        let id = read_next_id(&env);

        let proposal = Proposal {
            id,
            proposer: proposer.clone(),
            description,
            deadline,
            approvals: 0,
            approval_weight: 0,
            status: ProposalStatus::Pending,
            kind: ProposalKind::SetSpendingLimit(owner, token, limit),
            ready_at: 0,
            quorum_weight: threshold,
            category: ProposalCategory::Other,
        };
        write_proposal(&env, &proposal);
        register_active_proposal(&env, id)?;

        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

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

        if new_weight < MIN_OWNER_WEIGHT {
            return Err(ContractError::WeightBelowMinimum);
        }
        if new_weight > MAX_OWNER_WEIGHT {
            return Err(ContractError::InvalidWeight);
        }

        let owners = read_owners_map(&env)?;
        if !owners.contains_key(target_owner.clone()) {
            return Err(ContractError::OwnerNotFound);
        }

        let target_weight = owners.get(target_owner.clone()).unwrap();

        let current_total = read_total_weight(&env);
        let resulting_total = checked_weight_add(
            checked_weight_sub(current_total, target_weight)?,
            new_weight,
        )?;
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

        let threshold = read_threshold(&env)?;
        let id = read_next_id(&env);

        let proposal = Proposal {
            id,
            proposer: proposer.clone(),
            description,
            deadline,
            approvals: 0,
            approval_weight: 0,
            status: ProposalStatus::Pending,
            kind: ProposalKind::ChangeOwnerWeight(target_owner, new_weight),
            ready_at: 0,
            quorum_weight: threshold,
            category: ProposalCategory::Other,
        };
        write_proposal(&env, &proposal);
        register_active_proposal(&env, id)?;

        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

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
    /// Automatically transitions the proposal to `Ready` when the approval count reaches threshold.
    /// Records `ready_at` the first time the threshold is crossed.
    pub fn approve(env: Env, approver: Address, proposal_id: u64) -> Result<(), ContractError> {
        approver.require_auth();
        require_owner(&env, &approver)?;

        let proposal = Proposal {
            id,
            proposer: proposer.clone(),
            description,
            deadline,
            approvals: 0,
            approval_weight: 0,
            status: ProposalStatus::Pending,
            kind: ProposalKind::RemoveOwner(owner_to_remove),
            ready_at: 0,
            quorum_weight: threshold,
            category: ProposalCategory::Other,
        };
        write_proposal(&env, &proposal);
        register_active_proposal(&env, id)?;

        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

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

        let threshold = read_threshold(&env)?;
        let id = read_next_id(&env);

        let proposal = Proposal {
            id,
            proposer: proposer.clone(),
            description,
            deadline,
            approvals: 0,
            approval_weight: 0,
            status: ProposalStatus::Pending,
            kind: ProposalKind::ChangeThreshold(new_threshold),
            ready_at: 0,
            quorum_weight: threshold,
            category: ProposalCategory::Other,
        };
        write_proposal(&env, &proposal);
        register_active_proposal(&env, id)?;

        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

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
        let owners = read_owners_map(&env)?;
        let raw_weight = owners.get(approver.clone()).ok_or(ContractError::Unauthorized)?;
        let mut proposal = read_proposal(&env, proposal_id)?;

        // Refresh derived status so an already-expired proposal is caught here.
        proposal.status = derive_status(&env, &proposal);

        if !matches!(
            proposal.status,
            ProposalStatus::Pending | ProposalStatus::Ready
        ) {
            return Err(ContractError::ProposalNotActive);
        }

        if read_approval_weight(&env, proposal_id, &approver) > 0 {
            return Err(ContractError::AlreadyApproved);
        }

        // Count the approver's effective (delegation-aware) weight, not just
        // their own raw weight — the exact value is stored per-approval so
        // `revoke` can later reverse precisely this amount.
        let weight = compute_effective_weight(&env, &owners, &approver, raw_weight)?;
        write_approval_weight(&env, proposal_id, &approver, weight);

        proposal.approvals = checked_weight_add(proposal.approvals, weight)?;

        proposal.approval_weight = checked_weight_add(proposal.approval_weight, weight)?;

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
        require_owner(&env, &approver)?;

        let mut proposal = read_proposal(&env, proposal_id)?;

        proposal.status = derive_status(&env, &proposal);

        if matches!(proposal.status, ProposalStatus::Expired) {
            // Persist the expired status and free up the active slot.
            write_proposal(&env, &proposal);
            remove_active_proposal(&env, proposal_id);
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
            ProposalKind::AddOwner(new_owner, weight) => {
                if !(MIN_OWNER_WEIGHT..=MAX_OWNER_WEIGHT).contains(weight) {
                    return Err(ContractError::InvalidWeight);
                }

                let owners = read_owners_map(&env)?;
                let prev_count = owners.len();

                // Re-check at execute time: adding an owner must not push the
                // owner count past MAX_OWNERS (20). The creation-time check
                // in create_add_owner_proposal only validates against the
                // owner count at proposal creation — a concurrent AddOwner
                // proposal executed beforehand could have already filled the
                // last slot.
                if prev_count >= MAX_OWNERS {
                    return Err(ContractError::InvalidOwners);
                }

                let current_total = read_total_weight(&env);
                let new_total = checked_weight_add(current_total, *weight)?;
                if !owner_weight_within_cap(&env, *weight, new_total) {
                    return Err(ContractError::SingleOwnerWeightCapExceeded);
                }

                let mut owners = owners;
                owners.set(new_owner.clone(), *weight);
                let key = owners_key();
                env.storage().persistent().set(&key, &owners);
                bump_persistent(&env, &key);

                let current_total = read_total_weight(&env);
                let new_total = current_total.checked_add(*weight).ok_or(ContractError::ArithmeticError)?;
                write_total_weight(&env, new_total);

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

                let current_total_weight = read_total_weight(&env);
                let resulting_total_weight = checked_weight_sub(current_total_weight, weight)?;

                // Re-validation 1: Ensure the resulting total weight is still >= the contract's current threshold.
                let current_threshold = read_threshold(&env)?;
                if resulting_total_weight < current_threshold {
                    return Err(ContractError::WouldBreakThreshold);
                }

                // Re-validation 2: Ensure no other active (Pending/Ready) proposal would become un-quorumable.
                // The current proposal (this one) is already being executed, so it doesn't
                // need to be checked against itself.
                let next_id = read_next_id(&env);
                for id in 1..next_id {
                    if id == proposal_id {
                        continue;
                    }
                    if let Ok(active_proposal) = read_proposal(&env, id) {
                        let status = derive_status(&env, &active_proposal);
                        if matches!(status, ProposalStatus::Pending | ProposalStatus::Ready)
                            && active_proposal.quorum_weight > resulting_total_weight
                        {
                            return Err(ContractError::WouldBreakThreshold);
                        }
                    }
                }
                owners.remove(owner_to_remove.clone());
                let key = owners_key();
                env.storage().persistent().set(&key, &owners);
                bump_persistent(&env, &key);

                write_total_weight(
                    &env,
                    resulting_total_weight,
                );

                // Remove the removed owner's approval weight from all
                // Pending and Ready proposals they previously approved.
                // Without this, a removed owner's prior votes would
                // continue counting toward the threshold even after
                // they are no longer an owner — undermining the M-of-N
                // model. Terminal proposals (Executed, Expired, Revoked)
                // are left untouched since their outcome is final.
                let next_id: u64 = env.storage()
                    .instance()
                    .get(&next_id_key())
                    .unwrap_or(1_u64);
                for pid in 1_u64..next_id {
                    if let Ok(mut p) = read_proposal(&env, pid) {
                        let derived = derive_status(&env, &p);
                        if matches!(derived, ProposalStatus::Pending | ProposalStatus::Ready) {
                            // Reverse the exact effective weight stored for this
                            // approval — not the owner's raw weight, which may
                            // differ from what was actually counted.
                            let counted_weight = read_approval_weight(&env, pid, owner_to_remove);
                            if counted_weight > 0 {
                                write_approval_weight(&env, pid, owner_to_remove, 0);
                                p.approvals = checked_weight_sub(p.approvals, counted_weight)?;
                                p.approval_weight =
                                    checked_weight_sub(p.approval_weight, counted_weight)?;
                                p.status = derive_status(&env, &p);
                                write_proposal(&env, &p);
                            }
                        }
                    }
                }

                env.events().publish(
                    (symbol_short!("r_own"),),
                    RemoveOwnerExecutedEvent {
                        removed_owner: owner_to_remove.clone(),
                        owner_count: prev_count - 1,
                    },
                );
            }
            ProposalKind::ChangeThreshold(new_threshold) => {
                let current_total_weight = read_total_weight(&env);
                if *new_threshold > current_total_weight {
                    return Err(ContractError::WouldBreakThreshold);
                }

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
                upsert_owner_spending_limit(&env, owner, token, *limit);
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
                if *new_weight < MIN_OWNER_WEIGHT {
                    return Err(ContractError::WeightBelowMinimum);
                }
                if *new_weight > MAX_OWNER_WEIGHT {
                    return Err(ContractError::InvalidWeight);
                }
                let mut owners = read_owners_map(&env)?;
                let old_weight = owners
                    .get(target_owner.clone())
                    .ok_or(ContractError::TargetOwnerNoLongerExists)?;
                let current_total = read_total_weight(&env);
                let new_total = checked_weight_add(
                    checked_weight_sub(current_total, old_weight)?,
                    *new_weight,
                )?;

                if !owner_weight_within_cap(&env, *new_weight, new_total) {
                    return Err(ContractError::SingleOwnerWeightCapExceeded);
                }

                // Invariant: ensure no active (Pending/Ready) proposal would
                // become un-quorumable (quorum_weight > new_total_weight).
                let active_ids = read_active_ids(&env);
                for id in active_ids.iter() {
                    if let Ok(active_proposal) = read_proposal(&env, id) {
                        let status = derive_status(&env, &active_proposal);
                        if matches!(status, ProposalStatus::Pending | ProposalStatus::Ready)
                            && active_proposal.quorum_weight > new_total
                        {
                            return Err(ContractError::WouldBreakQuorum);
                        }
                    }
                }

                owners.set(target_owner.clone(), *new_weight);
                env.storage().persistent().set(&owners_key(), &owners);
                write_total_weight(&env, new_total);

                env.events().publish(
                    (symbol_short!("c_wgt"),),
                    OwnerWeightChangedEvent {
                        owner: target_owner.clone(),
                        old_weight,
                        new_weight: *new_weight,
                        new_total_weight: new_total,
                    },
                );
            }
            ProposalKind::CreateRecurringPayment(params) => {
                let active = read_active_recurring_count(&env);
                if active >= MAX_ACTIVE_RECURRING {
                    return Err(ContractError::TooManyActiveRecurring);
                }

                let id = read_next_recurring_id(&env);
                write_next_recurring_id(&env, id + 1);

                let schedule = RecurringPayment {
                    id,
                    proposer: proposal.proposer.clone(),
                    recipient: params.recipient.clone(),
                    token: params.token.clone(),
                    amount: params.amount,
                    interval_secs: params.interval_secs,
                    start_time: params.start_time,
                    end_time: params.end_time,
                    cliff_time: params.cliff_time,
                    total_cap: params.total_cap,
                    total_disbursed: 0,
                    last_disbursed_at: 0,
                    status: RecurringStatus::Active,
                    kind: params.kind.clone(),
                    category: proposal.category.clone(),
                    description: proposal.description.clone(),
                };

                write_recurring_payment(&env, &schedule);
                write_active_recurring_count(&env, active + 1);

                env.events().publish(
                    (symbol_short!("r_crt"),),
                    RecurringPaymentCreatedEvent {
                        id,
                        proposer: proposal.proposer.clone(),
                        recipient: params.recipient.clone(),
                        token: params.token.clone(),
                        amount: params.amount,
                        interval_secs: params.interval_secs,
                        start_time: params.start_time,
                        end_time: params.end_time,
                        cliff_time: params.cliff_time,
                        total_cap: params.total_cap,
                        kind: params.kind.clone(),
                    },
                );
            }
            ProposalKind::CancelRecurringPayment(schedule_id) => {
                let mut schedule = read_recurring_payment(&env, *schedule_id)?;
                let status = derive_recurring_status(&env, &schedule);
                if status == RecurringStatus::Cancelled {
                    return Err(ContractError::ScheduleAlreadyCancelled);
                }
                if status == RecurringStatus::Completed {
                    return Err(ContractError::ScheduleTerminal);
                }

                if schedule.status == RecurringStatus::Active || schedule.status == RecurringStatus::Paused {
                    let active = read_active_recurring_count(&env);
                    if active > 0 {
                        write_active_recurring_count(&env, active - 1);
                    }
                }

                schedule.status = RecurringStatus::Cancelled;
                write_recurring_payment(&env, &schedule);

                env.events().publish(
                    (symbol_short!("r_cncl"),),
                    RecurringPaymentCancelledEvent {
                        id: *schedule_id,
                        caller: executor.clone(),
                    },
                );
            }
            ProposalKind::PauseRecurringPayment(schedule_id) => {
                let mut schedule = read_recurring_payment(&env, *schedule_id)?;
                let status = derive_recurring_status(&env, &schedule);
                if status == RecurringStatus::Cancelled || status == RecurringStatus::Completed {
                    return Err(ContractError::ScheduleTerminal);
                }
                if status == RecurringStatus::Paused {
                    return Err(ContractError::ScheduleAlreadyPaused);
                }

                schedule.status = RecurringStatus::Paused;
                write_recurring_payment(&env, &schedule);

                env.events().publish(
                    (symbol_short!("r_pause"),),
                    RecurringPaymentPausedEvent {
                        id: *schedule_id,
                        caller: executor.clone(),
                    },
                );
            }
            ProposalKind::ResumeRecurringPayment(schedule_id) => {
                let mut schedule = read_recurring_payment(&env, *schedule_id)?;
                let status = derive_recurring_status(&env, &schedule);
                if status != RecurringStatus::Paused {
                    return Err(ContractError::ScheduleNotPaused);
                }

                schedule.status = RecurringStatus::Active;
                write_recurring_payment(&env, &schedule);

                env.events().publish(
                    (symbol_short!("r_resum"),),
                    RecurringPaymentResumedEvent {
                        id: *schedule_id,
                        caller: executor.clone(),
                    },
                );
            }
            ProposalKind::ModifyRecurringPayment(params) => {
                let mut schedule = read_recurring_payment(&env, params.schedule_id)?;
                let status = derive_recurring_status(&env, &schedule);
                if status == RecurringStatus::Cancelled || status == RecurringStatus::Completed {
                    return Err(ContractError::ScheduleTerminal);
                }

                let previous_amount = schedule.amount;
                let previous_interval = schedule.interval_secs;
                let previous_end_time = schedule.end_time;

                if let Some(amt) = params.new_amount {
                    if amt < MIN_AMOUNT {
                        return Err(ContractError::InvalidAmount);
                    }
                    schedule.amount = amt;
                }
                if let Some(inv) = params.new_interval_secs {
                    if !(MIN_INTERVAL_SECS..=MAX_INTERVAL_SECS).contains(&inv) {
                        return Err(ContractError::InvalidInterval);
                    }
                    schedule.interval_secs = inv;
                }
                if let Some(end_t) = params.new_end_time {
                    if end_t <= schedule.start_time {
                        return Err(ContractError::InvalidDeadline);
                    }
                    schedule.end_time = end_t;
                }

                write_recurring_payment(&env, &schedule);

                env.events().publish(
                    (symbol_short!("r_mod"),),
                    RecurringPaymentModifiedEvent {
                        schedule_id: params.schedule_id,
                        previous_amount,
                        new_amount: schedule.amount,
                        previous_interval,
                        new_interval: schedule.interval_secs,
                        previous_end_time,
                        new_end_time: schedule.end_time,
                    },
                );
            }
        }

        proposal.status = ProposalStatus::Executed;
        write_proposal(&env, &proposal);

        remove_active_proposal(&env, proposal_id);

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
        let mut swept_ids = Vec::new(&env);

        for id in ids.iter() {
            let proposal = match read_proposal(&env, id) {
                Ok(p) => p,
                Err(_) => continue,
            };

            if matches!(derive_status(&env, &proposal), ProposalStatus::Expired) {
                swept = swept.saturating_add(1);
                swept_ids.push_back(id);
            }
        }

        if swept > 0 {
            remove_active_proposals(&env, &swept_ids);
        }

        Ok(swept)
    }

    // ─── Recurring Payments ──────────────────────────────────────────────────

    pub fn create_recurring_proposal(
        env: Env,
        proposer: Address,
        recipient: Address,
        token: Address,
        amount: i128,
        interval_secs: u64,
        start_time: u64,
        end_time: u64,
        cliff_time: u64,
        total_cap: i128,
        kind: RecurringKind,
        description: String,
        deadline: u64,
        category: ProposalCategory,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_owner_and_weight(&env, &proposer)?;
        require_not_frozen(&env)?;

        if amount < MIN_AMOUNT {
            return Err(ContractError::InvalidAmount);
        }
        if !(MIN_INTERVAL_SECS..=MAX_INTERVAL_SECS).contains(&interval_secs) {
            return Err(ContractError::InvalidInterval);
        }
        if recipient == env.current_contract_address() {
            return Err(ContractError::InvalidRecipient);
        }
        validate_description(&description)?;
        validate_deadline(&env, deadline)?;
        validate_recurring_schedule(start_time, cliff_time, end_time, total_cap, amount)?;

        if read_active_recurring_count(&env) >= MAX_ACTIVE_RECURRING {
            return Err(ContractError::TooManyActiveRecurring);
        }

        let threshold = read_threshold(&env)?;
        let id = read_next_id(&env);

        let p_kind = ProposalKind::CreateRecurringPayment(CreateRecurringParams {
            recipient,
            token,
            amount,
            interval_secs,
            start_time,
            end_time,
            cliff_time,
            total_cap,
            kind,
        });

        let proposal = Proposal {
            id,
            proposer: proposer.clone(),
            description,
            deadline,
            approvals: 0,
            approval_weight: 0,
            status: ProposalStatus::Pending,
            kind: p_kind,
            ready_at: 0,
            quorum_weight: threshold,
            category: category.clone(),
        };
        write_proposal(&env, &proposal);
        register_active_proposal(&env, id)?;

        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

        let total_weight = read_total_weight(&env);
        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                id,
                proposer,
                threshold,
                category,
                transfers: Vec::new(&env),
                quorum_weight: threshold,
                total_weight_at_creation: total_weight,
            },
        );

        Ok(id)
    }

    pub fn create_cancel_recurring_proposal(
        env: Env,
        proposer: Address,
        schedule_id: u64,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_owner_and_weight(&env, &proposer)?;
        require_not_frozen(&env)?;

        let schedule = read_recurring_payment(&env, schedule_id)?;
        let status = derive_recurring_status(&env, &schedule);
        if status == RecurringStatus::Cancelled {
            return Err(ContractError::ScheduleAlreadyCancelled);
        }
        if status == RecurringStatus::Completed {
            return Err(ContractError::ScheduleTerminal);
        }

        validate_description(&description)?;
        validate_deadline(&env, deadline)?;

        let threshold = read_threshold(&env)?;
        let id = read_next_id(&env);

        let p_kind = ProposalKind::CancelRecurringPayment(schedule_id);

        let proposal = Proposal {
            id,
            proposer: proposer.clone(),
            description,
            deadline,
            approvals: 0,
            approval_weight: 0,
            status: ProposalStatus::Pending,
            kind: p_kind,
            ready_at: 0,
            quorum_weight: threshold,
            category: ProposalCategory::Ops,
        };
        write_proposal(&env, &proposal);
        register_active_proposal(&env, id)?;

        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

        let total_weight = read_total_weight(&env);
        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                id,
                proposer,
                threshold,
                category: ProposalCategory::Ops,
                transfers: Vec::new(&env),
                quorum_weight: threshold,
                total_weight_at_creation: total_weight,
            },
        );

        Ok(id)
    }

    pub fn create_pause_recurring_proposal(
        env: Env,
        proposer: Address,
        schedule_id: u64,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_owner_and_weight(&env, &proposer)?;
        require_not_frozen(&env)?;

        let schedule = read_recurring_payment(&env, schedule_id)?;
        let status = derive_recurring_status(&env, &schedule);
        if status == RecurringStatus::Cancelled || status == RecurringStatus::Completed {
            return Err(ContractError::ScheduleTerminal);
        }
        if status == RecurringStatus::Paused {
            return Err(ContractError::ScheduleAlreadyPaused);
        }

        validate_description(&description)?;
        validate_deadline(&env, deadline)?;

        let threshold = read_threshold(&env)?;
        let id = read_next_id(&env);

        let p_kind = ProposalKind::PauseRecurringPayment(schedule_id);

        let proposal = Proposal {
            id,
            proposer: proposer.clone(),
            description,
            deadline,
            approvals: 0,
            approval_weight: 0,
            status: ProposalStatus::Pending,
            kind: p_kind,
            ready_at: 0,
            quorum_weight: threshold,
            category: ProposalCategory::Ops,
        };
        write_proposal(&env, &proposal);
        register_active_proposal(&env, id)?;

        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

        let total_weight = read_total_weight(&env);
        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                id,
                proposer,
                threshold,
                category: ProposalCategory::Ops,
                transfers: Vec::new(&env),
                quorum_weight: threshold,
                total_weight_at_creation: total_weight,
            },
        );

        Ok(id)
    }

    pub fn create_resume_recurring_proposal(
        env: Env,
        proposer: Address,
        schedule_id: u64,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_owner_and_weight(&env, &proposer)?;
        require_not_frozen(&env)?;

        let schedule = read_recurring_payment(&env, schedule_id)?;
        let status = derive_recurring_status(&env, &schedule);
        if status != RecurringStatus::Paused {
            return Err(ContractError::ScheduleNotPaused);
        }

        validate_description(&description)?;
        validate_deadline(&env, deadline)?;

        let threshold = read_threshold(&env)?;
        let id = read_next_id(&env);

        let p_kind = ProposalKind::ResumeRecurringPayment(schedule_id);

        let proposal = Proposal {
            id,
            proposer: proposer.clone(),
            description,
            deadline,
            approvals: 0,
            approval_weight: 0,
            status: ProposalStatus::Pending,
            kind: p_kind,
            ready_at: 0,
            quorum_weight: threshold,
            category: ProposalCategory::Ops,
        };
        write_proposal(&env, &proposal);
        register_active_proposal(&env, id)?;

        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

        let total_weight = read_total_weight(&env);
        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                id,
                proposer,
                threshold,
                category: ProposalCategory::Ops,
                transfers: Vec::new(&env),
                quorum_weight: threshold,
                total_weight_at_creation: total_weight,
            },
        );

        Ok(id)
    }

    pub fn create_modify_recurring_proposal(
        env: Env,
        proposer: Address,
        schedule_id: u64,
        new_amount: Option<i128>,
        new_interval_secs: Option<u64>,
        new_end_time: Option<u64>,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_owner_and_weight(&env, &proposer)?;
        require_not_frozen(&env)?;

        let schedule = read_recurring_payment(&env, schedule_id)?;
        let status = derive_recurring_status(&env, &schedule);
        if status == RecurringStatus::Cancelled || status == RecurringStatus::Completed {
            return Err(ContractError::ScheduleTerminal);
        }

        if let Some(amt) = new_amount {
            if amt < MIN_AMOUNT {
                return Err(ContractError::InvalidAmount);
            }
        }
        if let Some(inv) = new_interval_secs {
            if !(MIN_INTERVAL_SECS..=MAX_INTERVAL_SECS).contains(&inv) {
                return Err(ContractError::InvalidInterval);
            }
        }
        if let Some(end_t) = new_end_time {
            if end_t <= schedule.start_time {
                return Err(ContractError::InvalidDeadline);
            }
        }

        validate_description(&description)?;
        validate_deadline(&env, deadline)?;

        let threshold = read_threshold(&env)?;
        let id = read_next_id(&env);

        let p_kind = ProposalKind::ModifyRecurringPayment(ModifyRecurringParams {
            schedule_id,
            new_amount,
            new_interval_secs,
            new_end_time,
        });

        let proposal = Proposal {
            id,
            proposer: proposer.clone(),
            description,
            deadline,
            approvals: 0,
            approval_weight: 0,
            status: ProposalStatus::Pending,
            kind: p_kind,
            ready_at: 0,
            quorum_weight: threshold,
            category: ProposalCategory::Ops,
        };
        write_proposal(&env, &proposal);
        register_active_proposal(&env, id)?;

        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

        let total_weight = read_total_weight(&env);
        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                id,
                proposer,
                threshold,
                category: ProposalCategory::Ops,
                transfers: Vec::new(&env),
                quorum_weight: threshold,
                total_weight_at_creation: total_weight,
            },
        );

        Ok(id)
    }

    /// Returns a single recurring payment schedule by ID with a freshly derived status.
    pub fn get_recurring_payment(env: Env, schedule_id: u64) -> Result<RecurringPayment, ContractError> {
        let mut schedule = read_recurring_payment(&env, schedule_id)?;
        schedule.status = derive_recurring_status(&env, &schedule);
        Ok(schedule)
    }

    /// Returns the ledger timestamp of the next eligible disbursement for a schedule.
    pub fn get_next_disbursement_time(env: Env, schedule_id: u64) -> Result<u64, ContractError> {
        let schedule = read_recurring_payment(&env, schedule_id)?;
        let status = derive_recurring_status(&env, &schedule);

        if matches!(status, RecurringStatus::Completed | RecurringStatus::Cancelled) {
            return Ok(0);
        }

        if schedule.last_disbursed_at > 0 {
            Ok(schedule.last_disbursed_at.saturating_add(schedule.interval_secs))
        } else {
            match schedule.kind {
                RecurringKind::LinearVesting => {
                    if schedule.cliff_time > 0 {
                        Ok(schedule.start_time.saturating_add(schedule.cliff_time))
                    } else {
                        Ok(schedule.start_time)
                    }
                }
                RecurringKind::FixedAmountPerPeriod => {
                    if schedule.interval_secs > 0 {
                        Ok(schedule.start_time.saturating_add(schedule.interval_secs))
                    } else {
                        Ok(schedule.start_time)
                    }
                }
            }
        }
    }

    /// Returns a page of recurring schedules with limit capped at 20 and overflow protection.
    pub fn get_recurring_payments_paged(env: Env, offset: u64, mut limit: u32) -> Vec<RecurringPayment> {
        if limit > 20 {
            limit = 20;
        }
        let next_id = read_next_recurring_id(&env);
        let total_schedules = next_id.saturating_sub(1);

        if offset >= total_schedules {
            return Vec::new(&env);
        }

        let Some(start) = offset.checked_add(1) else {
            return Vec::new(&env);
        };
        let Some(end) = offset.checked_add(u64::from(limit)) else {
            return Vec::new(&env);
        };
        let end = end.min(total_schedules);

        let mut result = Vec::new(&env);
        if start > end {
            return result;
        }

        for id in start..=end {
            if let Ok(mut schedule) = read_recurring_payment(&env, id) {
                schedule.status = derive_recurring_status(&env, &schedule);
                result.push_back(schedule);
            }
        }
        result
    }

    pub fn get_active_recurring_count(env: Env) -> u32 {
        read_active_recurring_count(&env)
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
            if read_approval_weight(&env, proposal_id, &owner) > 0 {
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

    /// Returns every current owner's address paired with their voting weight,
    /// in a single call. Read-only; no authorization required.
    pub fn get_owner_weights(env: Env) -> Result<Vec<OwnerWeight>, ContractError> {
        let owners = read_owners_map(&env)?;
        let mut result = Vec::new(&env);
        for owner in owners.keys().iter() {
            let weight = owners.get(owner.clone()).unwrap_or(0);
            result.push_back(OwnerWeight { owner, weight });
        }
        Ok(result)
    }

    /// Returns the configured maximum percentage of total weight that one owner
    /// may receive through a ChangeOwnerWeight proposal.
    pub fn get_max_single_owner_weight_pct(env: Env) -> u32 {
        read_max_single_owner_weight_pct(&env)
    }

    /// Returns `owner`'s outgoing delegation (if any, including expired ones)
    /// alongside every delegation currently received from other owners.
    pub fn get_delegations(env: Env, owner: Address) -> Result<DelegationInfo, ContractError> {
        let owners = read_owners_map(&env)?;
        let mut outgoing_vec = Vec::new(&env);
        if let Some(d) = read_delegation(&env, &owner) {
            outgoing_vec.push_back(d);
        }

        let mut incoming = Vec::new(&env);
        for other in owners.keys().iter() {
            if other == owner {
                continue;
            }
            if let Some(delegation) = read_delegation(&env, &other) {
                if delegation.delegate == owner {
                    incoming.push_back(delegation);
                }
            }
        }

        Ok(DelegationInfo {
            outgoing: outgoing_vec,
            incoming,
        })
    }

    /// Returns every current owner's outgoing delegation that has not yet expired.
    pub fn get_active_delegations(env: Env) -> Result<Vec<Delegation>, ContractError> {
        let owners = read_owners_map(&env)?;
        let mut result = Vec::new(&env);
        for owner in owners.keys().iter() {
            if let Some(delegation) = read_delegation(&env, &owner) {
                if is_delegation_active(&env, &delegation) {
                    result.push_back(delegation);
                }
            }
        }
        Ok(result)
    }

    /// Returns `owner`'s effective voting weight: their raw weight, minus any
    /// outgoing delegation still active, plus any incoming delegations still
    /// active. Expired delegations (`expiry <= current ledger time`) are
    /// excluded from this calculation on both sides.
    pub fn get_effective_weight(env: Env, owner: Address) -> Result<u32, ContractError> {
        let owners = read_owners_map(&env)?;
        let raw_weight = owners.get(owner.clone()).ok_or(ContractError::OwnerNotFound)?;
        compute_effective_weight(&env, &owners, &owner, raw_weight)
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
        let total_proposals = next_id.saturating_sub(1);

        if offset >= total_proposals {
            return Vec::new(&env);
        }

        let Some(start) = offset.checked_add(1) else {
            return Vec::new(&env);
        };
        let Some(end) = offset.checked_add(u64::from(limit)) else {
            return Vec::new(&env);
        };
        let end = end.min(total_proposals);

        let mut result = Vec::new(&env);
        if start > end {
            return result;
        }

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

    /// Returns every configured spending-limit entry for `owner`, as a list of
    /// `(token, limit)` pairs. Owners with no configured limits receive an empty list.
    pub fn get_owner_spending_limits(env: Env, owner: Address) -> Vec<SpendingLimitEntry> {
        read_owner_spending_limits(&env, &owner)
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
        read_approval_weight(&env, proposal_id, &owner) > 0
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
