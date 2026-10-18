# Storage Data-Model Reference

This document provides a consolidated, exhaustive reference for Accord Protocol's on-chain storage data model on Stellar Soroban (`contracts/accord/src/lib.rs`). It inventories every storage key, data type, storage tier, granularity, TTL behavior, and rent cost.

---

## Table of Contents

1. [Storage Architecture & Tiers](#storage-architecture--tiers)
2. [TTL Constants & Rent Cost Methodology](#ttl-constants--rent-cost-methodology)
3. [Instance Storage Inventory (Shared Entry)](#instance-storage-inventory-shared-entry)
4. [Persistent Storage Inventory (Independent Entries)](#persistent-storage-inventory-independent-entries)
5. [Key Granularity & Scaling Analysis](#key-granularity--scaling-analysis)
   - [Global Singleton Keys](#global-singleton-keys)
   - [Per-Proposal Keys](#per-proposal-keys)
   - [Per-Owner Keys](#per-owner-keys)
   - [Per-Owner-Per-Token Keys](#per-owner-per-token-keys)
   - [Per-Schedule Keys](#per-schedule-keys)
   - [Per-Role Keys](#per-role-keys)
6. [Worst-Case Multisig Storage Cost Model](#worst-case-multisig-storage-cost-model)
7. [Storage Schema Versioning & Sync Maintenance Note](#storage-schema-versioning--sync-maintenance-note)

---

## Storage Architecture & Tiers

Soroban provides two distinct storage tiers used by Accord Protocol:

| Tier | Storage Type | Entry Lifecycle | Cost Model |
|---|---|---|---|
| **Instance Storage** | `env.storage().instance()` | Shared across all instance keys in **one single `LedgerEntry`**. | Billed once for the entire contract instance (~0.052 XLM / 30 days). |
| **Persistent Storage** | `env.storage().persistent()` | Each key is an **independent `LedgerEntry`** with its own TTL. | Billed per entry per 1 KB block per bump cycle (~0.052 XLM / entry / 30 days). |

---

## TTL Constants & Rent Cost Methodology

The storage layer enforces uniform TTL bounds defined in `contracts/accord/src/lib.rs`:

```rust
const INSTANCE_BUMP: u32 = 518_400;      // 30 days at 5s/ledger close
const INSTANCE_THRESHOLD: u32 = 17_280;  // 1 day at 5s/ledger close
const PERSISTENT_BUMP: u32 = 518_400;    // 30 days at 5s/ledger close
const PERSISTENT_THRESHOLD: u32 = 17_280;// 1 day at 5s/ledger close
```

### Rent Cost Formula (CAP-0046-08)

```
rent_fee_stroops = ceil(entry_size_bytes / 1024) × fee_rate_1kb × delta_ledgers
```

- **`fee_rate_1kb`**: ~1 stroop / 1 KB / ledger (0.0000001 XLM / 1 KB / ledger).
- **`delta_ledgers`**: 518,400 ledgers (full 30-day bump).
- **Base Rent per 1 KB entry per 30-day bump**:
  $$\text{Rent} = 1 \times 1 \text{ stroop} \times 518,400 = 518,400 \text{ stroops} \approx \mathbf{0.05184 \text{ XLM}} \approx \mathbf{0.052 \text{ XLM}}$$
- **Threshold Rule**: An entry is only bumped when its remaining TTL drops below `17,280` ledgers (~1 day). Entries accessed multiple times within 24 hours incur no additional rent extension writes.

---

## Instance Storage Inventory (Shared Entry)

All instance keys reside in the shared contract instance `LedgerEntry`. They expire and bump together. Total combined XDR payload is ~180 bytes, well below the 1 KB billing boundary.

| Key Symbol | Data Type | Rust Storage Function | Description & Purpose | Granularity |
|---|---|---|---|---|
| `INIT` | `bool` | `init_key()` | Initialization guard; prevents multiple `initialize` calls. | Singleton |
| `THRESH` | `u32` | `threshold_key()` | Approval threshold (M in M-of-N, or required quorum weight). | Singleton |
| `NEXT` | `u64` | `next_id_key()` | Monotonic auto-incrementing proposal ID counter. | Singleton |
| `RNEXT` | `u64` | `recur_next_id_key()` | Monotonic auto-incrementing recurring payment schedule ID counter. | Singleton |
| `ACTCNT` | `u32` | `active_count_key()` | Count of currently active (Pending + Ready) proposals. Bound by `MAX_ACTIVE_PROPOSALS` (50). | Singleton |
| `ACTREC` | `u32` | `active_recur_count_key()` | Count of active recurring payment schedules. Bound by `MAX_ACTIVE_RECURRING` (20). | Singleton |
| `TLOCK` | `u64` | `timelock_key()` | Global execution delay in seconds (0 = immediate execution after threshold). | Singleton |
| `GUARD` | `Address` | `guardian_key()` | Emergency guardian address authorized to execute `freeze()` or recovery. | Singleton |
| `FROZEN` | `bool` | `frozen_key()` | Emergency circuit-breaker freeze flag. If `true`, write calls return `ContractFrozen`. | Singleton |
| `RECOV` | `bool` | `recovery_key()` | Recovery mode status flag. If `true`, token transfers are paused; governance remains active. | Singleton |
| `TWEIGHT` | `u32` | `total_weight_key()` | Cached sum of all owner voting weights in the `OWNERS` map. | Singleton |
| `GOVVER` | `bool` | `governance_version_key()` | Flag indicating contract has completed migration to weighted governance. | Singleton |
| `ROLEVER` | `u32` | `role_version_key()` | Role-Based Access Control schema version (`1` = RBAC active). | Singleton |
| `STOVER` | `u32` | `storage_version_key()` | Storage-schema layout version (`STORAGE_SCHEMA_VERSION = 1`). | Singleton |
| `MAXOWNP` | `u32` | `max_single_owner_weight_pct_key()` | Maximum single-owner voting weight share percentage (default `50%`). | Singleton |

**Total Instance Cost**: **~0.052 XLM per 30-day bump cycle** (shared by all 15 instance keys).

---

## Persistent Storage Inventory (Independent Entries)

Each key below occupies an independent `LedgerEntry` with separate TTL extension tracking:

| Key Structure | Data Type | Rust Storage Function | Granularity | Approx Size (Bytes) | Billed Size | Approx Cost / 30 Days | Purpose |
|---|---|---|---|---|---|---|---|
| `OWNERS` | `Map<Address, u32>` | `owners_key()` | Global Singleton | 52–808 B (1–20 owners) | 1 KB | ~0.052 XLM | Active owner set mapped to voting weights (max 20 owners). |
| `ACTIDS` | `Vec<u64>` | `active_ids_key()` | Global Singleton | ~440 B (up to 50 IDs) | 1 KB | ~0.052 XLM | Active proposal ID tracking list for lazy purge and bounds checking. |
| `("PROP", id)` | `Proposal` | `proposal_key(id)` | Per-Proposal | 388–588 B | 1 KB | ~0.052 XLM | Full proposal state: proposer, description (max 300 chars), deadline, status, transfers, and metadata. |
| `("APPR", id, owner)` | `u32` | `approval_key(id, owner)` | Per-Proposal, Per-Owner | ~144 B | 1 KB | ~0.052 XLM | Recorded voting weight credited to `owner` for proposal `id`. Removed if approval is revoked. |
| `("RECUR", id)` | `RecurringPayment` | `recur_key(id)` | Per-Schedule | ~450 B | 1 KB | ~0.052 XLM | Recurring stream state: recipient, token, amount, interval, cap, disbursed totals, and kind. |
| `("SPLIM", owner, token)` | `i128` | `spending_limit_key(owner, token)` | Per-Owner, Per-Token | ~148 B | 1 KB | ~0.052 XLM | Spending cap on the amount `owner` can propose to transfer for `token`. |
| `("SWIND", owner, token)` | `u64` | `spending_window_key(owner, token)` | Per-Owner, Per-Token | ~140 B | 1 KB | ~0.052 XLM | Configured spending window in seconds (default 30 days, min 1 day, max 7 days configurable). |
| `("SPENT", owner, token)` | `SpentTracker` | `spent_tracking_key(owner, token)` | Per-Owner, Per-Token | ~152 B | 1 KB | ~0.052 XLM | Cumulative tokens spent by `owner` in the current window epoch (`spent: i128, epoch: u64`). |
| `("OSLIM", owner)` | `Vec<SpendingLimitEntry>` | `owner_spending_limits_key(owner)` | Per-Owner | ~120–400 B | 1 KB | ~0.052 XLM | Index of all token spending limits defined for an owner. |
| `("ROLES", address)` | `Vec<Role>` | `role_key(address)` | Per-Owner / Per-Address | ~120 B | 1 KB | ~0.052 XLM | Role set (`Proposer`, `Approver`, `Executor`, `Viewer`) assigned to an address. |
| `("RMEM", role)` | `Vec<Address>` | `role_members_key(role)` | Per-Role | ~120–880 B | 1 KB | ~0.052 XLM | Index of all addresses holding a specific role (max 20 members). |
| `("DELEG", delegator)` | `Delegation` | `delegation_key(delegator)` | Per-Owner (Delegator) | ~164 B | 1 KB | ~0.052 XLM | Outgoing voting weight delegation: delegate address, weight, and expiration timestamp. |
| `("CLASSIC", asset)` | `Address` | `classic_asset_key(asset)` | Per-Classic Asset | ~128 B | 1 KB | ~0.052 XLM | Mapping from asset symbol (`XLM`, `USDC`, `EURC`) to Stellar Asset Contract address. |

---

## Key Granularity & Scaling Analysis

Understanding key granularity ensures reviewers can evaluate storage costs when features scale:

### 1. Global Singleton Keys
- **Count**: Fixed at **2 persistent entries** (`OWNERS`, `ACTIDS`) + 1 instance entry.
- **Scaling Behavior**: $O(1)$ with respect to proposal volume.
- **Lifetime**: Permanent for the life of the multisig contract.

### 2. Per-Proposal Keys
- **Entries Created**:
  - `1` `("PROP", id)` entry.
  - Up to $N$ `("APPR", id, owner)` entries, where $N$ is the number of voting co-owners.
- **Maximum Active Footprint**: Bound by `MAX_ACTIVE_PROPOSALS = 50`.
  - For a 7-owner multisig: $50 \times (1 + 7) = \mathbf{400}$ max concurrent entries.
- **Lifecycle & Expiry**:
  - Inactive / settled proposals remain in ledger storage until their 30-day persistent TTL expires without access.

### 3. Per-Owner Keys
- **Entries Created**:
  - `("ROLES", owner)` (1 per owner)
  - `("OSLIM", owner)` (1 per owner with limits)
  - `("DELEG", owner)` (at most 1 per owner with active delegation)
- **Maximum Footprint**: Bound by `MAX_OWNERS = 20`.
  - At 20 owners: at most $20 \times 3 = \mathbf{60}$ persistent entries.

### 4. Per-Owner-Per-Token Keys
- **Entries Created**:
  - `("SPLIM", owner, token)`
  - `("SWIND", owner, token)`
  - `("SPENT", owner, token)`
- **Footprint**: $3 \times \text{distinct } (\text{owner}, \text{token}) \text{ pairs}$. If 5 owners have limits on 2 tokens = $5 \times 2 \times 3 = \mathbf{30}$ entries.

### 5. Per-Schedule Keys
- **Entries Created**: `("RECUR", id)` (1 per recurring schedule).
- **Maximum Active Footprint**: Bound by `MAX_ACTIVE_RECURRING = 20`.
  - At 20 active schedules: $\mathbf{20}$ persistent entries.

### 6. Per-Role Keys
- **Entries Created**: `("RMEM", role)` for 4 roles (`Proposer`, `Approver`, `Executor`, `Viewer`).
- **Footprint**: Fixed at $\mathbf{4}$ persistent entries.

---

## Worst-Case Multisig Storage Cost Model

Let us calculate the worst-case on-chain storage footprint and monthly rent for a fully loaded **20-owner multisig** operating at maximum contract limits:

| Storage Item | Entries | Billed KB | Monthly Cost (XLM) |
|---|---|---|---|
| **Instance Entry** (All 15 instance keys) | 1 | 1 KB | ~0.052 XLM |
| **`OWNERS` Map & `ACTIDS` List** | 2 | 2 KB | ~0.104 XLM |
| **Role Indexes** (`4` `RMEM` + `20` `ROLES`) | 24 | 24 KB | ~1.248 XLM |
| **Owner Limits & Windows** (20 owners × 2 tokens) | 120 | 120 KB | ~6.240 XLM |
| **Active Delegations** (20 owners) | 20 | 20 KB | ~1.040 XLM |
| **Active Recurring Payments** (20 schedules) | 20 | 20 KB | ~1.040 XLM |
| **Active Proposals** (50 proposals × [1 PROP + 20 APPR]) | 1,050 | 1,050 KB | ~54.600 XLM |
| **Total Worst-Case Ceiling** | **1,237 entries** | **1,237 KB** | **~64.324 XLM / month** |

### Typical Real-World Setup (5-of-7 Multisig, 5 Active Proposals):

| Storage Item | Entries | Monthly Cost (XLM) |
|---|---|---|
| Contract Instance | 1 | ~0.052 XLM |
| Owners & Active IDs | 2 | ~0.104 XLM |
| Roles (4 roles + 7 owners) | 11 | ~0.572 XLM |
| Spending Limits (3 owners, 1 token) | 9 | ~0.468 XLM |
| Active Recurring Schedules (2) | 2 | ~0.104 XLM |
| Active Proposals (5 proposals × [1 PROP + 5 APPR]) | 30 | ~1.560 XLM |
| **Total Typical Monthly Rent** | **55 entries** | **~2.86 XLM / month** ($0.29 USD at $0.10/XLM) |

---

## Storage Schema Versioning & Sync Maintenance Note

### Maintenance Rule & Developer Contract

1. **Storage Invariant**: Every storage key read or written in `contracts/accord/src/lib.rs` must have a corresponding entry in this reference document and in `docs/ARCHITECTURE.md` §3.
2. **Schema Versioning**:
   - The contract defines `STORAGE_SCHEMA_VERSION = 1` in `contracts/accord/src/lib.rs`.
   - Any commit that adds a new storage key, deletes an existing key, or modifies the serialized type of a value **must**:
     - Increment `STORAGE_SCHEMA_VERSION` in `lib.rs`.
     - Update the version migration table in `docs/ARCHITECTURE.md`.
     - Document the new key, its granularity, and its approximate size in this document.
3. **Reviewer Checklist for PRs Touching Storage**:
   - [ ] Is every new key using a short `Symbol` (≤ 9 chars) or clean tuple `(Symbol, ...)`?
   - [ ] Does the mutation call `bump_persistent()` or `bump_instance()`?
   - [ ] Is key granularity documented (Singleton, Per-Owner, Per-Proposal)?
   - [ ] Has worst-case entry growth been bounded (e.g. by a `MAX_*` constant)?
   - [ ] Has `docs/STORAGE_MODEL.md` been updated to match?
