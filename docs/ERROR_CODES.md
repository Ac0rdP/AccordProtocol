# Error-Code & Troubleshooting Index

This index maps every **Accord smart contract error** (`ContractError` in [`contracts/accord/src/lib.rs`](../contracts/accord/src/lib.rs)) and every **Analytics API error** (`analytics-api`) to its root cause, user-facing message, and operator remedy.

---

## Quick Diagnostic Commands

### Check contract state & freeze/recovery status
```bash
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --network testnet \
  -- is_frozen
```
**Expected output:**
```json
false
```

### Check owner roles & weights
```bash
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --network testnet \
  -- get_owner_weights
```
**Expected output:**
```json
[
  { "owner": "GABC...1111", "weight": 40 },
  { "owner": "GDEF...2222", "weight": 30 },
  { "owner": "GHIJ...3333", "weight": 30 }
]
```

### Check Analytics API health & readiness
```bash
curl -sS https://your-analytics-api.example.com/status | jq .
```
**Expected output:**
```json
{
  "service": "accord-analytics-api",
  "status": "ok",
  "checks": {
    "database": { "ok": true }
  }
}
```

---

## Smart Contract Errors (`ContractError`)

Every `#[contracterror]` variant in [`contracts/accord/src/lib.rs`](../contracts/accord/src/lib.rs):

### Initialization & Access Control

| Code | Variant | Cause | User Message | Operator Remedy |
|---|---|---|---|---|
| `1` | `AlreadyInitialized` | `initialize()` called on an already-initialized contract. | This multisig contract is already initialized. | Do not re-initialize; deploy a new contract instance or inspect existing state with `get_owners`. |
| `2` | `NotInitialized` | Contract entrypoint called before `initialize()`. | This multisig contract has not been initialized yet. | Run `initialize` with initial owners, threshold, and optional guardian. |
| `3` | `Unauthorized` | Signer is not an owner or lacks authority for the call. | Your connected wallet is not authorized to perform this action. | Verify the active Freighter account is in `get_owners` and holds the required role. |
| `25` | `OwnerNotFound` | Target address is not a registered multisig owner. | The specified address is not an owner of this multisig. | Check `get_owners` for the exact `G...` address before submitting weight/role/removal proposals. |
| `26` | `ContractFrozen` | Contract is frozen by the guardian or emergency freeze. | Treasury actions are paused because the contract is frozen. | Inspect freeze reason; only the guardian (or governance unfreeze flow) can unfreeze the contract. |
| `27` | `NoGuardian` | Guardian-only action invoked when no guardian is configured. | No guardian is configured on this contract. | Set a guardian via `create_change_guardian_proposal` before using guardian recovery/freeze. |
| `52` | `MissingRole` | Caller lacks the required RBAC role (`Proposer`, `Approver`, or `Executor`). | Your account does not have the required role for this action. | Inspect `get_roles(address)` and submit `create_grant_role_proposal` if appropriate. |
| `53` | `RoleAlreadyGranted` | `create_grant_role_proposal` executed for a role the target already holds. | This account already holds that role. | Query `get_roles(address)` before proposing a role grant. |
| `54` | `RoleNotGranted` | `create_revoke_role_proposal` executed for a role the target does not hold. | This account does not hold the role you are trying to revoke. | Query `get_roles(address)` and revoke only currently assigned roles. |
| `55` | `InvalidRole` | Supplied role value is not valid in the current context. | The selected role is not valid for this operation. | Use one of `Proposer`, `Approver`, `Executor`, or `Viewer`. |
| `56` | `DeprecatedEntrypoint` | Caller invoked a legacy entrypoint replaced by a newer governance flow. | This contract action uses a deprecated entrypoint. | Upgrade client/CLI call to the current entrypoint documented in [`docs/CONTRACT_API.md`](CONTRACT_API.md). |
| `57` | `RecoveryActive` | Outflow attempted while guardian recovery mode is active. | Outflows are blocked while account recovery is active. | Wait for recovery to complete or be cancelled by quorum before executing transfers. |

### Owners, Thresholds & Weighted Governance

| Code | Variant | Cause | User Message | Operator Remedy |
|---|---|---|---|---|
| `4` | `InvalidThreshold` | Threshold is `0` or invalid for the owner set. | Approval threshold must be at least 1 and reachable. | Set threshold between `1` and `total_weight`. |
| `5` | `InvalidOwners` | Owner list is empty or exceeds `MAX_OWNERS` (`20`). | Owner list must contain between 1 and 20 valid addresses. | Keep owner count within `1..=20` and ensure all addresses are valid Stellar accounts. |
| `19` | `DuplicateOwner` | Duplicate address in `initialize()` or `create_add_owner_proposal`. | This address is already a registered owner. | Remove the duplicate address from the owner list. |
| `24` | `WouldBreakThreshold` | Removing an owner would leave fewer owners than `threshold`. | Removing this owner would make the approval threshold unreachable. | Lower `threshold` via `create_change_threshold_proposal` before removing the owner. |
| `42` | `InvalidWeightsLength` | Weights vector length does not match owners vector length. | Each owner must have exactly one corresponding weight. | Pass a weights array of the exact same length as `owners`. |
| `43` | `WeightBelowMinimum` | Owner weight is `< MIN_OWNER_WEIGHT` (`1`). | Owner weight must be at least 1. | Set weight `>= 1` (use `remove_owner` instead of weight `0`). |
| `44` | `InvalidWeight` | Weight value is outside `1..=100_000`. | Owner weight must be between 1 and 100,000. | Choose a weight in `1..=100_000`. |
| `45` | `AlreadyMigrated` | `migrate_to_weighted_governance` or `migrate_to_rbac` called twice. | Governance migration has already been completed. | No action needed; query `is_governance_migrated` or `get_role_version`. |
| `46` | `SingleOwnerWeightCapExceeded` | A single owner's weight would exceed `MAX_SINGLE_OWNER_WEIGHT_PCT` (`50%`) of total weight. | No single owner may hold more than 50% of total voting weight. | Reduce the target weight or increase other owners' weights first. |
| `47` | `TargetOwnerNoLongerExists` | Proposal targets an owner who was removed before execution. | The target owner is no longer part of this multisig. | Cancel the stale proposal and create a new one if needed. |
| `48` | `WouldBreakQuorum` | Weight/owner change would make `threshold > total_weight`. | This change would make quorum impossible to reach. | Lower `threshold` first, then adjust weights or remove the owner. |
| `49` | `CannotRemoveLastOwner` | Attempted to remove the only remaining multisig owner. | You cannot remove the last remaining owner. | Add a replacement owner before removing the current one. |
| `50` | `ThresholdExceedsOwnerCount` | Threshold exceeds owner count (unweighted) or total weight. | Threshold cannot exceed the total available voting power. | Set `threshold <= total_weight`. |

### Proposal Lifecycle & Validation

| Code | Variant | Cause | User Message | Operator Remedy |
|---|---|---|---|---|
| `6` | `ProposalNotFound` | No proposal exists for the given `proposal_id`. | Proposal not found. | Verify `proposal_id` via `get_total_proposals` / `get_proposals_paged`. |
| `7` | `ProposalNotActive` | Proposal is already `Executed`, `Cancelled`, or `Expired`. | This proposal is no longer active. | Inspect proposal status; create a new proposal if the action is still needed. |
| `8` | `AlreadyApproved` | Owner has already approved this proposal. | You have already approved this proposal. | Wait for other owners to approve; no duplicate approval is possible. |
| `9` | `NotApproved` | `revoke()` called by an owner who has not approved the proposal. | You have not approved this proposal yet. | Only owners listed in `get_approvers(proposal_id)` can revoke. |
| `10` | `ThresholdNotMet` | `execute()` called before approved weight reaches `threshold`. | Proposal has not reached the required approval threshold yet. | Collect additional approvals until `approval_weight >= threshold`. |
| `11` | `ProposalExpired` | `ledger_timestamp > proposal.deadline`. | This proposal has expired and can no longer be approved or executed. | Recreate the proposal with a longer deadline (up to `MAX_PROPOSAL_DURATION` = 90 days / `7_776_000`s) and run `sweep_expired` to free slots. |
| `12` | `InvalidAmount` | Transfer amount is `< MIN_AMOUNT` (`1`). | Amount must be greater than zero. | Specify a positive amount in base token stroops/units. |
| `13` | `InvalidDeadline` | Deadline is in the past or exceeds 90 days (`7_776_000`s). | Proposal deadline must be in the future and within 90 days. | Choose a future Unix timestamp within `now + 7_776_000`. |
| `14` | `InvalidToken` | Token contract address is invalid or unsupported. | The selected token address is invalid. | Verify the SAC / SEP-41 token contract address for the active network. |
| `15` | `TransferFailed` | Underlying SEP-41 token transfer failed (typically insufficient balance). | Token transfer failed. Check contract balance and token status. | Fund the multisig contract with sufficient token balance and retry `execute`. |
| `16` | `EmptyDescription` | Proposal description is empty. | Please enter a proposal description. | Provide a non-empty description (1–300 characters). |
| `17` | `DescriptionTooLong` | Description exceeds `MAX_DESCRIPTION_LEN` (`300` bytes). | Description must be 300 characters or fewer. | Shorten the description to `<= 300` characters. |
| `18` | `TooManyActiveProposals` | Active proposals reached `MAX_ACTIVE_PROPOSALS` (`50`). | Active proposal limit (50) reached. | Execute ready proposals or run `sweep_expired` / `cancel_expired` to free slots. |
| `20` | `ArithmeticError` | Checked integer overflow/underflow during weight or amount math. | Numeric overflow or underflow occurred. | Verify amounts and weights are within valid bounds. |
| `21` | `InvalidDuration` | Duration parameter is zero or out of bounds. | Invalid duration specified. | Check valid min/max duration bounds for the operation. |
| `22` | `InvalidRecipient` | Recipient address is invalid (e.g. self-transfer where disallowed). | Invalid recipient address. | Verify the recipient Stellar `G...` or `C...` address. |
| `23` | `TimeLockActive` | Proposal is in its mandatory time-lock delay before execution. | This proposal is in its time-lock period and cannot be executed yet. | Wait until the time-lock timestamp elapses, then call `execute`. |
| `31` | `SpendingLimitExceeded` | Transfer exceeds the owner's or contract's rolling spending limit. | This transfer exceeds the configured spending limit for this window. | Wait for the spending window (`MIN_SPENDING_WINDOW` 24h – `MAX_SPENDING_WINDOW` 7d) to roll over, or update limits via `create_spending_limit_proposal`. |

### Recurring Payments & Streams

| Code | Variant | Cause | User Message | Operator Remedy |
|---|---|---|---|---|
| `28` | `InvalidInterval` | Interval outside `MIN_INTERVAL_SECS` (`60`s) – `MAX_INTERVAL_SECS` (`31_536_000`s). | Recurring interval must be between 60 seconds and 1 year. | Adjust interval to `60..=31_536_000` seconds. |
| `29` | `InvalidSchedule` | Recurring schedule parameters are inconsistent (e.g. start/cliff/end). | Invalid recurring schedule parameters. | Verify `start_time`, `interval`, and `total_cap` are consistent. |
| `30` | `InvalidCap` | Total cap is `< amount` or non-positive. | Total disbursement cap must be at least one period's amount. | Set `total_cap >= amount`. |
| `32` | `RecurringPaymentNotFound` | No recurring schedule exists for `schedule_id`. | Recurring payment schedule not found. | Check `get_recurring_payments_paged` for valid schedule IDs. |
| `33` | `RecurringPaymentNotDue` | `disburse_recurring` called before `next_disbursement_time`. | This recurring payment is not due yet. | Query `get_next_disbursement_time(schedule_id)` and retry after that timestamp. |
| `34` | `RecurringPaymentComplete` | Schedule has already disbursed its full `total_cap`. | This recurring schedule has completed all payments. | No action needed; create a new schedule if payments should continue. |
| `35` | `RecurringPaymentInactive` | Schedule is paused or cancelled. | This recurring schedule is not active. | Resume a paused schedule via `create_resume_recurring_proposal`, or create a new one if cancelled. |
| `36` | `RecurringIntervalNotElapsed` | Disbursement attempted before the full interval elapsed. | Next disbursement interval has not elapsed yet. | Wait until `get_next_disbursement_time(schedule_id)` before calling `disburse_recurring`. |
| `37` | `TooManyActiveRecurring` | Active recurring schedules reached `MAX_ACTIVE_RECURRING` (`20`). | Active recurring schedule limit (20) reached. | Cancel completed or unneeded schedules before creating new ones. |
| `38` | `ScheduleAlreadyCancelled` | Cancel proposed/executed on an already-cancelled schedule. | This schedule is already cancelled. | No action needed. |
| `39` | `ScheduleAlreadyPaused` | Pause proposed/executed on an already-paused schedule. | This schedule is already paused. | No action needed; use `create_resume_recurring_proposal` to resume. |
| `40` | `ScheduleNotPaused` | Resume proposed/executed on a schedule that is not paused. | This schedule is not paused. | Check status with `get_recurring_payment(schedule_id)`. |
| `41` | `ScheduleTerminal` | Operation attempted on a terminal (cancelled/completed) schedule. | This schedule is finalized and cannot be modified. | Create a new recurring schedule proposal instead. |
| `51` | `ScheduleNotActive` | Action requires an `Active` recurring schedule. | Recurring schedule must be active for this operation. | Verify schedule state with `get_recurring_payment(schedule_id)`. |

### Asset Registry & Escrow

| Code | Variant | Cause | User Message | Operator Remedy |
|---|---|---|---|---|
| `61` | `AssetNotApproved` | Transfer attempted with a token not on the approved asset registry. | This token is not approved in the treasury asset registry. | Submit `create_approve_token_proposal` to whitelist the token first. |
| `62` | `AssetRegistryState` | Invalid asset registry state transition (e.g. approving an already-approved token). | Asset registry state conflict. | Check current approved assets before proposing changes. |
| `63` | `EscrowNotFound` | No escrow exists for the specified ID. | Escrow record not found. | Verify the escrow ID from proposal/event logs. |
| `64` | `EscrowConditionNotMet` | Escrow release conditions (deadline/oracle/milestone) are not satisfied. | Escrow release conditions have not been met yet. | Confirm condition criteria are met before releasing escrow. |
| `65` | `EscrowFundsUnavailable` | Escrow balance is insufficient or already released/refunded. | Escrow funds are unavailable. | Inspect escrow status and contract token balance. |

---

## Analytics API Errors (`analytics-api`)

All JSON error responses from `analytics-api` follow:
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid query parameters",
    "details": [
      { "field": "limit", "message": "limit must be an integer between 1 and 100", "code": "INVALID_PAGINATION" }
    ]
  }
}
```

| HTTP Status | `error.code` | Cause | User Message | Operator Remedy |
|---|---|---|---|---|
| `400` | `VALIDATION_ERROR` | One or more query/body parameters failed validation (`UNKNOWN_PARAMETER`, `INVALID_LIMIT`, `INVALID_CATEGORY`, `INVALID_CONFIG`, `REQUIRED_FIELD`, `FIELD_TOO_LONG`, `REQUIRED_PARAMETER`, `INVALID_PAGINATION`, `INVALID_JSON`). | Invalid request parameters; see `error.details` for the exact field. | Fix the field listed in `error.details` against [`docs/analytics-api.openapi.json`](analytics-api.openapi.json). |
| `400` | `INVALID_PARAMETER` | Path or single parameter (e.g. proposal ID) is malformed. | Invalid parameter value. | Ensure path IDs are valid positive integers or strings. |
| `401` | `UNAUTHORIZED` | `ADMIN_TOKEN` is configured and `Authorization: Bearer <token>` is missing or invalid. | A valid administrator bearer token is required. | Supply `Authorization: Bearer <ADMIN_TOKEN>` on write requests. |
| `404` | `NOT_FOUND` | Requested proposal, alert rule, report template, or integration plugin does not exist. | The requested resource was not found. | Verify the resource ID and workspace `(network, contractId)` parameters. |
| `409` | `CONFLICT` | Duplicate or conflicting alert rule / state transition. | Resource conflict; the operation cannot be applied in the current state. | Inspect existing rules/resources and update rather than duplicating. |
| `429` | `RATE_LIMITED` | Client IP exceeded the configured request rate limit (`limits.rs`). | Too many requests; please retry after the `Retry-After` header. | Respect `Retry-After` and `X-RateLimit-*` headers or tune `RATE_LIMIT_*` env vars. |
| `500` | `INTERNAL_ERROR` | Database query failure or unexpected server error. | An internal server error occurred. | Check `analytics-api` logs and PostgreSQL connectivity via `/status`. |

---

## See Also
- [Troubleshooting Guide](guides/troubleshooting.md) — Wallet, Freighter, and Stellar RPC issues
- [Contract API Reference](CONTRACT_API.md) — Full contract method signatures
- [Treasury Policy Operator Playbook](guides/treasury-policy-playbook.md) — Thresholds, weights, spend limits, and recurring schedules
