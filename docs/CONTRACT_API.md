# Accord Contract API Reference

All amounts are in the token's smallest unit (stroops for XLM-derived tokens).
All deadlines are Unix timestamps (seconds since epoch).

---

## `initialize`

```rust
fn initialize(env: Env, owners: Vec<Address>, threshold: u32) -> Result<(), ContractError>
```

One-shot initializer. Must be called before any other function. All owners must authorize this call.

| Parameter | Type | Constraints |
|-----------|------|-------------|
| `owners` | `Vec<Address>` | 1–20 unique addresses |
| `threshold` | `u32` | 1 ≤ threshold ≤ owners.len() |

**Errors:** `AlreadyInitialized`, `InvalidOwners`, `InvalidThreshold`, `DuplicateOwner`

---

## `create_proposal`

```rust
fn create_proposal(
    env: Env,
    proposer: Address,
    to: Address,
    amount: i128,
    token: Address,
    description: String,
    deadline: u64,
) -> Result<u64, ContractError>
```

Creates a transfer proposal. Returns the new proposal ID.

| Parameter | Type | Constraints |
|-----------|------|-------------|
| `proposer` | `Address` | Must be an owner. Must authorize. |
| `to` | `Address` | Recipient address |
| `amount` | `i128` | ≥ 1 |
| `token` | `Address` | Must implement Soroban token interface (`decimals()` + `symbol()`) |
| `description` | `String` | 1–300 characters |
| `deadline` | `u64` | > current ledger timestamp, ≤ now + 90 days |

**Emits:** `("created",)` → `ProposalCreatedEvent`

**Errors:** `Unauthorized`, `InvalidAmount`, `EmptyDescription`, `DescriptionTooLong`, `InvalidDeadline`, `InvalidDuration`, `InvalidToken`, `TooManyActiveProposals`

---

## `approve`

```rust
fn approve(env: Env, approver: Address, proposal_id: u64) -> Result<(), ContractError>
```

Records an approval for `proposal_id` from `approver`. Transitions status to `Ready` when threshold is reached.

| Parameter | Type | Constraints |
|-----------|------|-------------|
| `approver` | `Address` | Must be an owner. Must authorize. |
| `proposal_id` | `u64` | Must refer to an existing Pending or Ready proposal |

**Emits:** `("approved",)` → `ProposalApprovedEvent`

**Errors:** `Unauthorized`, `ProposalNotFound`, `ProposalNotActive`, `AlreadyApproved`

---

## `revoke`

```rust
fn revoke(env: Env, approver: Address, proposal_id: u64) -> Result<(), ContractError>
```

Withdraws the caller's approval. Transitions status back to `Pending` if approvals drop below threshold.

| Parameter | Type | Constraints |
|-----------|------|-------------|
| `approver` | `Address` | Must be an owner with an existing approval. Must authorize. |
| `proposal_id` | `u64` | Must refer to an existing Pending or Ready proposal |

**Emits:** `("revoked",)` → `ProposalRevokedEvent`

**Errors:** `Unauthorized`, `ProposalNotFound`, `ProposalNotActive`, `NotApproved`

---

## `execute`

```rust
fn execute(env: Env, executor: Address, proposal_id: u64) -> Result<(), ContractError>
```

Executes a `Ready` proposal. Transfers `amount` of `token` from the contract to `proposal.to`. The contract must hold sufficient token balance.

| Parameter | Type | Constraints |
|-----------|------|-------------|
| `executor` | `Address` | Must be an owner. Must authorize. |
| `proposal_id` | `u64` | Must refer to a Ready proposal whose deadline has not passed |

**Emits:** `("executed",)` → `ProposalExecutedEvent`

**Errors:** `Unauthorized`, `ProposalNotFound`, `ProposalNotActive`, `ThresholdNotMet`, `ProposalExpired`, `TransferFailed`

---

## `get_proposal`

```rust
fn get_proposal(env: Env, proposal_id: u64) -> Result<Proposal, ContractError>
```

Returns the current proposal state with a freshly derived status (Expired status is derived from the current ledger timestamp without requiring a write).

**Errors:** `NotInitialized`, `ProposalNotFound`

---

## `get_proposals_paged`

```rust
fn get_proposals_paged(env: Env, offset: u64, limit: u32) -> Vec<Proposal>
```

Returns a page of proposals. `offset` is 0-based (first proposal is at offset 0). `limit` is capped at 20. Proposals are returned in creation order.

---

## `get_owners`

```rust
fn get_owners(env: Env) -> Result<Vec<Address>, ContractError>
```

Returns the current owner list.

---

## `get_threshold`

```rust
fn get_threshold(env: Env) -> Result<u32, ContractError>
```

Returns the approval threshold.

---

## `get_total_proposals`

```rust
fn get_total_proposals(env: Env) -> u64
```

Returns the total number of proposals ever created (including expired and executed).

---

## `is_owner`

```rust
fn is_owner(env: Env, address: Address) -> bool
```

Returns `true` if `address` is a current owner.

---

## `has_approved`

```rust
fn has_approved(env: Env, proposal_id: u64, owner: Address) -> bool
```

Returns `true` if `owner` has approved `proposal_id`.

---

## Error Codes

| Code | Value | Meaning |
|------|-------|---------|
| `AlreadyInitialized` | 1 | `initialize` was already called |
| `NotInitialized` | 2 | Contract has not been initialized |
| `Unauthorized` | 3 | Caller is not an owner |
| `InvalidThreshold` | 4 | threshold = 0 or threshold > owner count |
| `InvalidOwners` | 5 | Empty or oversized owner list |
| `ProposalNotFound` | 6 | No proposal exists with that ID |
| `ProposalNotActive` | 7 | Proposal is Executed, Expired, or Revoked |
| `AlreadyApproved` | 8 | Owner already approved this proposal |
| `NotApproved` | 9 | Owner has not approved — cannot revoke |
| `ThresholdNotMet` | 10 | Approvals < threshold — cannot execute |
| `ProposalExpired` | 11 | Deadline has passed |
| `InvalidAmount` | 12 | Amount < 1 |
| `InvalidDeadline` | 13 | Deadline ≤ current ledger timestamp |
| `InvalidToken` | 14 | Token address does not implement Soroban token interface |
| `TransferFailed` | 15 | On-chain token transfer failed (check contract balance) |
| `EmptyDescription` | 16 | Description is empty |
| `DescriptionTooLong` | 17 | Description exceeds 300 characters |
| `TooManyActiveProposals` | 18 | Active proposal count reached limit (50) |
| `DuplicateOwner` | 19 | Duplicate address in owner list |
| `ArithmeticError` | 20 | Integer overflow |
| `InvalidDuration` | 21 | Deadline more than 90 days in the future |

---

## XDR Type Reference

When calling contract functions from JavaScript, each parameter must be converted to the XDR `SCVal` format that the Soroban RPC expects. The Stellar SDK provides `nativeToScVal` for encoding and `scValToNative` for decoding.

> **Important:** `u64` and `i128` values exceed JavaScript's safe integer range (`Number.MAX_SAFE_INTEGER` = 2⁵³ − 1). They **must** be passed as JavaScript `BigInt` — not `Number`. Using `Number` silently truncates the value.

| Rust Type | SCVal Variant | Build with `nativeToScVal` | Decode with `scValToNative` |
|-----------|---------------|----------------------------|-----------------------------|
| `Address` | `ScVal::Address` | `nativeToScVal(address, { type: 'address' })` | `scValToNative(scval)` → `"G…"` string |
| `Vec<T>` | `ScVal::Vec` | `nativeToScVal(array, { type: 'vec' })` | `scValToNative(scval)` → JavaScript `Array` |
| `u32` | `ScVal::U32` | `nativeToScVal(n, { type: 'u32' })` | `scValToNative(scval)` → JavaScript `Number` |
| `u64` | `ScVal::U64` | `nativeToScVal(BigInt(n), { type: 'u64' })` | `scValToNative(scval)` → JavaScript `BigInt` |
| `i128` | `ScVal::I128` | `nativeToScVal(BigInt(n), { type: 'i128' })` | `scValToNative(scval)` → JavaScript `BigInt` |
| `String` | `ScVal::String` | `nativeToScVal(s, { type: 'string' })` | `scValToNative(scval)` → JavaScript `String` |
| `bool` | `ScVal::Bool` | `nativeToScVal(b, { type: 'bool' })` | `scValToNative(scval)` → JavaScript `Boolean` |
| `Proposal` | `ScVal::Map` | N/A (output only) | `scValToNative(scval)` → plain JavaScript object whose field names match the `Proposal` struct in [ARCHITECTURE.md §3](../ARCHITECTURE.md#3-storage-layout-soroban) |
| `()` (unit) | `ScVal::Void` | N/A (no input) | `scValToNative(scval)` → `undefined` |

---

## Event Payloads

### `ProposalCreatedEvent`
```rust
struct ProposalCreatedEvent {
    id: u64,
    proposer: Address,
    to: Address,
    amount: i128,
    threshold: u32,
}
```

### `ProposalApprovedEvent`
```rust
struct ProposalApprovedEvent {
    id: u64,
    approver: Address,
    approvals: u32,
    threshold: u32,
}
```

### `ProposalRevokedEvent`
```rust
struct ProposalRevokedEvent {
    id: u64,
    approver: Address,
    approvals: u32,
}
```

### `ProposalExecutedEvent`
```rust
struct ProposalExecutedEvent {
    id: u64,
    executor: Address,
    to: Address,
    amount: i128,
}
```
