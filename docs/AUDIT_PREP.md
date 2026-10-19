# Accord Protocol — Audit Preparation Pack

> **Notice**: This document consolidates the smart contract audit scope, protocol invariants, trust model, and known residual risks for Accord Protocol. It is prepared for independent security reviewers and auditors. Accord Protocol is currently **unaudited**; this document makes no claim of security certification.

---

## Table of Contents

1. [Audit Scope & Pinned Baseline](#1-audit-scope--pinned-baseline)
   - [Pinned Commit & Toolchain](#pinned-commit--toolchain)
   - [In-Scope Artifacts](#in-scope-artifacts)
   - [Out-of-Scope Artifacts & Justifications](#out-of-scope-artifacts--justifications)
   - [Contract Attack Surface & Entrypoint Matrix](#contract-attack-surface--entrypoint-matrix)
2. [Protocol Invariants & Enforcement Matrix](#2-protocol-invariants--enforcement-matrix)
3. [Trust Model, Privileged Roles & Storage Architecture](#3-trust-model-privileged-roles--storage-architecture)
   - [Privileged Powers](#privileged-powers)
   - [Role-Based Access Control (RBAC)](#role-based-access-control-rbac)
   - [Storage Layout & Lifecycle (TTL)](#storage-layout--lifecycle-ttl)
4. [Known Limitations & Residual Risks](#4-known-limitations--residual-risks)
5. [Build, Test & Verification Instructions](#5-build-test--verification-instructions)
6. [Cross-Document References](#6-cross-document-references)
7. [Disagreements: Existing Docs vs. Contract Source](#7-disagreements-existing-docs-vs-contract-source)
8. [Open Items for Maintainers](#8-open-items-for-maintainers)

---

## 1. Audit Scope & Pinned Baseline

### Pinned Commit & Toolchain

- **Target Repository**: `Ac0rdP/AccordProtocol`
- **Pinned Commit Hash**: `eeab819a9d7fb8fbf2003c2aaad50eb55c918341`
- **Rust Toolchain**: `rustc 1.85.0` (stable)
- **Target Architecture**: `wasm32v1-none`
- **Soroban SDK**: `=25.3.1` (pinned in root [`Cargo.toml`](../Cargo.toml))
- **Stellar CLI**: `v25.0.0`
- **Node.js Environment**: `v20.x` LTS

### In-Scope Artifacts

The audit scope comprises the core smart contract implementation, internal validation modules, and Cargo configuration defining the contract dependencies and compiler profiles:

| File Path | Component | Language / Format | Role & Purpose |
|---|---|---|---|
| [`contracts/accord/src/lib.rs`](../contracts/accord/src/lib.rs) | Contract Implementation | Rust (`no_std`) | Core multisig state, governance, proposal lifecycle, guardian freeze, and token interaction logic. |
| [`contracts/accord/src/validate.rs`](../contracts/accord/src/validate.rs) | Input Validation | Rust (`no_std`) | Validation helpers for proposal deadlines and description length boundaries. |
| [`contracts/accord/Cargo.toml`](../contracts/accord/Cargo.toml) | Contract Manifest | TOML | Declares dependencies (`soroban-sdk`) and coverage thresholds. |
| [`Cargo.toml`](../Cargo.toml) | Workspace Manifest | TOML | Declares workspace resolver and release profile settings (`opt-level = "z"`, `overflow-checks = true`, `panic = "abort"`). |

*Total In-Scope Contract Source Code*: 4,932 lines of Rust.

---

### Out-of-Scope Artifacts & Justifications

The following repository components are strictly **out-of-scope** for the on-chain smart contract audit:

1. **Frontend Application (`frontend/`)**:
   - *Reason*: Client-side React 19 application. It operates in an untrusted browser context, does not custody private keys, and interacts with the contract solely via public RPC simulations and Freighter wallet signing.
2. **Indexer Service (`indexer/`)**:
   - *Reason*: Off-chain Node.js service that subscribes to Soroban RPC events. It is advisory only and has no authority or mechanism to mutate on-chain state.
3. **Analytics API (`analytics-api/`)**:
   - *Reason*: Off-chain Axum/Rust HTTP service querying indexed PostgreSQL data. Advisory only.
4. **Client SDK (`packages/sdk/`)**:
   - *Reason*: Off-chain TypeScript wrapper for RPC simulation and XDR serialization. Key handling is delegated to caller-supplied signing callbacks.
5. **Example Applications (`examples/`)**:
   - *Reason*: Sample integration code demonstrating SDK usage for third-party developers.
6. **Third-Party External Dependencies**:
   - *Reason*: The Soroban SDK (`soroban-sdk`) and the underlying Stellar network protocol/host environment are audited and maintained upstream by the Stellar Development Foundation.

---

### Contract Attack Surface & Entrypoint Matrix

The table below lists every public entrypoint and view exposed by `contracts/accord/src/lib.rs`:

| Entrypoint / View | Category | Caller Authorization | State Changed | Errors Possible (Codes) | Events Emitted |
|---|---|---|---|---|---|
| `initialize(owners, threshold, time_lock, weights)` | State Init | Uninitialized deployer | Instance: `INIT`, `THRESH`, `TLOCK`, `STOVER`, `TWGT`, `MAXOWNP`. Persistent: `OWNERS`. | 1 (`AlreadyInitialized`), 4 (`InvalidThreshold`), 5 (`InvalidOwners`), 19 (`DuplicateOwner`), 42 (`InvalidWeightsLength`), 43 (`WeightBelowMinimum`), 44 (`InvalidWeight`), 46 (`SingleOwnerWeightCapExceeded`), 50 (`ThresholdExceedsOwnerCount`) | — |
| `create_proposal(proposer, transfers, description, deadline, category)` | Proposal Creation | `proposer.require_auth()` + `Role::Proposer` | Instance: `ACTCNT`, `NEXT`. Persistent: `PROP`, `SPENT`. | 2 (`NotInitialized`), 3 (`Unauthorized`), 7 (`ProposalNotActive`), 12 (`InvalidAmount`), 13 (`InvalidDeadline`), 14 (`InvalidToken`), 16 (`EmptyDescription`), 17 (`DescriptionTooLong`), 18 (`TooManyActiveProposals`), 21 (`InvalidDuration`), 26 (`ContractFrozen`), 31 (`SpendingLimitExceeded`), 52 (`MissingRole`) | `ProposalCreatedEvent` (`created`) |
| `create_proposal_with_attachment(proposer, transfers, description, deadline, category, attachment_hash)` | Proposal Creation | Same as `create_proposal` | Same as `create_proposal` + stores `attachment_hash` in `PROP`. | Same as `create_proposal` | `ProposalCreatedEvent` (`created`) |
| `create_asset_proposal(proposer, transfers, description, deadline, category)` | Proposal Creation | Same as `create_proposal` | Same as `create_proposal` (resolves classic SAC references) | Same as `create_proposal` + 14 (`InvalidToken`) | `ProposalCreatedEvent` (`created`) |
| `create_add_owner_proposal(proposer, new_owner, weight, description, deadline, category)` | Governance Proposal | `proposer.require_auth()` + `Role::Proposer` | Instance: `ACTCNT`, `NEXT`. Persistent: `PROP`. | Same as `create_proposal` + 5 (`InvalidOwners`), 19 (`DuplicateOwner`), 43 (`WeightBelowMinimum`), 44 (`InvalidWeight`), 46 (`SingleOwnerWeightCapExceeded`) | `ProposalCreatedEvent` (`created`) |
| `create_remove_owner_proposal(proposer, owner_to_remove, description, deadline, category)` | Governance Proposal | `proposer.require_auth()` + `Role::Proposer` | Instance: `ACTCNT`, `NEXT`. Persistent: `PROP`. | Same as `create_proposal` + 24 (`WouldBreakThreshold`), 25 (`OwnerNotFound`), 48 (`WouldBreakQuorum`), 49 (`CannotRemoveLastOwner`) | `ProposalCreatedEvent` (`created`) |
| `create_change_threshold_proposal(proposer, new_threshold, description, deadline, category)` | Governance Proposal | `proposer.require_auth()` + `Role::Proposer` | Instance: `ACTCNT`, `NEXT`. Persistent: `PROP`. | Same as `create_proposal` + 4 (`InvalidThreshold`) | `ProposalCreatedEvent` (`created`) |
| `create_change_weight_proposal(proposer, target_owner, new_weight, description, deadline, category)` | Governance Proposal | `proposer.require_auth()` + `Role::Proposer` | Instance: `ACTCNT`, `NEXT`. Persistent: `PROP`. | Same as `create_proposal` + 25 (`OwnerNotFound`), 43 (`WeightBelowMinimum`), 44 (`InvalidWeight`), 46 (`SingleOwnerWeightCapExceeded`), 48 (`WouldBreakQuorum`) | `ProposalCreatedEvent` (`created`) |
| `create_spending_limit_proposal(...)` | Governance Proposal | `proposer.require_auth()` + `Role::Proposer` | Instance: `ACTCNT`, `NEXT`. Persistent: `PROP`. | Same as `create_proposal` + 25 (`OwnerNotFound`) | `ProposalCreatedEvent` (`created`) |
| `create_spending_window_proposal(...)` | Governance Proposal | `proposer.require_auth()` + `Role::Proposer` | Instance: `ACTCNT`, `NEXT`. Persistent: `PROP`. | Same as `create_proposal` + 25 (`OwnerNotFound`), 21 (`InvalidDuration`) | `ProposalCreatedEvent` (`created`) |
| `create_recurring_proposal(...)` | Recurring Proposal | `proposer.require_auth()` + `Role::Proposer` | Instance: `ACTCNT`, `NEXT`. Persistent: `PROP`. | Same as `create_proposal` + 28 (`InvalidInterval`), 30 (`InvalidCap`), 37 (`TooManyActiveRecurring`) | `ProposalCreatedEvent` (`created`) |
| `create_cancel_recurring_proposal(proposer, schedule_id, ...)` | Recurring Governance | `proposer.require_auth()` + `Role::Proposer` | Instance: `ACTCNT`, `NEXT`. Persistent: `PROP`. | Same as `create_proposal` + 32 (`RecurringPaymentNotFound`), 38 (`ScheduleAlreadyCancelled`) | `ProposalCreatedEvent` (`created`) |
| `create_pause_recurring_proposal(proposer, schedule_id, ...)` | Recurring Governance | `proposer.require_auth()` + `Role::Proposer` | Instance: `ACTCNT`, `NEXT`. Persistent: `PROP`. | Same as `create_proposal` + 32 (`RecurringPaymentNotFound`), 39 (`ScheduleAlreadyPaused`), 41 (`ScheduleTerminal`) | `ProposalCreatedEvent` (`created`) |
| `create_resume_recurring_proposal(proposer, schedule_id, ...)` | Recurring Governance | `proposer.require_auth()` + `Role::Proposer` | Instance: `ACTCNT`, `NEXT`. Persistent: `PROP`. | Same as `create_proposal` + 32 (`RecurringPaymentNotFound`), 40 (`ScheduleNotPaused`), 41 (`ScheduleTerminal`) | `ProposalCreatedEvent` (`created`) |
| `create_modify_recurring_proposal(...)` | Recurring Governance | `proposer.require_auth()` + `Role::Proposer` | Instance: `ACTCNT`, `NEXT`. Persistent: `PROP`. | Same as `create_proposal` + 28 (`InvalidInterval`), 32 (`RecurringPaymentNotFound`), 41 (`ScheduleTerminal`) | `ProposalCreatedEvent` (`created`) |
| `create_grant_role_proposal(proposer, target, role, ...)` | Governance Proposal | `proposer.require_auth()` + `Role::Proposer` | Instance: `ACTCNT`, `NEXT`. Persistent: `PROP`. | Same as `create_proposal` + 53 (`RoleAlreadyGranted`), 55 (`InvalidRole`) | `ProposalCreatedEvent` (`created`) |
| `create_revoke_role_proposal(proposer, target, role, ...)` | Governance Proposal | `proposer.require_auth()` + `Role::Proposer` | Instance: `ACTCNT`, `NEXT`. Persistent: `PROP`. | Same as `create_proposal` + 54 (`RoleNotGranted`), 55 (`InvalidRole`) | `ProposalCreatedEvent` (`created`) |
| `approve(approver, proposal_id)` | Voting | `approver.require_auth()` + `Role::Approver` (or Owner) | Persistent: `PROP` (accumulates weight, `ready_at`), `APPR`. | 2, 3, 6 (`ProposalNotFound`), 7 (`ProposalNotActive`), 8 (`AlreadyApproved`), 11 (`ProposalExpired`), 26 (`ContractFrozen`), 52 | `ProposalApprovedEvent` (`approved`) |
| `revoke(approver, proposal_id)` | Voting | `approver.require_auth()` | Persistent: `PROP` (subtracts weight, resets `ready_at`), `APPR`. | 2, 3, 6, 7, 9 (`NotApproved`), 11, 26 | `ProposalRevokedEvent` (`revoked`) |
| `execute(executor, proposal_id)` | Execution | `executor.require_auth()` + `Role::Executor` (or Owner) | Modifies target state based on proposal kind; marks `PROP.status = Executed`; decrements `ACTCNT`. Transfers external tokens if `Transfer`. | 2, 3, 6, 7, 10 (`ThresholdNotMet`), 11, 15 (`TransferFailed`), 23 (`TimeLockActive`), 26 (`ContractFrozen`), 57 (`RecoveryActive` on transfer), 31 | `ProposalExecutedEvent` (`executed`), variant executed events |
| `cancel_expired(caller, ids)` | Housekeeping | `caller.require_auth()` | Sets `PROP.status = Expired`; decrements `ACTCNT`. | 2, 3, 26 | — |
| `disburse_recurring(caller, schedule_id)` | Outflow Execution | `caller.require_auth()` | Persistent: `RPAY` (updates `total_disbursed`, `periods_disbursed`, `last_disbursed_at`). Transfers tokens. | 2, 3, 15, 26, 32, 33 (`RecurringPaymentNotDue`), 34 (`RecurringPaymentComplete`), 35 (`RecurringPaymentInactive`), 36 (`RecurringIntervalNotElapsed`), 57 (`RecoveryActive`) | `RecurringPaymentDisbursedEvent` (`rpay`) |
| `set_guardian(approvers, new_guardian)` | Governance Admin | `require_weighted_approvers(approvers)` >= threshold | Instance: `GUARD`. | 2, 3, 10, 24 | `GuardianSetEvent` (`guard_set`) |
| `freeze(guardian)` | Emergency Admin | `guardian.require_auth()` | Instance: `FROZEN = true`. | 2, 3, 27 (`NoGuardian`) | `FrozenEvent` (`frozen`) |
| `unfreeze(approvers)` | Emergency Admin | `require_weighted_approvers(approvers)` >= threshold | Instance: `FROZEN = false`. | 2, 3, 10 | `UnfrozenEvent` (`unfrozen`) |
| `enter_recovery(guardian)` | Emergency Admin | `guardian.require_auth()` | Instance: `RECOV = true`. | 2, 3, 27 | `RecoveryEnteredEvent` (`recov_on`) |
| `exit_recovery(approvers)` | Emergency Admin | `require_weighted_approvers(approvers)` >= threshold | Instance: `RECOV = false`. | 2, 3, 10 | `RecoveryExitedEvent` (`recov_off`) |
| `set_classic_asset(approvers, identifier, sac)` | Config Admin | `require_weighted_approvers(approvers)` >= threshold | Instance: `CLASSIC`. | 2, 3, 10, 14 | — |
| `set_max_single_owner_weight_pct(approvers, max_pct)` | Parameter Admin | `require_weighted_approvers(approvers)` >= threshold | Instance: `MAXOWNP`. | 2, 3, 10, 44 (`InvalidWeight`) | — |
| `upgrade(approvers, new_wasm_hash)` | Code Upgrade | `require_weighted_approvers(approvers)` >= threshold | In-place bytecode replacement via `deployer().update_current_contract_wasm`. | 2, 3, 10 | `UpgradeExecutedEvent` (`upgraded`) |
| `migrate_to_weighted_governance(approvers, weights)` | Migration Admin | `require_weighted_approvers(approvers)` >= threshold | Instance: `GOVVER = true`, `TWGT`. Persistent: `OWNERS`. | 2, 3, 10, 42, 43, 44, 45 (`AlreadyMigrated`), 46 | `GovernanceMigratedEvent` (`gov_migr`) |
| `migrate_to_rbac(approvers)` | Migration Admin | `require_weighted_approvers(approvers)` >= threshold | Instance: `ROLEVER = 1`. Persistent: `ROLES`, `RMEM`. | 2, 3, 10, 45 (`AlreadyMigrated`) | `RbacMigratedEvent` (`rbac_migr`) |
| Views (`get_proposal`, `get_owners`, `get_threshold`, `get_total_weight`, `is_frozen`, `is_in_recovery`, etc.) | Read-Only | None (Public simulation) | None (Read-only simulation) | None / View specific errors | None |

---

## 2. Protocol Invariants & Enforcement Matrix

The table below catalogs the invariant guarantees enforced by the protocol, the exact code functions responsible for enforcement, and the test cases that verify each invariant:

| Invariant Description | Mathematical / State Rule | Enforcing Code Location | Exercising Unit Tests in `contracts/accord/src/test.rs` |
|---|---|---|---|
| **Threshold Lower Bound** | `threshold >= 1` | `contracts/accord/src/lib.rs::validate_threshold` | `initialize_rejects_threshold_zero`, `change_threshold_rejects_zero` |
| **Threshold Upper Bound** | `threshold <= total_weight` | `contracts/accord/src/lib.rs::validate_threshold` | `initialize_rejects_threshold_above_total_weight`, `change_threshold_proposal_validates_against_total_weight` |
| **Owner Count Bounds** | `1 <= count(owners) <= 20` | `contracts/accord/src/lib.rs::require_owner_bounds`, `execute` | `initialize_accepts_maximum_owners`, `execute_add_owner_rejects_when_at_cap` |
| **Non-Zero Owner Weight** | `weight >= 1` (`MIN_OWNER_WEIGHT`) | `contracts/accord/src/lib.rs::require_weight_bounds` | `initialize_rejects_owner_weight_of_zero_and_leaves_uninitialized`, `execute_change_weight_rejects_zero` |
| **Single Owner Weight Cap** | `weight * 100 <= total_weight * max_single_owner_weight_pct (50%)` | `contracts/accord/src/lib.rs::owner_weight_within_cap` | `initialize_rejects_owner_weight_above_max`, `execute_change_weight_rejects_above_cap` |
| **Quorum Preservation on Removal** | `(total_weight - removed_owner_weight) >= threshold` | `contracts/accord/src/lib.rs::create_remove_owner_proposal`, `execute` | `remove_owner_rejected_when_remaining_weight_below_threshold`, `test_quorum_matrix_remove_owner_and_change_threshold_blocked` |
| **Cannot Remove Last Owner** | `count(owners) > 1` | `contracts/accord/src/lib.rs::create_remove_owner_proposal`, `execute` | `remove_last_owner_rejected` |
| **Quorum Snapshotted at Creation** | `proposal.quorum_weight` remains constant across owner changes | `contracts/accord/src/lib.rs::create_proposal`, `derive_status` | `quorum_weight_unchanged_when_owner_added`, `test_proposal_created_event_snapshots_weights` |
| **Approval Non-Duplication** | An owner can approve at most once per proposal | `contracts/accord/src/lib.rs::approve` | `approve_rejects_already_approved`, `approve_rejects_double_approval_across_weight_changes` |
| **Revocation Balance** | An owner can only revoke if currently approved | `contracts/accord/src/lib.rs::revoke` | `revoke_rejects_not_approved`, `revoke_transitions_back_to_pending` |
| **Emergency Freeze Exclusivity** | Only stored guardian can freeze or enter recovery | `contracts/accord/src/lib.rs::freeze`, `enter_recovery` | `freeze_rejects_non_guardian`, `recovery_blocks_value_but_allows_governance` |
| **Emergency Resumption Quorum** | Resumption requires distinct owners with combined weight >= threshold | `contracts/accord/src/lib.rs::unfreeze`, `exit_recovery` | `unfreeze_weight_sufficient_succeeds`, `unfreeze_weight_insufficient_fails` |
| **Outflow Lock in Recovery** | `execute` (transfers) and `disburse_recurring` blocked during recovery | `contracts/accord/src/lib.rs::execute`, `disburse_recurring` | `recovery_blocks_value_but_allows_governance` |
| **Transfer Failure Reversion** | If any token transfer fails, execution reverts completely; proposal remains `Ready` | `contracts/accord/src/lib.rs::execute`, `disburse_recurring` | `execute_with_trapping_token_preserves_state`, `execute_with_false_returning_token_is_rejected_and_preserves_state`, `execute_with_reentrant_token_is_rejected_and_preserves_state` |
| **Time-Lock Integrity** | Proposals cannot be executed until `ready_at + timelock_delay <= now` | `contracts/accord/src/lib.rs::execute` | `execute_rejects_when_timelock_active`, `execute_succeeds_after_timelock_elapsed` |
| **Active Proposal Cap** | At most 50 active (`Pending` + `Ready`) proposals | `contracts/accord/src/lib.rs::create_proposal` | `create_proposal_rejects_when_active_proposals_at_cap`, `cancel_expired_frees_active_slots` |

---

## 3. Trust Model, Privileged Roles & Storage Architecture

### Privileged Powers

Accord Protocol enforces a decentralized trust hierarchy:

```text
               ┌────────────────────────────────────────────────────────┐
               │                     GUARDIAN                           │
               │  - freeze()            (halts all operations)          │
               │  - enter_recovery()    (halts treasury outflows only)  │
               └───────────────────────────┬────────────────────────────┘
                                           │
         ┌─────────────────────────────────┴─────────────────────────────────┐
         │                                                                   │
         ▼                                                                   ▼
┌─────────────────────────────────┐                         ┌─────────────────────────────────┐
│     MULTISIG OWNERS (QUORUM)    │                         │         ROLE HOLDERS            │
│  Weight sum >= Threshold        │                         │  Assigned per-address           │
│  - unfreeze() / exit_recovery() │                         │  - Proposer: create_proposal()  │
│  - upgrade() (in-place code)    │                         │  - Approver: approve/revoke()   │
│  - set_guardian()               │                         │  - Executor: execute()          │
│  - set_max_single_owner_pct()   │                         │  - Viewer: read marker          │
│  - execute governance proposals │                         └─────────────────────────────────┘
└─────────────────────────────────┘
```

1. **The Guardian**:
   - Single designated address (`GUARD`).
   - Powers are strictly defensive: can immediately pause all contract functions (`freeze`) or pause financial outflows while leaving governance active (`enter_recovery`).
   - The Guardian **cannot** withdraw funds, approve proposals, alter voting weights, or upgrade contract code.
2. **Multisig Owners (Threshold Quorum)**:
   - Supreme governance authority.
   - Requires co-authorization from distinct registered owners whose cumulative weight reaches or exceeds `threshold`.
   - Authorized to: upgrade bytecode (`upgrade`), replace guardian (`set_guardian`), resume operations (`unfreeze`, `exit_recovery`), set governance parameters, and execute approved multisig proposals.

### Role-Based Access Control (RBAC)

When RBAC is active (`ROLEVER = 1`), routine operational actions require specific roles granted via on-chain governance proposals:
- `Role::Proposer`: authorized to submit new proposals.
- `Role::Approver`: authorized to approve or revoke proposals.
- `Role::Executor`: authorized to execute proposals that have reached `Ready` status and passed any required time-lock delay.
- `Role::Viewer`: informational non-voting role.

Owners hold default roles (`DEFAULT_OWNER_ROLES = [Proposer, Approver, Executor]`).


---

### Storage Layout & Lifecycle (TTL)

Accord Protocol partitions on-chain data into **Instance Storage** (contract-wide variables sharing one ledger entry) and **Persistent Storage** (individually tracked ledger entries):

#### Instance Storage Layout

- **Shared Ledger Entry**: All instance keys live in the contract's instance entry.
- **TTL Window**: `INSTANCE_BUMP = 518,400 ledgers` (~30 days). Bumped whenever remaining TTL falls below `INSTANCE_THRESHOLD = 17,280 ledgers` (~1 day).
- **Keys Stored**:
  - `INIT` (`bool`): Initialization guard.
  - `THRESH` (`u32`): Approval threshold weight.
  - `NEXT` (`u64`): Monotonic proposal ID sequence counter.
  - `ACTCNT` (`u32`): Count of active (`Pending` + `Ready`) proposals.
  - `TWGT` (`u32`): Cached total voting weight of all owners.
  - `TLOCK` (`u64`): Mandatory execution delay in seconds after reaching quorum.
  - `GUARD` (`Address`): Active guardian address.
  - `FROZEN` (`bool`): Emergency freeze flag.
  - `RECOV` (`bool`): Treasury recovery flag.
  - `RPNEXT` (`u64`): Monotonic recurring schedule ID counter.
  - `ACTREC` (`u32`): Count of active recurring payment schedules.
  - `GOVVER` (`bool`): Flag indicating migration to weighted governance.
  - `ROLEVER` (`u32`): Role schema version.
  - `STOVER` (`u32`): Storage schema version (`STORAGE_SCHEMA_VERSION = 1`).
  - `MAXOWNP` (`u32`): Maximum single-owner voting weight percentage cap.
  - `("CLASSIC", symbol)` (`Address`): Mapping from classic asset symbols (`XLM`, `USDC`, `EURC`) to Stellar Asset Contract addresses.

#### Persistent Storage Layout

Each persistent entry is a standalone `LedgerEntry` with its own TTL (`PERSISTENT_BUMP = 518,400 ledgers`, `PERSISTENT_THRESHOLD = 17,280 ledgers`):

| Key Pattern | Value Type | Description |
|---|---|---|
| `OWNERS` | `Map<Address, u32>` | Map of registered owner addresses to their voting weights (max 20). |
| `("PROP", id)` | `Proposal` | Proposal state (kind, description, deadline, attachments, status, snapshotted quorum). |
| `("APPR", id, owner)` | `u32` | Vote weight contributed by `owner` to proposal `id`. |
| `("RPAY", id)` | `RecurringPayment` | Configuration and disbursement progress of recurring payment schedule `id`. |
| `("SPLIM", owner, token)` | `i128` | Per-owner, per-token spending cap. |
| `("OSLIM", owner)` | `Vec<SpendingLimitEntry>` | Catalog of all tokens with configured spending limits for `owner`. |
| `("SPENT", owner, token)` | `SpentTracker` | Cumulative spent amount within current epoch window. |
| `("SWIND", owner, token)` | `u64` | Custom spending accounting window in seconds. |
| `("ROLES", address)` | `Vec<Role>` | List of granted roles for `address`. |
| `("RMEM", role)` | `Vec<Address>` | Set of addresses currently holding `role`. |
| `("DELEG", delegator)` | `Delegation` | Active voting weight delegation from `delegator` to another owner. |

---

## 4. Known Limitations & Residual Risks

Cross-checked against [`docs/SECURITY.md`](./SECURITY.md) and contract source:

1. **Malicious External Token Contracts**:
   - *Risk*: A rogue token contract can lie about its balance or execute a no-op inside `transfer` while returning success.
   - *Mitigation*: The contract validates that `transfer` returns `Ok(Ok(()))` (unit result) via `transfer_succeeded`, checks pre-transfer balances with `try_balance`, and relies on Soroban's native anti-reentrancy rules. Proposers and approvers are responsible for inspecting token contract IDs before approving transfers.
2. **Active Proposal Cap Denial-of-Service**:
   - *Risk*: An authorized owner can flood the contract with proposals up to `MAX_ACTIVE_PROPOSALS = 50`, blocking new proposals until deadlines expire.
   - *Mitigation*: The public `cancel_expired` entrypoint allows any caller to prune expired proposals without owner co-signatures.
3. **Single Owner Key Compromise**:
   - *Risk*: A compromised owner key can submit proposals and approve them up to that owner's weight.
   - *Mitigation*: The 50% single-owner weight cap ensures no single compromised key can meet quorum alone. Uncompromised owners can use recovery mode (`enter_recovery`) to freeze transfers while executing a removal proposal.
4. **Opt-In Spending Limits**:
   - *Risk*: Spending limits are opt-in per (owner, token) pair. Owners without an explicit entry have unrestricted proposal creation rights up to treasury balance.
   - *Mitigation*: Enforced at creation time; M-of-N threshold remains the primary authorization boundary.
5. **Storage TTL Dormancy**:
   - *Risk*: If a contract instance receives zero invocations for >30 days (518,400 ledgers), instance storage can become archived.
   - *Mitigation*: Handled via standard Soroban rent restoration if required. Normal usage automatically extends TTL.

---

## 5. Build, Test & Verification Instructions

Commands verified on a clean checkout at pinned commit `eeab819a9d7fb8fbf2003c2aaad50eb55c918341`:

### 1. Build Smart Contract WASM
```bash
stellar contract build
```
*Expected Output*: Produces optimized bytecode at `target/wasm32v1-none/release/accord.wasm`.

### 2. Run Comprehensive Test Suite
```bash
cd contracts/accord
cargo test -- --nocapture
```
*Actual Verified Result*: **315 unit tests passed; 0 failed; 0 ignored**.

### 3. Check Clippy Lints
```bash
cd contracts/accord
cargo clippy -- -D warnings
```
*Actual Verified Result*: Clean build; 0 warnings.

### 4. Verify Code Formatting
```bash
cd contracts/accord
cargo fmt --check
```
*Actual Verified Result*: Clean; 0 formatting errors.

---

## 6. Cross-Document References

- **Architecture & System Design**: [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)
- **Security Policy & Threat Model**: [`docs/SECURITY.md`](./SECURITY.md)
- **Contract API Reference**: [`docs/CONTRACT_API.md`](./CONTRACT_API.md)
- **Event Schema Reference**: [`docs/EVENTS.md`](./EVENTS.md)
- **Deployment Procedures**: [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md)
- **Operational Runbooks**:
  - [Runbooks Index](./runbooks/README.md)
  - [Incident Response Runbook](./runbooks/INCIDENT_RESPONSE.md)
  - [Upgrade Rollback Runbook](./runbooks/UPGRADE_ROLLBACK.md)
  - [Key Rotation Runbook](./runbooks/KEY_ROTATION.md)

---

## 7. Disagreements: Existing Docs vs. Contract Source

During audit preparation, the following discrepancies were identified between existing documentation and actual contract code in `contracts/accord/src/lib.rs`:

1. **`upgrade()` Function Signature**:
   - *Doc Claim* ([`docs/DEPLOYMENT.md`](./DEPLOYMENT.md#upgrading-the-contract) and [`README.md`](../README.md)): Claims `upgrade` accepts `--caller <address>`.
   - *Code Reality*: `contracts/accord/src/lib.rs` line 4841 defines `pub fn upgrade(env: Env, approvers: Vec<Address>, new_wasm_hash: BytesN<32>)`. Upgrades require multi-owner co-authorization meeting threshold, not a single caller.
2. **Emergency Recovery Documentation**:
   - *Doc Claim* ([`docs/SECURITY.md`](./SECURITY.md#residual-risks)): States *"No SOS Recovery: If enough owner keys are lost, there is no emergency 'recovery' mode"*.
   - *Code Reality*: `contracts/accord/src/lib.rs` line 4787 and line 4803 explicitly implement `enter_recovery(guardian)` and `exit_recovery(approvers)` to halt value transfers while allowing governance remediation.
3. **Contract Error Code Catalog**:
   - *Doc Claim* ([`docs/CONTRACT_API.md`](./CONTRACT_API.md)): The error table lists error codes up to 56 (`DeprecatedEntrypoint`).
   - *Code Reality*: `contracts/accord/src/lib.rs` line 576 defines `RecoveryActive = 57`, returned when transfer execution is attempted while recovery mode is active.
4. **Unit Test Count in README**:
   - *Doc Claim* ([`README.md`](../README.md#4-run-the-contract-tests)): States *"29 unit tests covering all lifecycle paths"*.
   - *Code Reality*: `contracts/accord/src/test.rs` currently contains **315 unit tests**, representing significantly broader test coverage added in recent development waves.

---

## 8. Open Items for Maintainers

The following operational and organizational items are not documented in the repository and must be provided by maintainers prior to audit commencement:

- [ ] **Formal Prior Audit Reports**: Confirm if any private or preliminary security reviews were conducted.
- [ ] **Production Deployment Addresses**: Publish official mainnet and public testnet contract addresses and verification records.
- [ ] **Designated Security Contact**: Publish an official security contact email and PGP fingerprint for vulnerability disclosure.
- [ ] **Bug Bounty Scope & Terms**: Formalize bounty program parameters and reward tiers for responsible disclosure.
