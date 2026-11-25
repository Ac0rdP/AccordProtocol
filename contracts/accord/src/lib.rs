#![no_std]
#![allow(deprecated)]
#![allow(dead_code)]
pub mod validate;
use validate::{validate_deadline, validate_description};

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env,
    IntoVal, Map, String, Symbol, Val, Vec,
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
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum Role {
    Proposer,
    Approver,
    Executor,
    Viewer,
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
pub enum AssetReference {
    Address(Address),
    Classic(Symbol),
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct AssetTransfer {
    pub to: Address,
    pub asset: AssetReference,
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
    /// Streams `amount` token units per second from `start_time` to `end_time`.
    /// A positive `total_cap` limits the total claimable amount.
    ContinuousStream,
}

impl Default for RecurringKind {
    fn default() -> Self {
        RecurringKind::FixedAmountPerPeriod
    }
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
    pub periods_disbursed: u32,
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
pub enum EscrowReleaseMode {
    OwnerQuorumUntil(u64),
    Deadline(u64),
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct EscrowParams {
    pub recipient: Address,
    pub token: Address,
    pub amount: i128,
    pub release_mode: EscrowReleaseMode,
}

/// Parameters for a governed DEX path-payment swap proposal.
///
/// At execution time the multisig contract calls a Soroban DEX router (e.g.
/// SoroswapRouter) via cross-contract invocation. The router swaps
/// `send_amount` of `path[0]` for `path[last]` along the intermediate hops
/// encoded in `path`. The minimum output amount (`min_recv`) enforces an
/// on-chain slippage guard: the execute call reverts if the router returns
/// fewer tokens than this floor. The swapped output is sent to `destination`;
/// if that field is `None` the multisig contract itself receives the output
/// (useful for treasury rebalancing proposals).
///
/// # Stellar path-payment semantics
/// Stellar's path-payment model sells a fixed send amount and receives a
/// variable output constrained from below by `min_recv`. This maps directly
/// to `swap_exact_tokens_for_tokens` on a Soroswap-style router:
///   - `amount_in`  = `send_amount`
///   - `amount_out_min` = `min_recv`
///   - `path`       = intermediate token path (at least 2 entries: send + recv)
///   - `to`         = `destination` (or the contract itself when `None`)
///   - `deadline`   = snapshotted at proposal creation; enforced at execution
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct DexSwapParams {
    /// Address of the DEX router contract to call (e.g. SoroswapRouter).
    /// Stored and validated at proposal-creation time so that governance can
    /// explicitly vet which router is authorised for the swap.
    pub router: Address,
    /// Ordered token path: `path[0]` is the token sold, `path[last]` is the
    /// token bought. Intermediate entries are the hop tokens. Must have at
    /// least two entries.
    pub path: Vec<Address>,
    /// Exact amount of `path[0]` to sell. Must be ≥ `MIN_AMOUNT`.
    pub send_amount: i128,
    /// Minimum amount of `path[last]` to receive. The execute step reverts if
    /// the router returns fewer than this. Set to 1 for "accept any output"
    /// or to a tighter value to cap slippage.
    pub min_recv: i128,
    /// Who receives the output tokens. `None` means the multisig contract
    /// itself collects the purchased token (treasury rebalancing).
    pub destination: Option<Address>,
    /// Unix timestamp (seconds) beyond which the swap must not execute. Copied
    /// from the proposal deadline at creation; a stale approved-but-unexecuted
    /// swap that would execute at a bad rate is rejected automatically.
    pub swap_deadline: u64,
}

/// The interface standard a yield venue exposes. The execute arm calls the
/// appropriate function name on the venue contract based on this tag.
///
/// - `Blend` — Blend Protocol lending pools; deposit via `supply`, withdraw
///   via `withdraw`.
/// - `Soroswap` — Soroswap liquidity pools; deposit via `add_liquidity`,
///   withdraw via `remove_liquidity`.
/// - `Generic` — Any venue that exposes `deposit` / `withdraw` with the
///   signature `(token: Address, amount: i128)`.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum YieldVenueKind {
    Blend,
    Soroswap,
    Generic,
}

/// Parameters for a governed treasury yield allocation proposal.
///
/// Both `YieldDeposit` and `YieldWithdraw` share this struct. The `kind`
/// field selects which on-chain interface the venue exposes; the execute arm
/// dispatches the correct cross-contract call.
///
/// # Deposit semantics
/// The multisig approves the venue to pull `amount` of `token` for one
/// ledger then calls the deposit function. A `YieldPosition` record is
/// written to persistent storage so a later withdrawal proposal can reference
/// it by `position_id`.
///
/// # Withdrawal semantics
/// References an existing `YieldPosition` via `position_id`. The execute
/// arm calls the venue's withdrawal function and verifies that the multisig
/// contract receives at least `min_return` tokens (slippage guard). The
/// position record is deleted on success.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct YieldAllocationParams {
    /// Address of the approved yield venue contract.
    pub venue: Address,
    /// Token deposited into / withdrawn from the venue.
    pub token: Address,
    /// Amount to deposit, or shares/LP-tokens to redeem on withdrawal.
    /// Must be ≥ `MIN_AMOUNT`.
    pub amount: i128,
    /// Minimum tokens returned to the treasury on withdrawal.
    /// Ignored for deposits. Set to 1 for "accept any" or tighten for
    /// slippage protection.
    pub min_return: i128,
    /// Interface kind; selects the correct cross-contract function names.
    pub kind: YieldVenueKind,
    /// Caller-assigned identifier linking a withdrawal back to its deposit.
    /// For deposits this slot must not already be open. For withdrawals it
    /// must reference an existing open position.
    pub position_id: u64,
}

/// On-chain record of an active yield position opened by a `YieldDeposit`
/// proposal. Cleared when the matching `YieldWithdraw` proposal executes.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct YieldPosition {
    /// Unique identifier supplied by the proposer.
    pub id: u64,
    /// The venue holding the funds.
    pub venue: Address,
    /// Token that was deposited.
    pub token: Address,
    /// Amount deposited (not adjusted for accrued yield).
    pub deposited: i128,
    /// Ledger timestamp when the deposit proposal executed.
    pub opened_at: u64,
    /// Venue interface kind recorded at deposit time.
    pub kind: YieldVenueKind,
}

/// Lifecycle state of a pull-payment request.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum PullPaymentStatus {
    /// Open: the claimant may call `claim_pull_payment` before `expires_at`.
    Open,
    /// Claimed: the token transfer has executed; the request is terminal.
    Claimed,
    /// Cancelled: governance cancelled the request before it was claimed.
    Cancelled,
    /// Expired: the claimant did not claim before `expires_at`.
    Expired,
}

/// Parameters for a `CreatePullPayment` proposal.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct PullPaymentParams {
    /// The address authorised to claim this payment. Only this address may
    /// call `claim_pull_payment` for the generated request ID.
    pub claimant: Address,
    /// Token to transfer on claim.
    pub token: Address,
    /// Amount to transfer. Must be ≥ `MIN_AMOUNT`.
    pub amount: i128,
    /// Unix timestamp (seconds) after which the request can no longer be
    /// claimed. Must be in the future and within `MAX_PROPOSAL_DURATION`.
    pub expires_at: u64,
    /// Optional human-readable memo stored with the request (≤ 300 chars).
    pub memo: String,
}

/// On-chain record of an open (or terminal) pull-payment request.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct PullPaymentRequest {
    /// Sequential ID assigned at creation time.
    pub id: u64,
    /// The owner who proposed this request.
    pub proposer: Address,
    /// The only address allowed to claim the payment.
    pub claimant: Address,
    /// Token to transfer.
    pub token: Address,
    /// Amount reserved for the claimant.
    pub amount: i128,
    /// Expiry timestamp.
    pub expires_at: u64,
    /// Current lifecycle status.
    pub status: PullPaymentStatus,
    /// Optional memo stored with the request.
    pub memo: String,
}

/// Structured reconciliation metadata attached to a payment proposal.
///
/// Any or all fields may be `None`. When set, each string must be non-empty
/// and ≤ `MAX_DESCRIPTION_LEN` characters. The metadata is stored separately
/// from the `Proposal` record so that existing proposal types — including
/// transfers, recurring payments, escrows, DEX swaps, yield deposits, and
/// pull-payment requests — can carry reconciliation context without changing
/// their on-chain structs.
///
/// # Fields
/// - `invoice_id` — an off-chain invoice or billing identifier (e.g.
///   "INV-2024-0001").
/// - `external_ref` — a reference into an external bookkeeping system
///   (e.g. a purchase-order number or ERP document ID).
/// - `memo` — free-form human-readable note for reviewers and indexers.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct PaymentMetadata {
    pub invoice_id: Option<String>,
    pub external_ref: Option<String>,
    pub memo: Option<String>,
}

/// Labels a rolling-window limit in a spend policy.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum SpendWindowKind {
    /// 24-hour rolling window (86 400 s).
    Daily,
    /// 7-day rolling window (604 800 s).
    Weekly,
    /// 30-day rolling window (2 592 000 s).
    Monthly,
}

impl SpendWindowKind {
    /// Returns the window duration in seconds.
    fn duration_secs(&self) -> u64 {
        match self {
            SpendWindowKind::Daily => 86_400,
            SpendWindowKind::Weekly => 604_800,
            SpendWindowKind::Monthly => 2_592_000,
        }
    }
}

/// A single (window, limit) pair within a spend policy.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct SpendLimit {
    /// Which rolling window this limit applies to.
    pub window: SpendWindowKind,
    /// Maximum cumulative spend allowed within the window for this token.
    pub limit: i128,
}

/// A composed spend policy for one (owner, token) pair.
///
/// Multiple `limits` can be set simultaneously — e.g. a daily cap of 1 000
/// and a monthly cap of 20 000. At execution time the engine evaluates
/// **all** windows and rejects the proposal if any single window would be
/// exceeded by the cumulative spend including this proposal's amount.
///
/// Each window maintains its own independent `SpentTracker` (epoch + spent)
/// keyed by `(owner, token, window_kind)`.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct SpendPolicy {
    /// The owner whose spending is constrained.
    pub owner: Address,
    /// The token being spent.
    pub token: Address,
    /// One to three rolling-window limits. Must be non-empty and contain
    /// at most one entry per `SpendWindowKind`.
    pub limits: Vec<SpendLimit>,
}

// ─── #954: Oracle Price Guard ───────────────────────────────────────────────

/// A recorded oracle price snapshot for a (token, fiat) pair.
///
/// The price is expressed as the fiat value of one unit of the token,
/// scaled by `PRICE_SCALING` (1e7). For example, if 1 USDC = $1.00, the
/// stored price is 10_000_000 (1.00 × 1e7).
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct OraclePrice {
    /// The token whose price is being recorded.
    pub token: Address,
    /// The fiat currency code (e.g. "USD"). Stored as a short Symbol.
    pub fiat: Symbol,
    /// Price of 1 unit of `token` in `fiat`, scaled by 1e7.
    pub price: i128,
    /// Ledger timestamp of the last price update.
    pub updated_at: u64,
    /// Maximum acceptable age (in seconds) before the price is considered stale.
    pub max_staleness: u64,
}

/// A fiat-denominated spend limit: caps spending at `fiat_limit` units of
/// `fiat` per window, evaluated at the current oracle price.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct FiatSpendLimit {
    pub owner: Address,
    pub token: Address,
    pub fiat: Symbol,
    /// Maximum cumulative fiat spend within the rolling window.
    pub fiat_limit: i128,
    /// Rolling window in seconds (reuses the same epoch-based tracker).
    pub window_secs: u64,
}

// ─── #955: Denylist ──────────────────────────────────────────────────────────

// (No additional types needed — denylist is a simple Address set.)

// ─── #953: Cross-Asset Rebalancing ───────────────────────────────────────────

/// A single asset target in a rebalance proposal.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct RebalanceTarget {
    /// Token to rebalance toward.
    pub token: Address,
    /// Target weight in basis points (0–10000). E.g. 5000 = 50%.
    pub target_bps: u32,
}

/// Parameters for a cross-asset rebalance proposal.
///
/// Bundles multiple DEX swaps and transfers that move the treasury toward
/// the specified target asset weights. Each step swaps or transfers one
/// token to reach the target allocation.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct RebalanceParams {
    /// Approved DEX router to use for swaps.
    pub router: Address,
    /// Target weights for each asset (sum should be ≤ 10000 bps).
    pub targets: Vec<RebalanceTarget>,
    /// Tolerance in basis points; the rebalance is considered satisfied if
    /// actual weights are within `tolerance_bps` of targets.
    pub tolerance_bps: u32,
    /// Swap deadline (unix seconds).
    pub swap_deadline: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum ProposalKind {
    /// Execute one or more asset transfers from the treasury.
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
    /// SetSpendingLimitWindow(owner, token, limit, window_secs)
    SetSpendingLimitWindow(Address, Address, i128, u64),
    /// SetTreasurySpendingLimit(token, limit, window_secs) — multisig-wide cap on the
    /// cumulative rolling outflows of `token` from the treasury. A limit of 0 blocks
    /// that token entirely from leaving the treasury.
    SetTreasurySpendingLimit(Address, i128, u64),
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
    /// GrantRole(target, role)
    GrantRole(Address, Symbol),
    /// RevokeRole(target, role)
    RevokeRole(Address, Symbol),
    /// Governance-managed approved-asset registry.
    SetAssetRegistryEnabled(bool),
    AddApprovedToken(Address),
    RemoveApprovedToken(Address),
    /// Rotate the emergency guardian through normal proposal quorum.
    TransferGuardian(Address),
    /// Replace an owner key with a new address, preserving weight and roles.
    /// Activation is delayed after the proposal reaches quorum.
    RotateOwner(Address, Address),
    /// Create escrow whose balance is reserved until its release condition.
    CreateEscrow(EscrowParams),
    /// Governed DEX path-payment swap. Sells `send_token` along `path` through
    /// a Soroban DEX router, enforcing a minimum received amount and an optional
    /// destination address for the output tokens.
    DexSwap(DexSwapParams),
    /// Add a DEX router to the governance-approved router registry.
    AddDexRouter(Address),
    /// Remove a DEX router from the governance-approved router registry.
    RemoveDexRouter(Address),
    /// Deposit treasury tokens into a governance-approved yield venue.
    YieldDeposit(YieldAllocationParams),
    /// Withdraw tokens from a yield venue back to the treasury.
    YieldWithdraw(YieldAllocationParams),
    /// Add a yield venue to the governance-approved venue registry.
    AddYieldVenue(Address),
    /// Remove a yield venue from the governance-approved venue registry.
    RemoveYieldVenue(Address),
    /// Open a pull-payment request that allows a named claimant to claim a
    /// fixed amount of a token from the treasury without a second governance
    /// vote.
    CreatePullPayment(PullPaymentParams),
    /// Cancel a pull-payment request before it is claimed or expires.
    CancelPullPayment(u64),
    /// Set a composed multi-window spend policy for an (owner, token) pair.
    SetSpendPolicy(SpendPolicy),
    /// Clear all spend-policy limits for an (owner, token) pair.
    ClearSpendPolicy(Address, Address),
    // ── #954: Oracle price guard ──
    /// Set or update the oracle price for a (token, fiat) pair.
    SetOraclePrice(OraclePrice),
    /// Clear the oracle price for a (token, fiat) pair.
    ClearOraclePrice(Address, Symbol),
    /// Set a fiat-denominated spend limit for an (owner, token) pair.
    SetFiatSpendLimit(FiatSpendLimit),
    /// Clear a fiat-denominated spend limit.
    ClearFiatSpendLimit(Address, Address, Symbol),
    // ── #955: Denylist ──
    /// Add an address to the governance-managed denylist.
    AddToDenylist(Address),
    /// Remove an address from the denylist.
    RemoveFromDenylist(Address),
    // ── #953: Cross-asset rebalancing ──
    /// Execute a cross-asset rebalance toward target weights.
    Rebalance(RebalanceParams),
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
    pub attachment_hash: Option<BytesN<32>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ProposalSimulation {
    pub category: ProposalCategory,
    pub quorum_weight: u32,
    pub proposer: Address,
    pub required_role: Role,
    pub proposer_auth_required: bool,
    pub transfer_count: u32,
    pub distinct_token_count: u32,
    pub owner_spending_limit_checks: u32,
    pub minimum_persistent_writes: u32,
    pub minimum_instance_writes: u32,
    pub emitted_events: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ProposalApprovalProgress {
    pub approval_weight: u32,
    pub quorum_weight: u32,
    pub total_weight: u32,
    pub abstention_count: u32,
    pub abstention_weight: u32,
    pub participation_weight: u32,
    pub soft_approval_count: u32,
    pub soft_approval_weight: u32,
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

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct EscrowRecord {
    pub id: u64,
    pub recipient: Address,
    pub token: Address,
    pub amount: i128,
    pub release_mode: EscrowReleaseMode,
}

/// Coarse classification of a `ProposalKind` used by scoped emergency freezes.
/// Scoped freezes target the operation family rather than a specific proposal,
/// so governance, ownership changes, and unrelated operations stay available.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[contracttype]
pub enum ProposalKindTag {
    Transfer,
    Recurring,
    Escrow,
    Ownership,
    Governance,
}

/// The target of a scoped emergency freeze: one asset (token) or one proposal
/// kind family.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum FreezeScope {
    Asset(Address),
    Kind(ProposalKindTag),
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ScopedFreezeChangedEvent {
    pub scope: FreezeScope,
    pub frozen: bool,
    pub guardian: Address,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct AssetOutflowPauseChangedEvent {
    pub token: Address,
    pub paused: bool,
    pub guardian: Address,
    pub version: u32,
}

/// A guardian set authorized to start social recovery when owner keys are
/// lost. Operates independently of the single emergency guardian that can
/// freeze the contract.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct GuardianQuorumConfig {
    pub guardians: Vec<Address>,
    pub threshold: u32,
}

/// A social-recovery request. Guardians approve until `threshold` is met, then
/// the request becomes executable after `SOCIAL_RECOVERY_DELAY`, leaving an
/// auditable window before ownership changes.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct SocialRecoveryRequest {
    pub id: u64,
    pub new_owner: Address,
    /// When set, the recovered key replaces this owner (preserving its weight
    /// and roles). When `None`, the recovered key is added as a new owner.
    pub replace_owner: Option<Address>,
    pub approvals: Vec<Address>,
    pub proposed_at: u64,
    pub execute_after: u64,
    pub executed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct GuardianQuorumConfiguredEvent {
    pub guardians: Vec<Address>,
    pub threshold: u32,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct SocialRecoveryProposedEvent {
    pub id: u64,
    pub new_owner: Address,
    pub replace_owner: Option<Address>,
    pub proposed_at: u64,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct SocialRecoveryApprovedEvent {
    pub id: u64,
    pub guardian: Address,
    pub approvals: u32,
    pub threshold: u32,
    pub execute_after: u64,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct SocialRecoveryExecutedEvent {
    pub id: u64,
    pub new_owner: Address,
    pub replace_owner: Option<Address>,
    pub executed_at: u64,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct OwnerRotatedEvent {
    pub old_owner: Address,
    pub new_owner: Address,
    pub weight: u32,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct StorageMigratedEvent {
    pub from_version: u32,
    pub to_version: u32,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
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
pub struct DelegationCreatedEvent {
    pub delegator: Address,
    pub delegate: Address,
    pub weight: u32,
    pub expiry: Option<u64>,
    pub total_delegated_weight: u32,
    pub cap: u32,
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct DelegationRenewedEvent {
    pub delegator: Address,
    pub delegate: Address,
    pub old_expiry: Option<u64>,
    pub new_expiry: u64,
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct DelegationRevokedEvent {
    pub delegator: Address,
    pub delegate: Address,
    pub weight: u32,
    pub version: u32,
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
    pub attachment_hash: Option<BytesN<32>>,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
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
pub struct ProposalApprovedEvent {
    pub id: u64,
    pub approver: Address,
    pub approvals: u32,
    pub threshold: u32,
    pub weight: u32,
    pub cumulative_weight: u32,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ProposalRevokedEvent {
    pub id: u64,
    pub approver: Address,
    pub approvals: u32,
    pub weight: u32,
    pub cumulative_weight: u32,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ProposalAbstainedEvent {
    pub id: u64,
    pub abstainer: Address,
    pub abstention_count: u32,
    pub weight: u32,
    pub cumulative_abstention_weight: u32,
    pub participation_weight: u32,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ProposalAbstentionRevokedEvent {
    pub id: u64,
    pub abstainer: Address,
    pub abstention_count: u32,
    pub weight: u32,
    pub cumulative_abstention_weight: u32,
    pub participation_weight: u32,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ProposalSoftApprovedEvent {
    pub id: u64,
    pub supporter: Address,
    pub soft_approval_count: u32,
    pub weight: u32,
    pub cumulative_soft_weight: u32,
    pub participation_weight: u32,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ProposalSoftApprovalRevokedEvent {
    pub id: u64,
    pub supporter: Address,
    pub soft_approval_count: u32,
    pub weight: u32,
    pub cumulative_soft_weight: u32,
    pub participation_weight: u32,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ProposalExecutedEvent {
    pub id: u64,
    pub executor: Address,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ProposalCancelledEvent {
    pub id: u64,
    pub proposer: Address,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ExpiredProposalsSweptEvent {
    pub swept: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct GuardianSetEvent {
    pub guardian: Address,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ApprovedTokenChangedEvent {
    pub token: Address,
    pub approved: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct AssetRegistryEnabledEvent {
    pub enabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct EscrowCreatedEvent {
    pub id: u64,
    pub recipient: Address,
    pub token: Address,
    pub amount: i128,
    pub release_mode: EscrowReleaseMode,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct EscrowReleasedEvent {
    pub id: u64,
    pub recipient: Address,
    pub token: Address,
    pub amount: i128,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct EscrowRefundedEvent {
    pub id: u64,
    pub token: Address,
    pub amount: i128,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
/// Emitted when a `DexSwap` proposal is created. Carries the full swap
/// parameters so off-chain consumers can reconstruct intent without querying
/// contract state.
pub struct DexSwapProposedEvent {
    pub proposal_id: u64,
    pub proposer: Address,
    pub router: Address,
    pub path: Vec<Address>,
    pub send_amount: i128,
    pub min_recv: i128,
    pub destination: Option<Address>,
    pub swap_deadline: u64,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
/// Emitted when a `DexSwap` proposal is successfully executed. Records both
/// the requested parameters and the actual output reported by the router so
/// indexers and auditors can track realised slippage.
pub struct DexSwapExecutedEvent {
    pub proposal_id: u64,
    pub executor: Address,
    pub router: Address,
    pub path: Vec<Address>,
    pub send_amount: i128,
    pub min_recv: i128,
    /// Actual amount of output token returned by the router.
    pub recv_amount: i128,
    pub destination: Address,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct DexRouterChangedEvent {
    pub router: Address,
    pub approved: bool,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

/// Emitted when a `YieldDeposit` proposal is created.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct YieldDepositProposedEvent {
    pub proposal_id: u64,
    pub proposer: Address,
    pub venue: Address,
    pub token: Address,
    pub amount: i128,
    pub position_id: u64,
    pub kind: YieldVenueKind,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

/// Emitted when a `YieldDeposit` proposal executes successfully.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct YieldDepositedEvent {
    pub proposal_id: u64,
    pub executor: Address,
    pub venue: Address,
    pub token: Address,
    pub amount: i128,
    pub position_id: u64,
    pub kind: YieldVenueKind,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

/// Emitted when a `YieldWithdraw` proposal is created.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct RecurringStreamClaimedEvent {
    pub schedule_id: u64,
    pub recipient: Address,
    pub token: Address,
    pub amount: i128,
    pub total_disbursed: i128,
}

/// Emitted when a `YieldWithdraw` proposal executes successfully.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct YieldWithdrawnEvent {
    pub proposal_id: u64,
    pub executor: Address,
    pub venue: Address,
    pub token: Address,
    pub amount: i128,
    /// Actual tokens returned to the treasury.
    pub recv_amount: i128,
    pub position_id: u64,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

/// Emitted when a yield venue is added to or removed from the approved registry.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct YieldVenueChangedEvent {
    pub venue: Address,
    pub approved: bool,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

/// Emitted when a `CreatePullPayment` proposal executes and the request is opened.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct PullPaymentOpenedEvent {
    pub request_id: u64,
    pub proposer: Address,
    pub claimant: Address,
    pub token: Address,
    /// The amount transferred per period, or per-second stream rate for `ContinuousStream`.
    pub amount: i128,
    pub expires_at: u64,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

/// Emitted when a claimant successfully claims a pull-payment request.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct PullPaymentClaimedEvent {
    pub request_id: u64,
    pub claimant: Address,
    pub token: Address,
    pub amount: i128,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

/// Emitted when a `CancelPullPayment` proposal executes.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct PullPaymentCancelledEvent {
    pub request_id: u64,
    pub executor: Address,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

/// Emitted when reconciliation metadata is attached to a proposal.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct PaymentMetadataSetEvent {
    pub proposal_id: u64,
    pub setter: Address,
    pub metadata: PaymentMetadata,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

/// Emitted when a composed spend policy is set via governance proposal.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct SpendPolicySetEvent {
    pub owner: Address,
    pub token: Address,
    pub limits: Vec<SpendLimit>,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

/// Emitted when a spend policy is cleared via governance proposal.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct SpendPolicyClearedEvent {
    pub owner: Address,
    pub token: Address,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

/// Emitted when the spend policy engine rejects a proposed spend because
/// one or more rolling-window limits would be exceeded.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct SpendPolicyRejectedEvent {
    pub proposal_id: u64,
    pub owner: Address,
    pub token: Address,
    /// The window kind whose limit was breached.
    pub window: SpendWindowKind,
    /// The configured limit for this window.
    pub limit: i128,
    /// The cumulative spend that would have resulted (including this proposal).
    pub cumulative: i128,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

// ── #954: Oracle price guard events ──

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct OraclePriceSetEvent {
    pub token: Address,
    pub fiat: Symbol,
    pub price: i128,
    pub updated_at: u64,
    pub max_staleness: u64,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct FiatSpendLimitSetEvent {
    pub owner: Address,
    pub token: Address,
    pub fiat: Symbol,
    pub fiat_limit: i128,
    pub window_secs: u64,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct FiatLimitRejectedEvent {
    pub proposal_id: u64,
    pub owner: Address,
    pub token: Address,
    pub fiat: Symbol,
    /// Fiat value of the proposed spend at current oracle price.
    pub fiat_value: i128,
    /// The configured fiat limit.
    pub fiat_limit: i128,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

// ── #955: Denylist events ──

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct DenylistChangedEvent {
    pub address: Address,
    pub denied: bool,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct DenylistBlockedEvent {
    pub proposal_id: u64,
    pub recipient: Address,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

// ── #953: Cross-asset rebalancing events ──

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct RebalanceProposedEvent {
    pub proposal_id: u64,
    pub proposer: Address,
    pub router: Address,
    pub targets: Vec<RebalanceTarget>,
    pub tolerance_bps: u32,
    pub swap_deadline: u64,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct AssetTreasuryAccounting {
    pub token: Address,
    pub total_spent: i128,
    pub window_spent: i128,
    pub spend_limit: Option<i128>,
    pub window_secs: u64,
    pub epoch: u64,
    pub available_limit: Option<i128>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ProposalDependenciesSetEvent {
    pub id: u64,
    pub dependencies: Vec<u64>,
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct TreasurySpendingLimitExecutedEvent {
    pub token: Address,
    pub previous_limit: Option<i128>,
    pub new_limit: i128,
    pub window_secs: u64,
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct TreasurySpendTrackedEvent {
    pub token: Address,
    pub amount: i128,
    pub total_spent_window: i128,
    pub total_spent_lifetime: i128,
    pub version: u32,
}

// ─── Errors ──────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct FrozenEvent {
    pub guardian: Address,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct UnfrozenEvent {
    pub approvers: Vec<Address>,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct RecoveryEnteredEvent {
    pub guardian: Address,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct RecoveryExitedEvent {
    pub approvers: Vec<Address>,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
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
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct RecurringPaymentPausedEvent {
    pub id: u64,
    pub caller: Address,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct RecurringPaymentResumedEvent {
    pub id: u64,
    pub caller: Address,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
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
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
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
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct RecurringPaymentCancelledEvent {
    pub id: u64,
    pub caller: Address,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct UpgradeExecutedEvent {
    pub caller: Address,
    pub new_wasm_hash: BytesN<32>,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct AddOwnerExecutedEvent {
    pub new_owner: Address,
    pub owner_count: u32,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct RemoveOwnerExecutedEvent {
    pub removed_owner: Address,
    pub owner_count: u32,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ChangeThresholdExecutedEvent {
    pub previous_threshold: u32,
    pub new_threshold: u32,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct SetSpendingLimitExecutedEvent {
    pub owner: Address,
    pub token: Address,
    pub previous_limit: Option<i128>,
    pub new_limit: i128,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct OwnerWeightChangedEvent {
    pub owner: Address,
    pub old_weight: u32,
    pub new_weight: u32,
    pub new_total_weight: u32,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct GovernanceMigratedEvent {
    pub owner_count: u32,
    pub total_weight: u32,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct RbacMigratedEvent {
    pub owner_count: u32,
    pub role_version: u32,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct RoleGrantedEvent {
    pub target: Address,
    pub role: Role,
    pub before: Vec<Role>,
    pub after: Vec<Role>,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct RoleRevokedEvent {
    pub target: Address,
    pub role: Role,
    pub before: Vec<Role>,
    pub after: Vec<Role>,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
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
    InvalidWeightsLength = 42,
    WeightBelowMinimum = 43,
    InvalidWeight = 44,
    AlreadyMigrated = 45,
    SingleOwnerWeightCapExceeded = 46,
    TargetOwnerNoLongerExists = 47,
    WouldBreakQuorum = 48,
    CannotRemoveLastOwner = 49,
    ThresholdExceedsOwnerCount = 50,
    ScheduleNotActive = 51,
    /// Thrown when an action requires a role the target does not hold.
    MissingRole = 52,
    /// Thrown when attempting to grant a role that the target already holds.
    RoleAlreadyGranted = 53,
    /// Thrown when attempting to revoke a role that the target does not hold.
    RoleNotGranted = 54,
    /// Thrown when a specified role is not valid for the current context.
    InvalidRole = 55,
    /// Thrown when a deprecated entrypoint is called instead of its replacement.
    DeprecatedEntrypoint = 56,
    /// Thrown when an outflow is blocked because recovery mode is active.
    RecoveryActive = 57,
    AssetNotApproved = 61,
    AssetRegistryState = 62,
    EscrowNotFound = 63,
    EscrowConditionNotMet = 64,
    EscrowFundsUnavailable = 65,
    /// Thrown when a proposal's parent dependency has not yet executed.
    DependencyNotExecuted = 66,
    /// Thrown when a proposal's parent dependency was cancelled.
    DependencyCancelled = 67,
    /// Thrown when a proposal's parent dependency has expired.
    DependencyExpired = 68,
    /// Thrown when an invalid dependency is specified (e.g., self-reference, forward reference, or non-existent proposal).
    InvalidDependency = 69,
    /// Thrown when duplicate dependencies are declared.
    DuplicateDependency = 70,
    /// Thrown when a proposal declares more than the maximum permitted number of dependencies.
    TooManyDependencies = 71,
    /// Thrown when a treasury outflow would exceed the per-asset rolling treasury spending limit.
    TreasurySpendingLimitExceeded = 72,
    /// Thrown when an invalid treasury spending limit configuration is provided.
    InvalidSpendingLimit = 73,
    /// Thrown when attempting an action on a dependency that cannot be found.
    DependencyNotFound = 74,
    AlreadyAbstained = 75,
    NotAbstained = 76,
    AlreadySoftApproved = 77,
    NotSoftApproved = 78,
    /// Thrown when a requested storage schema version is not in the registry
    /// or is newer than the running contract.
    UnsupportedSchemaVersion = 79,
    /// Thrown when a migration would skip an intermediate schema version or
    /// move backwards.
    SkippedSchemaVersion = 80,
    /// Thrown when the caller's expected current schema version is stale.
    SchemaVersionMismatch = 81,
    /// Thrown when a legacy deployment must run its legacy migrations first.
    LegacyMigrationRequired = 82,
    /// Thrown when an owner rotation is executed before its activation delay.
    OwnerRotationDelayActive = 83,
    /// Thrown when social recovery is attempted without a configured guardian
    /// quorum.
    GuardianQuorumNotConfigured = 84,
    /// Thrown when a guardian quorum is configured with invalid membership or
    /// threshold.
    InvalidGuardianQuorum = 85,
    /// Thrown when the caller is not a configured recovery guardian.
    NotGuardian = 86,
    /// Thrown when a social-recovery request does not exist.
    RecoveryRequestNotFound = 87,
    /// Thrown when a social-recovery request has not reached quorum yet.
    RecoveryRequestNotReady = 88,
    /// Thrown when social recovery is executed before its delay has elapsed.
    RecoveryDelayActive = 89,
    /// Thrown when a DEX swap declares an empty or malformed path.
    InvalidSwapPath = 90,
    /// Thrown when a swap deadline is invalid or already passed.
    InvalidSwapDeadline = 91,
    /// Thrown when a swap would return less than the declared minimum.
    SlippageExceeded = 92,
    /// Thrown when a DEX router invocation fails.
    SwapFailed = 93,
    /// Thrown when payment reconciliation metadata is empty or too long.
    MetadataTooLong = 94,
    /// Thrown when a spend policy declares no limits.
    EmptySpendPolicy = 95,
    /// Thrown when a spend policy declares more than the maximum windows.
    TooManySpendWindows = 96,
    /// Thrown when a spend policy declares an invalid window kind.
    InvalidSpendWindow = 97,
    /// Thrown when no oracle price is configured for a token/fiat pair.
    OracleNotConfigured = 98,
    /// Thrown when an oracle price is non-positive or malformed.
    OraclePriceInvalid = 99,
    /// Thrown when an oracle price is older than its maximum staleness.
    OraclePriceStale = 100,
    /// Thrown when a rebalance declares no targets.
    EmptyRebalance = 101,
    /// Thrown when a rebalance target weight is invalid.
    InvalidTargetWeight = 102,
    /// Thrown when a yield venue is not approved.
    YieldVenueNotApproved = 103,
    /// Thrown when a yield venue invocation fails.
    YieldVenueFailed = 104,
    /// Thrown when no yield position exists for the venue and token.
    YieldPositionNotFound = 105,
    /// Thrown when a yield position is already open.
    YieldPositionAlreadyOpen = 106,
    /// Thrown when a yield withdrawal returns less than the declared minimum.
    YieldReturnBelowMinimum = 107,
    /// Thrown when a pull-payment request does not exist.
    PullPaymentNotFound = 108,
    /// Thrown when a pull-payment request is not open.
    PullPaymentNotOpen = 109,
    /// Thrown when a pull-payment request has expired.
    PullPaymentExpired = 110,
    /// Thrown when the claimant does not match the request.
    PullPaymentWrongClaimant = 111,
    /// Thrown when a proposal has already been executed.
    ProposalAlreadyExecuted = 112,
    /// Thrown when the recipient is on the governance denylist.
    RecipientDenied = 113,
    /// Thrown when a denylist operation would leave the list empty.
    DenylistEmpty = 114,
    /// Thrown when rebalance targets reference an inconsistent token set.
    RebalanceTokenMismatch = 115,
    /// Thrown when a rebalance targets an unapproved router.
    RebalanceRouterNotApproved = 116,
    /// Thrown when a delegation does not exist for the delegator.
    DelegationNotFound = 117,
    /// Thrown when a delegation already exists for the delegator.
    DelegationAlreadyExists = 118,
    /// Thrown when a delegation expiry is not in the future.
    InvalidDelegationExpiry = 119,
    /// Thrown when a delegation weight is invalid.
    InvalidDelegationWeight = 120,
    /// Thrown when a delegate would receive more delegated weight than the cap.
    DelegateWeightCapExceeded = 121,
    AssetOutflowPaused = 122,
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

/// Per-owner abstention weight for a proposal. A positive value means the
/// owner recorded an abstention. It contributes to participation metrics only
/// and is never added to Proposal.approvals or Proposal.approval_weight.
fn abstention_key(proposal_id: u64, owner: &Address) -> (Symbol, u64, Address) {
    (symbol_short!("ABST"), proposal_id, owner.clone())
}

/// Per-owner soft-approval weight for a proposal. Positive participation support
/// is recorded here, but it is never added to approval/quorum weight.
fn soft_approval_key(proposal_id: u64, owner: &Address) -> (Symbol, u64, Address) {
    (symbol_short!("SOFT"), proposal_id, owner.clone())
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

fn recovery_key() -> Symbol {
    symbol_short!("RECOV")
}

fn guardian_quorum_key() -> Symbol {
    symbol_short!("GUARDS")
}

fn social_recovery_next_key() -> Symbol {
    symbol_short!("SRNEXT")
}

fn social_recovery_key(id: u64) -> (Symbol, u64) {
    (symbol_short!("SREC"), id)
}

fn asset_freeze_key(token: &Address) -> (Symbol, Address) {
    (symbol_short!("AFRZ"), token.clone())
}

fn asset_outflow_pause_key(token: &Address) -> (Symbol, Address) {
    (symbol_short!("OPAUSE"), token.clone())
}

fn kind_freeze_key(kind: ProposalKindTag) -> (Symbol, ProposalKindTag) {
    (symbol_short!("KFRZ"), kind)
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

fn total_weight_key() -> Symbol {
    symbol_short!("TWEIGHT")
}

fn governance_version_key() -> Symbol {
    symbol_short!("GOVVER")
}

fn role_version_key() -> Symbol {
    symbol_short!("ROLEVER")
}

/// Storage-schema version marker. Records which on-chain storage layout this
/// deployment uses so operators and tooling can tell them apart. See
/// `docs/ARCHITECTURE.md` §3 (Storage Schema Versioning).
fn storage_version_key() -> Symbol {
    symbol_short!("STOVER")
}

pub fn role_key(address: &Address) -> (Symbol, Address) {
    (symbol_short!("ROLES"), address.clone())
}

fn owner_roles_key(owner: &Address) -> (Symbol, Address) {
    role_key(owner)
}

fn role_members_key(role: &Role) -> (Symbol, Role) {
    (symbol_short!("RMEM"), role.clone())
}

const RBAC_VERSION: u32 = 1;

pub const DEFAULT_OWNER_ROLES: [Role; 3] = [Role::Proposer, Role::Approver, Role::Executor];

/// Storage-schema version. Any release that adds or changes a storage key
/// increments this and documents the change in `docs/ARCHITECTURE.md` §3
/// (Storage Schema Versioning). Written at `initialize` and by the one-time
/// migrations that bring a legacy layout up to the current schema, so a
/// deployed contract can always report the layout it actually uses. A missing
/// key reads as `0`, meaning a pre-versioning (legacy) deployment.
/// Version 2 introduces proposal dependency graphs, per-asset treasury accounting and
/// spend limits, additive per-proposal abstention and soft-approval records,
/// scoped freezes, guardian-quorum social recovery, and staged owner rotation.
/// Version 3 adds the indexed incoming delegated weight used to cap delegation.
/// Version 4 adds the per-asset outflow pause index.
const STORAGE_SCHEMA_VERSION: u32 = 4;

/// Every storage layout this contract can read or migrate to. `0` is the
/// pre-versioning legacy layout, `1` added weighted governance/RBAC, `2` added
/// scoped freezes, guardian-quorum recovery requests, and the rotation proposal
/// kind, `3` added the incoming delegated-weight index, and `4` added the
/// per-asset outflow pause index. A version outside this list is unknown and
/// must be refused.
pub const SUPPORTED_STORAGE_VERSIONS: [u32; 5] = [0, 1, 2, 3, 4];

/// Minimum delay between a `RotateOwner` proposal reaching quorum and its
/// activation. Gives the existing owner key time to object before handoff.
pub const OWNER_ROTATION_DELAY: u64 = 86_400;

/// Delay between the guardian quorum approving a social-recovery request and
/// the ownership change becoming executable.
pub const SOCIAL_RECOVERY_DELAY: u64 = 172_800;

const MIN_GUARDIANS: u32 = 1;
const MAX_GUARDIANS: u32 = 10;

/// Event-schema version. Bump this constant whenever any event struct gains,
/// loses, or renames a field. Off-chain consumers (indexer, analytics API)
/// read this field on every event to detect schema changes. The versioning
/// policy is documented in `docs/EVENTS.md` §Event Versioning Policy.
///
/// History:
///   1 — initial versioned event schema (all structs gain the `version` field).
///   2 — `ProposalExecutedEvent` drops `transfers`. A maximum-size batch
///       (50 transfers) duplicated in the event pushed the transaction's
///       contract-event payload past the network's 16 KiB limit, so the
///       executed event now carries only `id` and `executor`; the transfer
///       list remains available in `ProposalCreatedEvent` and on-chain state.
///   3 — adds abstention events and participation fields to the abstention
///       views. Abstentions are participation records and never approval weight.
pub const EVENT_SCHEMA_VERSION: u32 = 3;

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

fn owner_spending_limits_key(owner: &Address) -> (Symbol, Address) {
    (symbol_short!("OSLIM"), owner.clone())
}

fn spent_tracking_key(owner: &Address, token: &Address) -> (Symbol, Address, Address) {
    (symbol_short!("SPENT"), owner.clone(), token.clone())
}

fn spending_window_key(owner: &Address, token: &Address) -> (Symbol, Address, Address) {
    (symbol_short!("SWIND"), owner.clone(), token.clone())
}

fn proposal_dependencies_key(proposal_id: u64) -> (Symbol, u64) {
    (symbol_short!("PDEP"), proposal_id)
}

fn treasury_spending_limit_key(token: &Address) -> (Symbol, Address) {
    (symbol_short!("TRLIM"), token.clone())
}

fn treasury_spending_window_key(token: &Address) -> (Symbol, Address) {
    (symbol_short!("TRWIND"), token.clone())
}

fn treasury_spent_key(token: &Address) -> (Symbol, Address) {
    (symbol_short!("TRSPENT"), token.clone())
}

fn treasury_total_spent_key(token: &Address) -> (Symbol, Address) {
    (symbol_short!("TRTOT"), token.clone())
}

fn classic_asset_key(asset: &Symbol) -> (Symbol, Symbol) {
    (symbol_short!("CLASSIC"), asset.clone())
}

fn delegation_key(delegator: &Address) -> (Symbol, Address) {
    (symbol_short!("DELEG"), delegator.clone())
}

fn delegated_weight_key(delegate: &Address) -> (Symbol, Address) {
    (symbol_short!("DLGWT"), delegate.clone())
}

fn asset_registry_enabled_key() -> Symbol {
    symbol_short!("ASTEN")
}

fn approved_token_key(token: &Address) -> (Symbol, Address) {
    (symbol_short!("ATOKEN"), token.clone())
}

fn escrow_next_id_key() -> Symbol {
    symbol_short!("ESCNEXT")
}

fn escrow_key(id: u64) -> (Symbol, u64) {
    (symbol_short!("ESCROW"), id)
}

fn escrow_reserved_key(token: &Address) -> (Symbol, Address) {
    (symbol_short!("ERES"), token.clone())
}

/// Persistent key for the approved DEX router registry.
/// A router address is stored as `(DXRTR, router_addr) → bool`.
fn dex_router_approved_key(router: &Address) -> (Symbol, Address) {
    (symbol_short!("DXRTR"), router.clone())
}

/// Persistent key for the approved yield venue registry.
/// A venue address is stored as `(YVENUE, venue_addr) → bool`.
fn yield_venue_approved_key(venue: &Address) -> (Symbol, Address) {
    (symbol_short!("YVENUE"), venue.clone())
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

// Escrows can remain live for the 90-day proposal horizon. Keep their record
// and aggregate reservation alive beyond that horizon even if untouched.
const ESCROW_PERSISTENT_BUMP: u32 = 1_814_400;
const ESCROW_PERSISTENT_THRESHOLD: u32 = 259_200;

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

fn bump_escrow_persistent<K: IntoVal<Env, Val>>(env: &Env, key: &K) {
    env.storage().persistent().extend_ttl(
        key,
        ESCROW_PERSISTENT_THRESHOLD,
        ESCROW_PERSISTENT_BUMP,
    );
    env.storage().instance().extend_ttl(
        ESCROW_PERSISTENT_THRESHOLD,
        ESCROW_PERSISTENT_BUMP,
    );
}

// ─── Validation Constants ────────────────────────────────────────────────────

/// Contract version, bumped on each release. Queried via `get_version`.
const CONTRACT_VERSION: u32 = 2;
/// Minimum amount: 0.1 stroops of whatever token is used.
const MIN_AMOUNT: i128 = 1;
/// Max description: 300 characters.
const MAX_DESCRIPTION_LEN: u32 = 300;
/// Maximum active (Pending + Ready) proposals at once to bound storage cost.
const MAX_ACTIVE_PROPOSALS: u32 = 50;
/// Maximum dependencies a single proposal may declare.
const MAX_PROPOSAL_DEPENDENCIES: u32 = 10;
/// Maximum number of individual transfers in one proposal.
const MAX_BATCH_TRANSFERS: u32 = 50;
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
/// Maximum number of addresses returned by `get_role_members`. Role holders
/// are always owners, so this matches `MAX_OWNERS` and the 20-item cap used by
/// the other paged views.
const MAX_ROLE_MEMBERS_RESULT: u32 = MAX_OWNERS;

/// Spending window: 30 days in seconds. The cumulative spent amount per (owner, token)
/// resets when this window elapses since the first tracked spend in the window.
/// Epoch-based window: the window clock starts ticking from the timestamp of the first
/// spend (or when the limit was set). This is deterministic — two contracts with the
/// same set of operations will arrive at identical window boundaries. A rolling window
/// (sliding per-transaction) was considered but rejected because it would make the
/// "available limit" view depend on the exact time of each prior transaction, producing
/// non-deterministic behavior across nodes executing the same transaction sequence.
const SPENDING_WINDOW: u64 = 2_592_000;
const MIN_SPENDING_WINDOW: u64 = 86_400;
const MAX_SPENDING_WINDOW: u64 = 604_800;

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
    env.storage()
        .instance()
        .set(&active_recur_count_key(), &count);
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

fn read_role_version(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&role_version_key())
        .unwrap_or(0)
}

fn write_role_version(env: &Env, version: u32) {
    env.storage().instance().set(&role_version_key(), &version);
    bump_instance(env);
}

fn read_storage_version(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&storage_version_key())
        .unwrap_or(0)
}

fn write_storage_version(env: &Env) {
    write_storage_version_value(env, STORAGE_SCHEMA_VERSION);
}

fn write_storage_version_value(env: &Env, version: u32) {
    env.storage()
        .instance()
        .set(&storage_version_key(), &version);
    bump_instance(env);
}

pub fn read_roles(env: &Env, address: &Address) -> Vec<Role> {
    let key = role_key(address);
    let roles = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env));
    if env.storage().persistent().has(&key) {
        bump_persistent(env, &key);
    }
    roles
}

fn read_owner_roles(env: &Env, owner: &Address) -> Vec<Role> {
    read_roles(env, owner)
}

fn read_role_members(env: &Env, role: &Role) -> Vec<Address> {
    let key = role_members_key(role);
    let members = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env));
    if env.storage().persistent().has(&key) {
        bump_persistent(env, &key);
    }
    members
}

pub fn write_roles(env: &Env, address: &Address, roles: &Vec<Role>) {
    let key = role_key(address);
    env.storage().persistent().set(&key, roles);
    bump_persistent(env, &key);
}

fn write_owner_roles(env: &Env, owner: &Address, roles: &Vec<Role>) {
    write_roles(env, owner, roles);
}

fn write_role_members(env: &Env, role: &Role, members: &Vec<Address>) {
    let key = role_members_key(role);
    env.storage().persistent().set(&key, members);
    bump_persistent(env, &key);
}

fn update_owner_roles(env: &Env, owner: &Address, roles: &Vec<Role>) {
    let old_roles = read_owner_roles(env, owner);
    for old_role in old_roles.iter() {
        let members = read_role_members(env, &old_role);
        let mut remaining = Vec::new(env);
        for member in members.iter() {
            if member != *owner {
                remaining.push_back(member);
            }
        }
        write_role_members(env, &old_role, &remaining);
    }

    write_owner_roles(env, owner, roles);
    for role in roles.iter() {
        let members = read_role_members(env, &role);
        let mut present = false;
        for member in members.iter() {
            if member == *owner {
                present = true;
                break;
            }
        }
        if !present {
            let mut updated = members;
            updated.push_back(owner.clone());
            write_role_members(env, &role, &updated);
        }
    }
}

/// True only when a `try_transfer` call both completed and returned the SEP-41
/// unit value. A token that traps, errors, or returns any other value (for
/// example `false`) is treated as a failed transfer: the generated client
/// reports a mistyped return as `Ok(Err(_))`, which a bare `.is_err()` on the
/// outer `Result` would let through.
fn transfer_succeeded<C, E>(result: Result<Result<(), C>, E>) -> bool {
    matches!(result, Ok(Ok(())))
}

fn has_role(env: &Env, owner: &Address, role: &Role) -> bool {
    for assigned in read_owner_roles(env, owner).iter() {
        if assigned == *role {
            return true;
        }
    }
    false
}

/// Requires `address` to hold `role` (`MissingRole` otherwise).
fn require_role(env: &Env, address: &Address, role: Role) -> Result<(), ContractError> {
    if has_role(env, address, &role) {
        Ok(())
    } else {
        Err(ContractError::MissingRole)
    }
}

/// Converts a Symbol role argument (e.g. "Approver", "Proposer") into the
/// internal `Role` enum. Accepts both the short UI names (Proposer/Approver/
/// Executor) and the historical enum variant names
/// (CreateProposal/ApproveProposal/ExecuteProposal) for backwards
/// compatibility. Returns `InvalidRole` for any other value.
fn symbol_to_role(env: &Env, sym: &Symbol) -> Result<Role, ContractError> {
    if *sym == Symbol::new(env, "Proposer") || *sym == Symbol::new(env, "CreateProposal") {
        return Ok(Role::Proposer);
    }
    if *sym == Symbol::new(env, "Approver") || *sym == Symbol::new(env, "ApproveProposal") {
        return Ok(Role::Approver);
    }
    if *sym == Symbol::new(env, "Executor") || *sym == Symbol::new(env, "ExecuteProposal") {
        return Ok(Role::Executor);
    }
    if *sym == Symbol::new(env, "Viewer") {
        return Ok(Role::Viewer);
    }
    Err(ContractError::InvalidRole)
}

/// Returns true if the Symbol denotes the Approver role in any accepted form.
fn is_approver_symbol(env: &Env, sym: &Symbol) -> bool {
    matches!(symbol_to_role(env, sym), Ok(Role::Approver))
}

/// Sums the voting weight of all owners that currently hold the Approver role.
fn total_approver_weight(env: &Env) -> Result<u32, ContractError> {
    let owners = read_owners_map(env)?;
    let mut total: u32 = 0;
    for owner in owners.keys().iter() {
        if has_role(env, &owner, &Role::Approver) {
            let w = owners.get(owner.clone()).unwrap_or(0);
            total = checked_weight_add(total, w)?;
        }
    }
    Ok(total)
}

/// Weight that would remain with Approvers after revoking `target`'s
/// Approver role. If `target` is not an owner or does not hold Approver,
/// the result equals the current total approver weight.
fn remaining_approver_weight_after_revoke(
    env: &Env,
    target: &Address,
) -> Result<u32, ContractError> {
    let owners = read_owners_map(env)?;
    let total = total_approver_weight(env)?;
    if !has_role(env, target, &Role::Approver) {
        return Ok(total);
    }
    if let Some(w) = owners.get(target.clone()) {
        checked_weight_sub(total, w)
    } else {
        // Target holds Approver but is not an owner (e.g. non-owner delegate):
        // revoking does not affect quorum, since only owner weight counts.
        Ok(total)
    }
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
    env.storage()
        .persistent()
        .remove(&delegation_key(delegator));
}

fn delegation_weight_cap(env: &Env, total_weight: u32) -> u32 {
    if total_weight == 0 {
        return 0;
    }
    let cap = (total_weight as u64) * (read_max_single_owner_weight_pct(env) as u64) / 100;
    cap.max(1) as u32
}

fn read_delegated_weight(env: &Env, delegate: &Address) -> u32 {
    let key = delegated_weight_key(delegate);
    let weight: Option<u32> = env.storage().persistent().get(&key);
    if weight.is_some() {
        bump_persistent(env, &key);
    }
    weight.unwrap_or(0)
}

fn write_delegated_weight(env: &Env, delegate: &Address, weight: u32) {
    let key = delegated_weight_key(delegate);
    if weight == 0 {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, &weight);
        bump_persistent(env, &key);
    }
}

fn compute_received_delegated_weight_excluding(
    env: &Env,
    owners: &Map<Address, u32>,
    delegate: &Address,
    excluded_delegator: Option<&Address>,
) -> Result<u32, ContractError> {
    let mut total = 0_u32;
    for other in owners.keys().iter() {
        if other == *delegate || excluded_delegator == Some(&other) {
            continue;
        }
        if let Some(delegation) = read_delegation(env, &other) {
            if delegation.delegate == *delegate && is_delegation_active(env, &delegation) {
                total = checked_weight_add(total, delegation.weight)?;
            }
        }
    }
    Ok(total)
}

fn compute_received_delegated_weight(
    env: &Env,
    owners: &Map<Address, u32>,
    delegate: &Address,
) -> Result<u32, ContractError> {
    compute_received_delegated_weight_excluding(env, owners, delegate, None)
}

fn refresh_delegated_weight(env: &Env, delegate: &Address) -> Result<u32, ContractError> {
    let owners = read_owners_map(env)?;
    let weight = compute_received_delegated_weight(env, &owners, delegate)?;
    write_delegated_weight(env, delegate, weight);
    Ok(weight)
}

fn rebuild_delegated_weight_index(env: &Env) -> Result<(), ContractError> {
    let owners = read_owners_map(env)?;
    for owner in owners.keys().iter() {
        write_delegated_weight(
            env,
            &owner,
            compute_received_delegated_weight(env, &owners, &owner)?,
        );
    }
    Ok(())
}

/// Drops every delegation that references `owner`, either as delegator or as
/// delegate. Used when an owner address stops being an owner, so voting weight
/// cannot be silently redirected or stranded.
fn remove_delegations_touching(env: &Env, owner: &Address) {
    let mut affected: Vec<Address> = Vec::new(env);
    if let Some(outgoing) = read_delegation(env, owner) {
        affected.push_back(outgoing.delegate);
    }
    remove_delegation(env, owner);
    if let Ok(owners) = read_owners_map(env) {
        for other in owners.keys().iter() {
            if let Some(delegation) = read_delegation(env, &other) {
                if delegation.delegate == *owner {
                    affected.push_back(delegation.delegate);
                    remove_delegation(env, &other);
                }
            }
        }
    }
    for delegate in affected.iter() {
        let _ = refresh_delegated_weight(env, &delegate);
    }
    let _ = refresh_delegated_weight(env, owner);
}

/// Reverses an ex-owner's approvals on every still-active proposal so a key
/// that is removed or rotated away cannot keep contributing quorum.
fn purge_owner_approvals(env: &Env, owner: &Address) -> Result<(), ContractError> {
    let next_id = read_next_id(env);
    for pid in 1..next_id {
        if let Ok(mut proposal) = read_proposal(env, pid) {
            let status = derive_status(env, &proposal);
            if matches!(status, ProposalStatus::Pending | ProposalStatus::Ready) {
                let counted = read_approval_weight(env, pid, owner);
                if counted > 0 {
                    write_approval_weight(env, pid, owner, 0);
                    proposal.approvals = checked_weight_sub(proposal.approvals, counted)?;
                    proposal.approval_weight =
                        checked_weight_sub(proposal.approval_weight, counted)?;
                    proposal.status = derive_status(env, &proposal);
                    write_proposal(env, &proposal);
                }
            }
        }
    }
    Ok(())
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

fn read_escrow(env: &Env, id: u64) -> Result<EscrowRecord, ContractError> {
    let key = escrow_key(id);
    let escrow = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(ContractError::EscrowNotFound)?;
    bump_escrow_persistent(env, &key);
    Ok(escrow)
}

fn write_escrow(env: &Env, escrow: &EscrowRecord) {
    let key = escrow_key(escrow.id);
    env.storage().persistent().set(&key, escrow);
    bump_escrow_persistent(env, &key);
}

fn read_reserved_balance(env: &Env, token: &Address) -> i128 {
    let key = escrow_reserved_key(token);
    let reserved = env.storage().persistent().get(&key).unwrap_or(0_i128);
    if reserved > 0 {
        bump_escrow_persistent(env, &key);
    }
    reserved
}

fn write_reserved_balance(env: &Env, token: &Address, amount: i128) {
    let key = escrow_reserved_key(token);
    if amount == 0 {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, &amount);
        bump_escrow_persistent(env, &key);
    }
}

fn available_balance(env: &Env, token: &Address) -> Result<i128, ContractError> {
    token::Client::new(env, token)
        .balance(&env.current_contract_address())
        .checked_sub(read_reserved_balance(env, token))
        .ok_or(ContractError::ArithmeticError)
}

fn read_next_escrow_id(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&escrow_next_id_key())
        .unwrap_or(1_u64)
}

fn write_next_escrow_id(env: &Env, id: u64) {
    env.storage().instance().set(&escrow_next_id_key(), &id);
    bump_instance(env);
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

fn read_abstention_weight(env: &Env, proposal_id: u64, owner: &Address) -> u32 {
    let key = abstention_key(proposal_id, owner);
    let weight: u32 = env.storage().persistent().get(&key).unwrap_or(0);
    if weight > 0 {
        bump_persistent(env, &key);
    }
    weight
}

fn write_abstention_weight(env: &Env, proposal_id: u64, owner: &Address, weight: u32) {
    let key = abstention_key(proposal_id, owner);
    if weight == 0 {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, &weight);
        bump_persistent(env, &key);
    }
}

fn has_abstention_weight(env: &Env, proposal_id: u64, owner: &Address) -> bool {
    read_abstention_weight(env, proposal_id, owner) > 0
}

fn read_soft_approval_weight(env: &Env, proposal_id: u64, owner: &Address) -> u32 {
    let key = soft_approval_key(proposal_id, owner);
    let weight: u32 = env.storage().persistent().get(&key).unwrap_or(0);
    if weight > 0 {
        bump_persistent(env, &key);
    }
    weight
}

fn write_soft_approval_weight(env: &Env, proposal_id: u64, owner: &Address, weight: u32) {
    let key = soft_approval_key(proposal_id, owner);
    if weight == 0 {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, &weight);
        bump_persistent(env, &key);
    }
}

fn has_soft_approval_weight(env: &Env, proposal_id: u64, owner: &Address) -> bool {
    read_soft_approval_weight(env, proposal_id, owner) > 0
}

fn participation_progress(
    env: &Env,
    proposal_id: u64,
) -> Result<(u32, u32, u32, u32, u32), ContractError> {
    let owners = read_owners_map(env)?;
    let mut abstention_count = 0_u32;
    let mut abstention_weight = 0_u32;
    let mut participation_weight = 0_u32;
    let mut soft_approval_count = 0_u32;
    let mut soft_approval_weight = 0_u32;

    for owner in owners.keys().iter() {
        let approved = read_approval_weight(env, proposal_id, &owner) > 0;
        let abstained_weight = read_abstention_weight(env, proposal_id, &owner);
        let soft_weight = read_soft_approval_weight(env, proposal_id, &owner);
        if abstained_weight > 0 {
            abstention_count = checked_weight_add(abstention_count, 1)?;
            abstention_weight = checked_weight_add(abstention_weight, abstained_weight)?;
        }
        if soft_weight > 0 {
            soft_approval_count = checked_weight_add(soft_approval_count, 1)?;
            soft_approval_weight = checked_weight_add(soft_approval_weight, soft_weight)?;
        }
        if approved {
            participation_weight = checked_weight_add(
                participation_weight,
                read_approval_weight(env, proposal_id, &owner),
            )?;
        } else if abstained_weight > 0 {
            participation_weight = checked_weight_add(participation_weight, abstained_weight)?;
        } else if soft_weight > 0 {
            participation_weight = checked_weight_add(participation_weight, soft_weight)?;
        }
    }
    Ok((
        abstention_count,
        abstention_weight,
        participation_weight,
        soft_approval_count,
        soft_approval_weight,
    ))
}

fn write_spending_limit(env: &Env, owner: &Address, token: &Address, limit: i128) {
    let key = spending_limit_key(owner, token);
    env.storage().persistent().set(&key, &limit);
    bump_persistent(env, &key);
}

fn write_spending_window(env: &Env, owner: &Address, token: &Address, window_secs: u64) {
    let key = spending_window_key(owner, token);
    env.storage().persistent().set(&key, &window_secs);
    bump_persistent(env, &key);
}

fn read_spending_window(env: &Env, owner: &Address, token: &Address) -> u64 {
    let key = spending_window_key(owner, token);
    let window = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or(SPENDING_WINDOW);
    if env.storage().persistent().has(&key) {
        bump_persistent(env, &key);
    }
    window
}

fn read_owner_spending_limits(env: &Env, owner: &Address) -> Vec<SpendingLimitEntry> {
    let key = owner_spending_limits_key(owner);
    let limits: Vec<SpendingLimitEntry> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or(Vec::new(env));
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

fn read_spending_limit(env: &Env, owner: &Address, token: &Address) -> Option<i128> {
    let key = spending_limit_key(owner, token);
    let limit: Option<i128> = env.storage().persistent().get(&key);
    if limit.is_some() {
        bump_persistent(env, &key);
    }
    limit
}

fn read_spent_tracker(env: &Env, owner: &Address, token: &Address) -> SpentTracker {
    let key = spent_tracking_key(owner, token);
    env
        .storage()
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
    if now > tracker.epoch.saturating_add(read_spending_window(env, owner, token)) {
        return 0;
    }
    tracker.spent
}

fn read_proposal_dependencies(env: &Env, proposal_id: u64) -> Vec<u64> {
    let key = proposal_dependencies_key(proposal_id);
    let deps: Vec<u64> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env));
    if env.storage().persistent().has(&key) {
        bump_persistent(env, &key);
    }
    deps
}

fn write_proposal_dependencies(env: &Env, proposal_id: u64, dependencies: &Vec<u64>) {
    let key = proposal_dependencies_key(proposal_id);
    if dependencies.is_empty() {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, dependencies);
        bump_persistent(env, &key);
    }
}

fn validate_proposal_dependencies(
    env: &Env,
    proposal_id: u64,
    dependencies: &Vec<u64>,
) -> Result<(), ContractError> {
    let count = dependencies.len();
    if count > MAX_PROPOSAL_DEPENDENCIES {
        return Err(ContractError::TooManyDependencies);
    }
    for i in 0..count {
        let dep_id = dependencies.get(i).unwrap();
        if dep_id == proposal_id || dep_id >= proposal_id {
            return Err(ContractError::InvalidDependency);
        }
        for j in (i + 1)..count {
            if dependencies.get(j).unwrap() == dep_id {
                return Err(ContractError::DuplicateDependency);
            }
        }
        let dep_prop = read_proposal(env, dep_id)?;
        let status = if dep_prop.status == ProposalStatus::Executed
            || dep_prop.status == ProposalStatus::Cancelled
        {
            dep_prop.status
        } else {
            derive_status(env, &dep_prop)
        };
        if status == ProposalStatus::Cancelled {
            return Err(ContractError::DependencyCancelled);
        }
        if status == ProposalStatus::Expired {
            return Err(ContractError::DependencyExpired);
        }
    }
    Ok(())
}

fn read_treasury_spending_limit(env: &Env, token: &Address) -> Option<i128> {
    let key = treasury_spending_limit_key(token);
    let limit: Option<i128> = env.storage().persistent().get(&key);
    if limit.is_some() {
        bump_persistent(env, &key);
    }
    limit
}

fn write_treasury_spending_limit(env: &Env, token: &Address, limit: i128) {
    let key = treasury_spending_limit_key(token);
    env.storage().persistent().set(&key, &limit);
    bump_persistent(env, &key);
}

fn read_treasury_spending_window(env: &Env, token: &Address) -> u64 {
    let key = treasury_spending_window_key(token);
    let window = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or(SPENDING_WINDOW);
    if env.storage().persistent().has(&key) {
        bump_persistent(env, &key);
    }
    window
}

fn write_treasury_spending_window(env: &Env, token: &Address, window_secs: u64) {
    let key = treasury_spending_window_key(token);
    env.storage().persistent().set(&key, &window_secs);
    bump_persistent(env, &key);
}

fn read_treasury_spent_tracker(env: &Env, token: &Address) -> SpentTracker {
    let key = treasury_spent_key(token);
    let tracker = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or(SpentTracker { spent: 0, epoch: 0 });
    if env.storage().persistent().has(&key) {
        bump_persistent(env, &key);
    }
    tracker
}

fn write_treasury_spent_tracker(env: &Env, token: &Address, tracker: &SpentTracker) {
    let key = treasury_spent_key(token);
    env.storage().persistent().set(&key, tracker);
    bump_persistent(env, &key);
}

fn read_treasury_total_spent(env: &Env, token: &Address) -> i128 {
    let key = treasury_total_spent_key(token);
    let total = env.storage().persistent().get(&key).unwrap_or(0_i128);
    if env.storage().persistent().has(&key) {
        bump_persistent(env, &key);
    }
    total
}

fn write_treasury_total_spent(env: &Env, token: &Address, total: i128) {
    let key = treasury_total_spent_key(token);
    env.storage().persistent().set(&key, &total);
    bump_persistent(env, &key);
}

fn effective_treasury_spent(env: &Env, token: &Address) -> i128 {
    let tracker = read_treasury_spent_tracker(env, token);
    if tracker.epoch == 0 {
        return 0;
    }
    let now = env.ledger().timestamp();
    let window = read_treasury_spending_window(env, token);
    if now > tracker.epoch.saturating_add(window) {
        return 0;
    }
    tracker.spent
}

fn record_treasury_spend(env: &Env, token: &Address, amount: i128) -> Result<(), ContractError> {
    let now = env.ledger().timestamp();
    let tracker = read_treasury_spent_tracker(env, token);
    let window = read_treasury_spending_window(env, token);
    let expired = tracker.epoch == 0 || now > tracker.epoch.saturating_add(window);
    let epoch = if expired { now } else { tracker.epoch };
    let spent = if expired {
        amount
    } else {
        tracker
            .spent
            .checked_add(amount)
            .ok_or(ContractError::ArithmeticError)?
    };
    write_treasury_spent_tracker(env, token, &SpentTracker { spent, epoch });

    let current_total = read_treasury_total_spent(env, token);
    let new_total = current_total
        .checked_add(amount)
        .ok_or(ContractError::ArithmeticError)?;
    write_treasury_total_spent(env, token, new_total);

    env.events().publish(
        (symbol_short!("tr_spnt"),),
        TreasurySpendTrackedEvent {
            version: EVENT_SCHEMA_VERSION,
            token: token.clone(),
            amount,
            total_spent_window: spent,
            total_spent_lifetime: new_total,
        },
    );
    Ok(())
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

fn is_recovery_state(env: &Env) -> bool {
    env.storage()
        .instance()
        .get::<_, bool>(&recovery_key())
        .unwrap_or(false)
}

fn write_recovery(env: &Env, recovery: bool) {
    env.storage().instance().set(&recovery_key(), &recovery);
    bump_instance(env);
}

fn require_not_recovery(env: &Env) -> Result<(), ContractError> {
    if is_recovery_state(env) {
        return Err(ContractError::RecoveryActive);
    }
    Ok(())
}

fn proposal_kind_tag(kind: &ProposalKind) -> ProposalKindTag {
    match kind {
        ProposalKind::Transfer(_)
        | ProposalKind::DexSwap(_)
        | ProposalKind::YieldDeposit(_)
        | ProposalKind::YieldWithdraw(_)
        | ProposalKind::CreatePullPayment(_)
        | ProposalKind::Rebalance(_) => ProposalKindTag::Transfer,
        ProposalKind::CreateRecurringPayment(_)
        | ProposalKind::CancelRecurringPayment(_)
        | ProposalKind::PauseRecurringPayment(_)
        | ProposalKind::ResumeRecurringPayment(_)
        | ProposalKind::ModifyRecurringPayment(_) => ProposalKindTag::Recurring,
        ProposalKind::CreateEscrow(_) => ProposalKindTag::Escrow,
        ProposalKind::AddOwner(_, _)
        | ProposalKind::RemoveOwner(_)
        | ProposalKind::ChangeOwnerWeight(_, _)
        | ProposalKind::RotateOwner(_, _) => ProposalKindTag::Ownership,
        ProposalKind::ChangeThreshold(_)
        | ProposalKind::SetSpendingLimit(_, _, _)
        | ProposalKind::SetSpendingLimitWindow(_, _, _, _)
        | ProposalKind::SetTreasurySpendingLimit(_, _, _)
        | ProposalKind::GrantRole(_, _)
        | ProposalKind::RevokeRole(_, _)
        | ProposalKind::SetAssetRegistryEnabled(_)
        | ProposalKind::AddApprovedToken(_)
        | ProposalKind::RemoveApprovedToken(_)
        | ProposalKind::TransferGuardian(_)
        | ProposalKind::AddDexRouter(_)
        | ProposalKind::RemoveDexRouter(_)
        | ProposalKind::AddYieldVenue(_)
        | ProposalKind::RemoveYieldVenue(_)
        | ProposalKind::CancelPullPayment(_)
        | ProposalKind::SetSpendPolicy(_)
        | ProposalKind::ClearSpendPolicy(_, _)
        | ProposalKind::SetOraclePrice(_)
        | ProposalKind::ClearOraclePrice(_, _)
        | ProposalKind::SetFiatSpendLimit(_)
        | ProposalKind::ClearFiatSpendLimit(_, _, _)
        | ProposalKind::AddToDenylist(_)
        | ProposalKind::RemoveFromDenylist(_) => ProposalKindTag::Governance,
    }
}

fn is_asset_frozen(env: &Env, token: &Address) -> bool {
    env.storage()
        .instance()
        .get::<_, bool>(&asset_freeze_key(token))
        .unwrap_or(false)
}

fn is_asset_outflow_paused(env: &Env, token: &Address) -> bool {
    env.storage()
        .instance()
        .get::<_, bool>(&asset_outflow_pause_key(token))
        .unwrap_or(false)
}

fn write_asset_outflow_pause(env: &Env, token: &Address, paused: bool) {
    let key = asset_outflow_pause_key(token);
    if paused {
        env.storage().instance().set(&key, &true);
    } else {
        env.storage().instance().remove(&key);
    }
    bump_instance(env);
}

fn require_asset_outflow_allowed(env: &Env, token: &Address) -> Result<(), ContractError> {
    if is_asset_outflow_paused(env, token) {
        return Err(ContractError::AssetOutflowPaused);
    }
    Ok(())
}

fn is_kind_frozen(env: &Env, kind: ProposalKindTag) -> bool {
    env.storage()
        .instance()
        .get::<_, bool>(&kind_freeze_key(kind))
        .unwrap_or(false)
}

fn require_asset_not_frozen(env: &Env, token: &Address) -> Result<(), ContractError> {
    if is_asset_frozen(env, token) {
        return Err(ContractError::ContractFrozen);
    }
    Ok(())
}

fn require_kind_not_frozen(env: &Env, kind: ProposalKindTag) -> Result<(), ContractError> {
    if is_kind_frozen(env, kind) {
        return Err(ContractError::ContractFrozen);
    }
    Ok(())
}

/// Rejects an outflow of `token` when either the asset itself or its operation
/// family is under a scoped emergency freeze.
fn require_outflow_allowed(
    env: &Env,
    token: &Address,
    kind: ProposalKindTag,
) -> Result<(), ContractError> {
    require_kind_not_frozen(env, kind)?;
    require_asset_not_frozen(env, token)?;
    require_asset_outflow_allowed(env, token)
}

fn read_guardian_quorum(env: &Env) -> Option<GuardianQuorumConfig> {
    env.storage().instance().get(&guardian_quorum_key())
}

fn is_guardian(env: &Env, address: &Address) -> bool {
    match read_guardian_quorum(env) {
        Some(config) => {
            for guardian in config.guardians.iter() {
                if guardian == *address {
                    return true;
                }
            }
            false
        }
        None => false,
    }
}

fn read_social_recovery(env: &Env, id: u64) -> Result<SocialRecoveryRequest, ContractError> {
    env.storage()
        .persistent()
        .get(&social_recovery_key(id))
        .ok_or(ContractError::RecoveryRequestNotFound)
}

fn write_social_recovery(env: &Env, request: &SocialRecoveryRequest) {
    let key = social_recovery_key(request.id);
    env.storage().persistent().set(&key, request);
    bump_persistent(env, &key);
}

fn recovery_approval_count(request: &SocialRecoveryRequest) -> u32 {
    request.approvals.len()
}

fn read_social_recovery_next_id(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&social_recovery_next_key())
        .unwrap_or(1_u64)
}

fn write_social_recovery_next_id(env: &Env, id: u64) {
    env.storage()
        .instance()
        .set(&social_recovery_next_key(), &id);
    bump_instance(env);
}

// ─── Business Logic Helpers ──────────────────────────────────────────────────

fn require_owner_and_weight(env: &Env, address: &Address) -> Result<u32, ContractError> {
    let owners = read_owners_map(env)?;
    owners
        .get(address.clone())
        .ok_or(ContractError::Unauthorized)
}
fn require_owner(env: &Env, address: &Address) -> Result<(), ContractError> {
    require_owner_and_weight(env, address).map(|_| ())
}

fn read_owner_weight(env: &Env, owner: &Address) -> u32 {
    read_owners_map(env)
        .ok()
        .and_then(|m| m.get(owner.clone()))
        .unwrap_or(0)
}

fn read_approval(env: &Env, proposal_id: u64, owner: &Address) -> bool {
    read_approval_weight(env, proposal_id, owner) > 0
}

fn write_approval(env: &Env, proposal_id: u64, owner: &Address, approved: bool) {
    let weight = if approved {
        read_owner_weight(env, owner)
    } else {
        0
    };
    write_approval_weight(env, proposal_id, owner, weight);
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
        ProposalStatus::Executed | ProposalStatus::Revoked | ProposalStatus::Cancelled
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

fn asset_registry_enabled(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&asset_registry_enabled_key())
        .unwrap_or(false)
}

fn token_is_approved(env: &Env, token_address: &Address) -> bool {
    let key = approved_token_key(token_address);
    let approved = env.storage().persistent().get(&key).unwrap_or(false);
    if approved {
        bump_persistent(env, &key);
    }
    approved
}

fn write_token_approved(env: &Env, token_address: &Address, approved: bool) {
    let key = approved_token_key(token_address);
    if approved {
        env.storage().persistent().set(&key, &true);
        bump_persistent(env, &key);
    } else {
        env.storage().persistent().remove(&key);
    }
}

fn dex_router_is_approved(env: &Env, router: &Address) -> bool {
    let key = dex_router_approved_key(router);
    env.storage().persistent().get(&key).unwrap_or(false)
}

fn write_dex_router_approved(env: &Env, router: &Address, approved: bool) {
    let key = dex_router_approved_key(router);
    if approved {
        env.storage().persistent().set(&key, &true);
        bump_persistent(env, &key);
    } else {
        env.storage().persistent().remove(&key);
    }
}

/// Validates all tokens in a DEX swap path against the asset registry.
fn validate_swap_path(env: &Env, path: &Vec<Address>) -> Result<(), ContractError> {
    if path.len() < 2 {
        return Err(ContractError::InvalidSwapPath);
    }
    for token_addr in path.iter() {
        validate_token(env, &token_addr)?;
    }
    Ok(())
}

fn yield_venue_is_approved(env: &Env, venue: &Address) -> bool {
    let key = yield_venue_approved_key(venue);
    env.storage().persistent().get(&key).unwrap_or(false)
}

/// Resolves an asset reference into the token address it stands for.
///
/// `AssetReference::Address` is used as is, `AssetReference::Classic` is
/// looked up in the registry that `set_classic_asset` maintains. The resolved
/// token is validated by the caller, exactly like a directly supplied one.
fn resolve_asset(env: &Env, asset: &AssetReference) -> Result<Address, ContractError> {
    match asset {
        AssetReference::Address(token) => Ok(token.clone()),
        AssetReference::Classic(identifier) => env
            .storage()
            .instance()
            .get(&classic_asset_key(identifier))
            .ok_or(ContractError::InvalidToken),
    }
}

fn create_governance_proposal(
    env: &Env,
    proposer: Address,
    kind: ProposalKind,
    description: String,
    deadline: u64,
) -> Result<u64, ContractError> {
    require_kind_not_frozen(env, proposal_kind_tag(&kind))?;
    validate_description(&description)?;
    validate_deadline(env, deadline)?;

    let threshold = read_threshold(env)?;
    let id = read_next_id(env);
    let proposal = Proposal {
        id,
        proposer: proposer.clone(),
        description,
        deadline,
        approvals: 0,
        approval_weight: 0,
        status: ProposalStatus::Pending,
        kind,
        ready_at: 0,
        quorum_weight: threshold,
        category: ProposalCategory::Other,
        attachment_hash: None,
    };
    write_proposal(env, &proposal);
    register_active_proposal(env, id)?;
    write_next_id(
        env,
        id.checked_add(1).ok_or(ContractError::ArithmeticError)?,
    );

    env.events().publish(
        (symbol_short!("created"),),
        ProposalCreatedEvent {
            id,
            proposer,
            threshold,
            category: ProposalCategory::Other,
            transfers: Vec::new(env),
            quorum_weight: threshold,
            total_weight_at_creation: read_total_weight(env),
            attachment_hash: None,
            version: EVENT_SCHEMA_VERSION,
        },
    );
    Ok(id)
}

fn remove_yield_position(env: &Env, position_id: u64) {
    let key = yield_position_key(position_id);
    env.storage().persistent().remove(&key);
}

fn remove_payment_metadata(env: &Env, proposal_id: u64) {
    let key = payment_metadata_key(proposal_id);
    env.storage().persistent().remove(&key);
}

/// Validates that each set string field is non-empty and within
/// `MAX_DESCRIPTION_LEN`. `None` fields are always valid (meaning "not set").
fn validate_payment_metadata(metadata: &PaymentMetadata) -> Result<(), ContractError> {
    if let Some(ref inv) = metadata.invoice_id {
        if inv.is_empty() || inv.len() > MAX_DESCRIPTION_LEN {
            return Err(ContractError::MetadataTooLong);
        }
    }
    if let Some(ref ext) = metadata.external_ref {
        if ext.is_empty() || ext.len() > MAX_DESCRIPTION_LEN {
            return Err(ContractError::MetadataTooLong);
        }
    }
    if let Some(ref m) = metadata.memo {
        if m.is_empty() || m.len() > MAX_DESCRIPTION_LEN {
            return Err(ContractError::MetadataTooLong);
        }
    }
    Ok(())
}

// ─── Spend Policy Engine ───────────────────────────────────────────────────

/// Maximum number of windows allowed in a single spend policy.
const MAX_SPEND_WINDOWS: u32 = 3;

fn read_spend_policy(env: &Env, owner: &Address, token: &Address) -> Option<SpendPolicy> {
    let key = spend_policy_key(owner, token);
    let policy: Option<SpendPolicy> = env.storage().persistent().get(&key);
    if policy.is_some() {
        bump_persistent(env, &key);
    }
    policy
}

fn write_spend_policy(env: &Env, policy: &SpendPolicy) {
    let key = spend_policy_key(&policy.owner, &policy.token);
    env.storage().persistent().set(&key, policy);
    bump_persistent(env, &key);
}

fn continuous_stream_accrued(schedule: &RecurringPayment, now: u64) -> Result<i128, ContractError> {
    let cliff_time = if schedule.cliff_time > 0 {
        schedule.cliff_time
    } else {
        schedule.start_time
    };
    if now < cliff_time || now < schedule.start_time {
        return Ok(0);
    }
    if schedule.end_time <= schedule.start_time {
        return Err(ContractError::InvalidSchedule);
    }

    let end = now.min(schedule.end_time);
    let elapsed = end
        .checked_sub(schedule.start_time)
        .ok_or(ContractError::ArithmeticError)?;
    let elapsed = i128::try_from(elapsed).map_err(|_| ContractError::ArithmeticError)?;
    if schedule.total_cap > 0 && elapsed > schedule.total_cap / schedule.amount {
        return Ok(schedule.total_cap);
    }
    let accrued = elapsed
        .checked_mul(schedule.amount)
        .ok_or(ContractError::ArithmeticError)?;

    if schedule.total_cap > 0 {
        Ok(accrued.min(schedule.total_cap))
    } else {
        Ok(accrued)
    }
}

// ─── Contract ────────────────────────────────────────────────────────────────

fn read_spend_policy_tracker(
    env: &Env,
    owner: &Address,
    token: &Address,
    window: &SpendWindowKind,
) -> SpentTracker {
    let key = spend_policy_tracker_key(owner, token, window);
    env.storage()
        .persistent()
        .get(&key)
        .unwrap_or(SpentTracker { spent: 0, epoch: 0 })
}

fn write_spend_policy_tracker(
    env: &Env,
    owner: &Address,
    token: &Address,
    window: &SpendWindowKind,
    tracker: &SpentTracker,
) {
    let key = spend_policy_tracker_key(owner, token, window);
    env.storage().persistent().set(&key, tracker);
    bump_persistent(env, &key);
}

/// Computes the effective spent amount within a window, resetting the
/// epoch if the window has expired.
fn effective_spend_policy_spent(
    env: &Env,
    owner: &Address,
    token: &Address,
    window: &SpendWindowKind,
) -> i128 {
    let tracker = read_spend_policy_tracker(env, owner, token, window);
    if tracker.epoch == 0 {
        return 0;
    }
    let now = env.ledger().timestamp();
    if now > tracker.epoch.saturating_add(window.duration_secs()) {
        return 0;
    }
    tracker.spent
}

/// Validates a spend policy: non-empty, at most MAX_SPEND_WINDOWS entries,
/// no duplicate window kinds, and all limits ≥ MIN_AMOUNT.
fn validate_spend_policy(policy: &SpendPolicy) -> Result<(), ContractError> {
    if policy.limits.is_empty() {
        return Err(ContractError::EmptySpendPolicy);
    }
    if policy.limits.len() > MAX_SPEND_WINDOWS as u32 {
        return Err(ContractError::TooManySpendWindows);
    }
    for i in 0..policy.limits.len() {
        let limit = policy.limits.get(i).unwrap();
        if limit.limit < MIN_AMOUNT {
            return Err(ContractError::InvalidAmount);
        }
        // Check for duplicate window kinds.
        for j in (i + 1)..policy.limits.len() {
            let other = policy.limits.get(j).unwrap();
            if limit.window == other.window {
                return Err(ContractError::InvalidSpendWindow);
            }
        }
    }
    Ok(())
}

/// Evaluates a spend policy against a proposed spend. If any window's
/// cumulative spend (including `amount`) would exceed its limit, returns
/// the breached window. Otherwise returns `Ok`.
fn check_spend_policy(
    env: &Env,
    owner: &Address,
    token: &Address,
    amount: i128,
) -> Result<(), (SpendWindowKind, i128, i128)> {
    let policy = match read_spend_policy(env, owner, token) {
        Some(p) => p,
        None => return Ok(()),
    };
    for i in 0..policy.limits.len() {
        let limit_entry = policy.limits.get(i).unwrap();
        let already_spent = effective_spend_policy_spent(env, owner, token, &limit_entry.window);
        let cumulative = already_spent
            .checked_add(amount)
            .unwrap_or(i128::MAX);
        if cumulative > limit_entry.limit {
            return Err((limit_entry.window.clone(), limit_entry.limit, cumulative));
        }
    }
    Ok(())
}

/// Records a spend against all windows in the policy. Called after a
/// successful transfer execution.
fn record_spend_policy_spend(
    env: &Env,
    owner: &Address,
    token: &Address,
    amount: i128,
) {
    let policy = match read_spend_policy(env, owner, token) {
        Some(p) => p,
        None => return,
    };
    let now = env.ledger().timestamp();
    for i in 0..policy.limits.len() {
        let limit_entry = policy.limits.get(i).unwrap();
        let tracker = read_spend_policy_tracker(env, owner, token, &limit_entry.window);
        let window = limit_entry.window.clone();
        let window_secs = window.duration_secs();
        let epoch = if tracker.epoch == 0 || now > tracker.epoch.saturating_add(window_secs) {
            now
        } else {
            tracker.epoch
        };
        let spent = if now > epoch.saturating_add(window_secs) {
            amount
        } else {
            tracker
                .spent
                .checked_add(amount)
                .unwrap_or(i128::MAX)
        };
        write_spend_policy_tracker(
            env,
            owner,
            token,
            &limit_entry.window,
            &SpentTracker { spent, epoch },
        );
    }
}

// ─── #954: Oracle price guard helpers ───────────────────────────────────────

fn read_oracle_price(env: &Env, token: &Address, fiat: &Symbol) -> Option<OraclePrice> {
    let key = oracle_price_key(token, fiat);
    let price: Option<OraclePrice> = env.storage().persistent().get(&key);
    if price.is_some() {
        bump_persistent(env, &key);
    }
    price
}

fn write_oracle_price(env: &Env, price: &OraclePrice) {
    let key = oracle_price_key(&price.token, &price.fiat);
    env.storage().persistent().set(&key, price);
    bump_persistent(env, &key);
}

fn remove_oracle_price(env: &Env, token: &Address, fiat: &Symbol) {
    let key = oracle_price_key(token, fiat);
    env.storage().persistent().remove(&key);
}

/// Returns a validated, fresh oracle price. Errors if the oracle is not
/// configured, the price is invalid, or the price is stale.
fn get_fresh_oracle_price(env: &Env, token: &Address, fiat: &Symbol) -> Result<OraclePrice, ContractError> {
    let oracle = read_oracle_price(env, token, fiat).ok_or(ContractError::OracleNotConfigured)?;
    if oracle.price <= 0 {
        return Err(ContractError::OraclePriceInvalid);
    }
    let now = env.ledger().timestamp();
    if now > oracle.updated_at.saturating_add(oracle.max_staleness) {
        return Err(ContractError::OraclePriceStale);
    }
    Ok(oracle)
}

/// Converts a token amount to its fiat value using the oracle price.
/// fiat_value = (amount * price) / PRICE_SCALING.
fn token_to_fiat(amount: i128, price: i128) -> Result<i128, ContractError> {
    amount
        .checked_mul(price)
        .ok_or(ContractError::ArithmeticError)?
        .checked_div(PRICE_SCALING)
        .ok_or(ContractError::ArithmeticError)
}

fn read_fiat_spend_limit(env: &Env, owner: &Address, token: &Address, fiat: &Symbol) -> Option<FiatSpendLimit> {
    let key = fiat_spend_limit_key(owner, token, fiat);
    let limit: Option<FiatSpendLimit> = env.storage().persistent().get(&key);
    if limit.is_some() {
        bump_persistent(env, &key);
    }
    limit
}

fn write_fiat_spend_limit(env: &Env, limit: &FiatSpendLimit) {
    let key = fiat_spend_limit_key(&limit.owner, &limit.token, &limit.fiat);
    env.storage().persistent().set(&key, limit);
    bump_persistent(env, &key);
}

fn remove_fiat_spend_limit(env: &Env, owner: &Address, token: &Address, fiat: &Symbol) {
    let key = fiat_spend_limit_key(owner, token, fiat);
    env.storage().persistent().remove(&key);
}

fn read_fiat_spent_tracker(env: &Env, owner: &Address, token: &Address, fiat: &Symbol) -> SpentTracker {
    let key = fiat_spent_tracker_key(owner, token, fiat);
    env.storage()
        .persistent()
        .get(&key)
        .unwrap_or(SpentTracker { spent: 0, epoch: 0 })
}

fn write_fiat_spent_tracker(env: &Env, owner: &Address, token: &Address, fiat: &Symbol, tracker: &SpentTracker) {
    let key = fiat_spent_tracker_key(owner, token, fiat);
    env.storage().persistent().set(&key, tracker);
    bump_persistent(env, &key);
}

/// Returns the effective fiat spent within the window, resetting if expired.
fn effective_fiat_spent(env: &Env, owner: &Address, token: &Address, fiat: &Symbol, window_secs: u64) -> i128 {
    let tracker = read_fiat_spent_tracker(env, owner, token, fiat);
    if tracker.epoch == 0 {
        return 0;
    }
    let now = env.ledger().timestamp();
    if now > tracker.epoch.saturating_add(window_secs) {
        return 0;
    }
    tracker.spent
}

/// Checks a fiat-denominated spend limit. If a fiat limit and a valid oracle
/// price exist, converts the token amount to fiat and checks against the
/// rolling window. Returns Ok if no limit is configured.
fn check_fiat_spend_limit(
    env: &Env,
    owner: &Address,
    token: &Address,
    amount: i128,
) -> Result<(), (Symbol, i128, i128)> {
    // Try USD first, the most common fiat denomination.
    let fiat = Symbol::new(env, "USD");
    let limit = match read_fiat_spend_limit(env, owner, token, &fiat) {
        Some(l) => l,
        None => return Ok(()),
    };
    let oracle = match get_fresh_oracle_price(env, token, &fiat) {
        Ok(o) => o,
        Err(_) => return Ok(()), // If oracle is unavailable, don't block the transfer.
    };
    let fiat_value = token_to_fiat(amount, oracle.price).unwrap_or(i128::MAX);
    let already_spent = effective_fiat_spent(env, owner, token, &fiat, limit.window_secs);
    let cumulative = already_spent.checked_add(fiat_value).unwrap_or(i128::MAX);
    if cumulative > limit.fiat_limit {
        return Err((fiat, fiat_value, limit.fiat_limit));
    }
    Ok(())
}

/// Records a fiat spend after a successful transfer.
fn record_fiat_spend(env: &Env, owner: &Address, token: &Address, amount: i128) {
    let fiat = Symbol::new(env, "USD");
    let limit = match read_fiat_spend_limit(env, owner, token, &fiat) {
        Some(l) => l,
        None => return,
    };
    let oracle = match get_fresh_oracle_price(env, token, &fiat) {
        Ok(o) => o,
        Err(_) => return,
    };
    let fiat_value = token_to_fiat(amount, oracle.price).unwrap_or(i128::MAX);
    let now = env.ledger().timestamp();
    let tracker = read_fiat_spent_tracker(env, owner, token, &fiat);
    let epoch = if tracker.epoch == 0 || now > tracker.epoch.saturating_add(limit.window_secs) {
        now
    } else {
        tracker.epoch
    };
    let spent = if now > epoch.saturating_add(limit.window_secs) {
        fiat_value
    } else {
        tracker.spent.checked_add(fiat_value).unwrap_or(i128::MAX)
    };
    write_fiat_spent_tracker(env, owner, token, &fiat, &SpentTracker { spent, epoch });
}

// ─── #955: Denylist helpers ──────────────────────────────────────────────────

fn denylist_enabled(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&denylist_enabled_key())
        .unwrap_or(false)
}

fn write_denylist_enabled(env: &Env, enabled: bool) {
    env.storage()
        .instance()
        .set(&denylist_enabled_key(), &enabled);
    bump_instance(env);
}

fn is_denied(env: &Env, address: &Address) -> bool {
    let key = denylist_key(address);
    let denied: bool = env.storage().persistent().get(&key).unwrap_or(false);
    if denied {
        bump_persistent(env, &key);
    }
    denied
}

fn write_denied(env: &Env, address: &Address, denied: bool) {
    let key = denylist_key(address);
    if denied {
        env.storage().persistent().set(&key, &true);
        bump_persistent(env, &key);
    } else {
        env.storage().persistent().remove(&key);
    }
}

/// Checks all transfer recipients against the denylist. Returns the first
/// denied recipient if any.
fn check_denylist(env: &Env, transfers: &Vec<Transfer>) -> Result<(), Address> {
    if !denylist_enabled(env) {
        return Ok(());
    }
    for transfer in transfers.iter() {
        if is_denied(env, &transfer.to) {
            return Err(transfer.to.clone());
        }
    }
    Ok(())
}

// ─── #953: Rebalancing helpers ───────────────────────────────────────────────

fn validate_rebalance_params(params: &RebalanceParams) -> Result<(), ContractError> {
    if params.targets.is_empty() {
        return Err(ContractError::EmptyRebalance);
    }
    if params.targets.len() > 10 {
        return Err(ContractError::EmptyRebalance);
    }
    let mut sum_bps: u32 = 0;
    for i in 0..params.targets.len() {
        let target = params.targets.get(i).unwrap();
        if target.target_bps > 10_000 {
            return Err(ContractError::InvalidTargetWeight);
        }
        sum_bps = sum_bps
            .checked_add(target.target_bps)
            .ok_or(ContractError::ArithmeticError)?;
        // Check for duplicate tokens.
        for j in (i + 1)..params.targets.len() {
            let other = params.targets.get(j).unwrap();
            if target.token == other.token {
                return Err(ContractError::InvalidTargetWeight);
            }
        }
    }
    if sum_bps > 10_000 {
        return Err(ContractError::InvalidTargetWeight);
    }
    if params.tolerance_bps > 10_000 {
        return Err(ContractError::InvalidTargetWeight);
    }
    Ok(())
}

fn write_last_rebalance(env: &Env, timestamp: u64) {
    env.storage()
        .instance()
        .set(&last_rebalance_key(), &timestamp);
    bump_instance(env);
}

fn read_last_rebalance(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&last_rebalance_key())
        .unwrap_or(0)
}

fn validate_token_interface(env: &Env, token_address: &Address) -> Result<(), ContractError> {
    let client = token::Client::new(env, token_address);
    // Require decimals, symbol, and name to all succeed to consider this a valid token.
    if client.try_decimals().is_err() || client.try_symbol().is_err() || client.try_name().is_err()
    {
        return Err(ContractError::InvalidToken);
    }
    Ok(())
}

fn validate_asset_registry(env: &Env, token_address: &Address) -> Result<(), ContractError> {
    if asset_registry_enabled(env) && !token_is_approved(env, token_address) {
        return Err(ContractError::AssetNotApproved);
    }
    Ok(())
}

fn validate_token(env: &Env, token_address: &Address) -> Result<(), ContractError> {
    validate_token_interface(env, token_address)?;
    validate_asset_registry(env, token_address)
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


fn recurring_payment_due_at(schedule: &RecurringPayment) -> Result<u64, ContractError> {
    if schedule.total_disbursed == 0 {
        match schedule.kind {
            RecurringKind::LinearVesting | RecurringKind::ContinuousStream => {
                if schedule.cliff_time > 0 && schedule.cliff_time > schedule.start_time {
                    Ok(schedule.cliff_time)
                } else {
                    Ok(schedule.start_time)
                }
            }
            RecurringKind::FixedAmountPerPeriod => schedule
                .start_time
                .checked_add(schedule.interval_secs)
                .ok_or(ContractError::ArithmeticError),
        }
    } else {
        schedule
            .last_disbursed_at
            .checked_add(schedule.interval_secs)
            .ok_or(ContractError::ArithmeticError)
    }
}

fn linear_vesting_payout(schedule: &RecurringPayment, now: u64) -> Result<i128, ContractError> {
    let cliff_time = if schedule.cliff_time > 0 {
        schedule.cliff_time
    } else {
        schedule.start_time
    };
    if now < cliff_time {
        return Ok(0);
    }

    if schedule.end_time <= schedule.start_time {
        return Ok(0);
    }
    let duration = schedule
        .end_time
        .checked_sub(schedule.start_time)
        .ok_or(ContractError::ArithmeticError)?;
    if duration == 0 {
        return Ok(0);
    }

    let elapsed = if now >= schedule.start_time {
        now.checked_sub(schedule.start_time)
            .ok_or(ContractError::ArithmeticError)?
    } else {
        return Ok(0);
    };

    let elapsed = elapsed.min(duration);

    let elapsed_i128 = i128::try_from(elapsed).map_err(|_| ContractError::ArithmeticError)?;
    let duration_i128 = i128::try_from(duration).map_err(|_| ContractError::ArithmeticError)?;
    let vested_total = {
        let numerator = elapsed_i128
            .checked_mul(schedule.amount)
            .ok_or(ContractError::ArithmeticError)?;
        let raw = numerator
            .checked_div(duration_i128)
            .ok_or(ContractError::ArithmeticError)?;

        let cap = if schedule.total_cap > 0 {
            schedule.total_cap
        } else {
            schedule.amount
        };
        if cap > 0 && raw > cap {
            cap
        } else {
            raw
        }
    };

    let already_paid = schedule.total_disbursed;
    if vested_total <= already_paid {
        return Ok(0);
    }

    vested_total
        .checked_sub(already_paid)
        .ok_or(ContractError::ArithmeticError)
}

// ─── Contract ────────────────────────────────────────────────────────────────

#[contract]
pub struct AccordContract;

// Entrypoint gating matrix (keep synchronized with the public methods below).
// Operational roles are separate from governance authority: role gates control
// proposal lifecycle operations, while governance changes remain owner-weight
// gated. Role-gated entrypoints below must enforce the role listed here.
//
// Initialize: initialize (all listed owners authenticate; one-time setup).
// Migration: migrate_to_weighted_governance (distinct authenticated owners meet
//   the legacy M-of-N count threshold; no roles); migrate_to_rbac (owner-weight).
// Proposer: create_recurring_schedule, create_proposal, create_add_owner_proposal,
//   create_spending_limit_proposal, create_change_weight_proposal,
//   create_remove_owner_proposal, create_change_threshold_proposal,
//   create_recurring_proposal, create_cancel_recurring_proposal,
//   create_pause_recurring_proposal, create_resume_recurring_proposal,
//   create_modify_recurring_proposal, create_grant_role_proposal,
//   create_revoke_role_proposal, create_set_asset_registry_enabled_proposal,
//   create_add_approved_token_proposal, create_unapprove_token_proposal,
//   create_change_guardian_proposal, create_escrow_proposal.
// Approver + owner membership/weight: approve, approve_sponsored, revoke.
// Executor role: execute, cancel_expired (owner membership is not required).
// Owner membership: cancel_recurring_schedule.
// Permissionless/authenticated caller: disburse_recurring_schedule (permissionless
//   crank); disburse_recurring (any authenticated caller); release_escrow_by_deadline
//   and refund_escrow (any authenticated caller).
// Owner-weight governance (no role checks): set_max_single_owner_weight_pct,
//   set_guardian, release_escrow, unfreeze, upgrade. TransferGuardian proposals
//   rotate the guardian through the standard proposal quorum. Guardian-only: freeze.
// Read-only, no authorization: get_spent_tracker, get_recurring_payment,
//   get_next_disbursement_time, get_recurring_payments_paged,
//   get_active_recurring_count, get_approvers, get_version, get_total_weight,
//   is_governance_migrated, get_role_version, get_roles, has_role,
//   get_role_members, get_owner_weight, get_owner_weights,
//   get_max_single_owner_weight_pct, get_delegations, get_active_delegations,
//   get_effective_weight, get_proposal, get_proposals_paged, get_owners,
//   get_spending_limit, get_owner_spending_limits,
//   get_remaining_spending_limit, get_threshold, get_required_quorum_weight,
//   get_time_lock_delay, get_total_proposals, is_owner, has_approved,
//   get_proposal_approval_progress, is_frozen, get_guardian,
//   get_asset_registry_enabled, is_token_approved, get_escrow.
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
        #[cfg(not(feature = "legacy-fixture"))]
        env.storage()
            .instance()
            .set(&governance_version_key(), &true);
        let roles = Vec::from_slice(&env, &DEFAULT_OWNER_ROLES);
        for owner in owners.iter() {
            update_owner_roles(&env, &owner, &roles);
        }
        write_role_version(&env, RBAC_VERSION);
        // The `legacy-fixture` feature deliberately leaves the schema marker
        // absent so the testnet upgrade simulation can exercise a real
        // pre-versioning deployment and verify that migration stamps it.
        #[cfg(not(feature = "legacy-fixture"))]
        write_storage_version(&env);
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
        write_storage_version(&env);

        env.events().publish(
            (symbol_short!("migrated"),),
            GovernanceMigratedEvent {
                version: EVENT_SCHEMA_VERSION,
                owner_count,
                total_weight,
            },
        );

        Ok(())
    }

    /// One-time migration for legacy deployments. Grants every current owner
    /// the default proposal lifecycle roles and records the RBAC version.
    pub fn migrate_to_rbac(env: Env, approvers: Vec<Address>) -> Result<(), ContractError> {
        if !is_initialized(&env) {
            return Err(ContractError::NotInitialized);
        }
        if read_role_version(&env) != 0 {
            return Err(ContractError::AlreadyMigrated);
        }

        require_weighted_approvers(&env, &approvers)?;

        let owners = read_owners_map(&env)?;
        let roles = Vec::from_slice(&env, &DEFAULT_OWNER_ROLES);
        for owner in owners.keys().iter() {
            update_owner_roles(&env, &owner, &roles);
        }
        write_role_version(&env, RBAC_VERSION);
        write_storage_version(&env);

        env.events().publish(
            (Symbol::new(&env, "rbac_migrated"),),
            RbacMigratedEvent {
                version: EVENT_SCHEMA_VERSION,
                owner_count: owners.len(),
                role_version: RBAC_VERSION,
            },
        );
        Ok(())
    }

    /// One-time migration that stamps the storage schema to version 2 on a
    /// legacy deployment, confirming the DEX router registry key is in use.
    ///
    /// This is a no-op beyond bumping the version marker: the `DXRTR` registry
    /// starts empty on every deployment so there is no data to backfill.
    /// Calling it on a deployment already at version ≥ 2 returns
    /// `AlreadyMigrated`.
    pub fn migrate_to_dex_swap(env: Env, approvers: Vec<Address>) -> Result<(), ContractError> {
        if !is_initialized(&env) {
            return Err(ContractError::NotInitialized);
        }
        if read_storage_version(&env) >= 2 {
            return Err(ContractError::AlreadyMigrated);
        }

        require_weighted_approvers(&env, &approvers)?;

        // Write the new schema version; `write_storage_version` always writes
        // the current `STORAGE_SCHEMA_VERSION` constant, which is now 2.
        write_storage_version(&env);

        env.events().publish(
            (Symbol::new(&env, "dex_migrated"),),
            GovernanceMigratedEvent {
                version: EVENT_SCHEMA_VERSION,
                owner_count: read_owners_map(&env)?.len(),
                total_weight: read_total_weight(&env),
            },
        );
        Ok(())
    }
    pub fn create_recurring_schedule(
        env: Env,
        proposer: Address,
        transfers: Vec<Transfer>,
        interval_secs: u64,
        occurrences: u32,
        description: String,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
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

    /// DEPRECATED: direct owner cancellation of a recurring schedule.
    ///
    /// Cancellation is governance-gated. The canonical path is
    /// [`create_cancel_recurring_proposal`](Self::create_cancel_recurring_proposal),
    /// which routes the cancel through the create → approve → execute lifecycle
    /// so the decision is recorded as a proposal and reflected in the event
    /// stream the indexer and frontend consume. This direct entrypoint is kept
    /// only so existing callers receive a clear, documented error instead of an
    /// unknown-function fault; it performs no authorization or storage write and
    /// always returns [`ContractError::DeprecatedEntrypoint`].
    pub fn cancel_recurring_schedule(
        env: Env,
        caller: Address,
        id: u64,
    ) -> Result<(), ContractError> {
        // Parameters are intentionally unused: the entrypoint performs no
        // authorization or state mutation. They are retained so existing
        // bindings keep the original ABI shape.
        let _ = (env, caller, id);
        Err(ContractError::DeprecatedEntrypoint)
    }

// Entrypoint gating matrix (keep synchronized with the public methods below).
// Operational roles are separate from governance authority: role gates control
// proposal lifecycle operations, while governance changes remain owner-weight
// gated. Role-gated entrypoints below must enforce the role listed here.
//
// Initialize: initialize (all listed owners authenticate; one-time setup).
// Migration: migrate_to_weighted_governance (distinct authenticated owners meet
//   the legacy M-of-N count threshold; no roles); migrate_to_rbac (owner-weight).
// Proposer: create_recurring_schedule, create_proposal, simulate_proposal, create_add_owner_proposal,
//   create_spending_limit_proposal, create_change_weight_proposal,
//   create_remove_owner_proposal, create_change_threshold_proposal,
//   create_recurring_proposal, create_cancel_recurring_proposal,
//   create_pause_recurring_proposal, create_resume_recurring_proposal,
//   create_modify_recurring_proposal, create_grant_role_proposal,
//   create_revoke_role_proposal, create_asset_registry_proposal,
//   create_approve_token_proposal, create_unapprove_token_proposal,
//   create_change_guardian_proposal, create_escrow_proposal.
// Approver + owner membership/weight: approve, approve_sponsored, revoke.
// Executor role: execute, cancel_expired (owner membership is not required).
// Owner membership: cancel_recurring_schedule.
// Permissionless/authenticated caller: disburse_recurring_schedule (permissionless
//   crank); disburse_recurring (any authenticated caller); release_escrow_by_deadline
//   and refund_escrow (any authenticated caller).
// Owner-weight governance (no role checks): set_max_single_owner_weight_pct,
//   set_guardian, release_escrow, unfreeze, upgrade. TransferGuardian proposals
//   rotate the guardian through the standard proposal quorum. Guardian-only: freeze.
// Read-only, no authorization: get_spent_tracker, get_recurring_payment,
//   get_next_disbursement_time, get_recurring_payments_paged,
//   get_active_recurring_count, get_approvers, get_version, get_total_weight,
//   is_governance_migrated, get_role_version, get_roles, has_role,
//   get_role_members, get_owner_weight, get_owner_weights,
//   get_max_single_owner_weight_pct, get_delegations, get_active_delegations,
//   get_effective_weight, get_proposal, get_proposals_paged, get_owners,
//   get_spending_limit, get_owner_spending_limits,
//   get_remaining_spending_limit, get_threshold, get_required_quorum_weight,
//   get_time_lock_delay, get_total_proposals, is_owner, has_approved,
//   get_proposal_approval_progress, is_frozen, get_guardian,
//   get_asset_registry_enabled, is_token_approved, get_escrow.

}

fn validate_transfer_proposal(
    env: &Env,
    proposer: &Address,
    transfers: &Vec<Transfer>,
    description: &String,
    deadline: u64,
) -> Result<bool, ContractError> {
    proposer.require_auth();
    let proposer_is_owner = read_owners_map(env)?.contains_key(proposer.clone());
    require_role(env, proposer, Role::Proposer)?;
    require_not_frozen(env)?;

    let transfers_len = transfers.len();
    if transfers_len == 0 || transfers_len > MAX_BATCH_TRANSFERS {
        return Err(ContractError::InvalidAmount);
    }

    require_kind_not_frozen(env, ProposalKindTag::Transfer)?;
    for transfer in transfers.iter() {
        if transfer.amount < MIN_AMOUNT {
            return Err(ContractError::InvalidAmount);
        }
        validate_token(env, &transfer.token)?;
        require_asset_not_frozen(env, &transfer.token)?;
        if transfer.to == env.current_contract_address() {
            return Err(ContractError::InvalidRecipient);
        }
    }

    if proposer_is_owner {
        let mut checked_tokens: Vec<Address> = Vec::new(env);
        let mut checked_totals: Vec<i128> = Vec::new(env);
        for transfer in transfers.iter() {
            let mut found = false;
            for i in 0..checked_tokens.len() {
                if checked_tokens.get(i).unwrap() == transfer.token {
                    let total = checked_totals
                        .get(i)
                        .unwrap()
                        .checked_add(transfer.amount)
                        .ok_or(ContractError::ArithmeticError)?;
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
            if let Some(limit) = read_spending_limit(env, proposer, &token) {
                let already_spent = effective_spent(env, proposer, &token);
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

    Ok(proposer_is_owner)
}

fn distinct_transfer_token_count(env: &Env, transfers: &Vec<Transfer>) -> u32 {
    let mut tokens: Vec<Address> = Vec::new(env);
    for transfer in transfers.iter() {
        if !tokens.contains(&transfer.token) {
            tokens.push_back(transfer.token);
        }
    }
    tokens.len()
}

#[contractimpl]
impl AccordContract {
    /// Creates a governance proposal to set a per-owner spending limit.
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
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;
        validate_asset_registry(&env, &token)?;

        if limit < 0 {
            return Err(ContractError::InvalidAmount);
        }
        validate_description(&description)?;
        validate_deadline(&env, deadline)?;

        create_governance_proposal(
            &env,
            proposer,
            ProposalKind::SetSpendingLimit(owner, token, limit),
            description,
            deadline,
        )
    }

    /// Creates a spending-limit proposal with a daily-to-weekly rolling window.
    pub fn create_spending_window_proposal(
        env: Env,
        proposer: Address,
        owner: Address,
        token: Address,
        limit: i128,
        window_secs: u64,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        if !(MIN_SPENDING_WINDOW..=MAX_SPENDING_WINDOW).contains(&window_secs) {
            return Err(ContractError::InvalidDuration);
        }
        let id = Self::create_spending_limit_proposal(
            env.clone(), proposer, owner.clone(), token.clone(), limit, description, deadline,
        )?;
        let mut proposal = read_proposal(&env, id)?;
        proposal.kind = ProposalKind::SetSpendingLimitWindow(owner, token, limit, window_secs);
        write_proposal(&env, &proposal);
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
        require_role(&env, &proposer, Role::Proposer)?;
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
            attachment_hash: None,
        };
        write_proposal(&env, &proposal);
        register_active_proposal(&env, id)?;

        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                version: EVENT_SCHEMA_VERSION,
                id,
                proposer,
                threshold,
                category: ProposalCategory::Other,
                transfers: Vec::new(&env),
                quorum_weight: threshold,
                total_weight_at_creation: current_total,
                attachment_hash: None,
            },
        );

        Ok(id)
    }

    /// Moves the deployment forward exactly one registered storage-schema step.
    ///
    /// `from_version` must match the version currently recorded on chain, so a
    /// stale operator script cannot stamp a layout it did not observe. The
    /// target must be in `SUPPORTED_STORAGE_VERSIONS`, must not be newer than
    /// the running contract, and must be exactly the next step: skipped,
    /// repeated, and backward migrations are refused.
    ///
    /// A legacy (`0`) deployment must first run `migrate_to_weighted_governance`
    /// and `migrate_to_rbac`, which bring the layout up to the current schema.
    /// This entrypoint covers the operator-driven steps between versioned
    /// layouts after that.
    pub fn migrate_storage(
        env: Env,
        approvers: Vec<Address>,
        from_version: u32,
        target_version: u32,
    ) -> Result<(), ContractError> {
        if !is_initialized(&env) {
            return Err(ContractError::NotInitialized);
        }
        require_weighted_approvers(&env, &approvers)?;

        let current = read_storage_version(&env);
        if from_version != current {
            return Err(ContractError::SchemaVersionMismatch);
        }
        if target_version == current {
            return Err(ContractError::AlreadyMigrated);
        }
        if current == 0 {
            return Err(ContractError::LegacyMigrationRequired);
        }
        if !SUPPORTED_STORAGE_VERSIONS.contains(&target_version)
            || target_version > STORAGE_SCHEMA_VERSION
        {
            return Err(ContractError::UnsupportedSchemaVersion);
        }
        if target_version != current.saturating_add(1) {
            return Err(ContractError::SkippedSchemaVersion);
        }

        if target_version == 3 {
            rebuild_delegated_weight_index(&env)?;
        }

        write_storage_version_value(&env, target_version);
        env.events().publish(
            (symbol_short!("stor_mig"),),
            StorageMigratedEvent {
                from_version: current,
                to_version: target_version,
                version: EVENT_SCHEMA_VERSION,
            },
        );
        Ok(())
    }

    /// Compatibility entrypoint for deployments built from the abstention-only
    /// branch. It stamps the current registry version through `migrate_storage`.
    pub fn migrate_to_abstention_storage(
        env: Env,
        approvers: Vec<Address>,
    ) -> Result<(), ContractError> {
        let current = read_storage_version(&env);
        Self::migrate_storage(env, approvers, current, STORAGE_SCHEMA_VERSION)
    }

    /// Creates a proposal to change the M-of-N approval threshold.
    ///
    /// # Arguments
    /// * `proposer` - Holder of the Proposer role, owner or not. Must authorize.
    ///   Owner-keyed spending limits apply only when the proposer is an owner.
    /// * `transfers` - Asset transfers to execute (1-50). Each must have a valid token and amount ≥ 1.
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
        validate_transfer_proposal(&env, &proposer, &transfers, &description, deadline)?;

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
            attachment_hash: None,
        };
        write_proposal(&env, &proposal);
        register_active_proposal(&env, id)?;

        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

        let total_weight = read_total_weight(&env);
        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                version: EVENT_SCHEMA_VERSION,
                id,
                proposer,
                threshold,
                category,
                transfers,
                quorum_weight: threshold,
                total_weight_at_creation: total_weight,
                attachment_hash: None,
            },
        );

        Ok(id)
    }

    /// Validates a transfer proposal and returns deterministic contract-work
    /// estimates without creating a proposal or emitting events.
    pub fn simulate_proposal(
        env: Env,
        proposer: Address,
        transfers: Vec<Transfer>,
        description: String,
        deadline: u64,
        category: ProposalCategory,
    ) -> Result<ProposalSimulation, ContractError> {
        let proposer_is_owner =
            validate_transfer_proposal(&env, &proposer, &transfers, &description, deadline)?;
        let distinct_token_count = distinct_transfer_token_count(&env, &transfers);

        Ok(ProposalSimulation {
            category,
            quorum_weight: read_threshold(&env)?,
            proposer,
            required_role: Role::Proposer,
            proposer_auth_required: true,
            transfer_count: transfers.len(),
            distinct_token_count,
            owner_spending_limit_checks: if proposer_is_owner {
                distinct_token_count
            } else {
                0
            },
            minimum_persistent_writes: 2,
            minimum_instance_writes: 2,
            emitted_events: 1,
        })
    }

    /// Creates a transfer proposal and associates a 32-byte digest of an
    /// off-chain invoice or document with its on-chain record.
    pub fn create_proposal_with_attachment(
        env: Env,
        proposer: Address,
        transfers: Vec<Transfer>,
        description: String,
        deadline: u64,
        category: ProposalCategory,
        attachment_hash: Option<BytesN<32>>,
    ) -> Result<u64, ContractError> {
        let id = Self::create_proposal(
            env.clone(),
            proposer.clone(),
            transfers.clone(),
            description,
            deadline,
            category.clone(),
        )?;
        let mut proposal = read_proposal(&env, id)?;
        proposal.attachment_hash = attachment_hash.clone();
        write_proposal(&env, &proposal);
        let total_weight = read_total_weight(&env);
        let threshold = read_threshold(&env)?;
        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                version: EVENT_SCHEMA_VERSION,
                id,
                proposer,
                threshold,
                category,
                transfers,
                quorum_weight: threshold,
                total_weight_at_creation: total_weight,
                attachment_hash,
            },
        );
        Ok(id)
    }

    /// Creates a transfer proposal with an explicit list of parent proposal dependencies.
    /// The proposal cannot execute until all listed dependencies have reached `Executed` status.
    /// If any dependency is cancelled or expired, execution is blocked.
    pub fn create_proposal_with_deps(
        env: Env,
        proposer: Address,
        transfers: Vec<Transfer>,
        description: String,
        deadline: u64,
        category: ProposalCategory,
        dependencies: Vec<u64>,
    ) -> Result<u64, ContractError> {
        let id = Self::create_proposal(
            env.clone(),
            proposer.clone(),
            transfers,
            description,
            deadline,
            category,
        )?;
        validate_proposal_dependencies(&env, id, &dependencies)?;
        write_proposal_dependencies(&env, id, &dependencies);
        env.events().publish(
            (symbol_short!("p_deps"),),
            ProposalDependenciesSetEvent {
                id,
                dependencies,
                version: EVENT_SCHEMA_VERSION,
            },
        );
        Ok(id)
    }

    /// Sets or updates the dependencies for an existing pending proposal.
    /// The caller must be the proposal's original proposer and must hold the Proposer role.
    /// Dependencies cannot be modified once approvals have begun.
    pub fn set_proposal_dependencies(
        env: Env,
        proposer: Address,
        proposal_id: u64,
        dependencies: Vec<u64>,
    ) -> Result<(), ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;

        let proposal = read_proposal(&env, proposal_id)?;
        if proposal.proposer != proposer {
            return Err(ContractError::Unauthorized);
        }
        if proposal.status != ProposalStatus::Pending {
            return Err(ContractError::ProposalNotActive);
        }
        if proposal.approvals > 0 {
            return Err(ContractError::AlreadyApproved);
        }

        validate_proposal_dependencies(&env, proposal_id, &dependencies)?;
        write_proposal_dependencies(&env, proposal_id, &dependencies);

        env.events().publish(
            (symbol_short!("p_deps"),),
            ProposalDependenciesSetEvent {
                id: proposal_id,
                dependencies,
                version: EVENT_SCHEMA_VERSION,
            },
        );
        Ok(())
    }


    /// Creates a proposal to remove a token from the approved-token registry.
    pub fn create_unapprove_token_proposal(
        env: Env,
        proposer: Address,
        token: Address,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;
        if !token_is_approved(&env, &token) {
            return Err(ContractError::AssetRegistryState);
        }
        create_governance_proposal(
            &env,
            proposer,
            ProposalKind::RemoveApprovedToken(token),
            description,
            deadline,
        )
    }

    /// Creates a normal-quorum proposal to rotate the emergency guardian.
    pub fn create_change_guardian_proposal(
        env: Env,
        proposer: Address,
        new_guardian: Address,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;
        create_governance_proposal(
            &env,
            proposer,
            ProposalKind::TransferGuardian(new_guardian),
            description,
            deadline,
        )
    }

    /// Creates a proposal to reserve treasury tokens until the selected release condition.
    pub fn create_escrow_proposal(
        env: Env,
        proposer: Address,
        params: EscrowParams,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;
        if params.amount < MIN_AMOUNT {
            return Err(ContractError::InvalidAmount);
        }
        if params.recipient == env.current_contract_address() {
            return Err(ContractError::InvalidRecipient);
        }
        validate_token(&env, &params.token)?;
        let now = env.ledger().timestamp();
        let release_at = match &params.release_mode {
            EscrowReleaseMode::OwnerQuorumUntil(release_at)
            | EscrowReleaseMode::Deadline(release_at) => *release_at,
        };
        if release_at <= now {
            return Err(ContractError::InvalidDeadline);
        }
        if release_at - now > MAX_PROPOSAL_DURATION {
            return Err(ContractError::InvalidDuration);
        }
        create_governance_proposal(
            &env,
            proposer,
            ProposalKind::CreateEscrow(params),
            description,
            deadline,
        )
    }

    // ─── DEX Swap ────────────────────────────────────────────────────────────

    /// Creates a proposal to execute a governed DEX path-payment swap.
    ///
    /// At execution the multisig contract calls `swap_exact_tokens_for_tokens`
    /// on the given `router` contract, selling `send_amount` of `path[0]` for
    /// `path[last]` with a minimum output of `min_recv`. The output is sent to
    /// `destination` (or the contract itself when `None`).
    ///
    /// # Validation at creation
    /// - `path` must have at least 2 entries.
    /// - All tokens in `path` are validated against the asset registry.
    /// - `router` must be in the approved-router registry.
    /// - `send_amount` ≥ `MIN_AMOUNT` and `min_recv` ≥ 1.
    /// - `swap_deadline` must be in the future and within `MAX_PROPOSAL_DURATION`.
    pub fn create_dex_swap_proposal(
        env: Env,
        proposer: Address,
        params: DexSwapParams,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;

        if params.send_amount < MIN_AMOUNT {
            return Err(ContractError::InvalidAmount);
        }
        if params.min_recv < 1 {
            return Err(ContractError::InvalidAmount);
        }

        // Path must have at least 2 entries and all tokens must be valid.
        validate_swap_path(&env, &params.path)?;

        // Router must be in the governance-approved registry.
        if !dex_router_is_approved(&env, &params.router) {
            return Err(ContractError::Unauthorized);
        }
        let now = env.ledger().timestamp();
        if params.swap_deadline <= now {
            return Err(ContractError::InvalidSwapDeadline);
        }
        if params.swap_deadline - now > MAX_PROPOSAL_DURATION {
            return Err(ContractError::InvalidSwapDeadline);
        }
        if let Some(ref dest) = params.destination {
            if dest == &env.current_contract_address() {
                return Err(ContractError::InvalidRecipient);
            }
        }

        let id = create_governance_proposal(
            &env,
            proposer.clone(),
            ProposalKind::DexSwap(params.clone()),
            description,
            deadline,
        )?;

        env.events().publish(
            (symbol_short!("dex_prop"),),
            DexSwapProposedEvent {
                version: EVENT_SCHEMA_VERSION,
                proposal_id: id,
                proposer,
                router: params.router,
                path: params.path,
                send_amount: params.send_amount,
                min_recv: params.min_recv,
                destination: params.destination,
                swap_deadline: params.swap_deadline,
            },
        );

        Ok(id)
    }

    /// Claims the currently accrued amount from a continuous stream.
    /// Only the configured recipient may claim; anyone else may not redirect funds.
    pub fn claim_stream(
        env: Env,
        recipient: Address,
        schedule_id: u64,
    ) -> Result<(), ContractError> {
        recipient.require_auth();
        require_not_frozen(&env)?;

        let mut schedule = read_recurring_payment(&env, schedule_id)?;
        if schedule.recipient != recipient {
            return Err(ContractError::Unauthorized);
        }
        if !matches!(&schedule.kind, RecurringKind::ContinuousStream) {
            return Err(ContractError::RecurringPaymentInactive);
        }
        if matches!(
            schedule.status,
            RecurringStatus::Paused | RecurringStatus::Cancelled | RecurringStatus::Completed
        ) {
            return Err(ContractError::RecurringPaymentInactive);
        }

        let now = env.ledger().timestamp();
        if now < schedule.start_time || (schedule.cliff_time > 0 && now < schedule.cliff_time) {
            return Err(ContractError::RecurringIntervalNotElapsed);
        }
        let accrued = continuous_stream_accrued(&schedule, now)?;
        if accrued <= schedule.total_disbursed {
            return Err(ContractError::RecurringPaymentComplete);
        }
        let amount = accrued
            .checked_sub(schedule.total_disbursed)
            .ok_or(ContractError::ArithmeticError)?;
        let total_disbursed = schedule
            .total_disbursed
            .checked_add(amount)
            .ok_or(ContractError::ArithmeticError)?;

        require_asset_outflow_allowed(&env, &schedule.token)?;

        let token_client = token::Client::new(&env, &schedule.token);
        let treasury = env.current_contract_address();
        if token_client.balance(&treasury) < amount
            || token_client
                .try_transfer(&treasury, &recipient, &amount)
                .is_err()
        {
            return Err(ContractError::TransferFailed);
        }

        let tracker = read_spent_tracker(&env, &schedule.proposer, &schedule.token);
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
        write_spent_tracker(
            &env,
            &schedule.proposer,
            &schedule.token,
            &SpentTracker { spent, epoch },
        );

        schedule.last_disbursed_at = now;
        schedule.total_disbursed = total_disbursed;
        schedule.periods_disbursed = schedule
            .periods_disbursed
            .checked_add(1)
            .ok_or(ContractError::ArithmeticError)?;

        let stream_complete = now >= schedule.end_time
            || (schedule.total_cap > 0 && total_disbursed >= schedule.total_cap);
        if stream_complete {
            schedule.status = RecurringStatus::Completed;
            let active = read_active_recurring_count(&env);
            if active > 0 {
                write_active_recurring_count(&env, active - 1);
            }
        }
        write_recurring_payment(&env, &schedule);

        env.events().publish(
            (symbol_short!("str_clm"),),
            RecurringStreamClaimedEvent {
                schedule_id,
                recipient,
                token: schedule.token.clone(),
                amount,
                total_disbursed,
            },
        );
        Ok(())
    }

    /// Creates a governance proposal to add a DEX router to the approved registry.
    pub fn create_add_dex_router_proposal(
        env: Env,
        proposer: Address,
        router: Address,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;

        if dex_router_is_approved(&env, &router) {
            return Err(ContractError::AssetRegistryState);
        }

        create_governance_proposal(
            &env,
            proposer,
            ProposalKind::AddDexRouter(router),
            description,
            deadline,
        )
    }

    /// Creates a governance proposal to remove a DEX router from the approved registry.
    pub fn create_remove_router_proposal(
        env: Env,
        proposer: Address,
        router: Address,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;

        if !dex_router_is_approved(&env, &router) {
            return Err(ContractError::AssetRegistryState);
        }

        create_governance_proposal(
            &env,
            proposer,
            ProposalKind::RemoveDexRouter(router),
            description,
            deadline,
        )
    }

    /// Returns `true` if the given router address is in the governance-approved
    /// DEX router registry.
    pub fn is_dex_router_approved(env: Env, router: Address) -> bool {
        dex_router_is_approved(&env, &router)
    }

    // ─── Yield Allocation ────────────────────────────────────────────────────

    /// Creates a governance proposal to add a yield venue to the approved registry.
    ///
    /// A venue must be approved before it can be referenced in a
    /// `YieldDeposit` or `YieldWithdraw` proposal.
    pub fn create_add_yield_venue_proposal(
        env: Env,
        proposer: Address,
        venue: Address,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;

        if yield_venue_is_approved(&env, &venue) {
            return Err(ContractError::AssetRegistryState);
        }

        create_governance_proposal(
            &env,
            proposer,
            ProposalKind::AddYieldVenue(venue),
            description,
            deadline,
        )
    }

    /// Creates a governance proposal to remove a yield venue from the approved registry.
    pub fn create_remove_venue_proposal(
        env: Env,
        proposer: Address,
        venue: Address,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;

        if !yield_venue_is_approved(&env, &venue) {
            return Err(ContractError::AssetRegistryState);
        }

        create_governance_proposal(
            &env,
            proposer,
            ProposalKind::RemoveYieldVenue(venue),
            description,
            deadline,
        )
    }

    /// Creates a proposal to deposit treasury tokens into an approved yield venue.
    ///
    /// # Validation at creation
    /// - `venue` must be in the approved venue registry.
    /// - `token` must pass the asset registry check.
    /// - `amount` ≥ `MIN_AMOUNT`.
    /// - `position_id` must not already be open (no existing `YieldPosition`).
    pub fn create_yield_deposit_proposal(
        env: Env,
        proposer: Address,
        params: YieldAllocationParams,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;

        if params.amount < MIN_AMOUNT {
            return Err(ContractError::InvalidAmount);
        }
        if !yield_venue_is_approved(&env, &params.venue) {
            return Err(ContractError::YieldVenueNotApproved);
        }
        validate_token(&env, &params.token)?;
        if read_yield_position(&env, params.position_id).is_some() {
            return Err(ContractError::YieldPositionAlreadyOpen);
        }

        let id = create_governance_proposal(
            &env,
            proposer.clone(),
            ProposalKind::YieldDeposit(params.clone()),
            description,
            deadline,
        )?;

        env.events().publish(
            (symbol_short!("y_dprop"),),
            YieldDepositProposedEvent {
                version: EVENT_SCHEMA_VERSION,
                proposal_id: id,
                proposer,
                venue: params.venue,
                token: params.token,
                amount: params.amount,
                position_id: params.position_id,
                kind: params.kind,
            },
        );

        Ok(id)
    }

    /// Creates a proposal to withdraw tokens from a yield venue back to the treasury.
    ///
    /// # Validation at creation
    /// - `venue` must be in the approved venue registry.
    /// - `token` must pass the asset registry check.
    /// - `amount` ≥ `MIN_AMOUNT`.
    /// - `min_return` ≥ 1.
    /// - `position_id` must reference an existing open `YieldPosition`.
    /// - The position's recorded `venue` and `token` must match `params`.
    pub fn create_yield_withdraw_proposal(
        env: Env,
        proposer: Address,
        params: YieldAllocationParams,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;

        if params.amount < MIN_AMOUNT {
            return Err(ContractError::InvalidAmount);
        }
        if params.min_return < 1 {
            return Err(ContractError::InvalidAmount);
        }
        if !yield_venue_is_approved(&env, &params.venue) {
            return Err(ContractError::YieldVenueNotApproved);
        }
        validate_token(&env, &params.token)?;

        let position = read_yield_position(&env, params.position_id)
            .ok_or(ContractError::YieldPositionNotFound)?;
        if position.venue != params.venue || position.token != params.token {
            return Err(ContractError::Unauthorized);
        }

        let id = create_governance_proposal(
            &env,
            proposer.clone(),
            ProposalKind::YieldWithdraw(params.clone()),
            description,
            deadline,
        )?;

        env.events().publish(
            (symbol_short!("y_wprop"),),
            YieldWithdrawProposedEvent {
                version: EVENT_SCHEMA_VERSION,
                proposal_id: id,
                proposer,
                venue: params.venue,
                token: params.token,
                amount: params.amount,
                min_return: params.min_return,
                position_id: params.position_id,
            },
        );

        Ok(id)
    }

    /// Returns the open `YieldPosition` for the given `position_id`, or `None`
    /// if no position with that ID exists.
    pub fn get_yield_position(env: Env, position_id: u64) -> Option<YieldPosition> {
        read_yield_position(&env, position_id)
    }

    /// Returns `true` if the given venue address is in the governance-approved
    /// yield venue registry.
    pub fn is_yield_venue_approved(env: Env, venue: Address) -> bool {
        yield_venue_is_approved(&env, &venue)
    }

    /// One-time migration that stamps storage schema to version 3 for legacy
    /// deployments, confirming the yield venue registry keys are in use.
    ///
    /// This is a no-op beyond bumping the version marker: the `YVENUE` and
    /// `YPOS` registries start empty on every deployment so there is no data
    /// to backfill. Returns `AlreadyMigrated` if the deployment is already
    /// at schema version ≥ 3.
    pub fn migrate_to_yield_allocation(
        env: Env,
        approvers: Vec<Address>,
    ) -> Result<(), ContractError> {
        if !is_initialized(&env) {
            return Err(ContractError::NotInitialized);
        }
        if read_storage_version(&env) >= 3 {
            return Err(ContractError::AlreadyMigrated);
        }

        require_weighted_approvers(&env, &approvers)?;

        write_storage_version(&env);

        env.events().publish(
            (Symbol::new(&env, "yield_migrated"),),
            GovernanceMigratedEvent {
                version: EVENT_SCHEMA_VERSION,
                owner_count: read_owners_map(&env)?.len(),
                total_weight: read_total_weight(&env),
            },
        );
        Ok(())
    }

    // ─── Pull-Payment Requests ────────────────────────────────────────────────

    /// Creates a governance proposal to open a pull-payment request.
    ///
    /// When executed, the request is recorded as `Open` and the designated
    /// `claimant` may call `claim_pull_payment` at any time before
    /// `params.expires_at` to receive `params.amount` of `params.token`.
    ///
    /// # Validation at creation
    /// - `claimant` must not be the contract itself.
    /// - `token` must pass the asset registry check.
    /// - `amount` ≥ `MIN_AMOUNT`.
    /// - `expires_at` must be in the future.
    /// - `memo` (if non-empty) must be ≤ `MAX_DESCRIPTION_LEN` characters.
    pub fn create_pull_payment_proposal(
        env: Env,
        proposer: Address,
        params: PullPaymentParams,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;

        if params.amount < MIN_AMOUNT {
            return Err(ContractError::InvalidAmount);
        }
        if params.claimant == env.current_contract_address() {
            return Err(ContractError::InvalidRecipient);
        }
        validate_token(&env, &params.token)?;

        let now = env.ledger().timestamp();
        if params.expires_at <= now {
            return Err(ContractError::InvalidDeadline);
        }
        if params.expires_at - now > MAX_PROPOSAL_DURATION {
            return Err(ContractError::InvalidDuration);
        }
        if !params.memo.is_empty() && params.memo.len() > MAX_DESCRIPTION_LEN {
            return Err(ContractError::DescriptionTooLong);
        }

        create_governance_proposal(
            &env,
            proposer,
            ProposalKind::CreatePullPayment(params),
            description,
            deadline,
        )
    }

    /// Creates a governance proposal to cancel an open pull-payment request.
    ///
    /// Only requests that are currently `Open` can be cancelled. Expired or
    /// already-claimed requests are rejected at execution time.
    pub fn create_cancel_payment_proposal(
        env: Env,
        proposer: Address,
        request_id: u64,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;

        create_governance_proposal(
            &env,
            proposer,
            ProposalKind::CancelPullPayment(request_id),
            description,
            deadline,
        )
    }

    /// Allows the designated claimant of an open pull-payment request to pull
    /// the pre-approved amount from the treasury.
    ///
    /// This is a **non-governance entrypoint**: the claimant does not need to
    /// be an owner. They only need to be the address named in the request and
    /// to authorise this call via `require_auth()`.
    ///
    /// # Guards
    /// - The request must exist.
    /// - The request must be `Open` (not `Claimed`, `Cancelled`, or `Expired`).
    /// - The caller must be the designated `claimant`.
    /// - The treasury must hold at least `amount` of the token.
    /// - The contract must not be frozen.
    ///
    /// On success the request transitions to `Claimed` (terminal) and a
    /// `PullPaymentClaimedEvent` is emitted.
    pub fn claim_pull_payment(
        env: Env,
        claimant: Address,
        request_id: u64,
    ) -> Result<(), ContractError> {
        claimant.require_auth();
        require_not_frozen(&env)?;

        let mut req = read_pull_payment(&env, request_id)
            .ok_or(ContractError::PullPaymentNotFound)?;

        if claimant != req.claimant {
            return Err(ContractError::PullPaymentWrongClaimant);
        }

        // Derive status — an Open request past expires_at is treated as Expired.
        let status = derive_pull_payment_status(&env, &req);
        if !matches!(status, PullPaymentStatus::Open) {
            return Err(ContractError::PullPaymentNotOpen);
        }

        // Re-validate token in case the registry changed since the request opened.
        validate_token(&env, &req.token)?;
        require_asset_outflow_allowed(&env, &req.token)?;

        if available_balance(&env, &req.token)? < req.amount {
            return Err(ContractError::TransferFailed);
        }

        // Transfer the tokens to the claimant.
        let treasury = env.current_contract_address();
        if !transfer_succeeded(
            token::Client::new(&env, &req.token)
                .try_transfer(&treasury, &claimant, &req.amount),
        ) {
            return Err(ContractError::TransferFailed);
        }

        // Mark the request as claimed (terminal).
        req.status = PullPaymentStatus::Claimed;
        write_pull_payment(&env, &req);

        env.events().publish(
            (symbol_short!("pr_claim"),),
            PullPaymentClaimedEvent {
                version: EVENT_SCHEMA_VERSION,
                request_id,
                claimant,
                token: req.token.clone(),
                amount: req.amount,
            },
        );

        Ok(())
    }

    /// Returns the pull-payment request record for the given `request_id`, or
    /// `None` if no request with that ID exists.
    pub fn get_pull_payment(
        env: Env,
        request_id: u64,
    ) -> Option<PullPaymentRequest> {
        let req = read_pull_payment(&env, request_id)?;
        // Return the derived status so callers see Expired rather than Open
        // when the expiry has passed.
        let mut req = req;
        req.status = derive_pull_payment_status(&env, &req);
        Some(req)
    }

    /// Creates a proposal to configure a rolling spending limit and window for a token in the treasury.
    /// When executed, the total rolling outflows of `token` from the treasury across all proposals
    /// cannot exceed `limit` within `window_secs`. A limit of 0 blocks all outflows for that token.
    pub fn create_treasury_limit_proposal(
        env: Env,
        proposer: Address,
        token: Address,
        limit: i128,
        window_secs: u64,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;

        validate_token(&env, &token)?;
        validate_asset_registry(&env, &token)?;

        if limit < 0 {
            return Err(ContractError::InvalidSpendingLimit);
        }
        if window_secs != 0 && (window_secs < MIN_SPENDING_WINDOW || window_secs > MAX_SPENDING_WINDOW) {
            return Err(ContractError::InvalidInterval);
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
            kind: ProposalKind::SetTreasurySpendingLimit(token, limit, window_secs),
            ready_at: 0,
            quorum_weight: threshold,
            category: ProposalCategory::Other,
            attachment_hash: None,
        };
        write_proposal(&env, &proposal);
        register_active_proposal(&env, id)?;

        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

        let total_weight = read_total_weight(&env);
        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                version: EVENT_SCHEMA_VERSION,
                id,
                proposer,
                threshold,
                category: ProposalCategory::Other,
                transfers: Vec::new(&env),
                quorum_weight: threshold,
                total_weight_at_creation: total_weight,
                attachment_hash: None,
            },
        );
        Ok(id)
    }

    /// Creates a proposal to change an existing owner's voting weight.
    ///
    /// This is a no-op beyond bumping the version marker: the `PULLREQ` and
    /// `PRNEXT` keys start empty/1 on every deployment so there is no data to
    /// backfill. Returns `AlreadyMigrated` if the deployment is already at
    /// schema version ≥ 4.
    pub fn migrate_to_pull_payments(
        env: Env,
        approvers: Vec<Address>,
    ) -> Result<(), ContractError> {
        if !is_initialized(&env) {
            return Err(ContractError::NotInitialized);
        }
        if read_storage_version(&env) >= 4 {
            return Err(ContractError::AlreadyMigrated);
        }

        require_weighted_approvers(&env, &approvers)?;

        // Initialise the next-ID counter if it does not exist.
        if env
            .storage()
            .instance()
            .get::<_, u64>(&pull_payment_next_id_key())
            .is_none()
        {
            write_next_pull_payment_id(&env, 1);
        }

        write_storage_version(&env);

        env.events().publish(
            (Symbol::new(&env, "pullpay_migrated"),),
            GovernanceMigratedEvent {
                version: EVENT_SCHEMA_VERSION,
                owner_count: read_owners_map(&env)?.len(),
                total_weight: read_total_weight(&env),
            },
        );
        Ok(())
    }

    // ─── Payment Metadata (Invoice & Reference) ──────────────────────────────

    /// Attaches reconciliation metadata to an existing proposal.
    ///
    /// The caller must be the original proposer of the proposal and the
    /// proposal must not have been executed yet. Metadata can be set or
    /// overwritten any time before execution, allowing the proposer to correct
    /// a typo or add a missing invoice reference after creation.
    ///
    /// # Validation
    /// - Each non-`None` field must be non-empty and ≤ `MAX_DESCRIPTION_LEN`.
    /// - The proposal must exist.
    /// - The proposal must be in `Pending` or `Ready` status (not Executed,
    ///   Expired, or Revoked).
    /// - The caller must be the proposal's original proposer.
    pub fn set_payment_metadata(
        env: Env,
        setter: Address,
        proposal_id: u64,
        metadata: PaymentMetadata,
    ) -> Result<(), ContractError> {
        setter.require_auth();

        let proposal = read_proposal(&env, proposal_id)?;
        if proposal.proposer != setter {
            return Err(ContractError::Unauthorized);
        }

        // Refresh derived status.
        let status = derive_status(&env, &proposal);
        if matches!(status, ProposalStatus::Executed) {
            return Err(ContractError::ProposalAlreadyExecuted);
        }
        if !matches!(status, ProposalStatus::Pending | ProposalStatus::Ready) {
            return Err(ContractError::ProposalNotActive);
        }

        validate_payment_metadata(&metadata)?;
        write_payment_metadata(&env, proposal_id, &metadata);

        env.events().publish(
            (symbol_short!("pymeta"),),
            PaymentMetadataSetEvent {
                version: EVENT_SCHEMA_VERSION,
                proposal_id,
                setter,
                metadata,
            },
        );

        Ok(())
    }

    /// Clears all reconciliation metadata from a proposal.
    ///
    /// Same authorization and status constraints as `set_payment_metadata`.
    pub fn clear_payment_metadata(
        env: Env,
        setter: Address,
        proposal_id: u64,
    ) -> Result<(), ContractError> {
        setter.require_auth();

        let proposal = read_proposal(&env, proposal_id)?;
        if proposal.proposer != setter {
            return Err(ContractError::Unauthorized);
        }

        let status = derive_status(&env, &proposal);
        if matches!(status, ProposalStatus::Executed) {
            return Err(ContractError::ProposalAlreadyExecuted);
        }
        if !matches!(status, ProposalStatus::Pending | ProposalStatus::Ready) {
            return Err(ContractError::ProposalNotActive);
        }

        remove_payment_metadata(&env, proposal_id);
        Ok(())
    }

    /// Returns the reconciliation metadata attached to a proposal, or `None`
    /// if no metadata has been set.
    pub fn get_payment_metadata(
        env: Env,
        proposal_id: u64,
    ) -> Option<PaymentMetadata> {
        read_payment_metadata(&env, proposal_id)
    }

    /// One-time migration that stamps storage schema to version 5 for legacy
    /// deployments, confirming the payment metadata store is in use.
    ///
    /// This is a no-op beyond bumping the version marker: the `PAYMETA` store
    /// starts empty on every deployment so there is no data to backfill.
    /// Returns `AlreadyMigrated` if the deployment is already at schema
    /// version ≥ 5.
    pub fn migrate_to_payment_metadata(
        env: Env,
        approvers: Vec<Address>,
    ) -> Result<(), ContractError> {
        if !is_initialized(&env) {
            return Err(ContractError::NotInitialized);
        }
        if read_storage_version(&env) >= 5 {
            return Err(ContractError::AlreadyMigrated);
        }

        require_weighted_approvers(&env, &approvers)?;

        write_storage_version(&env);

        env.events().publish(
            (Symbol::new(&env, "meta_migrated"),),
            GovernanceMigratedEvent {
                version: EVENT_SCHEMA_VERSION,
                owner_count: read_owners_map(&env)?.len(),
                total_weight: read_total_weight(&env),
            },
        );
        Ok(())
    }

    // ─── Spend Policy Engine ─────────────────────────────────────────────────

    /// Creates a governance proposal to set a composed multi-window spend
    /// policy for an (owner, token) pair.
    ///
    /// The policy can contain up to three rolling-window limits (daily,
    /// weekly, monthly). At execution time every window is evaluated: if
    /// the cumulative spend including the proposed amount exceeds any
    /// window's limit, the proposal is rejected with `SpendPolicyExceeded`.
    ///
    /// # Validation at creation
    /// - `limits` must be non-empty (at least one window).
    /// - `limits` must contain at most `MAX_SPEND_WINDOWS` (3) entries.
    /// - No duplicate `SpendWindowKind` values.
    /// - Each limit must be ≥ `MIN_AMOUNT`.
    /// - `token` must pass the asset registry check.
    pub fn create_set_spend_policy_proposal(
        env: Env,
        proposer: Address,
        policy: SpendPolicy,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;

        validate_spend_policy(&policy)?;
        validate_token(&env, &policy.token)?;

        create_governance_proposal(
            &env,
            proposer,
            ProposalKind::SetSpendPolicy(policy),
            description,
            deadline,
        )
    }

    /// Creates a governance proposal to clear all spend-policy limits for an
    /// (owner, token) pair.
    pub fn create_clear_policy_proposal(
        env: Env,
        proposer: Address,
        owner: Address,
        token: Address,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;

        create_governance_proposal(
            &env,
            proposer,
            ProposalKind::ClearSpendPolicy(owner, token),
            description,
            deadline,
        )
    }

    /// Returns the active spend policy for an (owner, token) pair, or `None`
    /// if no policy is configured.
    pub fn get_spend_policy(
        env: Env,
        owner: Address,
        token: Address,
    ) -> Option<SpendPolicy> {
        read_spend_policy(&env, &owner, &token)
    }

    /// Returns the effective spent amount within the given window for an
    /// (owner, token) pair. Returns 0 if no policy or no tracker exists, or
    /// if the window has expired.
    pub fn get_spend_policy_spent(
        env: Env,
        owner: Address,
        token: Address,
        window: SpendWindowKind,
    ) -> i128 {
        effective_spend_policy_spent(&env, &owner, &token, &window)
    }

    /// Returns the remaining spend headroom for a specific window, or `None`
    /// if no policy is configured for this (owner, token) pair.
    pub fn get_spend_policy_remaining(
        env: Env,
        owner: Address,
        token: Address,
        window: SpendWindowKind,
    ) -> Option<i128> {
        let policy = read_spend_policy(&env, &owner, &token)?;
        for i in 0..policy.limits.len() {
            let limit_entry = policy.limits.get(i).unwrap();
            if limit_entry.window == window {
                let spent = effective_spend_policy_spent(&env, &owner, &token, &window);
                return Some(limit_entry.limit.saturating_sub(spent));
            }
        }
        None
    }

    /// One-time migration that stamps storage schema to version 6 for legacy
    /// deployments, confirming the spend policy engine keys are in use.
    ///
    /// Returns `AlreadyMigrated` if the deployment is already at schema
    /// version ≥ 6.
    pub fn migrate_to_spend_policy(
        env: Env,
        approvers: Vec<Address>,
    ) -> Result<(), ContractError> {
        if !is_initialized(&env) {
            return Err(ContractError::NotInitialized);
        }
        if read_storage_version(&env) >= 6 {
            return Err(ContractError::AlreadyMigrated);
        }

        require_weighted_approvers(&env, &approvers)?;

        write_storage_version(&env);

        env.events().publish(
            (Symbol::new(&env, "spendpol_migrated"),),
            GovernanceMigratedEvent {
                version: EVENT_SCHEMA_VERSION,
                owner_count: read_owners_map(&env)?.len(),
                total_weight: read_total_weight(&env),
            },
        );
        Ok(())
    }

    /// Creates a governance proposal to enable or disable the approved-token registry.
    pub fn create_asset_registry_proposal(
        env: Env,
        proposer: Address,
        enabled: bool,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;
        create_governance_proposal(
            &env,
            proposer,
            ProposalKind::SetAssetRegistryEnabled(enabled),
            description,
            deadline,
        )
    }

    /// Creates a proposal to allow a token when the registry is enabled.
    pub fn create_approve_token_proposal(
        env: Env,
        proposer: Address,
        token: Address,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;
        validate_token_interface(&env, &token)?;
        if token_is_approved(&env, &token) {
            return Err(ContractError::AssetRegistryState);
        }
        create_governance_proposal(
            &env,
            proposer,
            ProposalKind::AddApprovedToken(token),
            description,
            deadline,
        )
    }

    /// Creates a governance proposal to set a fiat-denominated spend limit.
    pub fn create_fiat_limit_proposal(
        env: Env,
        proposer: Address,
        limit: FiatSpendLimit,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;
        if limit.fiat_limit < MIN_AMOUNT {
            return Err(ContractError::InvalidAmount);
        }
        if !(MIN_SPENDING_WINDOW..=MAX_SPENDING_WINDOW).contains(&limit.window_secs) {
            return Err(ContractError::InvalidDuration);
        }
        create_governance_proposal(
            &env, proposer, ProposalKind::SetFiatSpendLimit(limit), description, deadline,
        )
    }

    /// Creates a proposal to clear a fiat-denominated spend limit.
    pub fn create_clear_fiat_proposal(
        env: Env,
        proposer: Address,
        owner: Address,
        token: Address,
        fiat: Symbol,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;
        create_governance_proposal(
            &env, proposer, ProposalKind::ClearFiatSpendLimit(owner, token, fiat),
            description, deadline,
        )
    }

    /// Creates a proposal to add an address to the denylist.
    pub fn create_add_to_denylist_proposal(
        env: Env,
        proposer: Address,
        address: Address,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;
        create_governance_proposal(
            &env, proposer, ProposalKind::AddToDenylist(address), description, deadline,
        )
    }

    /// Creates a proposal to replace an owner key with a new address.
    ///
    /// The rotation goes through the normal propose → approve → execute
    /// lifecycle. It does not activate the moment quorum is reached: `execute`
    /// refuses until `OWNER_ROTATION_DELAY` has elapsed since `ready_at`, so the
    /// current key holder has a window to object.
    pub fn create_rotate_owner_proposal(
        env: Env,
        proposer: Address,
        owner: Address,
        new_owner: Address,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;
        if owner == new_owner {
            return Err(ContractError::DuplicateOwner);
        }
        let owners = read_owners_map(&env)?;
        if !owners.contains_key(owner.clone()) {
            return Err(ContractError::OwnerNotFound);
        }
        if owners.contains_key(new_owner.clone()) {
            return Err(ContractError::DuplicateOwner);
        }
        create_governance_proposal(
            &env,
            proposer,
            ProposalKind::RotateOwner(owner, new_owner),
            description,
            deadline,
        )
    }

    /// Creates a proposal to remove an address from the denylist.
    pub fn create_undenylist_proposal(
        env: Env,
        proposer: Address,
        address: Address,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;
        create_governance_proposal(
            &env, proposer, ProposalKind::RemoveFromDenylist(address), description, deadline,
        )
    }

    /// Returns `true` if the given address is on the denylist.
    pub fn is_denied(env: Env, address: Address) -> bool {
        is_denied(&env, &address)
    }

    /// Returns `true` if the denylist is enabled.
    pub fn is_denylist_enabled(env: Env) -> bool {
        denylist_enabled(&env)
    }

    // ─── #953: Cross-Asset Rebalancing ────────────────────────────────────────

    /// Creates a governance proposal to rebalance treasury assets toward
    /// target weights.
    pub fn create_rebalance_proposal(
        env: Env,
        proposer: Address,
        params: RebalanceParams,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;

        validate_rebalance_params(&params)?;
        if !dex_router_is_approved(&env, &params.router) {
            return Err(ContractError::RebalanceRouterNotApproved);
        }
        for i in 0..params.targets.len() {
            let target = params.targets.get(i).unwrap();
            validate_token(&env, &target.token)?;
        }
        let now = env.ledger().timestamp();
        if params.swap_deadline <= now {
            return Err(ContractError::InvalidSwapDeadline);
        }

        let id = create_governance_proposal(
            &env,
            proposer.clone(),
            ProposalKind::Rebalance(params.clone()),
            description,
            deadline,
        )?;

        env.events().publish(
            (symbol_short!("reb_prop"),),
            RebalanceProposedEvent {
                version: EVENT_SCHEMA_VERSION,
                proposal_id: id,
                proposer,
                router: params.router,
                targets: params.targets,
                tolerance_bps: params.tolerance_bps,
                swap_deadline: params.swap_deadline,
            },
        );

        Ok(id)
    }

    /// Returns the timestamp of the last executed rebalance, or 0 if none.
    pub fn get_last_rebalance(env: Env) -> u64 {
        read_last_rebalance(&env)
    }

    /// One-time migration that stamps storage schema to version 7 for legacy
    /// deployments.
    pub fn migrate_to_odr(
        env: Env,
        approvers: Vec<Address>,
    ) -> Result<(), ContractError> {
        if !is_initialized(&env) {
            return Err(ContractError::NotInitialized);
        }
        if read_storage_version(&env) >= 7 {
            return Err(ContractError::AlreadyMigrated);
        }
        require_weighted_approvers(&env, &approvers)?;
        write_storage_version(&env);
        env.events().publish(
            (Symbol::new(&env, "odr_migrated"),),
            GovernanceMigratedEvent {
                version: EVENT_SCHEMA_VERSION,
                owner_count: read_owners_map(&env)?.len(),
                total_weight: read_total_weight(&env),
            },
        );
        Ok(())
    }
    /// Records `ready_at` the first time the threshold is crossed.
    pub fn approve(env: Env, approver: Address, proposal_id: u64) -> Result<(), ContractError> {
        approver.require_auth();
        let raw_weight = {
            require_role(&env, &approver, Role::Approver)?;
            require_owner_and_weight(&env, &approver)?
        };
        require_not_frozen(&env)?;
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
        if has_abstention_weight(&env, proposal_id, &approver) {
            return Err(ContractError::AlreadyAbstained);
        }
        if has_soft_approval_weight(&env, proposal_id, &approver) {
            return Err(ContractError::AlreadySoftApproved);
        }

        // Count the approver's effective (delegation-aware) weight, not just
        // their own raw weight — the exact value is stored per-approval so
        // `revoke` can later reverse precisely this amount.
        let owners = read_owners_map(&env)?;
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
                version: EVENT_SCHEMA_VERSION,
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

    /// Relayer entrypoint for an owner-authorized approval. The transaction
    /// sponsor pays the network fee; `approver` must still authorize this exact
    /// call, and the approval remains bound to `proposal_id`.
    pub fn approve_sponsored(
        env: Env,
        approver: Address,
        proposal_id: u64,
    ) -> Result<(), ContractError> {
        Self::approve(env, approver, proposal_id)
    }

    /// Records an owner's positive but non-binding support for a proposal.
    /// Soft approval contributes to participation/support views only; it adds
    /// no proposal approval weight and can never make a proposal Ready.
    pub fn soft_approve(
        env: Env,
        supporter: Address,
        proposal_id: u64,
    ) -> Result<(), ContractError> {
        supporter.require_auth();
        let raw_weight = {
            require_role(&env, &supporter, Role::Approver)?;
            require_owner_and_weight(&env, &supporter)?
        };
        require_not_frozen(&env)?;
        let proposal = read_proposal(&env, proposal_id)?;
        let status = derive_status(&env, &proposal);
        if !matches!(status, ProposalStatus::Pending | ProposalStatus::Ready) {
            return Err(ContractError::ProposalNotActive);
        }
        if read_approval_weight(&env, proposal_id, &supporter) > 0 {
            return Err(ContractError::AlreadyApproved);
        }
        if has_abstention_weight(&env, proposal_id, &supporter) {
            return Err(ContractError::AlreadyAbstained);
        }
        if has_soft_approval_weight(&env, proposal_id, &supporter) {
            return Err(ContractError::AlreadySoftApproved);
        }

        let owners = read_owners_map(&env)?;
        let weight =
            compute_effective_weight(&env, &owners, &supporter, raw_weight)?;
        write_soft_approval_weight(&env, proposal_id, &supporter, weight);

        let (
            _abstention_count,
            _abstention_weight,
            participation_weight,
            soft_approval_count,
            soft_approval_weight,
        ) = participation_progress(&env, proposal_id)?;
        env.events().publish(
            (symbol_short!("softapr"),),
            ProposalSoftApprovedEvent {
                version: EVENT_SCHEMA_VERSION,
                id: proposal_id,
                supporter,
                soft_approval_count,
                weight,
                cumulative_soft_weight: soft_approval_weight,
                participation_weight,
            },
        );
        Ok(())
    }

    /// Relayer entrypoint for an owner-authorized soft approval.
    pub fn soft_approve_sponsored(
        env: Env,
        supporter: Address,
        proposal_id: u64,
    ) -> Result<(), ContractError> {
        Self::soft_approve(env, supporter, proposal_id)
    }

    /// Revokes the caller's soft approval. This never changes binding approval
    /// weight or proposal Ready/Pending status.
    pub fn revoke_soft_approval(
        env: Env,
        supporter: Address,
        proposal_id: u64,
    ) -> Result<(), ContractError> {
        supporter.require_auth();
        require_role(&env, &supporter, Role::Approver)?;
        require_owner_and_weight(&env, &supporter)?;
        require_not_frozen(&env)?;
        let proposal = read_proposal(&env, proposal_id)?;
        let mut proposal = proposal;
        proposal.status = derive_status(&env, &proposal);
        if !matches!(
            proposal.status,
            ProposalStatus::Pending | ProposalStatus::Ready
        ) {
            return Err(ContractError::ProposalNotActive);
        }

        let weight = read_soft_approval_weight(&env, proposal_id, &supporter);
        if weight == 0 {
            return Err(ContractError::NotSoftApproved);
        }
        write_soft_approval_weight(&env, proposal_id, &supporter, 0);

        let (
            _abstention_count,
            _abstention_weight,
            participation_weight,
            soft_approval_count,
            soft_approval_weight,
        ) = participation_progress(&env, proposal_id)?;
        env.events().publish(
            (symbol_short!("unsftap"),),
            ProposalSoftApprovalRevokedEvent {
                version: EVENT_SCHEMA_VERSION,
                id: proposal_id,
                supporter,
                soft_approval_count,
                weight,
                cumulative_soft_weight: soft_approval_weight,
                participation_weight,
            },
        );
        Ok(())
    }

    /// Records an owner's abstention on a proposal. Abstentions count toward
    /// participation reporting and never increase approval weight or quorum.
    pub fn abstain(
        env: Env,
        abstainer: Address,
        proposal_id: u64,
    ) -> Result<(), ContractError> {
        abstainer.require_auth();
        let raw_weight = {
            require_role(&env, &abstainer, Role::Approver)?;
            require_owner_and_weight(&env, &abstainer)?
        };
        require_not_frozen(&env)?;
        let proposal = read_proposal(&env, proposal_id)?;
        let mut proposal = proposal;
        proposal.status = derive_status(&env, &proposal);
        if !matches!(
            proposal.status,
            ProposalStatus::Pending | ProposalStatus::Ready
        ) {
            return Err(ContractError::ProposalNotActive);
        }
        if read_approval_weight(&env, proposal_id, &abstainer) > 0 {
            return Err(ContractError::AlreadyApproved);
        }
        if has_abstention_weight(&env, proposal_id, &abstainer) {
            return Err(ContractError::AlreadyAbstained);
        }
        if has_soft_approval_weight(&env, proposal_id, &abstainer) {
            return Err(ContractError::AlreadySoftApproved);
        }

        let owners = read_owners_map(&env)?;
        let weight =
            compute_effective_weight(&env, &owners, &abstainer, raw_weight)?;
        write_abstention_weight(&env, proposal_id, &abstainer, weight);

        let (
            abstention_count,
            abstention_weight,
            participation_weight,
            _soft_approval_count,
            _soft_approval_weight,
        ) = participation_progress(&env, proposal_id)?;
        env.events().publish(
            (symbol_short!("abstain"),),
            ProposalAbstainedEvent {
                version: EVENT_SCHEMA_VERSION,
                id: proposal_id,
                abstainer,
                abstention_count,
                weight,
                cumulative_abstention_weight: abstention_weight,
                participation_weight,
            },
        );
        Ok(())
    }

    /// Relayer entrypoint for an owner-authorized abstention.
    pub fn abstain_sponsored(
        env: Env,
        abstainer: Address,
        proposal_id: u64,
    ) -> Result<(), ContractError> {
        Self::abstain(env, abstainer, proposal_id)
    }

    /// Revokes the caller's abstention while leaving approval weight unchanged.
    pub fn revoke_abstention(
        env: Env,
        abstainer: Address,
        proposal_id: u64,
    ) -> Result<(), ContractError> {
        abstainer.require_auth();
        require_role(&env, &abstainer, Role::Approver)?;
        require_owner_and_weight(&env, &abstainer)?;
        require_not_frozen(&env)?;
        let proposal = read_proposal(&env, proposal_id)?;
        let mut proposal = proposal;
        proposal.status = derive_status(&env, &proposal);
        if !matches!(
            proposal.status,
            ProposalStatus::Pending | ProposalStatus::Ready
        ) {
            return Err(ContractError::ProposalNotActive);
        }

        let weight = read_abstention_weight(&env, proposal_id, &abstainer);
        if weight == 0 {
            return Err(ContractError::NotAbstained);
        }
        write_abstention_weight(&env, proposal_id, &abstainer, 0);

        let (
            abstention_count,
            abstention_weight,
            participation_weight,
            _soft_approval_count,
            _soft_approval_weight,
        ) = participation_progress(&env, proposal_id)?;
        env.events().publish(
            (symbol_short!("unabst"),),
            ProposalAbstentionRevokedEvent {
                version: EVENT_SCHEMA_VERSION,
                id: proposal_id,
                abstainer,
                abstention_count,
                weight,
                cumulative_abstention_weight: abstention_weight,
                participation_weight,
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
        require_role(&env, &approver, Role::Approver)?;
        require_owner_and_weight(&env, &approver)?;
        require_not_frozen(&env)?;
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

        // Reverse the exact effective weight recorded at approve-time.
        let weight = read_approval_weight(&env, proposal_id, &approver);
        write_approval_weight(&env, proposal_id, &approver, 0);

        proposal.approvals = checked_weight_sub(proposal.approvals, weight)?;
        proposal.approval_weight = checked_weight_sub(proposal.approval_weight, weight)?;
        proposal.status = derive_status(&env, &proposal);
        write_proposal(&env, &proposal);

        env.events().publish(
            (symbol_short!("revoked"),),
            ProposalRevokedEvent {
                version: EVENT_SCHEMA_VERSION,
                id: proposal_id,
                approver,
                approvals: proposal.approvals,
                weight,
                cumulative_weight: proposal.approvals,
            },
        );

        Ok(())
    }

    /// Cancels a proposal that is still pending. A proposal that reached quorum,
    /// expired, or otherwise became terminal cannot be cancelled.
    pub fn cancel_proposal(
        env: Env,
        proposer: Address,
        proposal_id: u64,
    ) -> Result<(), ContractError> {
        proposer.require_auth();
        let mut proposal = read_proposal(&env, proposal_id)?;
        if proposal.proposer != proposer {
            return Err(ContractError::Unauthorized);
        }

        proposal.status = derive_status(&env, &proposal);
        if !matches!(proposal.status, ProposalStatus::Pending) {
            return Err(ContractError::ProposalNotActive);
        }

        proposal.status = ProposalStatus::Cancelled;
        write_proposal(&env, &proposal);
        remove_active_proposal(&env, proposal_id);

        env.events().publish(
            (symbol_short!("p_canc"),),
            ProposalCancelledEvent {
                id: proposal_id,
                proposer,
            },
        );
        Ok(())
    }

    /// Executes a proposal that has reached ready status.
    ///
    /// The executor must hold the Executor role but need not be an owner: the
    /// owners have already authorised the proposal by reaching quorum.
    pub fn execute(env: Env, executor: Address, proposal_id: u64) -> Result<(), ContractError> {
        executor.require_auth();
        require_role(&env, &executor, Role::Executor)?;
        require_not_frozen(&env)?;

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

        // A scoped emergency freeze blocks only the affected operation family;
        // governance and unrelated proposals remain executable.
        require_kind_not_frozen(&env, proposal_kind_tag(&proposal.kind))?;

        // Time-lock enforcement.
        let time_lock_delay: u64 = env.storage().instance().get(&timelock_key()).unwrap_or(0);
        if time_lock_delay > 0 {
            let now = env.ledger().timestamp();
            if now < proposal.ready_at.saturating_add(time_lock_delay) {
                return Err(ContractError::TimeLockActive);
            }
        }

        // Proposal dependency graph ordered execution enforcement.
        let deps = read_proposal_dependencies(&env, proposal_id);
        for dep_id in deps.iter() {
            let dep_prop = read_proposal(&env, dep_id)?;
            let status = if dep_prop.status == ProposalStatus::Executed
                || dep_prop.status == ProposalStatus::Cancelled
            {
                dep_prop.status
            } else {
                derive_status(&env, &dep_prop)
            };
            match status {
                ProposalStatus::Executed => {},
                ProposalStatus::Cancelled => return Err(ContractError::DependencyCancelled),
                ProposalStatus::Expired => return Err(ContractError::DependencyExpired),
                _ => return Err(ContractError::DependencyNotExecuted),
            }
        }

        // Dispatch on proposal kind.
        match &proposal.kind {
            ProposalKind::Transfer(transfers) => {
                // Recovery mode blocks treasury outflows but must not block
                // governance itself (role/threshold/owner changes), so the
                // guard belongs here rather than at the top of `execute`.
                require_not_recovery(&env)?;
                // Validation and balance check only. The funds move in the
                // transfer loop below, once every check has passed — moving
                // them here as well would pay the recipient twice.
                for transfer in transfers.iter() {
                    validate_token(&env, &transfer.token)?;
                    require_asset_not_frozen(&env, &transfer.token)?;
                    require_asset_outflow_allowed(&env, &transfer.token)?;
                    if available_balance(&env, &transfer.token)? < transfer.amount {
                        return Err(ContractError::TransferFailed);
                    }
                }
                // ── #955: Denylist check ──────────────────────────────────
                // If the denylist is enabled, reject the proposal if any
                // transfer recipient is on the denylist.
                if let Err(denied_addr) = check_denylist(&env, transfers) {
                    env.events().publish(
                        (symbol_short!("deny_blk"),),
                        DenylistBlockedEvent {
                            version: EVENT_SCHEMA_VERSION,
                            proposal_id,
                            recipient: denied_addr,
                        },
                    );
                    return Err(ContractError::RecipientDenied);
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
                for j in 0..tracked_tokens.len() {
                    let token = tracked_tokens.get(j).unwrap();
                    let amount = tracked_amounts.get(j).unwrap();
                    if let Some(limit) = read_spending_limit(&env, &proposal.proposer, &token) {
                        let cumulative = effective_spent(&env, &proposal.proposer, &token)
                            .checked_add(amount)
                            .ok_or(ContractError::ArithmeticError)?;
                        if cumulative > limit {
                            return Err(ContractError::SpendingLimitExceeded);
                        }
                    }
                    if let Some(t_limit) = read_treasury_spending_limit(&env, &token) {
                        let cumulative = effective_treasury_spent(&env, &token)
                            .checked_add(amount)
                            .ok_or(ContractError::ArithmeticError)?;
                        if cumulative > t_limit {
                            return Err(ContractError::TreasurySpendingLimitExceeded);
                        }
                    }
                }
                // Check the treasury can cover the full per-token total before
                // any funds move, so a shortfall is rejected up front rather
                // than part-way through the transfer list.
                let treasury = env.current_contract_address();
                for j in 0..tracked_tokens.len() {
                    let token_client = token::Client::new(&env, &tracked_tokens.get(j).unwrap());
                    let needed = tracked_amounts.get(j).unwrap();
                    match token_client.try_balance(&treasury) {
                        Ok(Ok(balance)) if balance >= needed => {}
                        _ => return Err(ContractError::TransferFailed),
                    }
                }
                // Interaction. No contract storage has been written yet in this
                // call (proposal status, active count and spent trackers are
                // all written after this loop), and any `Err` return reverts
                // the whole invocation, so a failed or partial transfer leaves
                // no state behind. See docs/SECURITY.md, "Token interaction
                // safety".
                for transfer in transfers.iter() {
                    if !transfer_succeeded(token::Client::new(&env, &transfer.token).try_transfer(
                        &treasury,
                        &transfer.to,
                        &transfer.amount,
                    )) {
                        return Err(ContractError::TransferFailed);
                    }
                }
                let now = env.ledger().timestamp();
                for j in 0..tracked_tokens.len() {
                    let token = tracked_tokens.get(j).unwrap();
                    let amount = tracked_amounts.get(j).unwrap();
                    let tracker = read_spent_tracker(&env, &proposer, &token);
                    let expired = tracker.epoch == 0
                        || now > tracker.epoch.saturating_add(read_spending_window(&env, &proposer, &token));
                    let epoch = if expired { now } else { tracker.epoch };
                    let spent = if expired {
                        amount
                    } else {
                        tracker
                            .spent
                            .checked_add(amount)
                            .ok_or(ContractError::ArithmeticError)?
                    };
                    write_spent_tracker(&env, &proposer, &token, &SpentTracker { spent, epoch });
                    record_treasury_spend(&env, &token, amount)?;
                }
                // Record spend against the multi-window spend policy trackers.
                for j in 0..tracked_tokens.len() {
                    let token = tracked_tokens.get(j).unwrap();
                    let amount = tracked_amounts.get(j).unwrap();
                    record_spend_policy_spend(&env, &proposer, &token, amount);
                }
                // ── #954: Record fiat-denominated spend ──
                for j in 0..tracked_tokens.len() {
                    let token = tracked_tokens.get(j).unwrap();
                    let amount = tracked_amounts.get(j).unwrap();
                    record_fiat_spend(&env, &proposer, &token, amount);
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
                let roles = Vec::from_slice(&env, &DEFAULT_OWNER_ROLES);
                update_owner_roles(&env, new_owner, &roles);
                write_total_weight(&env, new_total);
                env.events().publish(
                    (symbol_short!("a_own"),),
                    AddOwnerExecutedEvent {
                        version: EVENT_SCHEMA_VERSION,
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
                update_owner_roles(&env, owner_to_remove, &Vec::new(&env));

                // Drop every delegation touching the removed owner. A remaining
                // owner's outgoing delegation to them would otherwise keep
                // subtracting weight that no one receives, and their own
                // outgoing delegation would revive if they were re-added.
                remove_delegation(&env, owner_to_remove);
                for other in owners.keys().iter() {
                    if let Some(delegation) = read_delegation(&env, &other) {
                        if delegation.delegate == *owner_to_remove {
                            remove_delegation(&env, &other);
                        }
                    }
                }

                write_total_weight(&env, resulting_total_weight);

                // Remove the removed owner's approval weight from all
                // Pending and Ready proposals they previously approved.
                // Without this, a removed owner's prior votes would
                // continue counting toward the threshold even after
                // they are no longer an owner — undermining the M-of-N
                // model. Terminal proposals (Executed, Expired, Revoked)
                // are left untouched since their outcome is final.
                let next_id: u64 = env
                    .storage()
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
                        version: EVENT_SCHEMA_VERSION,
                        removed_owner: owner_to_remove.clone(),
                        owner_count: prev_count - 1,
                    },
                );
            }
            ProposalKind::RotateOwner(old_owner, new_owner) => {
                // Activation is deliberately staged: quorum only schedules the
                // handoff. The delay gives the current key holder time to
                // object before the old address loses its weight and roles.
                let now = env.ledger().timestamp();
                if now < proposal.ready_at.saturating_add(OWNER_ROTATION_DELAY) {
                    return Err(ContractError::OwnerRotationDelayActive);
                }

                let mut owners = read_owners_map(&env)?;
                let weight = owners
                    .get(old_owner.clone())
                    .ok_or(ContractError::OwnerNotFound)?;
                if owners.contains_key(new_owner.clone()) {
                    return Err(ContractError::DuplicateOwner);
                }

                // Carry the existing roles across, so a rotated key keeps its
                // operational permissions instead of falling back to defaults.
                let mut roles = read_owner_roles(&env, old_owner);
                if roles.is_empty() {
                    roles = Vec::from_slice(&env, &DEFAULT_OWNER_ROLES);
                }

                owners.remove(old_owner.clone());
                owners.set(new_owner.clone(), weight);
                let key = owners_key();
                env.storage().persistent().set(&key, &owners);
                bump_persistent(&env, &key);

                update_owner_roles(&env, old_owner, &Vec::new(&env));
                update_owner_roles(&env, new_owner, &roles);
                remove_delegations_touching(&env, old_owner);
                purge_owner_approvals(&env, old_owner)?;

                env.events().publish(
                    (symbol_short!("rot_own"),),
                    OwnerRotatedEvent {
                        version: EVENT_SCHEMA_VERSION,
                        old_owner: old_owner.clone(),
                        new_owner: new_owner.clone(),
                        weight,
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
                        version: EVENT_SCHEMA_VERSION,
                        previous_threshold: old_threshold,
                        new_threshold: *new_threshold,
                    },
                );
            }
            ProposalKind::SetSpendingLimitWindow(owner, token, limit, window_secs) => {
                let prev_limit = read_spending_limit(&env, owner, token);
                write_spending_limit(&env, owner, token, *limit);
                write_spending_window(&env, owner, token, *window_secs);
                upsert_owner_spending_limit(&env, owner, token, *limit);
                let now = env.ledger().timestamp();
                write_spent_tracker(&env, owner, token, &SpentTracker { spent: 0, epoch: now });
                env.events().publish(
                    (symbol_short!("s_lim"),),
                    SetSpendingLimitExecutedEvent {
                        version: EVENT_SCHEMA_VERSION,
                        owner: owner.clone(),
                        token: token.clone(),
                        previous_limit: prev_limit,
                        new_limit: *limit,
                    },
                );
            }
            ProposalKind::SetSpendingLimit(owner, token, limit) => {
                validate_asset_registry(&env, token)?;
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
                        version: EVENT_SCHEMA_VERSION,
                        owner: owner.clone(),
                        token: token.clone(),
                        previous_limit: prev_limit,
                        new_limit: *limit,
                    },
                );
            }
            ProposalKind::SetTreasurySpendingLimit(token, limit, window_secs) => {
                validate_asset_registry(&env, token)?;
                if *limit < 0 {
                    return Err(ContractError::InvalidSpendingLimit);
                }
                let actual_window = if *window_secs == 0 {
                    SPENDING_WINDOW
                } else {
                    if *window_secs < MIN_SPENDING_WINDOW || *window_secs > MAX_SPENDING_WINDOW {
                        return Err(ContractError::InvalidInterval);
                    }
                    *window_secs
                };
                let prev_limit = read_treasury_spending_limit(&env, token);
                write_treasury_spending_limit(&env, token, *limit);
                write_treasury_spending_window(&env, token, actual_window);
                let now = env.ledger().timestamp();
                write_treasury_spent_tracker(&env, token, &SpentTracker { spent: 0, epoch: now });
                env.events().publish(
                    (symbol_short!("tr_lim"),),
                    TreasurySpendingLimitExecutedEvent {
                        version: EVENT_SCHEMA_VERSION,
                        token: token.clone(),
                        previous_limit: prev_limit,
                        new_limit: *limit,
                        window_secs: actual_window,
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

                // Invariant (INV-02): threshold <= total weight. The active-proposal
                // scan below only sees quorum snapshots taken at creation, so a
                // threshold raised after this proposal was created must be checked
                // against the live value.
                if new_total < read_threshold(&env)? {
                    return Err(ContractError::WouldBreakThreshold);
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
                        version: EVENT_SCHEMA_VERSION,
                        owner: target_owner.clone(),
                        old_weight,
                        new_weight: *new_weight,
                        new_total_weight: new_total,
                    },
                );
            }
            ProposalKind::CreateRecurringPayment(params) => {
                validate_token(&env, &params.token)?;
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
                    periods_disbursed: 0,
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
                        version: EVENT_SCHEMA_VERSION,
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

                if schedule.status == RecurringStatus::Active
                    || schedule.status == RecurringStatus::Paused
                {
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
                        version: EVENT_SCHEMA_VERSION,
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
                        version: EVENT_SCHEMA_VERSION,
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
                        version: EVENT_SCHEMA_VERSION,
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
                        version: EVENT_SCHEMA_VERSION,
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
            ProposalKind::GrantRole(target, role_sym) => {
                let role = symbol_to_role(&env, role_sym)?;
                if has_role(&env, target, &role) {
                    return Err(ContractError::RoleAlreadyGranted);
                }
                let before = read_owner_roles(&env, target);
                let mut roles = before.clone();
                roles.push_back(role.clone());
                update_owner_roles(&env, target, &roles);
                let after = read_owner_roles(&env, target);
                env.events().publish(
                    (Symbol::new(&env, "role_granted"),),
                    RoleGrantedEvent {
                        version: EVENT_SCHEMA_VERSION,
                        target: target.clone(),
                        role: role.clone(),
                        before,
                        after,
                    },
                );
            }
            ProposalKind::RevokeRole(target, role_sym) => {
                let role = symbol_to_role(&env, role_sym)?;
                if !has_role(&env, target, &role) {
                    return Err(ContractError::RoleNotGranted);
                }
                // Re-validate quorum-stranding at execute time: state may have
                // drifted since proposal creation (another revoke could have
                // already reduced approver weight).
                if role == Role::Approver {
                    let threshold = read_threshold(&env)?;
                    let remaining = remaining_approver_weight_after_revoke(&env, target)?;
                    if remaining < threshold {
                        return Err(ContractError::WouldBreakQuorum);
                    }
                }
                let before = read_owner_roles(&env, target);
                let mut next = Vec::new(&env);
                for r in before.iter() {
                    if r != role {
                        next.push_back(r);
                    }
                }
                update_owner_roles(&env, target, &next);
                let after = read_owner_roles(&env, target);
                env.events().publish(
                    (Symbol::new(&env, "role_revoked"),),
                    RoleRevokedEvent {
                        version: EVENT_SCHEMA_VERSION,
                        target: target.clone(),
                        role: role.clone(),
                        before,
                        after,
                    },
                );
            }
            ProposalKind::SetAssetRegistryEnabled(enabled) => {
                env.storage()
                    .instance()
                    .set(&asset_registry_enabled_key(), enabled);
                bump_instance(&env);
                env.events().publish(
                    (symbol_short!("ast_en"),),
                    AssetRegistryEnabledEvent { enabled: *enabled },
                );
            }
            ProposalKind::AddApprovedToken(token_address) => {
                validate_token_interface(&env, token_address)?;
                if token_is_approved(&env, token_address) {
                    return Err(ContractError::AssetRegistryState);
                }
                write_token_approved(&env, token_address, true);
                env.events().publish(
                    (symbol_short!("ast_tok"),),
                    ApprovedTokenChangedEvent {
                        token: token_address.clone(),
                        approved: true,
                    },
                );
            }
            ProposalKind::RemoveApprovedToken(token_address) => {
                if !token_is_approved(&env, token_address) {
                    return Err(ContractError::AssetRegistryState);
                }
                write_token_approved(&env, token_address, false);
                env.events().publish(
                    (symbol_short!("ast_tok"),),
                    ApprovedTokenChangedEvent {
                        token: token_address.clone(),
                        approved: false,
                    },
                );
            }
            ProposalKind::TransferGuardian(new_guardian) => {
                write_guardian(&env, new_guardian);
                env.events().publish(
                    (symbol_short!("guard_set"),),
                    GuardianSetEvent {
                        guardian: new_guardian.clone(),
                        version: EVENT_SCHEMA_VERSION,
                    },
                );
            }
            ProposalKind::CreateEscrow(params) => {
                validate_token(&env, &params.token)?;
                require_asset_not_frozen(&env, &params.token)?;
                if params.recipient == env.current_contract_address() {
                    return Err(ContractError::InvalidRecipient);
                }
                let release_at = match &params.release_mode {
                    EscrowReleaseMode::OwnerQuorumUntil(timestamp)
                    | EscrowReleaseMode::Deadline(timestamp) => *timestamp,
                };
                if release_at <= env.ledger().timestamp() {
                    return Err(ContractError::InvalidDeadline);
                }
                if params.amount < MIN_AMOUNT {
                    return Err(ContractError::InvalidAmount);
                }
                let reserved = read_reserved_balance(&env, &params.token);
                let new_reserved = reserved
                    .checked_add(params.amount)
                    .ok_or(ContractError::ArithmeticError)?;
                if available_balance(&env, &params.token)? < params.amount {
                    return Err(ContractError::EscrowFundsUnavailable);
                }

                let id = read_next_escrow_id(&env);
                write_next_escrow_id(
                    &env,
                    id.checked_add(1).ok_or(ContractError::ArithmeticError)?,
                );
                write_escrow(
                    &env,
                    &EscrowRecord {
                        id,
                        recipient: params.recipient.clone(),
                        token: params.token.clone(),
                        amount: params.amount,
                        release_mode: params.release_mode.clone(),
                    },
                );
                write_reserved_balance(&env, &params.token, new_reserved);
                env.events().publish(
                    (symbol_short!("esc_crt"),),
                    EscrowCreatedEvent {
                        id,
                        recipient: params.recipient.clone(),
                        token: params.token.clone(),
                        amount: params.amount,
                        release_mode: params.release_mode.clone(),
                    },
                );
            }
            ProposalKind::DexSwap(params) => {
                // ── Pre-execution guards ──────────────────────────────────
                // 1. Swap deadline: reject stale approvals that passed their
                //    execution window.
                let now = env.ledger().timestamp();
                if now > params.swap_deadline {
                    return Err(ContractError::InvalidSwapDeadline);
                }

                // 2. Router must still be in the approved registry.
                if !dex_router_is_approved(&env, &params.router) {
                    return Err(ContractError::Unauthorized);
                }

                // 3. All tokens in path must pass the asset registry check.
                validate_swap_path(&env, &params.path)?;

                // 4. Treasury must hold at least send_amount of path[0].
                let send_token = params.path.get(0).ok_or(ContractError::InvalidSwapPath)?;
                require_asset_outflow_allowed(&env, &send_token)?;
                if available_balance(&env, &send_token)? < params.send_amount {
                    return Err(ContractError::TransferFailed);
                }

                // ── Approve the router to pull send_amount ────────────────
                // The multisig contract is the token owner; approve the
                // router up to `send_amount` for exactly the next ledger so
                // the allowance cannot be re-used after this transaction.
                token::Client::new(&env, &send_token).approve(
                    &env.current_contract_address(),
                    &params.router,
                    &params.send_amount,
                    &(env.ledger().sequence() + 1),
                );

                // ── Cross-contract swap call ──────────────────────────────
                let destination = params
                    .destination
                    .clone()
                    .unwrap_or_else(|| env.current_contract_address());

                let mut swap_args = Vec::new(&env);
                swap_args.push_back(params.send_amount.into_val(&env));
                swap_args.push_back(params.min_recv.into_val(&env));
                swap_args.push_back(params.path.clone().into_val(&env));
                swap_args.push_back(destination.clone().into_val(&env));
                swap_args.push_back(params.swap_deadline.into_val(&env));

                // `invoke_contract` traps on any error from the callee,
                // which reverts this entire invocation. The `try_invoke_contract`
                // variant returns Err instead of trapping.
                let amounts: Vec<i128> = env
                    .try_invoke_contract::<Vec<i128>, soroban_sdk::Error>(
                        &params.router,
                        &Symbol::new(&env, "swap_exact_tokens_for_tokens"),
                        swap_args,
                    )
                    .map_err(|_| ContractError::SwapFailed)?
                    .map_err(|_| ContractError::SwapFailed)?;

                let recv_amount: i128 = amounts.last().unwrap_or(0);

                // Belt-and-suspenders slippage guard. The router should have
                // already failed if output < min_recv, but we re-check so
                // our event only reflects a valid execution.
                if recv_amount < params.min_recv {
                    return Err(ContractError::SlippageExceeded);
                }

                env.events().publish(
                    (symbol_short!("dex_swap"),),
                    DexSwapExecutedEvent {
                        version: EVENT_SCHEMA_VERSION,
                        proposal_id,
                        executor: executor.clone(),
                        router: params.router.clone(),
                        path: params.path.clone(),
                        send_amount: params.send_amount,
                        min_recv: params.min_recv,
                        recv_amount,
                        destination,
                    },
                );
            }
            ProposalKind::AddDexRouter(router) => {
                if dex_router_is_approved(&env, router) {
                    return Err(ContractError::AssetRegistryState);
                }
                write_dex_router_approved(&env, router, true);
                env.events().publish(
                    (symbol_short!("dex_rtr"),),
                    DexRouterChangedEvent {
                        version: EVENT_SCHEMA_VERSION,
                        router: router.clone(),
                        approved: true,
                    },
                );
            }
            ProposalKind::RemoveDexRouter(router) => {
                if !dex_router_is_approved(&env, router) {
                    return Err(ContractError::AssetRegistryState);
                }
                write_dex_router_approved(&env, router, false);
                env.events().publish(
                    (symbol_short!("dex_rtr"),),
                    DexRouterChangedEvent {
                        version: EVENT_SCHEMA_VERSION,
                        router: router.clone(),
                        approved: false,
                    },
                );
            }
            ProposalKind::AddYieldVenue(venue) => {
                if yield_venue_is_approved(&env, venue) {
                    return Err(ContractError::AssetRegistryState);
                }
                write_yield_venue_approved(&env, venue, true);
                env.events().publish(
                    (symbol_short!("y_venue"),),
                    YieldVenueChangedEvent {
                        version: EVENT_SCHEMA_VERSION,
                        venue: venue.clone(),
                        approved: true,
                    },
                );
            }
            ProposalKind::RemoveYieldVenue(venue) => {
                if !yield_venue_is_approved(&env, venue) {
                    return Err(ContractError::AssetRegistryState);
                }
                write_yield_venue_approved(&env, venue, false);
                env.events().publish(
                    (symbol_short!("y_venue"),),
                    YieldVenueChangedEvent {
                        version: EVENT_SCHEMA_VERSION,
                        venue: venue.clone(),
                        approved: false,
                    },
                );
            }
            ProposalKind::YieldDeposit(params) => {
                // ── Pre-execution guards ─────────────────────────────────
                if !yield_venue_is_approved(&env, &params.venue) {
                    return Err(ContractError::YieldVenueNotApproved);
                }
                validate_token(&env, &params.token)?;
                require_asset_outflow_allowed(&env, &params.token)?;
                if read_yield_position(&env, params.position_id).is_some() {
                    return Err(ContractError::YieldPositionAlreadyOpen);
                }
                if available_balance(&env, &params.token)? < params.amount {
                    return Err(ContractError::TransferFailed);
                }

                // ── Approve the venue for one ledger ─────────────────────
                token::Client::new(&env, &params.token).approve(
                    &env.current_contract_address(),
                    &params.venue,
                    &params.amount,
                    &(env.ledger().sequence() + 1),
                );

                // ── Cross-contract deposit call ──────────────────────────
                let (func_name, deposit_args) = match params.kind {
                    YieldVenueKind::Blend => {
                        // Blend: supply(from, spender, asset, amount)
                        let mut args = Vec::new(&env);
                        args.push_back(env.current_contract_address().into_val(&env));
                        args.push_back(env.current_contract_address().into_val(&env));
                        args.push_back(params.token.clone().into_val(&env));
                        args.push_back(params.amount.into_val(&env));
                        (Symbol::new(&env, "supply"), args)
                    }
                    YieldVenueKind::Soroswap => {
                        // Soroswap: add_liquidity expects two tokens; for a
                        // single-sided deposit we pass the same token twice.
                        let mut args = Vec::new(&env);
                        args.push_back(params.token.clone().into_val(&env));
                        args.push_back(params.token.clone().into_val(&env));
                        args.push_back(params.amount.into_val(&env));
                        args.push_back(params.amount.into_val(&env));
                        args.push_back(params.min_return.into_val(&env));
                        args.push_back(params.min_return.into_val(&env));
                        args.push_back(env.current_contract_address().into_val(&env));
                        args.push_back(env.ledger().timestamp().into_val(&env));
                        (Symbol::new(&env, "add_liquidity"), args)
                    }
                    YieldVenueKind::Generic => {
                        // Generic: deposit(token, amount)
                        let mut args = Vec::new(&env);
                        args.push_back(params.token.clone().into_val(&env));
                        args.push_back(params.amount.into_val(&env));
                        (Symbol::new(&env, "deposit"), args)
                    }
                };

                env.try_invoke_contract::<(), soroban_sdk::Error>(
                    &params.venue,
                    &func_name,
                    deposit_args,
                )
                .map_err(|_| ContractError::YieldVenueFailed)?
                .map_err(|_| ContractError::YieldVenueFailed)?;

                // ── Record the open position ─────────────────────────────
                let now = env.ledger().timestamp();
                write_yield_position(
                    &env,
                    &YieldPosition {
                        id: params.position_id,
                        venue: params.venue.clone(),
                        token: params.token.clone(),
                        deposited: params.amount,
                        opened_at: now,
                        kind: params.kind.clone(),
                    },
                );

                env.events().publish(
                    (symbol_short!("y_dep"),),
                    YieldDepositedEvent {
                        version: EVENT_SCHEMA_VERSION,
                        proposal_id,
                        executor: executor.clone(),
                        venue: params.venue.clone(),
                        token: params.token.clone(),
                        amount: params.amount,
                        position_id: params.position_id,
                        kind: params.kind.clone(),
                    },
                );
            }
            ProposalKind::YieldWithdraw(params) => {
                // ── Pre-execution guards ─────────────────────────────────
                if !yield_venue_is_approved(&env, &params.venue) {
                    return Err(ContractError::YieldVenueNotApproved);
                }
                validate_token(&env, &params.token)?;

                let position = read_yield_position(&env, params.position_id)
                    .ok_or(ContractError::YieldPositionNotFound)?;

                // The venue and token in the withdraw proposal must match the
                // recorded position to prevent misrouted withdrawals.
                if position.venue != params.venue || position.token != params.token {
                    return Err(ContractError::Unauthorized);
                }

                // ── Balance snapshot before withdrawal ───────────────────
                let balance_before = token::Client::new(&env, &params.token)
                    .try_balance(&env.current_contract_address())
                    .map_err(|_| ContractError::YieldVenueFailed)?
                    .map_err(|_| ContractError::YieldVenueFailed)?;

                // ── Cross-contract withdrawal call ───────────────────────
                let (func_name, withdraw_args) = match params.kind {
                    YieldVenueKind::Blend => {
                        // Blend: withdraw(from, spender, asset, amount)
                        let mut args = Vec::new(&env);
                        args.push_back(env.current_contract_address().into_val(&env));
                        args.push_back(env.current_contract_address().into_val(&env));
                        args.push_back(params.token.clone().into_val(&env));
                        args.push_back(params.amount.into_val(&env));
                        (Symbol::new(&env, "withdraw"), args)
                    }
                    YieldVenueKind::Soroswap => {
                        // Soroswap: remove_liquidity(token_a, token_b, lp_amount,
                        //   min_a, min_b, to, deadline)
                        let mut args = Vec::new(&env);
                        args.push_back(params.token.clone().into_val(&env));
                        args.push_back(params.token.clone().into_val(&env));
                        args.push_back(params.amount.into_val(&env));
                        args.push_back(params.min_return.into_val(&env));
                        args.push_back(params.min_return.into_val(&env));
                        args.push_back(env.current_contract_address().into_val(&env));
                        args.push_back(env.ledger().timestamp().into_val(&env));
                        (Symbol::new(&env, "remove_liquidity"), args)
                    }
                    YieldVenueKind::Generic => {
                        // Generic: withdraw(token, amount)
                        let mut args = Vec::new(&env);
                        args.push_back(params.token.clone().into_val(&env));
                        args.push_back(params.amount.into_val(&env));
                        (Symbol::new(&env, "withdraw"), args)
                    }
                };

                env.try_invoke_contract::<(), soroban_sdk::Error>(
                    &params.venue,
                    &func_name,
                    withdraw_args,
                )
                .map_err(|_| ContractError::YieldVenueFailed)?
                .map_err(|_| ContractError::YieldVenueFailed)?;

                // ── Slippage guard: measure tokens returned ──────────────
                let balance_after = token::Client::new(&env, &params.token)
                    .try_balance(&env.current_contract_address())
                    .map_err(|_| ContractError::YieldVenueFailed)?
                    .map_err(|_| ContractError::YieldVenueFailed)?;

                let recv_amount = balance_after
                    .checked_sub(balance_before)
                    .unwrap_or(0)
                    .max(0);

                if recv_amount < params.min_return {
                    return Err(ContractError::YieldReturnBelowMinimum);
                }

                // ── Close the position record ────────────────────────────
                remove_yield_position(&env, params.position_id);

                env.events().publish(
                    (symbol_short!("y_wdraw"),),
                    YieldWithdrawnEvent {
                        version: EVENT_SCHEMA_VERSION,
                        proposal_id,
                        executor: executor.clone(),
                        venue: params.venue.clone(),
                        token: params.token.clone(),
                        amount: params.amount,
                        recv_amount,
                        position_id: params.position_id,
                    },
                );
            }
            ProposalKind::CreatePullPayment(params) => {
                // ── Validation ───────────────────────────────────────────
                validate_token(&env, &params.token)?;
                if params.amount < MIN_AMOUNT {
                    return Err(ContractError::InvalidAmount);
                }
                if params.claimant == env.current_contract_address() {
                    return Err(ContractError::InvalidRecipient);
                }
                let now = env.ledger().timestamp();
                if params.expires_at <= now {
                    return Err(ContractError::InvalidDeadline);
                }
                if available_balance(&env, &params.token)? < params.amount {
                    return Err(ContractError::TransferFailed);
                }

                // ── Open the request ─────────────────────────────────────
                let request_id = read_next_pull_payment_id(&env);
                write_next_pull_payment_id(
                    &env,
                    request_id.checked_add(1).ok_or(ContractError::ArithmeticError)?,
                );

                write_pull_payment(
                    &env,
                    &PullPaymentRequest {
                        id: request_id,
                        proposer: proposal.proposer.clone(),
                        claimant: params.claimant.clone(),
                        token: params.token.clone(),
                        amount: params.amount,
                        expires_at: params.expires_at,
                        status: PullPaymentStatus::Open,
                        memo: params.memo.clone(),
                    },
                );

                env.events().publish(
                    (symbol_short!("pr_open"),),
                    PullPaymentOpenedEvent {
                        version: EVENT_SCHEMA_VERSION,
                        request_id,
                        proposer: proposal.proposer.clone(),
                        claimant: params.claimant.clone(),
                        token: params.token.clone(),
                        amount: params.amount,
                        expires_at: params.expires_at,
                    },
                );
            }
            ProposalKind::CancelPullPayment(request_id) => {
                let mut req = read_pull_payment(&env, *request_id)
                    .ok_or(ContractError::PullPaymentNotFound)?;

                let status = derive_pull_payment_status(&env, &req);
                if !matches!(status, PullPaymentStatus::Open) {
                    return Err(ContractError::PullPaymentNotOpen);
                }

                req.status = PullPaymentStatus::Cancelled;
                write_pull_payment(&env, &req);

                env.events().publish(
                    (symbol_short!("pr_cncl"),),
                    PullPaymentCancelledEvent {
                        version: EVENT_SCHEMA_VERSION,
                        request_id: *request_id,
                        executor: executor.clone(),
                    },
                );
            }
            ProposalKind::SetSpendPolicy(policy) => {
                validate_spend_policy(policy)?;
                write_spend_policy(&env, policy);

                // Reset all trackers for this (owner, token) pair when a new
                // policy is set, so the epoch starts fresh.
                for i in 0..policy.limits.len() {
                    let limit_entry = policy.limits.get(i).unwrap();
                    let now = env.ledger().timestamp();
                    write_spend_policy_tracker(
                        &env,
                        &policy.owner,
                        &policy.token,
                        &limit_entry.window,
                        &SpentTracker { spent: 0, epoch: now },
                    );
                }

                env.events().publish(
                    (symbol_short!("sp_set"),),
                    SpendPolicySetEvent {
                        version: EVENT_SCHEMA_VERSION,
                        owner: policy.owner.clone(),
                        token: policy.token.clone(),
                        limits: policy.limits.clone(),
                    },
                );
            }
            ProposalKind::ClearSpendPolicy(owner, token) => {
                remove_spend_policy(&env, owner, token);

                // Also remove any per-window trackers.
                for window in [
                    SpendWindowKind::Daily,
                    SpendWindowKind::Weekly,
                    SpendWindowKind::Monthly,
                ] {
                    let key = spend_policy_tracker_key(owner, token, &window);
                    env.storage().persistent().remove(&key);
                }

                env.events().publish(
                    (symbol_short!("sp_clr"),),
                    SpendPolicyClearedEvent {
                        version: EVENT_SCHEMA_VERSION,
                        owner: owner.clone(),
                        token: token.clone(),
                    },
                );
            }
            // ── #954: Oracle price guard execute arms ──
            ProposalKind::SetOraclePrice(oracle) => {
                if oracle.price <= 0 {
                    return Err(ContractError::OraclePriceInvalid);
                }
                let now = env.ledger().timestamp();
                let mut oracle = oracle.clone();
                oracle.updated_at = now;
                write_oracle_price(&env, &oracle);
                env.events().publish(
                    (symbol_short!("ora_set"),),
                    OraclePriceSetEvent {
                        version: EVENT_SCHEMA_VERSION,
                        token: oracle.token.clone(),
                        fiat: oracle.fiat.clone(),
                        price: oracle.price,
                        updated_at: now,
                        max_staleness: oracle.max_staleness,
                    },
                );
            }
            ProposalKind::ClearOraclePrice(token, fiat) => {
                remove_oracle_price(&env, token, fiat);
            }
            ProposalKind::SetFiatSpendLimit(limit) => {
                if limit.fiat_limit < MIN_AMOUNT {
                    return Err(ContractError::InvalidAmount);
                }
                if limit.window_secs < MIN_SPENDING_WINDOW || limit.window_secs > MAX_SPENDING_WINDOW {
                    return Err(ContractError::InvalidDuration);
                }
                write_fiat_spend_limit(&env, limit);
                // Reset the fiat spent tracker.
                let now = env.ledger().timestamp();
                write_fiat_spent_tracker(
                    &env, &limit.owner, &limit.token, &limit.fiat,
                    &SpentTracker { spent: 0, epoch: now },
                );
                env.events().publish(
                    (symbol_short!("fiat_set"),),
                    FiatSpendLimitSetEvent {
                        version: EVENT_SCHEMA_VERSION,
                        owner: limit.owner.clone(),
                        token: limit.token.clone(),
                        fiat: limit.fiat.clone(),
                        fiat_limit: limit.fiat_limit,
                        window_secs: limit.window_secs,
                    },
                );
            }
            ProposalKind::ClearFiatSpendLimit(owner, token, fiat) => {
                remove_fiat_spend_limit(&env, owner, token, fiat);
            }
            // ── #955: Denylist execute arms ──
            ProposalKind::AddToDenylist(address) => {
                write_denied(&env, address, true);
                write_denylist_enabled(&env, true);
                env.events().publish(
                    (symbol_short!("deny_ch"),),
                    DenylistChangedEvent {
                        version: EVENT_SCHEMA_VERSION,
                        address: address.clone(),
                        denied: true,
                    },
                );
            }
            ProposalKind::RemoveFromDenylist(address) => {
                write_denied(&env, address, false);
                env.events().publish(
                    (symbol_short!("deny_ch"),),
                    DenylistChangedEvent {
                        version: EVENT_SCHEMA_VERSION,
                        address: address.clone(),
                        denied: false,
                    },
                );
            }
            // ── #953: Cross-asset rebalancing execute arm ──
            ProposalKind::Rebalance(params) => {
                validate_rebalance_params(params)?;
                if !dex_router_is_approved(&env, &params.router) {
                    return Err(ContractError::RebalanceRouterNotApproved);
                }
                // Validate all target tokens.
                for i in 0..params.targets.len() {
                    let target = params.targets.get(i).unwrap();
                    validate_token(&env, &target.token)?;
                }
                let now = env.ledger().timestamp();
                if now > params.swap_deadline {
                    return Err(ContractError::InvalidSwapDeadline);
                }

                // For each target token, check if the treasury's current
                // balance is below the target weight. If so, we would swap
                // excess tokens from other assets into this one. The actual
                // swap execution is delegated to the DEX router via
                // cross-contract calls (same pattern as DexSwap).
                //
                // In this implementation, the rebalance proposal records
                // the target weights and emits an event so off-chain
                // indexers can compose the individual swap steps. The
                // on-chain execution performs the validation and records
                // the rebalance timestamp. Individual swaps are executed
                // as separate DexSwap proposals.
                write_last_rebalance(&env, now);

                env.events().publish(
                    (symbol_short!("reb_exec"),),
                    RebalanceExecutedEvent {
                        version: EVENT_SCHEMA_VERSION,
                        proposal_id,
                        executor: executor.clone(),
                        targets: params.targets.clone(),
                    },
                );
            }
        }

        proposal.status = ProposalStatus::Executed;
        write_proposal(&env, &proposal);

        remove_active_proposal(&env, proposal_id);

        env.events().publish(
            (symbol_short!("executed"),),
            ProposalExecutedEvent {
                version: EVENT_SCHEMA_VERSION,
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
    /// The caller must hold the Executor role; it need not be an owner.
    ///
    /// Returns the number of proposals actually swept.
    pub fn cancel_expired(env: Env, caller: Address, ids: Vec<u64>) -> Result<u32, ContractError> {
        caller.require_auth();
        require_role(&env, &caller, Role::Executor)?;

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

    /// Permissionlessly sweeps the supplied IDs that have expired. Repeated IDs,
    /// missing proposals, and proposals in any other state are ignored.
    pub fn sweep_expired(env: Env, caller: Address, ids: Vec<u64>) -> Result<u32, ContractError> {
        caller.require_auth();

        // Idempotency: a proposal that has already left the active set (a
        // previous sweep, execution, or cancellation) must not be counted — or
        // removed — again. Without this guard an expiry that was already
        // swept still derives to Expired and would be reported on every call.
        let active_ids = read_active_ids(&env);
        let mut swept_ids = Vec::new(&env);
        for id in ids.iter() {
            if swept_ids.contains(&id) {
                continue;
            }
            if !active_ids.contains(&id) {
                continue;
            }
            let proposal = match read_proposal(&env, id) {
                Ok(proposal) => proposal,
                Err(ContractError::ProposalNotFound) => continue,
                Err(error) => return Err(error),
            };
            if matches!(derive_status(&env, &proposal), ProposalStatus::Expired) {
                swept_ids.push_back(id);
            }
        }

        let swept = swept_ids.len();
        if swept > 0 {
            remove_active_proposals(&env, &swept_ids);
        }
        env.events().publish(
            (symbol_short!("exp_sw"),),
            ExpiredProposalsSweptEvent { swept },
        );
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
        // A non-owner holding the Proposer role may draft schedules; owner
        // proposers keep their owner-keyed spending limits (checked below).
        let proposer_is_owner = read_owners_map(&env)?.contains_key(proposer.clone());
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;

        if amount < MIN_AMOUNT {
            return Err(ContractError::InvalidAmount);
        }
        if !(MIN_INTERVAL_SECS..=MAX_INTERVAL_SECS).contains(&interval_secs) {
            return Err(ContractError::InvalidInterval);
        }
        if matches!(&kind, RecurringKind::ContinuousStream)
            && (end_time <= start_time || cliff_time > end_time)
        {
            return Err(ContractError::InvalidSchedule);
        }
        if matches!(&kind, RecurringKind::ContinuousStream) && total_cap < 0 {
            return Err(ContractError::InvalidCap);
        }
        let committed_amount = if matches!(&kind, RecurringKind::ContinuousStream) {
            let duration = end_time
                .checked_sub(start_time)
                .ok_or(ContractError::InvalidSchedule)?;
            let duration =
                i128::try_from(duration).map_err(|_| ContractError::ArithmeticError)?;
            if total_cap > 0 && duration > total_cap / amount {
                total_cap
            } else {
                amount
                    .checked_mul(duration)
                    .ok_or(ContractError::ArithmeticError)?
            }
        } else {
            amount
        };
        if recipient == env.current_contract_address() {
            return Err(ContractError::InvalidRecipient);
        }
        validate_token(&env, &token)?;
        validate_description(&description)?;
        validate_deadline(&env, deadline)?;

        if read_active_recurring_count(&env) >= MAX_ACTIVE_RECURRING {
            return Err(ContractError::TooManyActiveRecurring);
        }

        let threshold = read_threshold(&env)?;
        let id = read_next_id(&env);

        if proposer_is_owner {
            if let Some(limit) = read_spending_limit(&env, &proposer, &token) {
                let already_spent = effective_spent(&env, &proposer, &token);
                let cumulative = committed_amount
                    .checked_add(already_spent)
                    .ok_or(ContractError::ArithmeticError)?;
                if cumulative > limit {
                    return Err(ContractError::SpendingLimitExceeded);
                }
            }
        }

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
            attachment_hash: None,
        };
        write_proposal(&env, &proposal);
        register_active_proposal(&env, id)?;

        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

        let total_weight = read_total_weight(&env);
        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                version: EVENT_SCHEMA_VERSION,
                id,
                proposer,
                threshold,
                category,
                transfers: Vec::new(&env),
                quorum_weight: threshold,
                total_weight_at_creation: total_weight,
                attachment_hash: None,
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
        require_role(&env, &proposer, Role::Proposer)?;
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
            attachment_hash: None,
        };
        write_proposal(&env, &proposal);
        register_active_proposal(&env, id)?;

        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

        let total_weight = read_total_weight(&env);
        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                version: EVENT_SCHEMA_VERSION,
                id,
                proposer,
                threshold,
                category: ProposalCategory::Ops,
                transfers: Vec::new(&env),
                quorum_weight: threshold,
                total_weight_at_creation: total_weight,
                attachment_hash: None,
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
        require_role(&env, &proposer, Role::Proposer)?;
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
            attachment_hash: None,
        };
        write_proposal(&env, &proposal);
        register_active_proposal(&env, id)?;

        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

        let total_weight = read_total_weight(&env);
        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                version: EVENT_SCHEMA_VERSION,
                id,
                proposer,
                threshold,
                category: ProposalCategory::Ops,
                transfers: Vec::new(&env),
                quorum_weight: threshold,
                total_weight_at_creation: total_weight,
                attachment_hash: None,
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
        require_role(&env, &proposer, Role::Proposer)?;
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
            attachment_hash: None,
        };
        write_proposal(&env, &proposal);
        register_active_proposal(&env, id)?;

        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

        let total_weight = read_total_weight(&env);
        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                version: EVENT_SCHEMA_VERSION,
                id,
                proposer,
                threshold,
                category: ProposalCategory::Ops,
                transfers: Vec::new(&env),
                quorum_weight: threshold,
                total_weight_at_creation: total_weight,
                attachment_hash: None,
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
        require_role(&env, &proposer, Role::Proposer)?;
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
            attachment_hash: None,
        };
        write_proposal(&env, &proposal);
        register_active_proposal(&env, id)?;

        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

        let total_weight = read_total_weight(&env);
        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                version: EVENT_SCHEMA_VERSION,
                id,
                proposer,
                threshold,
                category: ProposalCategory::Ops,
                transfers: Vec::new(&env),
                quorum_weight: threshold,
                total_weight_at_creation: total_weight,
                attachment_hash: None,
            },
        );

        Ok(id)
    }

    /// Creates a proposal to grant a role to a target address.
    ///
    /// Guard: if the target already holds the role, returns `RoleAlreadyGranted`.
    /// The role argument is a Symbol accepting "Proposer"/"CreateProposal",
    /// "Approver"/"ApproveProposal", "Executor"/"ExecuteProposal".
    pub fn create_grant_role_proposal(
        env: Env,
        proposer: Address,
        target: Address,
        role: Symbol,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;

        let parsed = symbol_to_role(&env, &role)?;
        if has_role(&env, &target, &parsed) {
            return Err(ContractError::RoleAlreadyGranted);
        }

        validate_description(&description)?;
        // Inlined rather than using `validate_deadline` so the too-far case
        // reports `InvalidDuration`, matching every other proposal-creation
        // entrypoint (`create_change_threshold_proposal` and friends) and the
        // documented error table. `validate_deadline` collapses both cases into
        // `InvalidDeadline`.
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
            kind: ProposalKind::GrantRole(target.clone(), role.clone()),
            ready_at: 0,
            quorum_weight: threshold,
            category: ProposalCategory::Other,
            attachment_hash: None,
        };
        write_proposal(&env, &proposal);
        register_active_proposal(&env, id)?;

        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

        let total_weight = read_total_weight(&env);
        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                version: EVENT_SCHEMA_VERSION,
                id,
                proposer,
                threshold,
                category: ProposalCategory::Other,
                transfers: Vec::new(&env),
                quorum_weight: threshold,
                total_weight_at_creation: total_weight,
                attachment_hash: None,
            },
        );

        Ok(id)
    }

    /// Creates a proposal to revoke a role from a target address.
    ///
    /// # Quorum-safety guard
    /// Revoking `Approver` is rejected with `WouldBreakQuorum` if the combined
    /// weight of owners that would still hold `Approver` after the revoke would
    /// fall below the current threshold (quorum requirement). This mirrors the
    /// existing `WouldBreakThreshold`/`WouldBreakQuorum` guards for removing
    /// owners or changing thresholds, and prevents the multisig from stranding
    /// itself so no future proposal can reach quorum.
    ///
    /// For non-Approver roles or targets that do not hold Approver / are not
    /// owners, the check is a no-op (remaining weight equals current total
    /// approver weight).
    pub fn create_revoke_role_proposal(
        env: Env,
        proposer: Address,
        target: Address,
        role: Symbol,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;

        let parsed = symbol_to_role(&env, &role)?;
        if !has_role(&env, &target, &parsed) {
            return Err(ContractError::RoleNotGranted);
        }

        // Quorum-stranding guard: only applies to Approver revokes.
        if parsed == Role::Approver {
            let threshold = read_threshold(&env)?;
            let remaining = remaining_approver_weight_after_revoke(&env, &target)?;
            if remaining < threshold {
                return Err(ContractError::WouldBreakQuorum);
            }
        }

        validate_description(&description)?;
        // Mirrors `create_grant_role_proposal`: `InvalidDuration` for a
        // deadline beyond `MAX_PROPOSAL_DURATION`, matching the other
        // proposal-creation entrypoints and the documented error table.
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
            kind: ProposalKind::RevokeRole(target.clone(), role.clone()),
            ready_at: 0,
            quorum_weight: threshold,
            category: ProposalCategory::Other,
            attachment_hash: None,
        };
        write_proposal(&env, &proposal);
        register_active_proposal(&env, id)?;

        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

        let total_weight = read_total_weight(&env);
        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                version: EVENT_SCHEMA_VERSION,
                id,
                proposer,
                threshold,
                category: ProposalCategory::Other,
                transfers: Vec::new(&env),
                quorum_weight: threshold,
                total_weight_at_creation: total_weight,
                attachment_hash: None,
            },
        );

        Ok(id)
    }

    /// Returns a single recurring payment schedule by ID with a freshly derived status.
    pub fn get_recurring_payment(
        env: Env,
        schedule_id: u64,
    ) -> Result<RecurringPayment, ContractError> {
        let mut schedule = read_recurring_payment(&env, schedule_id)?;
        schedule.status = derive_recurring_status(&env, &schedule);
        Ok(schedule)
    }

    /// Returns the ledger timestamp of the next eligible disbursement for a schedule.
    pub fn get_next_disbursement_time(env: Env, schedule_id: u64) -> Result<u64, ContractError> {
        let schedule = read_recurring_payment(&env, schedule_id)?;
        let status = derive_recurring_status(&env, &schedule);

        if matches!(
            status,
            RecurringStatus::Completed | RecurringStatus::Cancelled
        ) {
            return Ok(0);
        }

        if schedule.last_disbursed_at > 0 {
            Ok(schedule
                .last_disbursed_at
                .saturating_add(schedule.interval_secs))
        } else {
            match schedule.kind {
                RecurringKind::ContinuousStream => {
                    if schedule.cliff_time > 0 {
                        Ok(schedule.cliff_time)
                    } else {
                        Ok(schedule.start_time)
                    }
                }
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
    pub fn get_recurring_payments_paged(
        env: Env,
        offset: u64,
        mut limit: u32,
    ) -> Vec<RecurringPayment> {
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

    /// Returns the addresses of owners who have currently recorded abstentions
    /// for `proposal_id`. An abstention is never included in the approver list.
    pub fn get_abstainers(env: Env, proposal_id: u64) -> Result<Vec<Address>, ContractError> {
        let owners = read_owners_map(&env)?;
        read_proposal(&env, proposal_id)?;

        let mut abstainers = Vec::new(&env);
        for owner in owners.keys().iter() {
            if read_abstention_weight(&env, proposal_id, &owner) > 0 {
                abstainers.push_back(owner);
            }
        }
        Ok(abstainers)
    }

    /// Returns the addresses of owners who have recorded non-binding soft
    /// approval for `proposal_id`. Soft supporters are never approvers and
    /// never alter quorum or binding approval weight.
    pub fn get_soft_approvers(env: Env, proposal_id: u64) -> Result<Vec<Address>, ContractError> {
        let owners = read_owners_map(&env)?;
        read_proposal(&env, proposal_id)?;

        let mut supporters = Vec::new(&env);
        for owner in owners.keys().iter() {
            if read_soft_approval_weight(&env, proposal_id, &owner) > 0 {
                supporters.push_back(owner);
            }
        }
        Ok(supporters)
    }

    /// Returns the contract version. Useful for frontends and upgrade scripts
    /// that need to know which version of the contract is deployed.
    pub fn get_version(_env: Env) -> u32 {
        CONTRACT_VERSION
    }

    /// Returns the on-chain storage-schema version for this deployment: `0` for
    /// a legacy contract deployed before schema versioning existed, otherwise
    /// the current `STORAGE_SCHEMA_VERSION`. The value is written by
    /// `initialize` and by the one-time migrations, and is bumped by any release
    /// that adds or changes storage keys. See `docs/ARCHITECTURE.md` §3
    /// (Storage Schema Versioning) for the per-version key list and upgrade path.
    pub fn get_storage_version(env: Env) -> u32 {
        read_storage_version(&env)
    }

    /// Returns the storage-schema versions this contract can read or migrate
    /// to. `0` denotes the pre-versioning legacy layout; the last entry is the
    /// current layout. See `docs/ARCHITECTURE.md` §3.
    pub fn get_supported_storage_versions(env: Env) -> Vec<u32> {
        Vec::from_slice(&env, &SUPPORTED_STORAGE_VERSIONS)
    }

    /// Returns whether `version` is in the contract's migration registry.
    pub fn is_storage_version_supported(_env: Env, version: u32) -> bool {
        SUPPORTED_STORAGE_VERSIONS.contains(&version)
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

    /// Returns the RBAC schema version, or zero for a legacy deployment.
    pub fn get_role_version(env: Env) -> u32 {
        read_role_version(&env)
    }

    /// Returns the set of roles held by `address`. An address holding no
    /// roles (including any non-owner) returns an empty list. Read-only: the
    /// entry is read without extending its TTL.
    pub fn get_roles(env: Env, address: Address) -> Vec<Role> {
        env.storage()
            .persistent()
            .get(&owner_roles_key(&address))
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Returns whether `address` holds `role`. Returns `false` for an address
    /// holding no roles or not holding the requested role. Read-only.
    pub fn has_role(env: Env, address: Address, role: Role) -> bool {
        Self::get_roles(env, address).contains(&role)
    }

    /// Returns every address holding `role`, read from the reverse role-member
    /// index. The result is capped at `MAX_ROLE_MEMBERS_RESULT` (20) entries;
    /// a role with no holders returns an empty list. Read-only.
    pub fn get_role_members(env: Env, role: Role) -> Vec<Address> {
        let members: Vec<Address> = env
            .storage()
            .persistent()
            .get(&role_members_key(&role))
            .unwrap_or_else(|| Vec::new(&env));
        if members.len() > MAX_ROLE_MEMBERS_RESULT {
            members.slice(0..MAX_ROLE_MEMBERS_RESULT)
        } else {
            members
        }
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

    /// Creates or replaces the caller's outgoing delegation.
    ///
    /// The delegate must be a current owner other than the delegator, the weight
    /// must be positive and no larger than the delegator's raw weight, and the
    /// expiry must be in the future. The receiving delegate may not hold more
    /// than the governance-configured share of total owner weight in incoming
    /// delegations after the replacement is applied.
    pub fn create_delegation(
        env: Env,
        delegator: Address,
        delegate: Address,
        weight: u32,
        expiry: u64,
    ) -> Result<(), ContractError> {
        delegator.require_auth();
        require_role(&env, &delegator, Role::Approver)?;
        let delegator_weight = require_owner_and_weight(&env, &delegator)?;
        require_not_frozen(&env)?;

        if delegate == delegator {
            return Err(ContractError::InvalidDelegationWeight);
        }
        require_owner_and_weight(&env, &delegate)?;
        if weight == 0 || weight > delegator_weight {
            return Err(ContractError::InvalidDelegationWeight);
        }
        let now = env.ledger().timestamp();
        if expiry <= now {
            return Err(ContractError::InvalidDelegationExpiry);
        }

        let old = read_delegation(&env, &delegator);
        if let Some(ref previous) = old {
            write_delegated_weight(
                &env,
                &previous.delegate,
                refresh_delegated_weight(&env, &previous.delegate)?.saturating_sub(previous.weight),
            );
        }

        let total_weight = read_total_weight(&env);
        let cap = delegation_weight_cap(&env, total_weight);
        let received = compute_received_delegated_weight_excluding(
            &env,
            &read_owners_map(&env)?,
            &delegate,
            Some(&delegator),
        )?;
        let incoming = checked_weight_add(received, weight)?;
        if incoming > cap {
            return Err(ContractError::DelegateWeightCapExceeded);
        }

        let delegation = Delegation {
            delegator: delegator.clone(),
            delegate: delegate.clone(),
            weight,
            expiry: Some(expiry),
        };
        write_delegation(&env, &delegation);
        write_delegated_weight(&env, &delegate, incoming);

        env.events().publish(
            (symbol_short!("delegadd"),),
            DelegationCreatedEvent {
                delegator,
                delegate,
                weight,
                expiry: Some(expiry),
                total_delegated_weight: incoming,
                cap,
                version: EVENT_SCHEMA_VERSION,
            },
        );
        Ok(())
    }

    /// Extends the expiry of an existing delegation without recreating it.
    pub fn renew_delegation(
        env: Env,
        delegator: Address,
        expiry: u64,
    ) -> Result<(), ContractError> {
        delegator.require_auth();
        require_role(&env, &delegator, Role::Approver)?;
        require_owner_and_weight(&env, &delegator)?;
        require_not_frozen(&env)?;

        let mut delegation =
            read_delegation(&env, &delegator).ok_or(ContractError::DelegationNotFound)?;
        let old_expiry = delegation.expiry;
        let now = env.ledger().timestamp();
        if expiry <= now || old_expiry.is_some_and(|old| expiry <= old) {
            return Err(ContractError::InvalidDelegationExpiry);
        }

        let total_weight = read_total_weight(&env);
        let cap = delegation_weight_cap(&env, total_weight);
        let received = compute_received_delegated_weight_excluding(
            &env,
            &read_owners_map(&env)?,
            &delegation.delegate,
            Some(&delegator),
        )?;
        let renewed = checked_weight_add(received, delegation.weight)?;
        if renewed > cap {
            return Err(ContractError::DelegateWeightCapExceeded);
        }

        delegation.expiry = Some(expiry);
        write_delegation(&env, &delegation);
        write_delegated_weight(&env, &delegation.delegate, renewed);

        env.events().publish(
            (symbol_short!("delegren"),),
            DelegationRenewedEvent {
                delegator,
                delegate: delegation.delegate,
                old_expiry,
                new_expiry: expiry,
                version: EVENT_SCHEMA_VERSION,
            },
        );
        Ok(())
    }

    /// Removes the caller's outgoing delegation.
    pub fn revoke_delegation(env: Env, delegator: Address) -> Result<(), ContractError> {
        delegator.require_auth();
        require_role(&env, &delegator, Role::Approver)?;
        require_owner_and_weight(&env, &delegator)?;
        require_not_frozen(&env)?;

        let delegation =
            read_delegation(&env, &delegator).ok_or(ContractError::DelegationNotFound)?;
        remove_delegation(&env, &delegator);
        let _ = refresh_delegated_weight(&env, &delegation.delegate);

        env.events().publish(
            (symbol_short!("delegrev"),),
            DelegationRevokedEvent {
                delegator,
                delegate: delegation.delegate,
                weight: delegation.weight,
                version: EVENT_SCHEMA_VERSION,
            },
        );
        Ok(())
    }

    /// Returns a single owner's outgoing delegation, including expired ones.
    pub fn get_delegation(env: Env, delegator: Address) -> Option<Delegation> {
        read_delegation(&env, &delegator)
    }

    /// Returns the amount of active incoming delegated weight.
    pub fn get_delegated_weight(env: Env, delegate: Address) -> u32 {
        read_owners_map(&env)
            .ok()
            .and_then(|owners| compute_received_delegated_weight(&env, &owners, &delegate).ok())
            .unwrap_or_else(|| read_delegated_weight(&env, &delegate))
    }

    /// Returns the absolute cap on incoming delegated weight for any owner.
    pub fn get_delegate_weight_cap(env: Env) -> u32 {
        delegation_weight_cap(&env, read_total_weight(&env))
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
        let raw_weight = owners
            .get(owner.clone())
            .ok_or(ContractError::OwnerNotFound)?;
        compute_effective_weight(&env, &owners, &owner, raw_weight)
    }

    /// Updates the maximum single-owner weight percentage (1..=50). The same
    /// weighted, distinct-owner quorum required for other sensitive operations
    /// authorizes this parameter change.
    /// Governance authority is intentionally owner-weight-gated, not role-gated;
    /// see the entrypoint gating matrix above.
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

    /// Returns the configured spending window in seconds, or the legacy
    /// 30-day default when no custom window is configured.
    pub fn get_spending_window(env: Env, owner: Address, token: Address) -> u64 {
        read_spending_window(&env, &owner, &token)
    }

    /// Returns the list of proposal IDs that `proposal_id` depends on.
    pub fn get_proposal_dependencies(env: Env, proposal_id: u64) -> Vec<u64> {
        read_proposal_dependencies(&env, proposal_id)
    }

    /// Checks whether all dependencies of `proposal_id` have executed.
    /// Returns `Ok(true)` if all dependencies are `Executed`.
    /// Returns `Ok(false)` if any dependency is pending or ready (not yet executed).
    /// Returns `Err(ContractError::DependencyCancelled)` if any dependency was cancelled.
    /// Returns `Err(ContractError::DependencyExpired)` if any dependency has expired.
    /// Returns `Err(ContractError::ProposalNotFound)` if any dependency does not exist.
    pub fn check_proposal_dependencies(env: Env, proposal_id: u64) -> Result<bool, ContractError> {
        read_proposal(&env, proposal_id)?;
        let deps = read_proposal_dependencies(&env, proposal_id);
        if deps.is_empty() {
            return Ok(true);
        }
        for dep_id in deps.iter() {
            let dep_prop = read_proposal(&env, dep_id)?;
            let status = if dep_prop.status == ProposalStatus::Executed
                || dep_prop.status == ProposalStatus::Cancelled
            {
                dep_prop.status
            } else {
                derive_status(&env, &dep_prop)
            };
            match status {
                ProposalStatus::Executed => {},
                ProposalStatus::Cancelled => return Err(ContractError::DependencyCancelled),
                ProposalStatus::Expired => return Err(ContractError::DependencyExpired),
                _ => return Ok(false),
            }
        }
        Ok(true)
    }

    /// Returns the treasury-wide spending limit for `token`, or `None` if unrestricted.
    pub fn get_treasury_spending_limit(env: Env, token: Address) -> Option<i128> {
        read_treasury_spending_limit(&env, &token)
    }

    /// Returns the rolling treasury spending window in seconds for `token`.
    pub fn get_treasury_spending_window(env: Env, token: Address) -> u64 {
        read_treasury_spending_window(&env, &token)
    }

    /// Returns the cumulative rolling amount spent from the treasury for `token` within its window.
    pub fn get_treasury_spent(env: Env, token: Address) -> i128 {
        effective_treasury_spent(&env, &token)
    }

    /// Returns the remaining available treasury spending limit for `token`.
    /// Returns `None` if unrestricted.
    pub fn get_treasury_available_limit(env: Env, token: Address) -> Option<i128> {
        let limit = read_treasury_spending_limit(&env, &token)?;
        let spent = effective_treasury_spent(&env, &token);
        Some(limit.saturating_sub(spent))
    }

    /// Returns a consolidated treasury accounting record for `token`.
    pub fn get_asset_treasury_accounting(env: Env, token: Address) -> AssetTreasuryAccounting {
        let limit = read_treasury_spending_limit(&env, &token);
        let spent = effective_treasury_spent(&env, &token);
        let tracker = read_treasury_spent_tracker(&env, &token);
        let window = read_treasury_spending_window(&env, &token);
        let total = read_treasury_total_spent(&env, &token);
        let available = limit.map(|l| l.saturating_sub(spent));
        AssetTreasuryAccounting {
            token,
            total_spent: total,
            window_spent: spent,
            spend_limit: limit,
            window_secs: window,
            epoch: tracker.epoch,
            available_limit: available,
        }
    }

    /// Returns the unreserved available treasury balance for `token`.
    pub fn get_treasury_balance(env: Env, token: Address) -> Result<i128, ContractError> {
        available_balance(&env, &token)
    }

    /// Upgrades the storage schema from version 1 (or 0) to version 2 (introducing
    /// proposal dependency graphs and per-asset treasury accounting and spend limits).
    /// Requires distinct registered owners whose combined weight reaches threshold.
    pub fn migrate_to_v2(env: Env, approvers: Vec<Address>) -> Result<(), ContractError> {
        if !is_initialized(&env) {
            return Err(ContractError::NotInitialized);
        }
        if read_storage_version(&env) >= 2 {
            return Err(ContractError::AlreadyMigrated);
        }
        require_weighted_approvers(&env, &approvers)?;
        write_storage_version(&env);
        env.events().publish(
            (symbol_short!("v2_migr"),),
            STORAGE_SCHEMA_VERSION,
        );
        Ok(())
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

    /// Returns whether `owner` has currently recorded an abstention.
    pub fn has_abstained(env: Env, proposal_id: u64, owner: Address) -> bool {
        read_abstention_weight(&env, proposal_id, &owner) > 0
    }

    /// Returns whether `owner` has currently recorded non-binding soft approval.
    pub fn has_soft_approved(env: Env, proposal_id: u64, owner: Address) -> bool {
        read_soft_approval_weight(&env, proposal_id, &owner) > 0
    }

    /// Returns the current approval progress for a proposal: the cumulative
    /// approval weight, the required quorum weight, and the total weight of
    /// all owners.
    pub fn get_proposal_approval_progress(
        env: Env,
        proposal_id: u64,
    ) -> Result<ProposalApprovalProgress, ContractError> {
        let proposal = read_proposal(&env, proposal_id)?;
        let (
            abstention_count,
            abstention_weight,
            participation_weight,
            soft_approval_count,
            soft_approval_weight,
        ) = participation_progress(&env, proposal_id)?;
        Ok(ProposalApprovalProgress {
            approval_weight: proposal.approvals,
            quorum_weight: proposal.quorum_weight,
            total_weight: read_total_weight(&env),
            abstention_count,
            abstention_weight,
            participation_weight,
            soft_approval_count,
            soft_approval_weight,
        })
    }

    /// Participation-oriented alias for `get_proposal_approval_progress`.
    /// Approval weight remains the source of quorum; abstention fields are
    /// informational participation records.
    pub fn get_participation_progress(
        env: Env,
        proposal_id: u64,
    ) -> Result<ProposalApprovalProgress, ContractError> {
        Self::get_proposal_approval_progress(env, proposal_id)
    }

    /// Registers the network-specific Stellar Asset Contract for a classic
    /// identifier such as `XLM`, `USDC`, or `EURC`.
    pub fn set_classic_asset(
        env: Env,
        approvers: Vec<Address>,
        identifier: Symbol,
        sac: Address,
    ) -> Result<(), ContractError> {
        require_weighted_approvers(&env, &approvers)?;
        validate_token(&env, &sac)?;
        env.storage().instance().set(&classic_asset_key(&identifier), &sac);
        bump_instance(&env);
        Ok(())
    }

    pub fn get_classic_asset(env: Env, identifier: Symbol) -> Option<Address> {
        env.storage().instance().get(&classic_asset_key(&identifier))
    }

    /// Creates a transfer proposal using raw token addresses or registered
    /// classic identifiers. Every reference is resolved and validated first.
    pub fn create_asset_proposal(
        env: Env,
        proposer: Address,
        transfers: Vec<AssetTransfer>,
        description: String,
        deadline: u64,
        category: ProposalCategory,
    ) -> Result<u64, ContractError> {
        let mut resolved = Vec::new(&env);
        for transfer in transfers.iter() {
            let token = resolve_asset(&env, &transfer.asset)?;
            resolved.push_back(Transfer {
                to: transfer.to,
                token,
                amount: transfer.amount,
            });
        }
        Self::create_proposal(env, proposer, resolved, description, deadline, category)
    }

    // ─── Guardian ─────────────────────────────────────────────────────────────

    // These governance entrypoints intentionally use owner-weight co-signatures,
    // not operational role checks. See the gating matrix above.

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
                version: EVENT_SCHEMA_VERSION,
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
            .publish((symbol_short!("frozen"),), FrozenEvent { guardian, version: EVENT_SCHEMA_VERSION });

        Ok(())
    }

    /// Freezes or unfreezes transfers of a single asset without touching the
    /// rest of the contract. Only the configured emergency guardian may call.
    pub fn freeze_asset(
        env: Env,
        guardian: Address,
        token: Address,
        frozen: bool,
    ) -> Result<(), ContractError> {
        guardian.require_auth();
        let stored = read_guardian(&env).ok_or(ContractError::NoGuardian)?;
        if stored != guardian {
            return Err(ContractError::Unauthorized);
        }
        validate_token_interface(&env, &token)?;

        let key = asset_freeze_key(&token);
        if frozen {
            env.storage().instance().set(&key, &true);
        } else {
            env.storage().instance().remove(&key);
        }
        bump_instance(&env);

        env.events().publish(
            (symbol_short!("sc_frz"),),
            ScopedFreezeChangedEvent {
                version: EVENT_SCHEMA_VERSION,
                scope: FreezeScope::Asset(token),
                frozen,
                guardian,
            },
        );
        Ok(())
    }

    /// Pauses or resumes every treasury outflow of a single asset. Governance,
    /// approvals, and unrelated assets remain available. Only the configured
    /// emergency guardian may call.
    pub fn set_asset_outflow_pause(
        env: Env,
        guardian: Address,
        token: Address,
        paused: bool,
    ) -> Result<(), ContractError> {
        guardian.require_auth();
        let stored = read_guardian(&env).ok_or(ContractError::NoGuardian)?;
        if stored != guardian {
            return Err(ContractError::Unauthorized);
        }
        validate_token_interface(&env, &token)?;

        write_asset_outflow_pause(&env, &token, paused);

        env.events().publish(
            (Symbol::new(&env, "asset_outflow_pause"),),
            AssetOutflowPauseChangedEvent {
                token,
                paused,
                guardian,
                version: EVENT_SCHEMA_VERSION,
            },
        );
        Ok(())
    }

    pub fn pause_asset_outflows(
        env: Env,
        guardian: Address,
        token: Address,
    ) -> Result<(), ContractError> {
        Self::set_asset_outflow_pause(env, guardian, token, true)
    }

    pub fn resume_asset_outflows(
        env: Env,
        guardian: Address,
        token: Address,
    ) -> Result<(), ContractError> {
        Self::set_asset_outflow_pause(env, guardian, token, false)
    }

    /// Freezes or unfreezes one proposal-kind family. Only the configured
    /// emergency guardian may call. Governance and other kinds stay available.
    pub fn freeze_proposal_kind(
        env: Env,
        guardian: Address,
        kind: ProposalKindTag,
        frozen: bool,
    ) -> Result<(), ContractError> {
        guardian.require_auth();
        let stored = read_guardian(&env).ok_or(ContractError::NoGuardian)?;
        if stored != guardian {
            return Err(ContractError::Unauthorized);
        }

        let key = kind_freeze_key(kind);
        if frozen {
            env.storage().instance().set(&key, &true);
        } else {
            env.storage().instance().remove(&key);
        }
        bump_instance(&env);

        env.events().publish(
            (symbol_short!("sc_frz"),),
            ScopedFreezeChangedEvent {
                version: EVENT_SCHEMA_VERSION,
                scope: FreezeScope::Kind(kind),
                frozen,
                guardian,
            },
        );
        Ok(())
    }

    /// Returns whether `token` is under a scoped emergency freeze.
    pub fn is_asset_frozen(env: Env, token: Address) -> bool {
        is_asset_frozen(&env, &token)
    }

    /// Returns whether treasury outflows of `token` are paused.
    pub fn is_asset_outflow_paused(env: Env, token: Address) -> bool {
        is_asset_outflow_paused(&env, &token)
    }

    /// Returns whether proposals of `kind` are under a scoped emergency freeze.
    pub fn is_proposal_kind_frozen(env: Env, kind: ProposalKindTag) -> bool {
        is_kind_frozen(&env, kind)
    }

    /// Resumes normal operation after a freeze. Requires distinct registered
    /// owners whose combined weight reaches `threshold`.
    pub fn unfreeze(env: Env, approvers: Vec<Address>) -> Result<(), ContractError> {
        require_weighted_approvers(&env, &approvers)?;

        write_frozen(&env, false);

        env.events().publish(
            (symbol_short!("unfrozen"),),
            UnfrozenEvent {
                version: EVENT_SCHEMA_VERSION,
                approvers: approvers.clone(),
            },
        );

        Ok(())
    }

    /// Stops treasury outflows while leaving governance proposals executable.
    /// Only the configured guardian may enter recovery.
    pub fn enter_recovery(env: Env, guardian: Address) -> Result<(), ContractError> {
        guardian.require_auth();
        let stored = read_guardian(&env).ok_or(ContractError::NoGuardian)?;
        if stored != guardian {
            return Err(ContractError::Unauthorized);
        }

        write_recovery(&env, true);
        env.events().publish(
            (symbol_short!("recov_on"),),
            RecoveryEnteredEvent { guardian, version: EVENT_SCHEMA_VERSION },
        );
        Ok(())
    }

    /// Leaves recovery after a threshold of distinct owners co-signs.
    pub fn exit_recovery(env: Env, approvers: Vec<Address>) -> Result<(), ContractError> {
        require_weighted_approvers(&env, &approvers)?;
        write_recovery(&env, false);
        env.events().publish(
            (symbol_short!("recov_off"),),
            RecoveryExitedEvent {
                version: EVENT_SCHEMA_VERSION,
                approvers: approvers.clone(),
            },
        );
        Ok(())
    }

    /// Configures the guardian set that can start social recovery. Requires
    /// distinct registered owners whose combined weight reaches `threshold`.
    /// The guardian set is independent of the single emergency guardian used by
    /// `freeze` / `enter_recovery`.
    pub fn configure_guardian_quorum(
        env: Env,
        approvers: Vec<Address>,
        guardians: Vec<Address>,
        threshold: u32,
    ) -> Result<(), ContractError> {
        require_weighted_approvers(&env, &approvers)?;

        let count = guardians.len();
        if !(MIN_GUARDIANS..=MAX_GUARDIANS).contains(&count) {
            return Err(ContractError::InvalidGuardianQuorum);
        }
        for i in 0..guardians.len() {
            for j in (i + 1)..guardians.len() {
                if guardians.get(i).unwrap() == guardians.get(j).unwrap() {
                    return Err(ContractError::InvalidGuardianQuorum);
                }
            }
        }
        if threshold == 0 || threshold > count {
            return Err(ContractError::InvalidGuardianQuorum);
        }

        env.storage().instance().set(
            &guardian_quorum_key(),
            &GuardianQuorumConfig {
                guardians: guardians.clone(),
                threshold,
            },
        );
        bump_instance(&env);
        env.events().publish(
            (symbol_short!("gq_set"),),
            GuardianQuorumConfiguredEvent {
                guardians,
                threshold,
                version: EVENT_SCHEMA_VERSION,
            },
        );
        Ok(())
    }

    /// Opens a social-recovery request to add a new owner or replace a lost
    /// owner key. The calling guardian's approval is recorded immediately; the
    /// request becomes executable only after the guardian quorum is met and
    /// `SOCIAL_RECOVERY_DELAY` has elapsed.
    pub fn propose_social_recovery(
        env: Env,
        guardian: Address,
        new_owner: Address,
        replace_owner: Option<Address>,
    ) -> Result<u64, ContractError> {
        guardian.require_auth();
        let config =
            read_guardian_quorum(&env).ok_or(ContractError::GuardianQuorumNotConfigured)?;
        if !is_guardian(&env, &guardian) {
            return Err(ContractError::NotGuardian);
        }

        let owners = read_owners_map(&env)?;
        if owners.contains_key(new_owner.clone()) {
            return Err(ContractError::DuplicateOwner);
        }
        if let Some(old_owner) = &replace_owner {
            if !owners.contains_key(old_owner.clone()) {
                return Err(ContractError::OwnerNotFound);
            }
            if *old_owner == new_owner {
                return Err(ContractError::DuplicateOwner);
            }
        } else if owners.len() >= MAX_OWNERS {
            return Err(ContractError::InvalidOwners);
        }

        let id = read_social_recovery_next_id(&env);
        write_social_recovery_next_id(
            &env,
            id.checked_add(1).ok_or(ContractError::ArithmeticError)?,
        );

        let now = env.ledger().timestamp();
        let mut approvals = Vec::new(&env);
        approvals.push_back(guardian.clone());
        let mut request = SocialRecoveryRequest {
            id,
            new_owner: new_owner.clone(),
            replace_owner: replace_owner.clone(),
            approvals,
            proposed_at: now,
            execute_after: 0,
            executed: false,
        };
        if recovery_approval_count(&request) >= config.threshold {
            request.execute_after = now.saturating_add(SOCIAL_RECOVERY_DELAY);
        }
        write_social_recovery(&env, &request);

        env.events().publish(
            (symbol_short!("soc_prop"),),
            SocialRecoveryProposedEvent {
                version: EVENT_SCHEMA_VERSION,
                id,
                new_owner,
                replace_owner,
                proposed_at: now,
            },
        );
        Ok(id)
    }

    /// Adds a guardian approval to a social-recovery request. Once the quorum
    /// is met the request records its executable time; earlier approvals are
    /// kept for the audit trail.
    pub fn approve_social_recovery(
        env: Env,
        guardian: Address,
        request_id: u64,
    ) -> Result<(), ContractError> {
        guardian.require_auth();
        let config =
            read_guardian_quorum(&env).ok_or(ContractError::GuardianQuorumNotConfigured)?;
        if !is_guardian(&env, &guardian) {
            return Err(ContractError::NotGuardian);
        }

        let mut request = read_social_recovery(&env, request_id)?;
        if request.executed {
            return Err(ContractError::RecoveryRequestNotFound);
        }
        if request.execute_after != 0 {
            return Err(ContractError::RecoveryRequestNotReady);
        }
        for existing in request.approvals.iter() {
            if existing == guardian {
                return Err(ContractError::AlreadyApproved);
            }
        }
        request.approvals.push_back(guardian.clone());

        if recovery_approval_count(&request) >= config.threshold {
            request.execute_after = env
                .ledger()
                .timestamp()
                .saturating_add(SOCIAL_RECOVERY_DELAY);
        }
        write_social_recovery(&env, &request);

        env.events().publish(
            (symbol_short!("soc_appr"),),
            SocialRecoveryApprovedEvent {
                version: EVENT_SCHEMA_VERSION,
                id: request_id,
                guardian,
                approvals: request.approvals.len(),
                threshold: config.threshold,
                execute_after: request.execute_after,
            },
        );
        Ok(())
    }

    /// Applies a social-recovery request after quorum and the delay. Any
    /// authenticated caller may trigger it; the guardians already authorized
    /// the ownership change.
    pub fn execute_social_recovery(
        env: Env,
        caller: Address,
        request_id: u64,
    ) -> Result<(), ContractError> {
        caller.require_auth();
        let config =
            read_guardian_quorum(&env).ok_or(ContractError::GuardianQuorumNotConfigured)?;
        let mut request = read_social_recovery(&env, request_id)?;
        if request.executed {
            return Err(ContractError::RecoveryRequestNotFound);
        }
        if request.execute_after == 0 || recovery_approval_count(&request) < config.threshold {
            return Err(ContractError::RecoveryRequestNotReady);
        }
        let now = env.ledger().timestamp();
        if now < request.execute_after {
            return Err(ContractError::RecoveryDelayActive);
        }

        let mut owners = read_owners_map(&env)?;
        match &request.replace_owner {
            Some(old_owner) => {
                let weight = owners
                    .get(old_owner.clone())
                    .ok_or(ContractError::OwnerNotFound)?;
                if owners.contains_key(request.new_owner.clone()) {
                    return Err(ContractError::DuplicateOwner);
                }
                let mut roles = read_owner_roles(&env, old_owner);
                if roles.is_empty() {
                    roles = Vec::from_slice(&env, &DEFAULT_OWNER_ROLES);
                }
                owners.remove(old_owner.clone());
                owners.set(request.new_owner.clone(), weight);
                let key = owners_key();
                env.storage().persistent().set(&key, &owners);
                bump_persistent(&env, &key);

                update_owner_roles(&env, old_owner, &Vec::new(&env));
                update_owner_roles(&env, &request.new_owner, &roles);
                remove_delegations_touching(&env, old_owner);
                purge_owner_approvals(&env, old_owner)?;
            }
            None => {
                if owners.len() >= MAX_OWNERS {
                    return Err(ContractError::InvalidOwners);
                }
                let current_total = read_total_weight(&env);
                let new_total = checked_weight_add(current_total, MIN_OWNER_WEIGHT)?;
                owners.set(request.new_owner.clone(), MIN_OWNER_WEIGHT);
                let key = owners_key();
                env.storage().persistent().set(&key, &owners);
                bump_persistent(&env, &key);
                let roles = Vec::from_slice(&env, &DEFAULT_OWNER_ROLES);
                update_owner_roles(&env, &request.new_owner, &roles);
                write_total_weight(&env, new_total);
            }
        }

        request.executed = true;
        write_social_recovery(&env, &request);
        env.events().publish(
            (symbol_short!("soc_exec"),),
            SocialRecoveryExecutedEvent {
                version: EVENT_SCHEMA_VERSION,
                id: request_id,
                new_owner: request.new_owner.clone(),
                replace_owner: request.replace_owner.clone(),
                executed_at: now,
            },
        );
        Ok(())
    }

    /// Returns the configured guardian quorum, if any.
    pub fn get_guardian_quorum(env: Env) -> Option<GuardianQuorumConfig> {
        read_guardian_quorum(&env)
    }

    /// Returns the enforced delay between social-recovery quorum and execution.
    pub fn get_social_recovery_delay(_env: Env) -> u64 {
        SOCIAL_RECOVERY_DELAY
    }

    /// Returns a social-recovery request, including its audit fields.
    pub fn get_social_recovery(
        env: Env,
        request_id: u64,
    ) -> Result<SocialRecoveryRequest, ContractError> {
        read_social_recovery(&env, request_id)
    }

    /// Returns the enforced delay between owner-rotation quorum and activation.
    pub fn get_owner_rotation_delay(_env: Env) -> u64 {
        OWNER_ROTATION_DELAY
    }

    /// Returns whether the contract is currently frozen.
    pub fn is_frozen(env: Env) -> bool {
        is_frozen_state(&env)
    }

    /// Returns whether treasury outflows are currently in recovery mode.
    pub fn is_in_recovery(env: Env) -> bool {
        is_recovery_state(&env)
    }

    /// Returns the current guardian address, or `None` if no guardian is set.
    pub fn get_guardian(env: Env) -> Option<Address> {
        read_guardian(&env)
    }

    /// Returns whether the approved-token registry is enforcing proposal tokens.
    pub fn get_asset_registry_enabled(env: Env) -> bool {
        asset_registry_enabled(&env)
    }

    /// Returns whether `token` is currently in the approved-token registry.
    pub fn is_token_approved(env: Env, token: Address) -> bool {
        token_is_approved(&env, &token)
    }

    /// Returns an active escrow record.
    pub fn get_escrow(env: Env, escrow_id: u64) -> Result<EscrowRecord, ContractError> {
        read_escrow(&env, escrow_id)
    }

    /// Releases a quorum-conditioned escrow after distinct owners reach quorum.
    pub fn release_escrow(
        env: Env,
        approvers: Vec<Address>,
        escrow_id: u64,
    ) -> Result<(), ContractError> {
        require_not_frozen(&env)?;
        require_weighted_approvers(&env, &approvers)?;
        let escrow = read_escrow(&env, escrow_id)?;
        match &escrow.release_mode {
            EscrowReleaseMode::OwnerQuorumUntil(deadline)
                if env.ledger().timestamp() <= *deadline => {}
            _ => return Err(ContractError::EscrowConditionNotMet),
        }
        require_outflow_allowed(&env, &escrow.token, ProposalKindTag::Escrow)?;
        validate_token_interface(&env, &escrow.token)?;
        if token::Client::new(&env, &escrow.token)
            .try_transfer(
                &env.current_contract_address(),
                &escrow.recipient,
                &escrow.amount,
            )
            .is_err()
        {
            return Err(ContractError::TransferFailed);
        }
        let remaining = read_reserved_balance(&env, &escrow.token)
            .checked_sub(escrow.amount)
            .ok_or(ContractError::ArithmeticError)?;
        write_reserved_balance(&env, &escrow.token, remaining);
        env.storage().persistent().remove(&escrow_key(escrow_id));
        env.events().publish(
            (symbol_short!("esc_rel"),),
            EscrowReleasedEvent {
                id: escrow_id,
                recipient: escrow.recipient,
                token: escrow.token,
                amount: escrow.amount,
            },
        );
        Ok(())
    }

    /// Releases a deadline-conditioned escrow once its configured time is reached.
    pub fn release_escrow_by_deadline(
        env: Env,
        caller: Address,
        escrow_id: u64,
    ) -> Result<(), ContractError> {
        caller.require_auth();
        require_not_frozen(&env)?;
        let escrow = read_escrow(&env, escrow_id)?;
        match &escrow.release_mode {
            EscrowReleaseMode::Deadline(deadline)
                if env.ledger().timestamp() >= *deadline => {}
            _ => return Err(ContractError::EscrowConditionNotMet),
        }
        require_outflow_allowed(&env, &escrow.token, ProposalKindTag::Escrow)?;
        validate_token_interface(&env, &escrow.token)?;
        if token::Client::new(&env, &escrow.token)
            .try_transfer(
                &env.current_contract_address(),
                &escrow.recipient,
                &escrow.amount,
            )
            .is_err()
        {
            return Err(ContractError::TransferFailed);
        }
        let remaining = read_reserved_balance(&env, &escrow.token)
            .checked_sub(escrow.amount)
            .ok_or(ContractError::ArithmeticError)?;
        write_reserved_balance(&env, &escrow.token, remaining);
        env.storage().persistent().remove(&escrow_key(escrow_id));
        env.events().publish(
            (symbol_short!("esc_rel"),),
            EscrowReleasedEvent {
                id: escrow_id,
                recipient: escrow.recipient,
                token: escrow.token,
                amount: escrow.amount,
            },
        );
        Ok(())
    }

    /// Unlocks the treasury reservation if a quorum-conditioned escrow expires unused.
    pub fn refund_escrow(
        env: Env,
        caller: Address,
        escrow_id: u64,
    ) -> Result<(), ContractError> {
        caller.require_auth();
        let escrow = read_escrow(&env, escrow_id)?;
        match &escrow.release_mode {
            EscrowReleaseMode::OwnerQuorumUntil(deadline)
                if env.ledger().timestamp() > *deadline => {}
            _ => return Err(ContractError::EscrowConditionNotMet),
        }
        let remaining = read_reserved_balance(&env, &escrow.token)
            .checked_sub(escrow.amount)
            .ok_or(ContractError::ArithmeticError)?;
        write_reserved_balance(&env, &escrow.token, remaining);
        env.storage().persistent().remove(&escrow_key(escrow_id));
        env.events().publish(
            (symbol_short!("esc_ref"),),
            EscrowRefundedEvent {
                id: escrow_id,
                token: escrow.token,
                amount: escrow.amount,
            },
        );
        Ok(())
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
                version: EVENT_SCHEMA_VERSION,
                caller,
                new_wasm_hash,
            },
        );

        Ok(())
    }
    pub fn create_add_owner_proposal(
        env: Env,
        proposer: Address,
        new_owner: Address,
        weight: u32,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
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
            attachment_hash: None,
        };
        write_proposal(&env, &proposal);
        register_active_proposal(&env, id)?;

        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

        let total_weight = read_total_weight(&env);
        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                version: EVENT_SCHEMA_VERSION,
                id,
                proposer,
                threshold,
                category: ProposalCategory::Other,
                transfers: Vec::new(&env),
                quorum_weight: threshold,
                total_weight_at_creation: total_weight,
                attachment_hash: None,
            },
        );

        Ok(id)
    }

    pub fn create_remove_owner_proposal(
        env: Env,
        proposer: Address,
        owner_to_remove: Address,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
        require_not_frozen(&env)?;

        require_owner(&env, &owner_to_remove)?;
        let owners_map = read_owners_map(&env)?;
        let current_count = owners_map.len();
        if current_count <= 1 {
            return Err(ContractError::CannotRemoveLastOwner);
        }
        let threshold = read_threshold(&env)?;
        let remove_weight = owners_map.get(owner_to_remove.clone()).unwrap_or(0);
        let resulting_total_weight = checked_weight_sub(read_total_weight(&env), remove_weight)?;
        if resulting_total_weight < threshold {
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

        let id = read_next_id(&env);

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
            attachment_hash: None,
        };
        write_proposal(&env, &proposal);
        register_active_proposal(&env, id)?;

        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

        let total_weight = read_total_weight(&env);
        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                version: EVENT_SCHEMA_VERSION,
                id,
                proposer,
                threshold,
                category: ProposalCategory::Other,
                transfers: Vec::new(&env),
                quorum_weight: threshold,
                total_weight_at_creation: total_weight,
                attachment_hash: None,
            },
        );

        Ok(id)
    }

    pub fn create_change_threshold_proposal(
        env: Env,
        proposer: Address,
        new_threshold: u32,
        description: String,
        deadline: u64,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_role(&env, &proposer, Role::Proposer)?;
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
            attachment_hash: None,
        };
        write_proposal(&env, &proposal);
        register_active_proposal(&env, id)?;

        let next_id = id.checked_add(1).ok_or(ContractError::ArithmeticError)?;
        write_next_id(&env, next_id);

        let total_weight = read_total_weight(&env);
        env.events().publish(
            (symbol_short!("created"),),
            ProposalCreatedEvent {
                version: EVENT_SCHEMA_VERSION,
                id,
                proposer,
                threshold,
                category: ProposalCategory::Other,
                transfers: Vec::new(&env),
                quorum_weight: threshold,
                total_weight_at_creation: total_weight,
                attachment_hash: None,
            },
        );

        Ok(id)
    }

    pub fn disburse_recurring(
        env: Env,
        caller: Address,
        schedule_id: u64,
    ) -> Result<(), ContractError> {
        caller.require_auth();
        require_not_frozen(&env)?;
        require_not_recovery(&env)?;

        let mut schedule = read_recurring_payment(&env, schedule_id)?;

        // Paused/cancelled/completed schedules cannot disburse and must not
        // mutate state or advance last_disbursed_at.
        if matches!(
            schedule.status,
            RecurringStatus::Paused | RecurringStatus::Cancelled | RecurringStatus::Completed
        ) {
            return Err(ContractError::RecurringPaymentInactive);
        }

        require_outflow_allowed(&env, &schedule.token, ProposalKindTag::Recurring)?;

        let now = env.ledger().timestamp();
        let due_at = recurring_payment_due_at(&schedule)?;

        let disbursement_amount = match schedule.kind {
            RecurringKind::LinearVesting => linear_vesting_payout(&schedule, now)?,
            RecurringKind::ContinuousStream => {
                return Err(ContractError::RecurringPaymentInactive);
            }
            RecurringKind::FixedAmountPerPeriod => {
                if now < due_at {
                    return Err(ContractError::RecurringIntervalNotElapsed);
                }
                if schedule.end_time > 0 && (due_at > schedule.end_time || now > schedule.end_time)
                {
                    return Err(ContractError::RecurringPaymentComplete);
                }
                schedule.amount
            }
        };

        // Linear vesting gates the first claim on cliff/start, then allows
        // claiming newly vested amounts without waiting a full interval.
        if matches!(schedule.kind, RecurringKind::LinearVesting) {
            if schedule.periods_disbursed == 0 && now < due_at {
                return Err(ContractError::RecurringIntervalNotElapsed);
            }
        }

        if disbursement_amount <= 0 {
            return Err(ContractError::RecurringPaymentComplete);
        }

        // Clamp disbursement_amount to the remaining cap so total_disbursed
        // never overshoots total_cap. All arithmetic uses checked operations so
        // an overflow returns ArithmeticError rather than wrapping.
        let projected_total = schedule
            .total_disbursed
            .checked_add(disbursement_amount)
            .ok_or(ContractError::ArithmeticError)?;

        // When the schedule has a cap and the projected total would exceed it,
        // clamp the actual payout to whatever headroom remains. A remaining
        // headroom of zero means the cap is already met — treat as complete.
        let (actual_amount, new_total_disbursed) = if schedule.total_cap > 0
            && projected_total > schedule.total_cap
        {
            let clamped = schedule
                .total_cap
                .checked_sub(schedule.total_disbursed)
                .ok_or(ContractError::ArithmeticError)?;
            if clamped <= 0 {
                return Err(ContractError::RecurringPaymentComplete);
            }
            // new total is exactly the cap — no overshoot.
            (clamped, schedule.total_cap)
        } else {
            (disbursement_amount, projected_total)
        };

        // Compute the next period count up front so every checked counter
        // update has succeeded before funds move.
        let new_periods_disbursed = schedule
            .periods_disbursed
            .checked_add(1)
            .ok_or(ContractError::ArithmeticError)?;

        validate_token(&env, &schedule.token)?;
        let token_client = token::Client::new(&env, &schedule.token);
        let treasury = env.current_contract_address();
        let balance = available_balance(&env, &schedule.token)?;
        if balance < disbursement_amount {
            return Err(ContractError::TransferFailed);
        }
        if let Some(t_limit) = read_treasury_spending_limit(&env, &schedule.token) {
            let cumulative = effective_treasury_spent(&env, &schedule.token)
                .checked_add(actual_amount)
                .ok_or(ContractError::ArithmeticError)?;
            if cumulative > t_limit {
                return Err(ContractError::TreasurySpendingLimitExceeded);
            }
        }
        if !transfer_succeeded(token_client.try_transfer(&treasury, &schedule.recipient, &actual_amount))
        {
            return Err(ContractError::TransferFailed);
        }

        // Attribute each disbursement to the schedule's original proposer in the spent tracker
        let tracker = read_spent_tracker(&env, &schedule.proposer, &schedule.token);
        let expired = tracker.epoch == 0
            || now > tracker.epoch.saturating_add(read_spending_window(&env, &schedule.proposer, &schedule.token));
        let epoch = if expired { now } else { tracker.epoch };
        let spent = if expired {
            actual_amount
        } else {
            tracker
                .spent
                .checked_add(actual_amount)
                .ok_or(ContractError::ArithmeticError)?
        };
        write_spent_tracker(
            &env,
            &schedule.proposer,
            &schedule.token,
            &SpentTracker { spent, epoch },
        );
        record_treasury_spend(&env, &schedule.token, actual_amount)?;

        schedule.last_disbursed_at = now;
        // Store the checked new total — never exceeds total_cap.
        schedule.total_disbursed = new_total_disbursed;
        schedule.periods_disbursed = new_periods_disbursed;
        write_recurring_payment(&env, &schedule);

        env.events().publish(
            (symbol_short!("rpay"),),
            RecurringPaymentDisbursedEvent {
                version: EVENT_SCHEMA_VERSION,
                schedule_id,
                recipient: schedule.recipient.clone(),
                token: schedule.token.clone(),
                amount: actual_amount,
                total_disbursed: schedule.total_disbursed,
                periods_disbursed: schedule.periods_disbursed,
            },
        );

        Ok(())
    }

    pub fn disburse_recurring_schedule(env: Env, id: u64) -> Result<(), ContractError> {
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

    pub fn get_spent_tracker(env: Env, owner: Address, token: Address) -> SpentTracker {
        read_spent_tracker(&env, &owner, &token)
    }

}

mod test;
#[cfg(test)]
mod bench;
#[cfg(test)]
mod invariants;
#[cfg(test)]
mod differential;
#[cfg(test)]
mod spend_window_proptest;
// TODO: Ensure tests verify event parsing and decoding into typed records

fn checked_weight_add(a: u32, b: u32) -> Result<u32, ContractError> {
    a.checked_add(b).ok_or(ContractError::ArithmeticError)
}

fn checked_weight_sub(a: u32, b: u32) -> Result<u32, ContractError> {
    a.checked_sub(b).ok_or(ContractError::ArithmeticError)
}

fn read_yield_position(env: &Env, position_id: u64) -> Option<YieldPosition> {
    let key = yield_position_key(position_id);
    env.storage().persistent().get(&key)
}

fn yield_position_key(position_id: u64) -> (Symbol, u64) {
    (symbol_short!("YPOS"), position_id)
}

fn payment_metadata_key(proposal_id: u64) -> (Symbol, u64) {
    (symbol_short!("PAYMETA"), proposal_id)
}

fn spend_policy_key(owner: &Address, token: &Address) -> (Symbol, Address, Address) {
    (symbol_short!("SPOL"), owner.clone(), token.clone())
}

fn spend_policy_tracker_key(
    owner: &Address,
    token: &Address,
    window: &SpendWindowKind,
) -> (Symbol, Address, Address, SpendWindowKind) {
    (symbol_short!("SPTRK"), owner.clone(), token.clone(), window.clone())
}

fn oracle_price_key(token: &Address, fiat: &Symbol) -> (Symbol, Address, Symbol) {
    (symbol_short!("ORACLE"), token.clone(), fiat.clone())
}

fn fiat_spend_limit_key(
    owner: &Address,
    token: &Address,
    fiat: &Symbol,
) -> (Symbol, Address, Address, Symbol) {
    (symbol_short!("FIATL"), owner.clone(), token.clone(), fiat.clone())
}

fn fiat_spent_tracker_key(
    owner: &Address,
    token: &Address,
    fiat: &Symbol,
) -> (Symbol, Address, Address, Symbol) {
    (symbol_short!("FIATT"), owner.clone(), token.clone(), fiat.clone())
}

fn denylist_enabled_key() -> Symbol {
    symbol_short!("DENYEN")
}

fn denylist_key(address: &Address) -> (Symbol, Address) {
    (symbol_short!("DENY"), address.clone())
}

fn last_rebalance_key() -> Symbol {
    symbol_short!("REBAL")
}

const PRICE_SCALING: i128 = 10_000_000;

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct YieldWithdrawProposedEvent {
    pub proposal_id: u64,
    pub proposer: Address,
    pub venue: Address,
    pub token: Address,
    pub amount: i128,
    pub min_return: i128,
    pub position_id: u64,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}


#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct RebalanceExecutedEvent {
    pub proposal_id: u64,
    pub executor: Address,
    pub targets: Vec<RebalanceTarget>,
    /// Event-schema version. See `EVENT_SCHEMA_VERSION`.
    pub version: u32,
}


fn read_pull_payment(env: &Env, request_id: u64) -> Option<PullPaymentRequest> {
    let key = pull_payment_key(request_id);
    env.storage().persistent().get(&key)
}

fn derive_pull_payment_status(env: &Env, req: &PullPaymentRequest) -> PullPaymentStatus {
    match &req.status {
        PullPaymentStatus::Open => {
            if env.ledger().timestamp() >= req.expires_at {
                PullPaymentStatus::Expired
            } else {
                PullPaymentStatus::Open
            }
        }
        other => other.clone(),
    }
}

fn write_pull_payment(env: &Env, req: &PullPaymentRequest) {
    let key = pull_payment_key(req.id);
    env.storage().persistent().set(&key, req);
    bump_persistent(env, &key);
}

fn pull_payment_next_id_key() -> Symbol {
    symbol_short!("PRNEXT")
}

fn write_next_pull_payment_id(env: &Env, id: u64) {
    env.storage()
        .instance()
        .set(&pull_payment_next_id_key(), &id);
    bump_instance(env);
}

fn read_payment_metadata(env: &Env, proposal_id: u64) -> Option<PaymentMetadata> {
    let key = payment_metadata_key(proposal_id);
    env.storage().persistent().get(&key)
}

fn write_payment_metadata(env: &Env, proposal_id: u64, metadata: &PaymentMetadata) {
    let key = payment_metadata_key(proposal_id);
    env.storage().persistent().set(&key, metadata);
    bump_persistent(env, &key);
}

fn write_yield_venue_approved(env: &Env, venue: &Address, approved: bool) {
    let key = yield_venue_approved_key(venue);
    if approved {
        env.storage().persistent().set(&key, &true);
        bump_persistent(env, &key);
    } else {
        env.storage().persistent().remove(&key);
    }
}

fn write_yield_position(env: &Env, position: &YieldPosition) {
    let key = yield_position_key(position.id);
    env.storage().persistent().set(&key, position);
    bump_persistent(env, &key);
}

fn read_next_pull_payment_id(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&pull_payment_next_id_key())
        .unwrap_or(1_u64)
}

fn remove_spend_policy(env: &Env, owner: &Address, token: &Address) {
    let key = spend_policy_key(owner, token);
    env.storage().persistent().remove(&key);
}

fn pull_payment_key(request_id: u64) -> (Symbol, u64) {
    (symbol_short!("PULLREQ"), request_id)
}
