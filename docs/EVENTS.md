# Accord Protocol Event Catalog

This document outlines all the custom events emitted by the Accord Protocol contract (`contracts/accord/src/lib.rs`). 

The events are mapped by their primary topic (a `symbol_short!` or `Symbol`) to their payload struct.

| Topic Name     | Struct Name                      | Payload Description |
|----------------|----------------------------------|---------------------|
| `migrated`     | `GovernanceMigratedEvent`        | `{ owner_count: u32, total_weight: u32 }` |
| `rbac_migrated`| `RbacMigratedEvent`              | `{ owner_count: u32, role_version: u32 }` |
| `created`      | `ProposalCreatedEvent`           | `{ id: u64, proposer: Address, threshold: u32, category: ProposalCategory, transfers: Vec<Transfer>, quorum_weight: u32, total_weight_at_creation: u32 }` |
| `rpay`         | `RecurringPaymentDisbursedEvent` | `{ schedule_id: u64, recipient: Address, token: Address, amount: i128, total_disbursed: i128, periods_disbursed: u32 }` |
| `approved`     | `ProposalApprovedEvent`          | `{ id: u64, approver: Address, approvals: u32, threshold: u32, weight: u32, cumulative_weight: u32 }` |
| `revoked`      | `ProposalRevokedEvent`           | `{ id: u64, approver: Address, approvals: u32, weight: u32, cumulative_weight: u32 }` |
| `executed`     | `ProposalExecutedEvent`          | `{ id: u64, executor: Address, transfers: Vec<Transfer> }` |
| `guard_set`    | `GuardianSetEvent`               | `{ guardian: Address }` |
| `frozen`       | `FrozenEvent`                    | `{ guardian: Address }` |
| `unfrozen`     | `UnfrozenEvent`                  | `{ approvers: Vec<Address> }` |
| `r_pause`      | `RecurringPaymentPausedEvent`    | `{ id: u64, caller: Address }` |
| `r_resum`      | `RecurringPaymentResumedEvent`   | `{ id: u64, caller: Address }` |
| `r_mod`        | `RecurringPaymentModifiedEvent`  | `{ schedule_id: u64, previous_amount: i128, new_amount: i128, previous_interval: u64, new_interval: u64, previous_end_time: u64, new_end_time: u64 }` |
| `r_crt`        | `RecurringPaymentCreatedEvent`   | `{ id: u64, proposer: Address, recipient: Address, token: Address, amount: i128, interval_secs: u64, start_time: u64, end_time: u64, cliff_time: u64, total_cap: i128, kind: RecurringKind }` |
| `r_cncl`       | `RecurringPaymentCancelledEvent` | `{ id: u64, caller: Address }` |
| `upgraded`     | `UpgradeExecutedEvent`           | `{ caller: Address, new_wasm_hash: BytesN<32> }` |
| `a_own`        | `AddOwnerExecutedEvent`          | `{ new_owner: Address, owner_count: u32 }` |
| `r_own`        | `RemoveOwnerExecutedEvent`       | `{ removed_owner: Address, owner_count: u32 }` |
| `c_thr`        | `ChangeThresholdExecutedEvent`   | `{ previous_threshold: u32, new_threshold: u32 }` |
| `s_lim`        | `SetSpendingLimitExecutedEvent`  | `{ owner: Address, token: Address, previous_limit: Option<i128>, new_limit: i128 }` |
| `c_wgt`        | `OwnerWeightChangedEvent`        | `{ owner: Address, old_weight: u32, new_weight: u32, new_total_weight: u32 }` |
| `role_granted` | `RoleGrantedEvent`               | `{ target: Address, role: Role, before: Vec<Role>, after: Vec<Role> }` |
| `role_revoked` | `RoleRevokedEvent`               | `{ target: Address, role: Role, before: Vec<Role>, after: Vec<Role> }` |

This catalog is loaded by the off-chain indexer to decode raw contract events deterministically.
