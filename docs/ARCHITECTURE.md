# Accord Protocol — Architecture

## 1. System Overview
 
```text
┌──────────────────────────────┐
│     Web Client (Vite/React)  │
│  Proposal UI + Approval UX   │
└──────────────┬───────────────┘
               │ Freighter signing
               ▼
┌──────────────────────────────┐
│  Stellar JS SDK + Soroban    │
│  (@stellar/stellar-sdk)      │
└──────────────┬───────────────┘
               │ invokeHostFunction / simulateTransaction
               ▼
┌──────────────────────────────┐
│  Soroban RPC (Testnet)       │
│  soroban-testnet.stellar.org │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  accord Contract (Rust)      │
│  contracts/accord/src/lib.rs │
└──────────────┬───────────────┘
               │ emits events / stores state
               ▼
┌──────────────────────────────┐
│  Frontend Event Polling      │
│  query proposals + events    │
└──────────────────────────────┘
```

## 2. Contract ↔ Frontend Data Mapping

| Contract Function                                                     | Purpose                                          | Frontend Caller              |
| --------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------- |
| `initialize(owners, threshold)`                                       | One-shot init — sets owners and M-of-N threshold | Deployment script only       |
| `create_proposal(proposer, to, amount, token, description, deadline)` | Creates a transfer proposal                      | Proposal creation form       |
| `approve(approver, proposal_id)`                                      | Owner casts an approval vote                     | Proposal card approve button |
| `revoke(approver, proposal_id)`                                       | Owner withdraws their approval                   | Proposal card revoke button  |
| `execute(executor, proposal_id)`                                      | Executes a Ready proposal, transfers tokens      | Proposal card execute button |
| `get_proposal(proposal_id)`                                           | Reads a single proposal                          | Proposal detail page         |
| `get_proposals_paged(offset, limit)`                                  | Paginated proposal list                          | Dashboard list               |
| `get_owners()`                                                        | Returns owner list                               | Settings / owners panel      |
| `get_threshold()`                                                     | Returns approval threshold                       | Dashboard header stat        |
| `is_owner(address)`                                                   | Checks ownership for a connected wallet          | Wallet-connected gating      |
| `has_approved(proposal_id, owner)`                                    | Per-owner approval flag                          | Approval bar UI              |

## 3. Storage Layout (Soroban)

### Instance Storage (low-cost, short TTL)

All instance-storage keys share **one** `LedgerEntry` (the contract instance). The TTL bump and threshold apply to that single shared entry; all keys expire together.

| Key      | Type   | Description                               | TTL — bump / threshold (ledgers) |
| -------- | ------ | ----------------------------------------- | -------------------------------- |
| `INIT`   | `bool` | Initialization guard                      | 518,400 / 17,280                 |
| `THRESH` | `u32`  | Approval threshold                        | 518,400 / 17,280                 |
| `NEXT`   | `u64`  | Monotonic proposal ID counter             | 518,400 / 17,280                 |
| `ACTCNT` | `u32`  | Active proposal count (budget guard)      | 518,400 / 17,280                 |
| `TWGT`   | `u32`  | Cached total owner weight                  | 518,400 / 17,280                 |
| `TLOCK`  | `u64`  | Time-lock delay in seconds (0 = disabled) | 518,400 / 17,280                 |

**Instance entry cost**: all five keys together occupy roughly **~150 bytes** XDR-encoded (rounds to 1 KB for billing) → **~0.052 XLM per 30 days** (see [Storage Cost Methodology](#storage-cost-methodology) below).

### Persistent Storage (long TTL, bumped on access)

Each key is a separate `LedgerEntry` with its own independently tracked TTL.

| Key                   | Type               | Description                                | TTL — bump / threshold (ledgers) | Approx. cost (XLM / 30 days) |
| --------------------- | ------------------ | ------------------------------------------ | -------------------------------- | ---------------------------- |
| `OWNERS`              | `Map<Address,u32>` | Owner address → voting weight map (max 20) | 518,400 / 17,280                 | ~0.052 XLM                   |
| `("PROP", id)`        | `Proposal`         | Per-proposal state                         | 518,400 / 17,280                 | ~0.052 XLM                   |
| `("APPR", id, owner)` | `u32`              | Per-owner approval weight per proposal     | 518,400 / 17,280                 | ~0.052 XLM                   |

### Proposal Struct Fields

```
id               u64
proposer         Address
description      String        (max 300 chars)
deadline         u64           (Unix timestamp)
approvals        u32           (cumulative approval weight; kept in sync with approval_weight)
approval_weight  u32           (cumulative approval weight credited from approvers)
status           ProposalStatus
kind             ProposalKind  (Transfer | AddOwner | RemoveOwner | ChangeThreshold |
                                SetSpendingLimit | ChangeOwnerWeight | recurring variants)
ready_at         u64           (ledger time when quorum was first reached; 0 if not yet)
quorum_weight    u32           (threshold snapshotted at proposal creation)
category         ProposalCategory
```

### Key Naming Conventions

Soroban storage keys must be **short symbols** (≤ 9 bytes) because the XDR `Symbol` type allocates one byte per character with no heap overhead — longer names would require a `Bytes` type, adding allocation overhead and increasing each key's on-chain storage footprint.

Accord uses two patterns:

**Singleton keys** — short uppercase abbreviations for values that exist exactly once per deployed contract:

| Key      | Full meaning                        |
| -------- | ----------------------------------- |
| `INIT`   | Initialization guard                |
| `THRESH` | Approval threshold (M in M-of-N)    |
| `NEXT`   | Monotonic proposal ID counter       |
| `ACTCNT` | Count of currently active proposals |
| `TLOCK`  | Time-lock delay in seconds          |
| `TWGT`   | Cached total owner weight           |
| `OWNERS` | Owner address → weight map          |

**Tuple keys** — two- or three-part tuples for per-entity records, where the first element is a short symbol namespace:

| Tuple                 | Description                                             |
| --------------------- | ------------------------------------------------------- |
| `("PROP", id)`        | Proposal record keyed by proposal ID (u64)              |
| `("APPR", id, owner)` | Approval flag keyed by proposal ID and approver address |

Tuples are preferred over concatenated strings because Soroban hashes the entire key structure natively — string concatenation would require heap allocation and introduces ambiguity (`"PROP1"` vs `"PRO" + "P1"` are indistinguishable as strings, but distinct as tuples). Tuple keys are zero-copy, structurally unambiguous, and compose cleanly with Soroban's type-safe storage API.

### Lifecycle of Per-Owner Persistent Storage Entries

When an owner is removed from governance via `RemoveOwner`, the execution logic updates the `OWNERS` map and `TWEIGHT` (total weight) in storage. Per-owner persistent storage entries indexed by `Address` are not automatically swept or deleted upon owner removal:

- **Per-Proposal Approval Entries (`("APPR", id, owner)`)**: Persistent approval entries for removed owners remain in ledger storage. Calling `has_approved(proposal_id, address)` directly reads `APPR` and returns `true` for an approval recorded prior to removal. High-level view functions like `get_approvers(proposal_id)` iterate only currently registered owners in `OWNERS`, automatically excluding removed addresses from the active approvers list.
- **Spending Limit & Tracker Entries (`("SLIMIT", owner, token)` and `("SPENT", owner, token)`)**: Persistent spending limit bounds and tracking epochs are stored per `(owner, token)` pair and are not erased when an owner is removed.
- **Re-added Owner Inheritance**: If an address is removed and later re-added as an owner via `AddOwner`, any pre-existing `SLIMIT` and `SPENT` entries associated with that address remain active in storage. The re-added owner immediately inherits those previous spending limits unless a new `SetSpendingLimit` proposal is created and executed to update or clear the limit.

### Storage Cost Per Proposal

Each proposal creates a fixed number of persistent ledger entries:

- **1** `("PROP", id)` entry for the proposal record itself
- **Up to N** `("APPR", id, owner)` entries, where N is the number of owners who have voted

For a **5-of-7 multisig** (7 owners, all casting a vote), one proposal creates at most **8 persistent entries** (1 proposal + 7 approval entries), each billed at ~0.052 XLM per 30-day bump period.

The protocol enforces two caps that bound worst-case total storage:

| Cap                                   | Value        | Rationale                                       |
| ------------------------------------- | ------------ | ----------------------------------------------- |
| Active-proposal limit (`ACTCNT` ≤ 50) | 50 proposals | Bounds simultaneous persistent proposal entries |
| Owner list limit                      | 20 owners    | Bounds approval entries per proposal            |

**Worst-case total persistent entries**: 50 proposals × (1 proposal entry + 20 approval entries) = **1,050 entries** at ~0.052 XLM each ≈ **~54.6 XLM per 30-day bump cycle**.

In practice, most deployments have far fewer than 20 owners and many entries are bumped during normal use rather than at the maximum full-expiry cost.

### TTL Bump Rationale

Accord uses a **threshold-and-bump** pattern rather than a fixed-expiry TTL for three reasons:

1. **Entries extend on access, not on a fixed schedule.** Every read or write of a storage entry calls `extend_ttl`; an entry that is accessed regularly will never expire, regardless of calendar time.

2. **The one-day threshold prevents unnecessary writes.** If an entry's remaining TTL already exceeds the threshold (17,280 ledgers ≈ 1 day), `extend_ttl` is a no-op — no ledger storage is written and no rent is charged for that call. This keeps routine transaction costs low for frequently-accessed entries.

3. **The 30-day bump provides a generous safety margin.** When the TTL _is_ below the threshold, it is pushed forward 518,400 ledgers (≈ 30 days). Even a contract that goes completely unused for three weeks will not lose on-chain state.

A **fixed-expiry** model (e.g. "entries expire at a predetermined ledger") would require either a privileged renewal transaction sent on a strict schedule or acceptance that entries disappear on a known date — both are operationally fragile for a multisig holding real funds. The threshold-and-bump pattern ties entry lifetime to actual usage rather than to a calendar.

### Storage Cost Methodology

Soroban charges rent based on entry size and TTL extension length (CAP-0046-08):

```
rent_fee_stroops = ceil(entry_size_bytes / 1024) × fee_rate_1kb × delta_ledgers
```

| Parameter                        | Assumed value                     | Source                                                                                         |
| -------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `fee_rate_1kb`                   | ~1 stroop / 1 KB / ledger         | Stellar network config (verify current value via `soroban_rpc.getFeeStats` or Stellar Horizon) |
| `delta_ledgers`                  | 518,400 (full 30-day bump)        | Worst case — entry TTL fully expired before access                                             |
| `("PROP", id)` entry size        | ~396 bytes (100-char description) | XDR field sum below; 300-char max adds ~200 bytes, still rounds to 1 KB                        |
| `("APPR", id, owner)` entry size | ~144 bytes                        | XDR field sum below                                                                            |

**XDR byte breakdown — `OWNERS` entry (Map<Address, u32>):**

| Field                              | XDR bytes                       |
| ---------------------------------- | ------------------------------- |
| Key (`OWNERS` symbol)              | 8                               |
| Map length prefix                  | 4                               |
| Per entry: Address (discriminant + ed25519 key) | 40                   |
| Per entry: u32 weight              | 4                               |
| **1 owner**                        | **52 bytes → 1 KB billed**      |
| **7 owners**                       | **316 bytes → 1 KB billed**     |
| **20 owners (max)**                | **808 bytes → 1 KB billed**     |

**Before weighted governance:** `OWNERS` was `Vec<Address>` — 1 owner = 52 bytes, 7 owners = 332 bytes, 20 owners = 820 bytes. The `Map<Address, u32>` adds 4 bytes per entry for the weight value, yielding a modest increase.

**XDR byte breakdown — `("APPR", id, owner)` approval entry (weighted):**

| Field                                 | XDR bytes                    |
| ------------------------------------- | ---------------------------- |
| Key (`"APPR"` symbol + u64 + Address) | 60                           |
| Value (`u32` approval weight)         | 4                            |
| LedgerEntry framing and metadata      | ~80                          |
| **Total**                             | **~144 bytes → 1 KB billed** |

**Before weighted governance:** the approval entry stored a `bool` (4 bytes). After: stores a `u32` weight (4 bytes) — same byte count, different semantic.

**XDR byte breakdown — `("PROP", id)` Proposal entry (100-char description):**

| Field                                                      | XDR bytes                    |
| ---------------------------------------------------------- | ---------------------------- |
| Key (`"PROP"` symbol + u64 id)                             | 16                           |
| `id` (u64)                                                 | 8                            |
| `proposer` (Address)                                       | 40                           |
| `description` (String, 100 chars)                          | 104                          |
| `deadline` (u64)                                           | 8                            |
| `approvals` (u32)                                          | 4                            |
| `approval_weight` (u32)                                    | 4                            |
| `status` (enum)                                            | 4                            |
| `kind` (Transfer: discriminant + Vec<Transfer>)            | 108                          |
| `ready_at` (u64)                                           | 8                            |
| `quorum_weight` (u32)                                      | 4                            |
| `category` (enum)                                          | 4                            |
| LedgerEntry framing and metadata                           | ~80                          |
| **Total**                                                  | **~388 bytes → 1 KB billed** |

**XDR byte breakdown — `("APPR", id, owner)` approval entry:**

| Field                                 | XDR bytes                    |
| ------------------------------------- | ---------------------------- |
| Key (`"APPR"` symbol + u64 + Address) | 60                           |
| Value (`bool`)                        | 4                            |
| LedgerEntry framing and metadata      | ~80                          |
| **Total**                             | **~144 bytes → 1 KB billed** |

**Cost summary — one proposal at full 30-day bump:**

| Entry                              | Billed size | Stroops | XLM        |
| ---------------------------------- | ----------- | ------- | ---------- |
| `("PROP", id)`                     | 1 KB        | 518,400 | ~0.052     |
| `("APPR", id, owner)` per approver | 1 KB        | 518,400 | ~0.052     |
| **3-of-5 multisig (3 approvers)**  | —           | —       | **~0.208** |

### Storage Cost Delta — Weighted Governance

The table below compares the pre-weighted and post-weighted storage costs for the `OWNERS` entry and the worst-case persistent storage total.

| Metric | Pre-weighted (`Vec<Address>`) | Post-weighted (`Map<Address, u32>`) | Delta |
|--------|------------------------------|--------------------------------------|-------|
| `OWNERS` entry (1 owner) | 52 bytes → 1 KB billed | 52 bytes → 1 KB billed | 0 bytes |
| `OWNERS` entry (7 owners) | 332 bytes → 1 KB billed | 316 bytes → 1 KB billed | −16 bytes |
| `OWNERS` entry (20 owners) | 820 bytes → 1 KB billed | 808 bytes → 1 KB billed | −12 bytes |
| `("APPR", id, owner)` value | `bool` = 4 bytes | `u32` = 4 bytes | 0 bytes |
| `("PROP", id)` fields | 10 fields | 11 fields (+ `approval_weight`, `quorum_weight`) | +8 bytes |
| New instance key `TWGT` | — | `u32` = 4 bytes (~150 bytes shared entry) | +4 bytes |

**Worst-case persistent entries** (50 proposals × 20 owners):

| | Pre-weighted | Post-weighted |
|---|---|---|
| `OWNERS` | 1 entry | 1 entry |
| `("PROP", id)` | 50 entries | 50 entries |
| `("APPR", id, owner)` | 1,000 entries | 1,000 entries |
| **Total** | **1,051 entries** | **1,051 entries** |
| **Cost per 30-day cycle** | **~54.6 XLM** | **~54.6 XLM** |

> **Net impact**: The weighted governance model adds ~8 bytes to each proposal entry (`approval_weight` + `quorum_weight`) and introduces the shared instance key `TWGT`. Because all entries round up to 1 KB for billing, the actual XLM cost per 30-day bump cycle is **identical** — the byte-level increases fall well within the 1 KB billing quantum. The per-owner approval entry changed from `bool` to `u32` with no byte-level difference. The `OWNERS` map entry is slightly smaller than the prior `Vec` due to Soroban's more compact map encoding.

> These figures use a fee rate of 1 stroop/KB/ledger. Verify the current network value before capacity-planning large deployments; the rate is adjustable via Stellar governance.

### Bump-on-Access Strategy and Configuration

The contract defines the following TTL values for its storage entries:

- **`INSTANCE_BUMP`**: 518,400 ledgers (≈ 30 days)
- **`INSTANCE_THRESHOLD`**: 17,280 ledgers (≈ 1 day)
- **`PERSISTENT_BUMP`**: 518,400 ledgers (≈ 30 days)
- **`PERSISTENT_THRESHOLD`**: 17,280 ledgers (≈ 1 day)

**Instance storage** bumps on mutating calls, extending the lifetime of the core contract state (`INIT`, `THRESH`, `NEXT`, `ACTCNT`, `TLOCK`).
**Persistent storage** bumps per-entry on read or write, meaning that each proposal and approval entry maintains its own independent TTL.

> **Guidance Note**: The bump target must account for the 90-day maximum proposal duration. While the default bump is only 30 days (`518,400` ledgers), this 30-day bump functions correctly only because entries are re-bumped upon access. A proposal with a 90-day deadline will not expire prematurely as long as it is interacted with (read or written) at least once every 30 days.

Every read or write of a storage entry calls `extend_ttl` with a **threshold** and a **bump**:

- **Threshold** (17,280 ledgers ≈ 1 day): if the entry's remaining TTL already exceeds this value no extension is triggered and no rent is charged on that call.
- **Bump** (518,400 ledgers ≈ 30 days): when the TTL _is_ below the threshold, expiry is pushed to `current_ledger + bump`.

This means rent is paid at most once per day per entry rather than on every transaction, keeping routine call costs low.

**What happens when an entry expires:**

When an entry's TTL reaches zero the Stellar network **permanently deletes** it — there is no tombstone, no warning, and no recovery path. Consequences for this contract:

- A deleted `("PROP", id)` entry causes `get_proposal` to return `ProposalNotFound`, as if the proposal never existed.
- A deleted `("APPR", id, owner)` entry is read as `false` (not approved), silently erasing that owner's recorded vote.
- Deletion of the contract instance entry (`INIT`, `THRESH`, `NEXT`, `ACTCNT`, `TLOCK`) bricks the entire contract; a fresh deployment and re-initialisation is the only recovery.

For long-lived multisigs, ensure at least one on-chain call touches the contract within every 30-day window (for example, a periodic `get_threshold` call) to keep the instance alive.

## Weighted Governance Model

Accord Protocol evolved from a flat M-of-N approval count into **weighted governance**: each owner carries an individual voting weight, proposals become `Ready` when accumulated approval weight meets a snapshotted quorum, and the contract maintains a total-weight counter that must always equal the sum of current owner weights.

### Weighted data model

| Concept | Where it lives | Meaning |
|---------|----------------|---------|
| Per-owner weight | Persistent `OWNERS` map (`Address → u32`) | Each registered owner's raw voting weight (`MIN_OWNER_WEIGHT`..=`MAX_OWNER_WEIGHT`) |
| Total weight | Instance key `TWGT` (`u32`) | Running sum of all owner weights; updated on initialize, add/remove owner, and `ChangeOwnerWeight` |
| Threshold / required quorum | Instance key `THRESH` (`u32`) | Absolute weight a **new** proposal must reach; also returned by `get_required_quorum_weight` |
| Proposal quorum | `Proposal.quorum_weight` | Copy of the threshold at **proposal creation** — frozen for that proposal's lifetime |
| Proposal approval progress | `Proposal.approvals` / `Proposal.approval_weight` | Cumulative effective weight from owners who have approved (delegation-aware at approve time) |
| Per-approver contribution | Persistent `("APPR", id, owner)` weight | Weight credited when that owner approved, so `revoke` can subtract the same amount |

Bounds enforced by the contract:

- Per-owner weight: `1` … `100_000`
- Max owners: `20` → theoretical max total weight `2_000_000`
- Default single-owner cap for `ChangeOwnerWeight`: **50%** of resulting total weight (`MAX_SINGLE_OWNER_WEIGHT_PCT`)

Read paths for operators and frontends: `get_owner_weight`, `get_owner_weights`, `get_total_weight`, `get_required_quorum_weight`, `get_proposal_approval_progress`.

### Quorum computation and approval accumulation

1. **At creation** — Every proposal-creation entrypoint reads the current threshold and stores it as `quorum_weight` on the new `Proposal`. It also emits `total_weight_at_creation` on the `created` event so auditors can reconstruct context even after later ownership changes. Changing `THRESH` afterward does **not** rewrite existing proposals' `quorum_weight`.

2. **On approve** — The contract loads the approver's raw weight from `OWNERS`, computes **effective weight** (raw ± active delegations), records that value under `("APPR", id, owner)`, and adds it to both `approvals` and `approval_weight`.

3. **Ready transition** — `derive_status` marks a proposal `Ready` when `approvals >= quorum_weight` (and the deadline has not passed). The same comparison gates `execute`.

4. **On revoke** — The stored per-approver weight is subtracted from the cumulative totals so a weight change after approve cannot leave inconsistent counters.

Invariant operators must preserve: **sum(`get_owner_weights`) == `get_total_weight`**. Governance executions that would leave any active proposal's `quorum_weight` unreachable (`WouldBreakQuorum`) are rejected.

### How this differs from flat M-of-N

| | Flat M-of-N (original) | Weighted governance (current) |
|--|------------------------|-------------------------------|
| Owner vote | Every approval counts as `1` | Each approval contributes that owner's weight |
| Threshold meaning | “M distinct owners must approve” | “At least `threshold` weight must approve” |
| Owner storage | List of addresses | Map of address → weight |
| Ready condition | `approval_count >= M` | `approval_weight >= quorum_weight` |
| Changing power | Add/remove owners only | Also `ChangeOwnerWeight(target, new_weight)` |
| Equal weights | Native model | Still supported: set every weight to `1` and `threshold = M` — behaviour matches classical M-of-N |

**Equal weights reduce to the old model.** A 2-of-3 multisig with weights `[1, 1, 1]` and threshold `2` still needs any two owners. Skewed weights (for example `[5, 3, 2]` with threshold `6`) let larger stakeholders carry more influence while still requiring coalition approvals when no single owner meets quorum alone. Legacy deployments that predate weights can call `migrate_to_weighted_governance` once (after upgrading WASM) to assign weight `1` to every existing owner.

## RBAC & Access Control

Role-based access control (RBAC) layers **least-privilege operational roles** on top of owner-weighted governance. Ownership still decides *how much weight* a vote carries; roles decide *who is allowed* to draft proposals, cast votes, push execute, or only observe. High-privilege security posture changes stay on the owner-weight path so a role grant alone cannot freeze, upgrade, or reconfigure guardianship.

### Role data model

| Piece | Storage | Purpose |
|-------|---------|---------|
| `Role` enum | Contract type | Four variants: `Proposer`, `Approver`, `Executor`, `Viewer` |
| Per-address role set | Persistent `role_key(address)` → `Vec<Role>` | Which roles one address holds |
| Reverse member index | Persistent `role_members_key(role)` → `Vec<Address>` | Which addresses hold a given role (avoids scanning all addresses) |
| `role_version` / RBAC flag | Instance storage | Marks that RBAC migration (or fresh init) has populated roles |
| `DEFAULT_OWNER_ROLES` | Constant | `Proposer` + `Approver` + `Executor` — granted to every owner at `initialize` and by `migrate_to_rbac` |

Helpers:

- `has_role(env, address, role)` → `bool`
- `require_role(env, address, role)` → `Ok(())` or `MissingRole`
- `read_roles` / `write_roles` keep the per-address set and reverse index in sync on every grant/revoke
- Views: `get_roles`, `get_role_members`, `has_role`, `get_role_version`

Grant and revoke flow through governance: `ProposalKind::GrantRole(Address, Role)` and `ProposalKind::RevokeRole(Address, Role)`, created via `create_grant_role_proposal` / `create_revoke_role_proposal`, then approve → execute like any other proposal. Execute re-validates so a stale grant/revoke cannot corrupt the reverse index (`RoleAlreadyGranted`, `RoleNotGranted`).

### Entrypoint gating matrix

| Gate | Entrypoints | Rule |
|------|-------------|------|
| **Role: Proposer** | All `create_*_proposal` entrypoints (transfers, owner/weight/threshold/spending-limit changes, recurring schedules, grant/revoke role) | Caller must hold `Proposer`. Non-owner proposers may draft; owner proposers still get spending-limit checks. |
| **Owner + Role: Approver** | `approve`, `revoke` | Caller must be an **owner** (source of voting weight) **and** hold `Approver`. |
| **Role: Executor** | `execute`, `cancel_expired` | Caller must hold `Executor` (may be a keeper that is not an owner). |
| **Owner-weight (not role)** | `set_guardian`, `freeze` / `unfreeze`, `upgrade`, `migrate_to_weighted_governance`, `migrate_to_rbac`, `set_max_single_owner_weight_pct` | Distinct owner co-signers whose combined weight reaches threshold (`require_weighted_approvers`). Roles alone are insufficient. |
| **Guardian-only** | `freeze` (after guardian is set) | Guardian address must match; separate from RBAC roles. |
| **Ungated (read-only)** | `get_*` views, `is_owner`, `has_approved`, `has_role`, `get_roles`, `get_role_members`, `get_role_version`, `disburse_recurring` (public crank) | No role or owner check for pure reads / public crank. |

```text
                 ┌──────────────────────────────┐
                 │     Operational roles        │
                 │  Proposer / Approver /       │
                 │  Executor / Viewer           │
                 └──────────────┬───────────────┘
                                │
        create_* ───────────────┼─────────────── approve/revoke
        (Proposer)              │               (owner + Approver)
                                │
                          execute / cancel_expired
                                (Executor)
                                │
                 ┌──────────────┴───────────────┐
                 │  Governance security path    │
                 │  owner-weight co-signatures  │
                 │  (upgrade, guardian, migrate)│
                 └──────────────────────────────┘
```

`Viewer` is reserved for read-oriented assignments and UI affordances; it does not by itself unlock create/approve/execute. Holding `Viewer` alone never substitutes for the gates above.

### Migration (`migrate_to_rbac`)

Legacy deployments have no role data. After upgrading to RBAC-capable WASM:

1. Owners co-sign `migrate_to_rbac` (owner-weight gated, same pattern as `migrate_to_weighted_governance`).
2. The function grants `DEFAULT_OWNER_ROLES` to every current owner and updates the reverse index.
3. It sets the `role_version` flag so `get_role_version` reports RBAC-enabled.

**Single-run guarantee:** A second call is rejected (migration-already-done / `AlreadyMigrated`-style guard on `role_version`) and writes no further role state. Fresh contracts that grant defaults in `initialize` never need the migration.

See also: [Roles & Permissions guide](./guides/roles-and-permissions.md), [CONTRACT_API error reference](./CONTRACT_API.md#error-reference) (`MissingRole`, `RoleAlreadyGranted`, `RoleNotGranted`, `InvalidRole`).

## 4. Proposal Lifecycle

```
create_proposal()
        │
        ▼
  [Pending] ──── approve() ────► (approvals < threshold)
        │                               │
        │         approve() ────────────► (approvals >= threshold)
        │                                         │
        ▼                                         ▼
   (deadline                                  [Ready]
    exceeded)                                    │
        │                                   execute()
        ▼                                        │
  [Expired]                                      ▼
                                           [Executed]

  revoke() can transition Ready → Pending at any point before execute().
```

## 5. Approve & Execute Flows

### 5.1 Approve Flow

The approve flow begins when an owner clicks Approve on a proposal card. The frontend constructs the contract call, the wallet signs it, the SDK simulates the transaction against the Soroban RPC and then submits it, and the contract validates, records the vote, and emits an event.

```text
     Owner            Frontend        Freighter       Stellar SDK     Soroban RPC     Accord Contract
       |                |               |               |               |               |
       | (1) Click      |               |               |               |               |
       |    Approve      |               |               |               |               |
       |--------------->|               |               |               |               |
       |                | (2) Build tx  |               |               |               |
       |                |-------------->|               |               |               |
       |                |               | (3) Sign      |               |               |
       |                |               |-------------->|               |               |
       |                |               |               | (4) simulate  |               |
       |                |               |               |   transaction |               |
       |                |               |               |-------------->|               |
       |                |               |               | (5) OK        |               |
       |                |               |               |<--------------|               |
       |                |               |               | (6) submit    |               |
       |                |               |               |-------------->|               |
       |                |               |               |               | (7) approve() |
       |                |               |               |               |-------------->|
       |                |               |               |               |               |  require_auth
       |                |               |               |               |               |  require_owner
       |                |               |               |               |               |  read_proposal
       |                |               |               |               |               |  derive_status
       |                |               |               |               |               |  read_approval
       |                |               |               |               |               |  write_approval
       |                |               |               |               |               |  inc approvals
       |                |               |               |               |               |  check threshold
       |                |               |               |               |               |  set ready_at
       |                |               |               |               |               |  write_proposal
       |                |               |               |               |               |  emit approved
       |                |               |               |               |<--------------| (8) result
       |                |               |               |<--------------|               |
       |                |<--------------|               |               |               |
       |<---------------|               |               |               |               |
       | (9) re-fetch   |               |               |               |               |
       |     proposal   |               |               |               |               |
```

> **Most common failure point:** The proposal may expire between the time the owner clicks approve and the transaction lands. If `derive_status` returns `Expired`, the call reverts with `ProposalExpired`. Frontends should check `proposal.deadline` against the current ledger timestamp and disable the approve button for expired proposals.

### 5.2 Execute Flow

The execute flow is triggered when an owner clicks Execute on a proposal that has reached Ready status. It follows the same simulate-and-submit pattern as approve, but the contract additionally enforces the time-lock delay and makes a cross-contract transfer call to the token contract.

```text
     Owner            Frontend        Freighter       Stellar SDK     Soroban RPC     Accord Contract   Token Contract
       |                |               |               |               |               |               |
       | (1) Click      |               |               |               |               |               |
       |    Execute     |               |               |               |               |               |
       |--------------->|               |               |               |               |               |
       |                | (2) Build tx  |               |               |               |               |
       |                |-------------->|               |               |               |               |
       |                |               | (3) Sign      |               |               |               |
       |                |               |-------------->|               |               |               |
       |                |               |               | (4) simulate  |               |               |
       |                |               |               |-------------->|               |               |
       |                |               |               | (5) OK        |               |               |
       |                |               |               |<--------------|               |               |
       |                |               |               | (6) submit    |               |               |
       |                |               |               |-------------->|               |               |
       |                |               |               |               | (7) execute() |               |
       |                |               |               |               |-------------->|               |
       |                |               |               |               |               | require_auth  |
       |                |               |               |               |               | require_owner |
       |                |               |               |               |               | read_proposal |
       |                |               |               |               |               | derive_status |
       |                |               |               |               |               | check Ready   |
       |                |               |               |               |               | check timelock|
       |                |               |               |               |               | (8) transfer  |
       |                |               |               |               |               |-------------->|
       |                |               |               |               |               |<--------------| OK
       |                |               |               |               |               | status=Exec'd |
       |                |               |               |               |               | emit executed |
       |                |               |               |               |<--------------| (9) result    |
       |                |               |               |<--------------|               |               |
       |                |<--------------|               |               |               |               |
       |<---------------|               |               |               |               |               |
       | (10) re-fetch  |               |               |               |               |               |
       |      proposal  |               |               |               |               |               |
```

> **Most common failure point:** The Accord contract's token balance may be insufficient to cover the transfer amount. The token contract's `transfer` call fails and the execute call reverts with `TransferFailed`. Frontends should check the contract's token balance before enabling the execute button.

### 5.3 Weighted Approve & Execute Flow

The weighted flow differs from the flat model in two key ways: each approval contributes the owner's individual voting weight rather than a count of 1, and execution re-validates that the accumulated approval weight meets the snapshotted quorum weight. The approve step records the approver's effective (delegation-aware) weight so that `revoke` can later reverse precisely the same amount.

```text
     Owner            Frontend        Freighter       Stellar SDK     Soroban RPC     Accord Contract
       |                |               |               |               |               |
       | (1) Click      |               |               |               |               |
       |    Approve      |               |               |               |               |
       |--------------->|               |               |               |               |
       |                | (2) Build tx  |               |               |               |
       |                |-------------->|               |               |               |
       |                |               | (3) Sign      |               |               |
       |                |               |-------------->|               |               |
       |                |               |               | (4) simulate  |               |
       |                |               |               |   transaction |               |
       |                |               |               |-------------->|               |
       |                |               |               | (5) OK        |               |
       |                |               |               |<--------------|               |
       |                |               |               | (6) submit    |               |
       |                |               |               |-------------->|               |
       |                |               |               |               | (7) approve() |
       |                |               |               |               |-------------->|
       |                |               |               |               |               |  require_auth
       |                |               |               |               |               |  load_owner_weight
       |                |               |               |               |               |  read_proposal
       |                |               |               |               |               |  derive_status
       |                |               |               |               |               |  read_approval
       |                |               |               |               |               |  compute_effective_weight
       |                |               |               |               |               |  write_approval_weight
       |                |               |               |               |               |  add weight to approvals
       |                |               |               |               |               |  check approvals >= quorum
       |                |               |               |               |               |  set ready_at
       |                |               |               |               |               |  write_proposal
       |                |               |               |               |               |  emit approved
       |                |               |               |               |<--------------| (8) result
       |                |               |               |<--------------|               |
       |                |<--------------|               |               |               |
       |<---------------|               |               |               |               |
       | (9) re-fetch   |               |               |               |               |
       |     proposal   |               |               |               |               |
```

> **Weighted key difference:** The flat approve flow checks `approvals >= threshold` (where each approval counts as 1). The weighted flow loads the approver's raw weight from the `OWNERS` map, computes effective (delegation-aware) weight, stores that exact value for later revocation, and adds it to the cumulative `approval_weight`. The proposal transitions to `Ready` when `approval_weight >= quorum_weight` — the quorum weight was snapshotted at proposal creation from the contract's total weight threshold.

The weighted execute flow mirrors the flat flow's simulate-and-submit pattern, but re-validates the quorum at execution time against the snapshotted `quorum_weight` rather than an owner count:

```text
     Owner            Frontend        Freighter       Stellar SDK     Soroban RPC     Accord Contract   Token Contract
       |                |               |               |               |               |               |
       | (1) Click      |               |               |               |               |               |
       |    Execute     |               |               |               |               |               |
       |--------------->|               |               |               |               |               |
       |                | (2) Build tx  |               |               |               |               |
       |                |-------------->|               |               |               |               |
       |                |               | (3) Sign      |               |               |               |
       |                |               |-------------->|               |               |               |
       |                |               |               | (4) simulate  |               |               |
       |                |               |               |-------------->|               |               |
       |                |               |               | (5) OK        |               |               |
       |                |               |               |<--------------|               |               |
       |                |               |               | (6) submit    |               |               |
       |                |               |               |-------------->|               |               |
       |                |               |               |               | (7) execute() |               |
       |                |               |               |               |-------------->|               |
       |                |               |               |               |               | require_auth  |
       |                |               |               |               |               | require_owner |
       |                |               |               |               |               | read_proposal |
       |                |               |               |               |               | derive_status |
       |                |               |               |               |               | check Ready   |
       |                |               |               |               |               | check approvals >=
       |                |               |               |               |               |   quorum_weight|
       |                |               |               |               |               | check timelock|
       |                |               |               |               |               | (8) transfer  |
       |                |               |               |               |               |-------------->|
       |                |               |               |               |               |<--------------| OK
       |                |               |               |               |               | status=Exec'd |
       |                |               |               |               |               | emit executed |
       |                |               |               |               |<--------------| (9) result    |
       |                |               |               |<--------------|               |               |
       |                |<--------------|               |               |               |               |
       |<---------------|               |               |               |               |               |
       | (10) re-fetch  |               |               |               |               |               |
       |      proposal  |               |               |               |               |               |
```

> **Weighted key difference:** The flat execute flow checks `approvals >= threshold` (owner count). The weighted flow checks `proposal.approvals >= proposal.quorum_weight` — the quorum weight was snapshotted at proposal creation. If the contract's threshold has been changed since the proposal was created, the snapshotted quorum_weight is unaffected; the proposal's requirement is frozen at creation time.

## 6. Recurring & Scheduled Payments

The contract supports automated, recurring payroll and token vesting schedules via the `CreateRecurringPayment` proposal kind. Once a recurring schedule is proposed and approved by the multisig owners, it is registered on-chain. Payouts are then disbursed incrementally according to the schedule's configuration.

### 6.1 Data Model

Recurring schedules are represented by the `RecurringPayment` struct stored in persistent storage under the `("RECUR", id)` namespace.

```rust
pub struct RecurringPayment {
    pub id: u64,
    pub recipient: Address,
    pub token: Address,
    pub amount: i128,
    pub interval_secs: u64,
    pub start_time: u64,
    pub end_time: u64,
    pub cliff_time: u64,
    pub total_cap: i128,
    pub status: RecurringStatus,
    pub kind: RecurringKind,
    pub total_disbursed: i128,
    pub last_disbursed_at: u64,
}
```

#### Status Lifecycle (`RecurringStatus`)
- **Active**: The schedule is live and eligible for disbursement once temporal constraints (intervals/cliffs) are met.
- **Paused**: Temporarily paused by a governance proposal; no disbursements can be made.
- **Completed**: The schedule has naturally concluded because either its `end_time` has passed or the `total_cap` has been fully disbursed.
- **Cancelled**: Terminated early by a governance proposal (`CancelRecurringPayment`); no further disbursements are possible.

#### Payment Types (`RecurringKind`)
- **FixedAmountPerPeriod**: Periodic payouts (e.g. salary). Each successful disbursement releases a set `amount` after each `interval_secs`.
- **LinearVesting**: Continuous second-by-second vesting (e.g. token grants). Claimable amounts accrue continuously between `start_time` and `end_time` up to `total_cap`.

---

### 6.2 The Crank Pattern

Because blockchain smart contracts are passive and cannot run background tasks or triggers on a timer, Accord utilizes the **Crank Pattern** to process disbursements.

- **Crank Execution**: Any external party (such as the recipient, a multisig owner, or an automated bot) must call the public `disburse_recurring(schedule_id)` entrypoint.
- **Access Control**: This function is unauthenticated (anyone can call it) because the beneficiary and payout parameters are immutable once the schedule is approved.
- **Automation (Keepers)**: Teams typically deploy an off-chain script (a **Keeper**) that polls `get_claimable_amount(schedule_id)` and automatically submits a "crank" transaction calling `disburse_recurring` when the claimable balance is non-zero.

---

### 6.3 Catch-Up Policy

If a schedule is not cranked immediately when funds become claimable, the protocol handles the delay differently based on the schedule's type:

#### Fixed Amount Per Period (`FixedAmountPerPeriod`)
- **No Automatic Backpay / Stacking**: The contract enforces that a minimum of `interval_secs` must elapse since `last_disbursed_at`.
- **Resetting Schedule Timeline**: If multiple intervals are missed (e.g. 3 months on a 1-month interval), the next crank disburse exactly one `amount`. The `last_disbursed_at` is set to `now`, meaning subsequent intervals are measured from the actual execution time. This prevents sudden large token drains from the multisig.

#### Linear Vesting (`LinearVesting`)
- **True Catch-Up**: The claimable amount is calculated dynamically based on time elapsed since the start. 
- If a crank is called late, the recipient claims the entire accrued/vested amount up to that second at once, ensuring they are always fully caught up.

---

### 6.4 Linear Vesting Mathematics

For `LinearVesting` schedules, the claimable amount is calculated on-the-fly as:

$$\text{total\_duration} = \text{end\_time} - \text{start\_time}$$
$$\text{elapsed} = \min(\text{now}, \text{end\_time}) - \text{start\_time}$$
$$\text{vested} = \frac{\text{total\_cap} \times \text{elapsed}}{\text{total\_duration}}$$
$$\text{claimable} = \text{vested} - \text{total\_disbursed}$$

The contract uses `u128` arithmetic to prevent multiplication overflow during calculation:

```rust
let total_duration = schedule.end_time - schedule.start_time;
let elapsed = if now >= schedule.end_time {
    total_duration
} else {
    now - schedule.start_time
};
let vested = (schedule.total_cap as u128)
    .checked_mul(elapsed as u128)
    .unwrap_or(0)
    / (total_duration as u128);
let claimable = (vested as i128).saturating_sub(schedule.total_disbursed);
```

---

### 6.5 Full Lifecycle Sequence Diagram

The sequence diagram below illustrates the full lifecycle of a recurring payment schedule, from creation and voting through automated disbursement:

```text
  Proposer             Owners             Keeper / Bot       Accord Contract      Token Contract
     |                   |                     |                    |                   |
     | (1) Propose       |                     |                    |                   |
     |----create_recurring_payment_proposal------------------------>|                   |
     |                   |                     |                    |                   |
     |                   | (2) Approve         |                    |                   |
     |                   |----approve------------------------------>|                   |
     |                   |                     |                    |                   |
     |                   | (3) Execute         |                    |                   |
     |                   |----execute------------------------------>|                   |
     |                   |                     |                    |                   |
     |                   |                     |                    |--[Status=Active]  |
     |                   |                     |                    |                   |
     |                   |                     | (4) Poll           |                   |
     |                   |                     |----get_claimable-->|                   |
     |                   |                     |    _amount()       |                   |
     |                   |                     |<---returns > 0-----|                   |
     |                   |                     |                    |                   |
     |                   |                     | (5) Crank          |                   |
     |                   |                     |----disburse_       |                   |
     |                   |                     |    recurring()---->|                   |
     |                   |                     |                    |--[Verify Cliff]   |
     |                   |                     |                    |--[Calculate Amt]  |
     |                   |                     |                    |                   |
     |                   |                     |                    | (6) transfer()    |
     |                   |                     |                    |------------------>|
     |                   |                     |                    |<--[Transfer OK]---|
     |                   |                     |                    |                   |
     |                   |                     |                    |--[Update State]   |
     |                   |                     |                    |--[Emit Event]     |
     |                   |                     |<---disbursed-------|                   |
```

---

## 7. Event Schema

The contract emits events using `env.events().publish()`. Each Soroban event has two components that external consumers must understand:

**Event envelope structure:**

- **Contract address** — the deployed Accord contract ID, which Soroban attaches implicitly to every event. External consumers use this as a first-level filter to select only events from a specific deployment.
- **Topic string** — a short symbol published explicitly by the contract (`"created"`, `"approved"`, `"revoked"`, `"executed"`). This is the second filter consumers apply to select a specific event type.
- **Data payload** — a typed struct carrying the event details, as described in the table below.

The contract address plus one topic string together uniquely identify a stream of events from a specific action type on a specific deployment.

| Topics          | Data Type                                                      | Consumer            |
| --------------- | -------------------------------------------------------------- | ------------------- |
| `("created",)`  | `ProposalCreatedEvent { id, proposer, threshold, category, transfers, quorum_weight, total_weight_at_creation }` | Proposal feed       |
| `("approved",)` | `ProposalApprovedEvent { id, approver, approvals, threshold, weight, cumulative_weight }` | Approval bar update |
| `("revoked",)`  | `ProposalRevokedEvent { id, approver, approvals, weight, cumulative_weight }`             | Approval bar update |
| `("executed",)` | `ProposalExecutedEvent { id, executor, transfers }`             | Execution history   |

These four cover the core approve/execute lifecycle; the contract emits 22 distinct event types in total (governance, recurring payments, RBAC, and guardian/emergency actions included). See [§13.4 — Event Type Mapping](#134-event-type-to-storage-mapping) for the full list and [ANALYTICS_API.md](ANALYTICS_API.md#event-payload-schemas) for field-by-field schemas.

### Indexing Accord Events

External services — dashboards, notification systems, auditing tools — can consume Accord events through three approaches, each suited to different latency and persistence requirements:

**1. Soroban RPC `getEvents` polling (best for one-off queries)**

Query the Soroban RPC `getEvents` endpoint directly, filtering by the contract ID and topic string. Use the `startLedger` parameter to paginate through historical events. This is the simplest approach and requires no third-party infrastructure, but depends on the RPC node retaining historical events within its availability window (see [Event Availability](#event-availability) below).

```
POST /soroban/rpc
{ "method": "getEvents",
  "params": { "startLedger": <N>,
               "filters": [{ "type": "contract",
                             "contractIds": ["<ACCORD_CONTRACT_ID>"],
                             "topics": [["created"]] }] } }
```

**2. Stellar Horizon API or event streaming (best for real-time dashboards)**

The Stellar Horizon API exposes a `/transactions` endpoint with server-sent events (SSE) support, allowing a dashboard to stream ledger closes and parse Soroban event metadata from transaction results in near-real-time. This is well-suited for live approval-bar updates and proposal feed refreshes, though it requires parsing the Soroban `OperationResult` XDR to extract event payloads.

**3. Mercury or a dedicated Soroban indexer (best for persistent long-term indexing)**

Services such as [Mercury](https://mercurydata.app) subscribe to contract events via a webhook or subscription API and store them in a queryable database. This is the correct approach for auditing tools, analytics pipelines, or any consumer that needs events older than the standard RPC retention window. Configure a subscription with the Accord contract ID and desired topic filters; Mercury will forward matching events to a webhook endpoint as they are emitted.

### Event Availability

Soroban events are stored as part of ledger close metadata and are only available from standard RPC nodes for a **limited number of ledgers** (the exact window depends on the node operator's configuration — typically 17,280 ledgers, approximately one day on Testnet). Events older than this window are permanently unavailable from a standard node.

For long-term event history, use one of the following:

- A **self-hosted archival Soroban node** configured with `DISABLE_TX_META_EXPIRY=true` (or equivalent) to retain all historical ledger metadata.
- A **third-party indexing service** such as Mercury, which maintains its own persistent event store.

See issue #103 and the TTL documentation in Section 3 for context on how on-chain data persistence works more broadly.

## 8. Frontend Polling Strategy

1. Load current proposals on mount, then poll every 15-30s for active proposals.
2. After a confirmed transaction (approve, execute), re-fetch the affected proposal immediately for optimistic UI.
3. Deduplicate events by `(ledger, topic, data-hash)`.
4. Back off on RPC failure: 1s → 2s → 4s, cap at 30s.

## 9. Token Handling

All token amounts are stored and transferred in the token's **smallest unit** (stroops for XLM: 1 stroop = 0.0000001 XLM). Use `BigInt` in the frontend — never `Number` for on-chain amounts.

| Token Amount | Stroops       |
| ------------ | ------------- |
| 1.0 XLM      | 10,000,000    |
| 100.5 XLM    | 1,005,000,000 |

Frontend utilities should live in `frontend/src/lib/soroban.ts`:

- `toBaseUnit(amount: string, decimals: number): bigint`
- `fromBaseUnit(amount: bigint, decimals: number): string`

## 10. Token Deposit Flow

The Accord contract does not automatically pull tokens from owner wallets. It only holds whatever tokens have been sent directly to its own contract address — and only discovers a shortfall when execution is attempted.

### 9.1 Deposit Pattern

Owners (or anyone) must deposit tokens into the contract's address **before** a proposal referencing that token can be successfully executed. Depositing is a standard wallet transfer: send tokens to the contract's Stellar address the same way you would send tokens to any other account. There is no special contract function to call — the contract simply holds a balance in the same way any Stellar account does, using the network's native account model.

Each deposit should cover the full `amount` of the intended proposal (or multiple proposals). If multiple proposals reference different token contracts, each token needs a separate deposit to the same contract address.

### 9.2 Execute-Time Balance Check

There is **no balance check at proposal creation time**. The `create_proposal` function validates the token contract address (`validate_token`) and the amount (`amount ≥ 1`), but it never queries the contract's own token balance. A proposal can be created, approved by all owners, and reach `Ready` status even if the contract holds zero of the required token.

The balance is checked only at the moment of execution. When `execute` is called, the contract calls the token's `transfer` function directly from its own address to the recipient (`contracts/accord/src/lib.rs:1407–1416`):

```rust
token::Client::new(&env, &transfer.token)
    .try_transfer(&env.current_contract_address(), &transfer.to, &transfer.amount)
```

If the contract's balance is too low, this cross-contract call fails and the entire `execute` call reverts with **`ContractError::TransferFailed`** (error code 15). See [`CONTRACT_API.md`](CONTRACT_API.md#error-reference) for the full error description.

Because the failure happens inside the token contract's transfer logic — not in Accord's own validation — the error surfaces as a generic transfer failure rather than a specific "insufficient balance" error. The frontend maps this to the message *"Token transfer failed. Check the contract balance."* (`frontend/src/lib/soroban.ts:42`).

### 9.3 Frontend Integration

The Settings page (`frontend/src/pages/SettingsPage.tsx`) includes a **"Fund Contract"** panel that shows the contract's current token balances and its address with a copy button. Owners use this panel to:

1. **View the contract's address** — displayed at the top of the Settings page with a copy button (`SettingsPage.tsx:212–224`).
2. **Check current balances** — the "Fund Contract" panel shows XLM and USDC balances side-by-side (`SettingsPage.tsx:440–472`), loaded via `getContractXlmBalance()` and `getContractUsdcBalance()` from `frontend/src/lib/contract.ts`.
3. **Send a deposit** — copy the contract address, use any Stellar wallet (Freighter, Lobstr, etc.) to send the required tokens to that address, then return to the proposal and execute it.

The same panel also serves as a diagnostic tool: if an execute call fails with `TransferFailed`, an owner can check this panel to confirm the balance is sufficient before retrying.

## 11. Related Documents

| Document                                                                  | Description                                                    |
| ------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [DESIGN.md](DESIGN.md)                                                    | Design decisions — why the protocol is built the way it is     |
| [docs/guides/connecting-your-wallet.md](guides/connecting-your-wallet.md) | End-user guide: Freighter setup and Testnet funding            |
| [docs/guides/reading-the-dashboard.md](guides/reading-the-dashboard.md)   | End-user guide: proposal list, status badges, and approval bar |
| [docs/guides/treasury-analytics.md](guides/treasury-analytics.md)        | End-user guide: analytics charts, filters, and exports          |
| [CONTRACT_API.md](CONTRACT_API.md)                                        | Full contract function reference                               |
| [ANALYTICS_API.md](ANALYTICS_API.md)                                      | Analytics HTTP API and indexed event schema reference          |
| [SETUP.md](SETUP.md)                                                      | Developer setup and deployment instructions                    |

## 12. Owner-Authorization Check Resource Cost

Every authorized call into the contract (`approve`, `revoke`, `execute`, and each governance proposal creation) loads the entire `OWNERS` persistent entry (an `Address → u32` weight map) and looks up the caller's weight. This section measures the CPU instruction and memory cost of that check at the maximum owner count (`MAX_OWNERS = 20`) compared to a single-owner baseline.

### Benchmark Methodology

Two benchmark tests live in `contracts/accord/src/test.rs`:

- **`benchmark_owner_check_cpu_and_memory`** — Calls `env.budget().reset_unlimited()`, initializes a contract with 1 owner (then separately with 20 owners), calls `get_owner_weight` (which exercises the same `require_owner_and_weight` code path), and records `cpu_instruction_cost()` and `memory_bytes_cost()` deltas.
- **`benchmark_approve_cost_20_owners`** — Initializes a contract with 20 owners, creates a proposal, calls `approve` with a second owner, and records the full call cost.

Both tests use `env.mock_all_auths()` and run with an unlimited budget to avoid budget-exhaustion interference during setup. The budget is reset just before the measured operation so only the operation's own cost is captured.

### Results: Owner-Authorization Check (`get_owner_weight`)

| Owner count | CPU instructions | Memory bytes |
|-------------|-----------------|--------------|
| 1           | 47,958          | 24,477       |
| 20          | 89,998          | 55,035       |
| **Delta**   | **42,040**      | **30,558**   |

The delta (20 − 1) isolates the cost attributable to deserializing and iterating the larger owner map: approximately **2,212 CPU instructions and 1,608 memory bytes per additional owner**.

### Results: Full `approve` Call (20 owners)

| Scenario | CPU instructions | Memory bytes |
|----------|-----------------|--------------|
| `approve` at 20 owners | 280,920 | 145,205 |

### Comparison Against Soroban Mainnet Limits

Soroban's per-invocation resource limits on mainnet are **600,000,000 CPU instructions** and **41,943,040 memory bytes** (40 MiB).

| Scenario | CPU | % of limit | Memory | % of limit |
|---|---|---|---|---|
| Owner check (20 owners) | 89,998 | 0.0150% | 55,035 | 0.1312% |
| Full `approve` (20 owners) | 280,920 | 0.0468% | 145,205 | 0.3462% |

### Full Budget Breakdown (20 owners)

**Owner check (`get_owner_weight`):**
```
Cpu limit: 18446744073709551615; used: 89998
Mem limit: 18446744073709551615; used: 55035

CostType                           cpu_insns      mem_bytes
MemAlloc                           22682          8727
MemCpy                             7487           0
MemCmp                             7898           0
VisitObject                        7991           0
ValSer                             40202          46308
```

**Full `approve` call:**
```
Cpu limit: 18446744073709551615; used: 280920
Mem limit: 18446744073709551615; used: 145205

CostType                           cpu_insns      mem_bytes
MemAlloc                           88299          46535
```

### Conclusion

**The owner-authorization check stays well within Soroban's per-invocation resource budget at the maximum owner count of 20.** The check consumes roughly 0.015% of the CPU budget and 0.13% of the memory budget. Even the full `approve` call (which includes the owner check plus proposal loading, approval recording, and event emission) consumes only 0.047% of CPU and 0.35% of memory.

No follow-up action is required. The owner-map lookup does not pose a resource-limit risk, and the headroom is sufficient for the rest of each entrypoint's business logic.

> **Note**: These measurements were obtained running Rust natively in test mode (not compiled to WASM). Soroban SDK's own documentation notes that CPU and memory costs are *likely to be underestimated* when running natively compared to actual WASM execution. The true WASM costs may be higher, but given the large headroom (less than 1% of limits), this margin of error does not change the conclusion.

## 13. Indexer & Analytics Architecture

Section 7 explains why standard RPC nodes only retain events for a limited window and recommends a dedicated indexer for anything that needs longer history — auditing, dashboards, and the treasury analytics page. This section documents the reference design for that indexer and the analytics layer built on top of it: the end-to-end data flow, the datastore schema, checkpointing and replay safety, and how each indexed record maps back to a contract-emitted event.

This is the architecture the analytics HTTP contract in [ANALYTICS_API.md](ANALYTICS_API.md) is built against. The frontend's analytics client, hooks, and types (`frontend/src/lib/analyticsClient.ts`, `frontend/src/hooks/useTreasuryAnalytics.ts`, `frontend/src/types/accord.ts`) already implement the consuming side of this contract — see [frontend/docs/analytics-data-layer.md](../frontend/docs/analytics-data-layer.md) for that integration's current status. Until the indexer service lands, the Analytics page (`frontend/src/pages/AnalyticsPage.tsx`) computes the same charts and totals directly from proposals read over Soroban RPC (see [§13.6](#136-relationship-to-direct-rpc-reads)).

### 13.1 Data Flow

```text
┌───────────────────────────┐
│  Accord Contract          │
│  emits events on every    │
│  create/approve/execute/  │
│  governance/recurring call│
└─────────────┬─────────────┘
              │ env.events().publish((topic,), data)
              ▼
┌───────────────────────────┐
│  Soroban RPC getEvents     │
│  filtered by contract ID   │
│  paginated by startLedger  │
└─────────────┬─────────────┘
              │ (1) poll from last checkpoint
              ▼
┌───────────────────────────┐
│  Indexer: Fetch            │
│  reads events since the    │
│  last processed ledger     │
└─────────────┬─────────────┘
              │ (2) raw ScVal event
              ▼
┌───────────────────────────┐
│  Indexer: Decode           │
│  ScVal → typed event record│
│  (topic ⇒ Rust event type) │
└─────────────┬─────────────┘
              │ (3) typed record
              ▼
┌───────────────────────────┐
│  Indexer: Persist          │
│  upsert into the events    │
│  table, keyed so replays   │
│  can't duplicate a row     │
└─────────────┬─────────────┘
              │ (4) new/changed rows
              ▼
┌───────────────────────────┐
│  Indexer: Aggregate        │
│  update materialized       │
│  proposals, balances, and  │
│  spend/flow rollups        │
└─────────────┬─────────────┘
              │ (5) advance checkpoint
              ▼
┌───────────────────────────┐
│  Datastore                 │
│  events · proposals ·      │
│  balances · spend rollups  │
│  · checkpoints             │
└─────────────┬─────────────┘
              │ (6) SQL/query reads
              ▼
┌───────────────────────────┐
│  Analytics API             │
│  GET /proposals, /spend/*, │
│  /treasury/*, /stats/*     │
│  (see ANALYTICS_API.md)    │
└─────────────┬─────────────┘
              │ (7) JSON over HTTP
              ▼
┌───────────────────────────┐
│  Frontend Analytics Page   │
│  charts, stat cards,       │
│  CSV/PDF export            │
└───────────────────────────┘
```

Steps 1–4 run continuously on a poll loop (the same `startLedger`-driven pagination described in [§7 — Indexing Accord Events](#indexing-accord-events)); step 4's aggregation is derived from the raw event log rather than incremented independently, so an aggregate can always be rebuilt by replaying steps 1–4 from ledger zero. Step 5 only advances after steps 3 and 4 both commit, which is what makes a crash mid-batch safe to resume (see [§13.3](#133-checkpointing-resume-and-idempotency)).

### 13.2 Datastore Schema

| Table / collection | Holds | Key relationships |
| --- | --- | --- |
| `events` | The raw, decoded event log — one row per emitted event, in emission order. Fields: `contract_id`, `ledger`, `tx_hash`, `event_index`, `topic`, `occurred_at` (ledger close time), and `data` (the decoded event payload, shaped per [§13.4](#134-event-type-to-storage-mapping)). | The append-only source of truth. Every other table is a materialized view derived from `events` and can be rebuilt from it. `data.id` / `data.schedule_id` links a row to a `proposals` or `recurring_schedules` row where applicable. |
| `proposals` | One row per proposal, materialized by folding a proposal's `created` → `approved`/`revoked` → `executed`/expiry events into the current view the API returns from `GET /proposals` and `GET /proposals/:id`. Mirrors the on-chain `Proposal` fields (§3) plus derived fields (`createdAt`, `executedAt`) that only exist as event timestamps, not contract storage. | Keyed by `(contract_id, proposal_id)`. `timeline` in `AnalyticsProposalDetail` is the ordered slice of `events` rows for that proposal ID. |
| `recurring_schedules` | One row per recurring payment schedule, materialized the same way from `r_crt` / `rpay` / `r_pause` / `r_resum` / `r_mod` / `r_cncl` events, mirroring the on-chain `RecurringPayment` struct (§6.1). | Keyed by `(contract_id, schedule_id)`. Feeds spend rollups the same way executed transfers do. |
| `treasury_balance_snapshots` | Point-in-time token balances, one row per `(token, timestamp)`, recomputed whenever an executed transfer or recurring disbursement changes the contract's holdings. Backs `TreasuryBalance.timeSeries` and `GET /treasury/balance`. | Derived from `events` (transfer/disbursement rows), not read from the token contract directly — see [§13.6](#136-relationship-to-direct-rpc-reads) for why the current frontend reads balances on-chain instead. |
| `spend_by_category` / `spend_by_owner` | Aggregation buckets over executed transfers only (governance actions carry no monetary amount) grouped by `ProposalCategory` or proposer address, with running totals, counts, and percentage `share`. Backs `GET /spend/by-category` / `GET /spend/by-owner`. | Derived from `proposals` rows where `status = executed` and `kind = transfer`, matching the same filter the frontend already applies client-side in `filterExecutedTransfers` (`frontend/src/lib/analytics.ts`). |
| `treasury_flow` | Per-period (day/week/month, per `granularity`) inflow and outflow totals per token. Backs `GET /treasury/flow`. | Derived from `events`, bucketed by the `occurred_at` of each executed transfer/disbursement. |
| `checkpoints` | One row per indexed contract, storing the last successfully processed ledger sequence and the timestamp it was recorded. | Read on indexer startup to resume; written only after a batch's `events` rows and aggregate updates both commit (§13.3). |

### 13.3 Checkpointing, Resume, and Idempotency

**Checkpoint.** A checkpoint is the ledger sequence number through which the indexer has fully processed events — conceptually the same cursor the frontend keeps client-side as `lastSeenLedger` in `useEventPolling` (`frontend/src/hooks/useEventPolling.ts`), except the indexer persists its checkpoint to the `checkpoints` table instead of holding it only in memory.

**Resume.** On startup (or after any crash or deploy), the indexer reads its last checkpoint and calls `getEvents` with `startLedger = checkpoint + 1`, so it never re-scans ledgers it has already fully committed and never skips a ledger it hasn't. A fresh indexer with no checkpoint row starts from the contract's deployment ledger (or the oldest ledger the configured RPC/archival node retains — see [Event Availability](#event-availability)).

**Idempotency.** Every row written to `events` is keyed by the natural tuple `(contract_id, ledger, tx_hash, event_index)`, which is unique and immutable by construction — Soroban assigns it once at emission and it never changes on replay. Persisting a batch is therefore an *upsert* on that key, not a blind insert: reprocessing a ledger range the indexer already ingested (because a batch was retried after a crash before its checkpoint was written, for example) writes the same rows again and changes nothing. This is what the indexer idempotency test (`frontend/src/lib/__tests__/contract-events.test.ts`) verifies — replaying a ledger range produces no duplicate records.

**Why replaying is safe.** Two properties make replay safe rather than merely harmless:

1. **The raw event log is immutable and content-addressed.** Once `(contract_id, ledger, tx_hash, event_index)` is written, re-writing the same key with the same payload is a no-op by definition — Soroban ledger history doesn't change after the fact, so the same query against the same ledger range always returns the same events.
2. **Aggregates are recomputed, not incremented.** `proposals`, `recurring_schedules`, `treasury_balance_snapshots`, `spend_by_category`/`spend_by_owner`, and `treasury_flow` are all derived by folding `events` rows in order, not by adding a delta to a running counter on each poll. A partially-applied batch (crash after writing `events` but before the aggregate update, or vice versa) is corrected on the next run by re-deriving the affected aggregate rows from `events`, rather than by tracking which increments already landed.

Together, these mean the indexer can safely re-run any range of ledgers — after a crash, a bug fix, or a full historical backfill — without special-casing "have I seen this before."

### 13.4 Event Type to Storage Mapping

Every event the contract emits carries a topic symbol (§7) that the indexer uses to select which decoder and which downstream table(s) to update. The table below covers all 22 event types the contract can emit — see [ANALYTICS_API.md](ANALYTICS_API.md#event-payload-schemas) for each event's field-by-field schema, and [CONTRACT_API.md — Event Payloads](CONTRACT_API.md#event-payloads) for the subset also documented at the contract-API level.

| Topic | Event struct (`contracts/accord/src/lib.rs`) | Updates |
| --- | --- | --- |
| `created` | `ProposalCreatedEvent` | `proposals` (insert), `events` |
| `approved` | `ProposalApprovedEvent` | `proposals` (approval progress), `events` |
| `revoked` | `ProposalRevokedEvent` | `proposals` (approval progress), `events` |
| `executed` | `ProposalExecutedEvent` | `proposals` (status), `spend_by_category`, `spend_by_owner`, `treasury_flow`, `treasury_balance_snapshots`, `events` |
| `a_own` | `AddOwnerExecutedEvent` | `events` (owner-count context for `GET /stats/summary`'s `ownerCount`) |
| `r_own` | `RemoveOwnerExecutedEvent` | `events` (owner-count context) |
| `c_thr` | `ChangeThresholdExecutedEvent` | `events` |
| `s_lim` | `SetSpendingLimitExecutedEvent` | `events` |
| `c_wgt` | `OwnerWeightChangedEvent` | `events` |
| `migrated` | `GovernanceMigratedEvent` | `events` |
| `rbac_migrated` | `RbacMigratedEvent` | `events` |
| `role_granted` | `RoleGrantedEvent` | `events` |
| `role_revoked` | `RoleRevokedEvent` | `events` |
| `r_crt` | `RecurringPaymentCreatedEvent` | `recurring_schedules` (insert), `events` |
| `rpay` | `RecurringPaymentDisbursedEvent` | `recurring_schedules` (totals), `spend_by_category`, `spend_by_owner`, `treasury_flow`, `treasury_balance_snapshots`, `events` |
| `r_pause` | `RecurringPaymentPausedEvent` | `recurring_schedules` (status), `events` |
| `r_resum` | `RecurringPaymentResumedEvent` | `recurring_schedules` (status), `events` |
| `r_mod` | `RecurringPaymentModifiedEvent` | `recurring_schedules` (schedule fields), `events` |
| `r_cncl` | `RecurringPaymentCancelledEvent` | `recurring_schedules` (status), `events` |
| `guard_set` | `GuardianSetEvent` | `events` |
| `frozen` | `FrozenEvent` | `events` |
| `unfrozen` | `UnfrozenEvent` | `events` |
| `upgraded` | `UpgradeExecutedEvent` | `events` |

Only `executed` and `rpay` move real tokens, so only those two feed the spend and treasury-flow aggregates — the same rule the frontend already applies client-side (`filterExecutedTransfers` in `frontend/src/lib/analytics.ts`). Every other event type is still indexed into `events` (and, where it changes proposal or schedule state, into the corresponding materialized table) because `GET /proposals/:id`'s `timeline` and `GET /proposals/:id`'s audit trail need the full history, not just the transfers.

### 13.5 Analytics API Surface

The indexed datastore is served over HTTP by the analytics API — the endpoint list, query parameters, response shapes, and error format are documented in full in [ANALYTICS_API.md](ANALYTICS_API.md). In summary, the API exposes:

- `GET /proposals` and `GET /proposals/:id` — paginated proposal list and single-proposal detail (with event timeline)
- `GET /spend/by-category` and `GET /spend/by-owner` — spend aggregation buckets
- `GET /treasury/balance` and `GET /treasury/flow` — balance snapshots and inflow/outflow buckets
- `GET /stats/summary` — the dashboard stat-card rollup (`totalDisbursed`, `activeProposals`, `ownerCount`, `largestOutflow`)

### 13.6 Relationship to Direct RPC Reads

The indexer and analytics API are not the only way Accord data reaches the frontend. Section 8 describes the frontend's own polling strategy — reading proposals directly over Soroban RPC and re-fetching on a timer — which the dashboard and (currently) the Analytics page both use. The two paths serve different needs:

- **Direct RPC reads** (§8) always reflect current contract state exactly, at the cost of being limited to whatever `get_proposals_paged` and similar view calls can answer in one request — there's no server-side aggregation, and history beyond current state requires re-deriving it client-side from whatever proposals are loaded.
- **The indexer/analytics path** (this section) can answer aggregate and historical questions (spend by category over the last quarter, a balance time series) that would otherwise require fetching and reducing every proposal on every page load, but it necessarily lags the chain by however long a poll cycle takes to reach and process the relevant ledger — see the [Treasury Analytics guide](guides/treasury-analytics.md#data-freshness) for how that lag shows up to an end user.

## Security Note: Governance Controls vs Spending Limits

**Spending limits and voting weights are strictly independent.**
An owner's voting weight controls their governance power (e.g. approving proposals), while their spending limit controls the maximum token amount they can propose to transfer. Changing an owner's voting weight does not affect their spending limits, and vice versa. They are managed by completely separate storage keys and governance proposals.
