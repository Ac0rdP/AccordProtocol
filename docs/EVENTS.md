# Accord Protocol Event Catalog

This document outlines all the custom events emitted by the Accord Protocol contract (`contracts/accord/src/lib.rs`). 

For a complete guide on polling, decoding, and streaming these events from external applications via Soroban RPC, see the [Contract Integration Guide](./CONTRACT_INTEGRATION_GUIDE.md#consuming--decoding-events).

The events are mapped by their primary topic (a `symbol_short!` or `Symbol`) to their payload struct.

| Topic Name     | Struct Name                      | Payload Description |
|----------------|----------------------------------|---------------------|
| `migrated`     | `GovernanceMigratedEvent`        | `{ owner_count: u32, total_weight: u32, version: u32 }` |
| `rbac_migrated`| `RbacMigratedEvent`              | `{ owner_count: u32, role_version: u32, version: u32 }` |
| `created`      | `ProposalCreatedEvent`           | `{ id: u64, proposer: Address, threshold: u32, category: ProposalCategory, transfers: Vec<Transfer>, quorum_weight: u32, total_weight_at_creation: u32, version: u32 }` |
| `rpay`         | `RecurringPaymentDisbursedEvent` | `{ schedule_id: u64, recipient: Address, token: Address, amount: i128, total_disbursed: i128, periods_disbursed: u32, version: u32 }` |
| `approved`     | `ProposalApprovedEvent`          | `{ id: u64, approver: Address, approvals: u32, threshold: u32, weight: u32, cumulative_weight: u32, version: u32 }` |
| `revoked`      | `ProposalRevokedEvent`           | `{ id: u64, approver: Address, approvals: u32, weight: u32, cumulative_weight: u32, version: u32 }` |
| `executed`     | `ProposalExecutedEvent`          | `{ id: u64, executor: Address, transfers: Vec<Transfer>, version: u32 }` |
| `guard_set`    | `GuardianSetEvent`               | `{ guardian: Address, version: u32 }` |
| `frozen`       | `FrozenEvent`                    | `{ guardian: Address, version: u32 }` |
| `unfrozen`     | `UnfrozenEvent`                  | `{ approvers: Vec<Address>, version: u32 }` |
| `r_pause`      | `RecurringPaymentPausedEvent`    | `{ id: u64, caller: Address, version: u32 }` |
| `r_resum`      | `RecurringPaymentResumedEvent`   | `{ id: u64, caller: Address, version: u32 }` |
| `r_mod`        | `RecurringPaymentModifiedEvent`  | `{ schedule_id: u64, previous_amount: i128, new_amount: i128, previous_interval: u64, new_interval: u64, previous_end_time: u64, new_end_time: u64, version: u32 }` |
| `r_crt`        | `RecurringPaymentCreatedEvent`   | `{ id: u64, proposer: Address, recipient: Address, token: Address, amount: i128, interval_secs: u64, start_time: u64, end_time: u64, cliff_time: u64, total_cap: i128, kind: RecurringKind, version: u32 }` |
| `r_cncl`       | `RecurringPaymentCancelledEvent` | `{ id: u64, caller: Address, version: u32 }` |
| `upgraded`     | `UpgradeExecutedEvent`           | `{ caller: Address, new_wasm_hash: BytesN<32>, version: u32 }` |
| `a_own`        | `AddOwnerExecutedEvent`          | `{ new_owner: Address, owner_count: u32, version: u32 }` |
| `r_own`        | `RemoveOwnerExecutedEvent`       | `{ removed_owner: Address, owner_count: u32, version: u32 }` |
| `c_thr`        | `ChangeThresholdExecutedEvent`   | `{ previous_threshold: u32, new_threshold: u32, version: u32 }` |
| `s_lim`        | `SetSpendingLimitExecutedEvent`  | `{ owner: Address, token: Address, previous_limit: Option<i128>, new_limit: i128, version: u32 }` |
| `c_wgt`        | `OwnerWeightChangedEvent`        | `{ owner: Address, old_weight: u32, new_weight: u32, new_total_weight: u32, version: u32 }` |
| `role_granted` | `RoleGrantedEvent`               | `{ target: Address, role: Role, before: Vec<Role>, after: Vec<Role>, version: u32 }` |
| `role_revoked` | `RoleRevokedEvent`               | `{ target: Address, role: Role, before: Vec<Role>, after: Vec<Role>, version: u32 }` |

Every payload carries a trailing `version: u32` field holding the event-schema version (see [Event Versioning Policy](#event-versioning-policy)).

This catalog is loaded by the off-chain indexer to decode raw contract events deterministically.

## Event Versioning Policy

Every event payload includes a `version: u32` field set to `EVENT_SCHEMA_VERSION`, a single public constant in `contracts/accord/src/lib.rs`. It is the only place the version is defined; bump it there and every event picks up the new value.

**Current version: `1`.** Version `1` is the first versioned schema. Events emitted by deployments that predate the field have no `version`; consumers should treat a missing field as "unversioned" (the indexer stores it as `NULL`).

### When the version is bumped

`EVENT_SCHEMA_VERSION` increases by one whenever any event struct gains, loses, renames, reorders the meaning of, or changes the type of a field, or when a topic name changes. The version is global, not per event: a change to one event bumps the number carried by all events. Record each bump in the history comment on the constant and in the table below.

| Version | Change |
|---------|--------|
| `1` | Initial versioned schema: every event struct gains `version`. |

### Stability guarantees for consumers

Within a given schema version, consumers can rely on:

- **Topic names** and the topic-to-struct mapping in the catalog above do not change.
- **Field names and types** of an event do not change. Fields are never repurposed under the same name.
- **`version` is always present** on events emitted by a versioned deployment, and always equals the schema version the emitting WASM was built with.
- **Emission semantics** (which action emits which event, once per successful call) do not change.

What may change, and always with a version bump:

- Adding, removing, or renaming a field on any event.
- Changing a field's type or units.
- Adding new topics. New topics are additive, but they still bump the version so consumers learn the schema moved.

What is **not** guaranteed:

- The relative order of events emitted within a single transaction.
- Events from before a contract upgrade being rewritten; old events keep the version they were emitted with, so a single indexer may see several versions side by side.

### Guidance for indexers

- Read `version` from every payload and store it with the event. The Accord indexer records it in the `schema_version` column of `accord_events` and returns it as `schemaVersion` from its store.
- Decode by `version`, not by assuming the latest shape. Reject or quarantine events whose version is higher than the highest version your decoder supports instead of guessing at fields.
- Keep decoders for older versions as long as you index history that contains them.
