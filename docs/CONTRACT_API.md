# Accord Contract API Reference

All amounts are in the token's smallest unit (stroops for XLM-derived tokens).
All deadlines are Unix timestamps (seconds since epoch).

### Token Amounts and Decimals

All `amount` fields in function parameters and event data use the token's smallest unit. The table below lists the conventions for common tokens:

| Token | Decimals | Smallest Unit | Conversion Formula |
|-------|----------|--------------|-------------------|
| **XLM** | 7 | stroop | `human_amount × 10⁷ = on_chain_amount` |
| **USDC** | 7 | micro-dollar | `human_amount × 10⁷ = on_chain_amount` |
| **EURC** | 7 | micro-euro | `human_amount × 10⁷ = on_chain_amount` |

To convert a human-readable amount to the value passed to the contract: multiply by `10^decimals`. Every `amount` field — both in function parameters and event data — uses this smallest-unit representation (see the [Event Payloads](#event-payloads) section for per-field annotations).

---

## Common Errors Quick Reference

Scan this table when you hit an error code and need a fast answer. Errors developers hit most often during normal development are listed first. For full cause descriptions and remediation detail, see the [Error Reference](#error-reference) section below.

| Code / Variant | Most common root cause | One-line resolution |
|----------------|------------------------|---------------------|
| 3 `Unauthorized` | Signer is not a registered owner (or wrong Freighter account). | Switch to a registered owner address and retry. |
| 6 `ProposalNotFound` | Wrong `proposal_id`, network, or contract address. | Confirm the ID with `get_total_proposals` on the correct contract. |
| 12 `InvalidAmount` | Amount is less than 1, empty transfer list, or more than 3 transfers. | Pass 1–3 transfers with each amount ≥ 1 in the token's smallest unit. |
| 13 `InvalidDeadline` | Deadline is not strictly after the current ledger timestamp. | Set a future Unix deadline with a few minutes of buffer. |
| 7 `ProposalNotActive` | Proposal is already `Executed`, `Expired`, or `Revoked`. | Check status via `get_proposal`; create a new proposal if needed. |
| 8 `AlreadyApproved` | This owner already approved the proposal. | Call `revoke` before approving again, or skip. |
| 10 `ThresholdNotMet` | Not enough approvals (or too few co-signers on guardian/upgrade). | Gather threshold approvals / approvers, then retry. |
| 11 `ProposalExpired` | Deadline passed before `execute`. | Create a new proposal; sweep the expired ID if needed. |
| 15 `TransferFailed` | Contract treasury lacks sufficient token balance. | Fund the contract, then retry `execute`. |
| 14 `InvalidToken` | Token address does not implement the Soroban token interface. | Use a verified SEP-41 token (e.g. canonical XLM/USDC). |
| 16 `EmptyDescription` | Description string is empty. | Provide a non-empty description. |
| 17 `DescriptionTooLong` | Description exceeds 300 characters. | Trim the description to ≤ 300 characters. |
| 9 `NotApproved` | `revoke` called without a prior approval from this owner. | Only revoke after a successful `approve`. |
| 18 `TooManyActiveProposals` | Active (`Pending`/`Ready`) proposals hit the cap of 50. | Execute or sweep expired proposals, then retry. |
| 21 `InvalidDuration` | Deadline is more than 90 days from now. | Cap the deadline at ≤ 90 days ahead. |
| 22 `InvalidRecipient` | Transfer recipient is the contract's own address. | Use an external recipient address. |
| 28 `SpendingLimitExceeded` | Proposal amount exceeds the proposer's per-token spending limit. | Lower the amount or raise/remove the spending limit. |
| 29 `InvalidWeight` | An owner weight is above the maximum allowed value. | Use a weight within the `[MIN_OWNER_WEIGHT, MAX_OWNER_WEIGHT]` range. |
| 30 `WeightBelowMinimum` | An owner weight is below the minimum allowed value (zero is never valid). | Use a positive weight; use `RemoveOwner` rather than setting weight to zero. |
| 31 `SingleOwnerWeightCapExceeded` | A weight change would give one owner more than the configured share of total voting weight. | Choose a lower weight or adjust the quorum-authorized cap deliberately. |
| 23 `TimeLockActive` | Time-lock delay after reaching `Ready` has not elapsed. | Wait until `ready_at + time_lock_delay`, then execute. |
| 26 `ContractFrozen` | Contract is frozen; create/execute paths are blocked. | Co-sign `unfreeze` with threshold owners. |
| 27 `NoGuardian` | `freeze` called before a guardian was registered. | Call `set_guardian` first, then freeze. |
| 1 `AlreadyInitialized` | `initialize` called twice on the same instance. | Deploy a fresh contract; do not re-initialize. |
| 2 `NotInitialized` | Contract used before `initialize` completed. | Call `initialize` and wait for finality first. |
| 4 `InvalidThreshold` | Threshold is 0 or greater than the owner count. | Use a threshold in `[1, owners.len()]`. |
| 5 `InvalidOwners` | Owner list empty, or adding an owner would exceed 20. | Provide 1–20 owners; remove one before adding at cap. |
| 19 `DuplicateOwner` | Duplicate address in owners/approvers or add-owner list. | Deduplicate addresses before submitting. |
| 24 `WouldBreakThreshold` | Removing an owner would leave fewer owners than threshold (flat count checks). | Lower threshold first, then remove the owner. |
| 34 `WouldBreakQuorum` | Weight change or owner removal would leave total weight below threshold or leave an active proposal un-quorumable. | Lower threshold first or wait for active proposals to finish before modifying weights. |
| 25 `OwnerNotFound` | Address to remove or change weight for is not in the current owner list. | Verify with `is_owner` / `get_owners` first. |
| 20 `ArithmeticError` | Integer overflow/underflow guard tripped (rare). | Contact maintainers; should not occur in normal use. |
| 32 `TargetOwnerNoLongerExists` | The target of a `ChangeOwnerWeight` proposal is no longer an owner at execution time. | This is an edge case; create a new proposal. |
| 33 `AlreadyMigrated` | `migrate_to_weighted_governance` was called on a contract that already has weighted governance. | Do not re-migrate; the contract is already up-to-date. |

---

## Owner weights and `ChangeOwnerWeight`

`ChangeOwnerWeight(target_owner, new_weight)` accepts only positive weights.
**Zero is never a valid weight**: leaving an address on the owner list with no
meaningful vote is ambiguous, so use the `RemoveOwner` proposal flow when an
owner must lose voting rights. The contract checks this both when the proposal
is created and again immediately before it is executed.

The resulting weight is also limited by the configurable
`get_max_single_owner_weight_pct()` parameter (50% by default). A weighted,
distinct-owner quorum may tighten it through
`set_max_single_owner_weight_pct(approvers, max_pct)` (1–50 only).

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

## `get_proposal_approval_progress`

```rust
fn get_proposal_approval_progress(env: Env, proposal_id: u64) -> Result<(u32, u32, u32), ContractError>
```

Returns proposal progress values needed for frontend rendering.

| Return position | Meaning |
|-----------------|---------|
| `0` | Current approval weight (`approvals`) |
| `1` | Required quorum weight (`threshold`) |
| `2` | Current total owner weight (`total_weight`) |

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

## `get_total_weight`

```rust
fn get_total_weight(env: Env) -> u32
```

Returns the current total-weight counter — the sum of all registered owners' individual voting weights. This value is updated automatically when owners are added, removed, or re-weighted. Read-only; no authorization required.

---

## `get_required_quorum_weight`

```rust
fn get_required_quorum_weight(env: Env) -> Result<u32, ContractError>
```

Returns the quorum weight a newly created proposal would currently be assigned — that is, the value that would be stored in `Proposal.quorum_weight` and emitted in `ProposalCreatedEvent.quorum_weight` if a proposal were created right now. This is the same computation the proposal-creation functions use internally, so the view and the actual creation path can never drift out of sync.

Frontends should call this before rendering a "create proposal" screen so they can display the required quorum to the user before any transaction is submitted. The function is read-only and has no side effects.

**Errors:** `NotInitialized`

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

## `get_owner_weight`

```rust
fn get_owner_weight(env: Env, owner: Address) -> Result<u32, ContractError>
```

Returns the current voting weight for `owner`. The weight reflects the owner's individual contribution to quorum calculations. Read-only; no authorization required.

**Errors:** `NotInitialized`, `OwnerNotFound` (if `owner` is not a current owner)

---

## `get_owner_weights`

```rust
fn get_owner_weights(env: Env) -> Result<Vec<OwnerWeight>, ContractError>
```

Returns every current owner's address paired with their voting weight, in a single call. The returned list is a `Vec<OwnerWeight>` where each entry contains an `owner` field (the address) and a `weight` field (the owner's individual voting weight). The sum of all returned weights equals the current total-weight counter. This avoids the need for N separate `get_owner_weight` calls when rendering a full governance overview. Read-only; no authorization required.

| Return field | Type | Description |
|---|---|---|
| `owner` | `Address` | A current owner's address |
| `weight` | `u32` | That owner's individual voting weight |

**Errors:** `NotInitialized`

### JavaScript SDK example

```js
const ownerWeights = await contract.call("get_owner_weights");
```

In practice, frontends should use this view instead of calling `get_owner_weight` once per owner when they need the full set of weights for a governance overview or owners list.

> Pagination was intentionally deferred for this view because the owner set is capped at 20 (`MAX_OWNERS`), so a single call already returns the entire current owner-weight snapshot without introducing extra complexity.

---

## `has_approved`

```rust
fn has_approved(env: Env, proposal_id: u64, owner: Address) -> bool
```

Returns `true` if `owner` has approved `proposal_id`.

---

## Governance Proposals

These four functions create **governance proposals**. Like `create_proposal`, each returns a new proposal ID and then follows the standard **create → approve → execute** lifecycle: the returned proposal must reach the approval threshold via `approve` and then be run with `execute` before it takes effect. All four require the `proposer` to be a current owner and require the contract not to be frozen, and all enforce the same `description` (1–300 characters), `deadline` (strictly future, ≤ 90 days ahead), and active-proposal-cap (≤ 50) rules as `create_proposal`. Each emits `("created",)` → `ProposalCreatedEvent` with an empty `transfers` list and `category = Other`.

The JavaScript examples below assume `server` (an `rpc.Server`), `CONTRACT_ID`, and `networkPassphrase` are already defined, and reuse this helper to build, prepare, sign, and submit an owner-authorized write:

```js
import { Contract, TransactionBuilder, nativeToScVal, xdr } from "@stellar/stellar-sdk";

const contract = new Contract(CONTRACT_ID);

// Build → prepare (simulate) → sign with the proposer's key → submit.
async function submitOwnerCall(op, proposerKeypair) {
  const account = await server.getAccount(proposerKeypair.publicKey());
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase })
    .addOperation(op)
    .setTimeout(30)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(proposerKeypair); // or a wallet's signTransaction()
  return server.sendTransaction(prepared);
}
```

### `create_add_owner_proposal`

```rust
fn create_add_owner_proposal(
    env: Env,
    proposer: Address,
    new_owner: Address,
    description: String,
    deadline: u64,
) -> Result<u64, ContractError>
```

Proposes adding `new_owner` to the multisig. On execution the new owner is stored with the minimum voting weight of `1`. Returns the new proposal ID.

| Parameter | Type | Constraints |
|-----------|------|-------------|
| `proposer` | `Address` | Must be an owner. Must authorize. |
| `new_owner` | `Address` | Must not already be an owner. Current owner count must be `< 20` (`MAX_OWNERS`). |
| `description` | `String` | 1–300 characters |
| `deadline` | `u64` | > current ledger timestamp, ≤ now + 90 days |

**Emits:** `("created",)` → `ProposalCreatedEvent`

**Errors:** `Unauthorized`, `ContractFrozen`, `DuplicateOwner`, `InvalidOwners`, `EmptyDescription`, `DescriptionTooLong`, `InvalidDeadline`, `InvalidDuration`, `TooManyActiveProposals`

```js
await submitOwnerCall(
  contract.call(
    "create_add_owner_proposal",
    nativeToScVal(proposer, { type: "address" }),
    nativeToScVal(newOwner, { type: "address" }),
    nativeToScVal(description, { type: "string" }),
    nativeToScVal(BigInt(deadline), { type: "u64" }),
  ),
  proposerKeypair,
);
```

### `create_remove_owner_proposal`

```rust
fn create_remove_owner_proposal(
    env: Env,
    proposer: Address,
    owner_to_remove: Address,
    description: String,
    deadline: u64,
) -> Result<u64, ContractError>
```

Proposes removing `owner_to_remove` from the multisig. Rejected at creation if the removal would drop the remaining total owner weight below the current threshold. Returns the new proposal ID.

| Parameter | Type | Constraints |
|-----------|------|-------------|
| `proposer` | `Address` | Must be an owner. Must authorize. |
| `owner_to_remove` | `Address` | Must be a current owner. Remaining total weight after removal must stay ≥ threshold. |
| `description` | `String` | 1–300 characters |
| `deadline` | `u64` | > current ledger timestamp, ≤ now + 90 days |

**Emits:** `("created",)` → `ProposalCreatedEvent`

**Errors:** `Unauthorized`, `ContractFrozen`, `OwnerNotFound`, `WouldBreakThreshold`, `EmptyDescription`, `DescriptionTooLong`, `InvalidDeadline`, `InvalidDuration`, `TooManyActiveProposals`, `ArithmeticError`

```js
await submitOwnerCall(
  contract.call(
    "create_remove_owner_proposal",
    nativeToScVal(proposer, { type: "address" }),
    nativeToScVal(ownerToRemove, { type: "address" }),
    nativeToScVal(description, { type: "string" }),
    nativeToScVal(BigInt(deadline), { type: "u64" }),
  ),
  proposerKeypair,
);
```

### `create_change_threshold_proposal`

```rust
fn create_change_threshold_proposal(
    env: Env,
    proposer: Address,
    new_threshold: u32,
    description: String,
    deadline: u64,
) -> Result<u64, ContractError>
```

Proposes changing the approval threshold. The threshold is an **absolute weight value**, so it is validated against the current total owner weight rather than the owner count. Returns the new proposal ID.

| Parameter | Type | Constraints |
|-----------|------|-------------|
| `proposer` | `Address` | Must be an owner. Must authorize. |
| `new_threshold` | `u32` | ≥ 1 and ≤ current total owner weight |
| `description` | `String` | 1–300 characters |
| `deadline` | `u64` | > current ledger timestamp, ≤ now + 90 days |

**Emits:** `("created",)` → `ProposalCreatedEvent`

**Errors:** `Unauthorized`, `ContractFrozen`, `InvalidThreshold`, `EmptyDescription`, `DescriptionTooLong`, `InvalidDeadline`, `InvalidDuration`, `TooManyActiveProposals`

```js
await submitOwnerCall(
  contract.call(
    "create_change_threshold_proposal",
    nativeToScVal(proposer, { type: "address" }),
    nativeToScVal(newThreshold, { type: "u32" }),
    nativeToScVal(description, { type: "string" }),
    nativeToScVal(BigInt(deadline), { type: "u64" }),
  ),
  proposerKeypair,
);
```

### `create_spending_limit_proposal`

```rust
fn create_spending_limit_proposal(
    env: Env,
    proposer: Address,
    owner: Address,
    token: Address,
    limit: i128,
    description: String,
    deadline: u64,
) -> Result<u64, ContractError>
```

Proposes setting (or changing) a per-owner, per-token spending limit. Once executed, the limit caps the cumulative amount `owner` may propose for `token` within a fixed 30-day window; it is enforced in `create_proposal`. A `limit` of `0` blocks that token entirely for that owner. Returns the new proposal ID.

| Parameter | Type | Constraints |
|-----------|------|-------------|
| `proposer` | `Address` | Must be an owner. Must authorize. |
| `owner` | `Address` | The owner the limit applies to |
| `token` | `Address` | The token the limit applies to |
| `limit` | `i128` | ≥ 0 (`0` blocks the token for that owner) |
| `description` | `String` | 1–300 characters |
| `deadline` | `u64` | > current ledger timestamp, ≤ now + 90 days |

**Emits:** `("created",)` → `ProposalCreatedEvent`

**Errors:** `Unauthorized`, `ContractFrozen`, `InvalidAmount`, `EmptyDescription`, `DescriptionTooLong`, `InvalidDeadline`, `InvalidDuration`, `TooManyActiveProposals`

```js
await submitOwnerCall(
  contract.call(
    "create_spending_limit_proposal",
    nativeToScVal(proposer, { type: "address" }),
    nativeToScVal(owner, { type: "address" }),
    nativeToScVal(token, { type: "address" }),
    nativeToScVal(BigInt(limit), { type: "i128" }),
    nativeToScVal(description, { type: "string" }),
    nativeToScVal(BigInt(deadline), { type: "u64" }),
  ),
  proposerKeypair,
);
```

### `get_owner_spending_limits`

```rust
fn get_owner_spending_limits(env: Env, owner: Address) -> Vec<SpendingLimitEntry>
```

Returns every currently configured spending-limit entry for `owner` as a list of `(token, limit)` pairs. Owners with no configured limits return an empty list. Updating an existing limit for the same token replaces the prior entry instead of creating a duplicate.

| Parameter | Type | Constraints |
|-----------|------|-------------|
| `owner` | `Address` | The owner whose configured spending limits should be returned |

**Returns:** `Vec<SpendingLimitEntry>`

```js
await contract.call("get_owner_spending_limits", nativeToScVal(owner, { type: "address" }));
```

---

## Guardian & Emergency Pause

The guardian mechanism provides an emergency pause. **Unlike the create → approve → execute proposal flow used everywhere else in the contract, `set_guardian` and `unfreeze` are single-transaction, multi-owner calls.** They each take a `Vec<Address>` of *distinct* owners who must **all sign the same transaction**, and whose combined voting weight must reach the current threshold — there is no separate approval step and no stored proposal, so authorization and effect happen atomically in one call. `freeze`, by contrast, is authorized by the single registered guardian.

Because `set_guardian` and `unfreeze` require several signatures on one transaction, each co-signing owner must add their signature to the **same** transaction envelope before it is submitted:

```js
import { Contract, TransactionBuilder, nativeToScVal, xdr } from "@stellar/stellar-sdk";

const contract = new Contract(CONTRACT_ID);

// Encode a Vec<Address> of approver addresses.
function approversScVal(approvers) {
  return xdr.ScVal.scvVec(
    approvers.map((a) => nativeToScVal(a, { type: "address" })),
  );
}

// Build one transaction and collect a signature from every co-signing owner.
async function submitCoSignedCall(op, sourceKeypair, coSignerKeypairs) {
  const account = await server.getAccount(sourceKeypair.publicKey());
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase })
    .addOperation(op)
    .setTimeout(30)
    .build();
  const prepared = await server.prepareTransaction(tx);
  for (const kp of coSignerKeypairs) prepared.sign(kp); // every approver signs the same tx
  return server.sendTransaction(prepared);
}
```

### `set_guardian`

```rust
fn set_guardian(env: Env, approvers: Vec<Address>, new_guardian: Address) -> Result<(), ContractError>
```

Assigns or replaces the guardian address. Requires distinct owner `approvers` whose combined weight reaches the threshold, all signing the same transaction.

| Parameter | Type | Constraints |
|-----------|------|-------------|
| `approvers` | `Vec<Address>` | Distinct current owners; each must authorize; combined weight ≥ threshold |
| `new_guardian` | `Address` | The address to register as guardian |

**Emits:** `("guard_set",)` → `GuardianSetEvent`

**Errors:** `NotInitialized`, `DuplicateOwner`, `Unauthorized`, `ThresholdNotMet`

```js
await submitCoSignedCall(
  contract.call(
    "set_guardian",
    approversScVal(approvers),
    nativeToScVal(newGuardian, { type: "address" }),
  ),
  approverKeypairs[0],
  approverKeypairs,
);
```

### `freeze`

```rust
fn freeze(env: Env, guardian: Address) -> Result<(), ContractError>
```

Immediately freezes the contract, blocking new proposal creation and all execution. **Only the currently registered guardian may call this**, and only after a guardian has been set.

| Parameter | Type | Constraints |
|-----------|------|-------------|
| `guardian` | `Address` | Must equal the registered guardian. Must authorize. |

**Emits:** `("frozen",)` → `FrozenEvent`

**Errors:** `NoGuardian`, `Unauthorized`

```js
const account = await server.getAccount(guardianKeypair.publicKey());
const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase })
  .addOperation(contract.call("freeze", nativeToScVal(guardian, { type: "address" })))
  .setTimeout(30)
  .build();
const prepared = await server.prepareTransaction(tx);
prepared.sign(guardianKeypair);
await server.sendTransaction(prepared);
```

### `unfreeze`

```rust
fn unfreeze(env: Env, approvers: Vec<Address>) -> Result<(), ContractError>
```

Resumes normal operation after a freeze. Like `set_guardian`, requires distinct owner `approvers` whose combined weight reaches the threshold, all signing the same transaction.

| Parameter | Type | Constraints |
|-----------|------|-------------|
| `approvers` | `Vec<Address>` | Distinct current owners; each must authorize; combined weight ≥ threshold |

**Emits:** `("unfrozen",)` → `UnfrozenEvent`

**Errors:** `NotInitialized`, `DuplicateOwner`, `Unauthorized`, `ThresholdNotMet`

```js
await submitCoSignedCall(
  contract.call("unfreeze", approversScVal(approvers)),
  approverKeypairs[0],
  approverKeypairs,
);
```

### `get_guardian`

```rust
fn get_guardian(env: Env) -> Option<Address>
```

Returns the current guardian address, or `None` (decoded as `null`/`undefined`) if no guardian has been set. Read-only; no authorization required.

```js
import { scValToNative } from "@stellar/stellar-sdk";

// Read-only: simulate the call and decode the result (no signing required).
async function simulateView(fn) {
  const account = await server.getAccount(SIM_SOURCE); // any funded account
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase })
    .addOperation(contract.call(fn))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  return scValToNative(sim.result.retval);
}

const guardian = await simulateView("get_guardian"); // "G…" string, or null if unset
```

### `is_frozen`

```rust
fn is_frozen(env: Env) -> bool
```

Returns `true` if the contract is currently frozen. Read-only; no authorization required.

```js
// Reuses the read-only simulateView helper defined for get_guardian above.
const frozen = await simulateView("is_frozen"); // boolean
```

---

## Recurring Payments

Recurring payments are **proposal-gated schedules**: an owner creates a `CreateRecurringPayment` or `CancelRecurringPayment` proposal via the standard **create → approve → execute** lifecycle (`fix.md:505` lists `create, cancel, disburse` as the implemented entrypoints; `pause / resume / modify` are not separate entrypoints in `contracts/accord/src/lib.rs:2514` — `RecurringStatus::Paused` `lib.rs:35` is reserved and pause/resume/modify are achieved by cancelling and creating a new schedule). Once a `CreateRecurringPayment` proposal is executed, a `RecurringPayment` schedule becomes `Active` and can be disbursed incrementally via the permissionless `disburse_recurring` entrypoint (used by `scripts/keeper-recurring.js`).

### `create_recurring_proposal`

```rust
fn create_recurring_proposal(
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
) -> Result<u64, ContractError>
```

Creates a governance proposal to start a recurring-payment schedule. Like the other governance proposals (`create_add_owner_proposal` etc., `CONTRACT_API.md:334`), it does **not** create the schedule directly — it returns a proposal ID that must be approved and executed; execution creates the `RecurringPayment` (`status = Active`) and emits `r_crt` `RecurringPaymentCreatedEvent`.

| Parameter | Type | Constraints |
|-----------|------|-------------|
| `proposer` | `Address` | Must be an owner. Must authorize. |
| `recipient` | `Address` | Must not be the contract address (`InvalidRecipient`). |
| `token` | `Address` | Must implement Soroban token interface. |
| `amount` | `i128` | ≥ 1 (`MIN_AMOUNT`, `lib.rs:555`). Per-period amount for `FixedAmountPerPeriod`; ignored (set `0`) for `LinearVesting` where `total_cap` drives the schedule. |
| `interval_secs` | `u64` | `60` ≤ value ≤ `31536000` (`MIN_INTERVAL_SECS`/`MAX_INTERVAL_SECS`, `lib.rs:589`). |
| `start_time` | `u64` | Ledger timestamp when disbursements may begin. |
| `end_time` | `u64` | Ledger timestamp when schedule ends (`0` = no end; for `LinearVesting` must be `> start_time`). |
| `cliff_time` | `u64` | Earliest disbursement time (`0` = no cliff; if set must be ≥ `start_time`). |
| `total_cap` | `i128` | Total cap for the schedule (`0` = uncapped for `FixedAmountPerPeriod`; for `LinearVesting` must be `> 0`). |
| `kind` | `RecurringKind` | `FixedAmountPerPeriod` or `LinearVesting` (`lib.rs:42`). |
| `description` | `String` | 1–300 characters. |
| `deadline` | `u64` | > current ledger timestamp, ≤ now + 90 days (`MAX_PROPOSAL_DURATION`). |
| `category` | `ProposalCategory` | `Payroll`, `Grant`, `Ops`, etc. Stored in `RecurringPayment.category`. |

**Emits:** `("created",)` → `ProposalCreatedEvent` (proposal creation); on execution `("r_crt",)` → `RecurringPaymentCreatedEvent`.

**Errors:** `Unauthorized`, `ContractFrozen`, `InvalidAmount`, `InvalidInterval`, `InvalidRecipient`, `EmptyDescription`, `DescriptionTooLong`, `InvalidDeadline`, `InvalidDuration`, `TooManyActiveProposals`, `TooManyActiveRecurring` (if `active >= 20`, `lib.rs:594`), `ArithmeticError`.

```js
await submitOwnerCall(
  contract.call(
    "create_recurring_proposal",
    nativeToScVal(proposer, { type: "address" }),
    nativeToScVal(recipient, { type: "address" }),
    nativeToScVal(token, { type: "address" }),
    nativeToScVal(BigInt(amount), { type: "i128" }),
    nativeToScVal(BigInt(interval_secs), { type: "u64" }),
    nativeToScVal(BigInt(start_time), { type: "u64" }),
    nativeToScVal(BigInt(end_time), { type: "u64" }),
    nativeToScVal(BigInt(cliff_time), { type: "u64" }),
    nativeToScVal(BigInt(total_cap), { type: "i128" }),
    // RecurringKind is a Soroban enum: { FixedAmountPerPeriod: void } or { LinearVesting: void }
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(kind)]), // kind = "FixedAmountPerPeriod" | "LinearVesting"
    xdr.ScVal.scvString(description),
    nativeToScVal(BigInt(deadline), { type: "u64" }),
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(category)]), // category = "Payroll" | "Grant" | ...
  ),
  proposerKeypair,
);
```

### `create_cancel_recurring_proposal`

```rust
fn create_cancel_recurring_proposal(
    env: Env,
    proposer: Address,
    schedule_id: u64,
    description: String,
    deadline: u64,
) -> Result<u64, ContractError>
```

Creates a governance proposal to cancel an existing recurring schedule. The schedule remains `Active` until the cancel proposal is approved and executed, at which point its `status` becomes `Cancelled` and `ACTREC` is decremented, emitting `r_cncl` `RecurringPaymentCancelledEvent`. `pause / resume / modify` are not separate entrypoints — modify is “cancel + new create”, pause/resume uses the `Paused` status variant reserved for future use.

| Parameter | Type | Constraints |
|-----------|------|-------------|
| `proposer` | `Address` | Must be an owner. Must authorize. |
| `schedule_id` | `u64` | Must refer to an existing schedule (`RecurringPaymentNotFound` otherwise). Must not already be `Cancelled`. |
| `description` | `String` | 1–300 characters. |
| `deadline` | `u64` | > current ledger timestamp, ≤ now + 90 days. |

**Emits:** `("created",)` → `ProposalCreatedEvent`.

**Errors:** `Unauthorized`, `ContractFrozen`, `RecurringPaymentNotFound` (39), `ScheduleAlreadyCancelled` (45), `EmptyDescription`, `DescriptionTooLong`, `InvalidDeadline`, `InvalidDuration`, `TooManyActiveProposals`.

```js
await submitOwnerCall(
  contract.call(
    "create_cancel_recurring_proposal",
    nativeToScVal(proposer, { type: "address" }),
    nativeToScVal(BigInt(schedule_id), { type: "u64" }),
    xdr.ScVal.scvString(description),
    nativeToScVal(BigInt(deadline), { type: "u64" }),
  ),
  proposerKeypair,
);
```

### `disburse_recurring`

```rust
fn disburse_recurring(env: Env, schedule_id: u64) -> Result<(), ContractError>
```

Transfers the currently claimable amount from the contract treasury to the schedule’s `recipient`. **Permissionless** — any funded Stellar account may call it (no `require_auth`), enabling the off-chain keeper `scripts/keeper-recurring.js` to automate payouts. The contract must hold sufficient token balance.

Claimable amount logic (`lib.rs:2688`): `FixedAmountPerPeriod` = `amount` (capped by remaining `total_cap`) if `now >= last_disbursed_at + interval_secs`; `LinearVesting` = `vested = total_cap * elapsed / duration - total_disbursed` where `elapsed = min(now - start_time, end_time - start_time)`. On final disbursement or when `now >= end_time`, schedule transitions to `Completed`.

| Parameter | Type | Constraints |
|-----------|------|-------------|
| `schedule_id` | `u64` | Must refer to an `Active` schedule. |

**Emits:** `("r_disb",)` → `RecurringPaymentDisbursedEvent` on success.

**Errors:** `ContractFrozen`, `RecurringPaymentNotFound` (39), `ScheduleNotActive` (41), `DisbursementTooEarly` (42), `ScheduleEnded` (43), `ArithmeticError`, `TransferFailed` (via `token.transfer`).

```js
// Permissionless — any funded account can disburse; no owner auth required.
import { Contract, TransactionBuilder, nativeToScVal } from "@stellar/stellar-sdk";
const contract = new Contract(CONTRACT_ID);
// Keeper pattern (see scripts/keeper-recurring.js):
const account = await server.getAccount(keeperKeypair.publicKey());
const tx = new TransactionBuilder(account, { fee: "100000", networkPassphrase })
  .addOperation(contract.call("disburse_recurring", nativeToScVal(BigInt(schedule_id), { type: "u64" })))
  .setTimeout(30)
  .build();
const prepared = await server.prepareTransaction(tx);
prepared.sign(keeperKeypair);
await server.sendTransaction(prepared);

// Or as an owner-authorized call via submitOwnerCall:
await submitOwnerCall(
  contract.call("disburse_recurring", nativeToScVal(BigInt(schedule_id), { type: "u64" })),
  anyKeypair,
);
```

### `get_claimable_amount`

```rust
fn get_claimable_amount(env: Env, schedule_id: u64) -> Result<i128, ContractError>
```

Read-only view. Returns the amount that would be transferred by `disburse_recurring` at the current ledger timestamp, or `0` if not yet due, not `Active`, or cap exhausted. Mirrors `disburse_recurring` logic without performing the transfer (`lib.rs:2777`).

| Parameter | Type | Constraints |
|-----------|------|-------------|
| `schedule_id` | `u64` | Must refer to an existing schedule. |

**Returns:** `i128` claimable amount in token smallest units.

**Errors:** `RecurringPaymentNotFound` (39).

```js
// Reuses the read-only simulateView helper defined for get_guardian above.
const claimable = await simulateView("get_claimable_amount", nativeToScVal(BigInt(schedule_id), { type: "u64" })); // BigInt
```

### `get_recurring_payment`

```rust
fn get_recurring_payment(env: Env, schedule_id: u64) -> Result<RecurringPayment, ContractError>
```

Read-only view. Returns the full `RecurringPayment` struct for a schedule (`lib.rs:2831`).

| Parameter | Type | Constraints |
|-----------|------|-------------|
| `schedule_id` | `u64` | Must refer to an existing schedule. |

**Returns:** `RecurringPayment` (`id, proposer, recipient, token, amount, interval_secs, start_time, end_time, cliff_time, total_cap, total_disbursed, last_disbursed_at, status, kind, category, description`).

**Errors:** `RecurringPaymentNotFound` (39).

```js
const schedule = await simulateView("get_recurring_payment", nativeToScVal(BigInt(schedule_id), { type: "u64" }));
// { id, proposer, recipient, token, amount, interval_secs, start_time, end_time, cliff_time, total_cap, total_disbursed, last_disbursed_at, status, kind, category, description }
```

### `get_active_recurring_count`

```rust
fn get_active_recurring_count(env: Env) -> u32
```

Read-only view. Returns the number of schedules currently `Active` (`ACTREC`, `lib.rs:2835`, cap `20` `lib.rs:594`). No auth required.

```js
const activeCount = await simulateView("get_active_recurring_count"); // Number
```

---

## Error Reference

The table below maps every `ContractError` discriminant to its cause and the recommended remediation. All codes are `u32` values encoded as `ScVal::Error` in XDR responses.

| Code | Variant Name | Cause / Description | Recommended Action |
|------|--------------|--------------------|--------------------|
| 1 | `AlreadyInitialized` | `initialize` was called on a contract instance that has already been set up. The `INIT` storage flag is already `true`. | Deploy a fresh contract instance; do not call `initialize` twice on the same address. |
| 2 | `NotInitialized` | A function that requires contract state (threshold, owners) was invoked before `initialize` completed successfully. | Call `initialize` first and confirm the transaction is finalized on-chain before calling any other function. |
| 3 | `Unauthorized` | The caller's address is not present in the current owner list, or the guardian address did not match when calling `freeze`. | Ensure the signing address is a registered owner. For `freeze`, ensure the address matches the stored guardian. |
| 4 | `InvalidThreshold` | The proposed threshold is either `0` or exceeds the current owner count (`threshold > owners.len()`). Thrown by `initialize` and `create_change_threshold_proposal`. | Supply a threshold in the range `[1, owners.len()]`. |
| 5 | `InvalidOwners` | The owner list passed to `initialize` is empty, or `create_add_owner_proposal` was called when the owner count is already at the maximum of **20** (`MAX_OWNERS = 20`). | Provide 1–20 unique owner addresses. If the cap is reached, remove an owner before adding another. |
| 6 | `ProposalNotFound` | No proposal record exists in persistent storage for the given `proposal_id`. | Verify the ID with `get_total_proposals` and confirm the proposal was created on the correct network/contract. |
| 7 | `ProposalNotActive` | The proposal's derived status is `Executed`, `Expired`, or `Revoked` — any terminal state that blocks further `approve`, `revoke`, or `execute` calls. | Check the proposal status via `get_proposal` before acting. Expired proposals can only be swept via `cancel_expired`. |
| 8 | `AlreadyApproved` | The calling owner has already cast an approval for this proposal (the approval flag in persistent storage is `true`). | Use `revoke` first to withdraw the prior approval, then re-approve if needed. |
| 9 | `NotApproved` | `revoke` was called by an owner who has not yet approved the proposal (approval flag is `false` or absent). | Only call `revoke` after successfully calling `approve` for the same proposal. |
| 10 | `ThresholdNotMet` | `execute` was called before the required approval weight was reached. Also raised by `set_guardian`, `unfreeze`, and `upgrade` when distinct approvers' combined weight is below the current threshold. | Gather enough owner voting weight, then retry. Check the current threshold via `get_threshold`. |
| 11 | `ProposalExpired` | The ledger timestamp has surpassed the proposal's `deadline`. Raised by `execute` when it detects expiry; the proposal status is persisted as `Expired` and the active-proposal counter is decremented. | Create a new proposal with a fresh deadline. Use `cancel_expired` to sweep stale IDs and free the active-proposal slot. |
| 12 | `InvalidAmount` | The `amount` field in `create_proposal` is less than **1** stroop (`MIN_AMOUNT = 1`). Negative and zero values are both rejected. | Pass a positive integer ≥ 1 in the token's smallest unit. For XLM this is stroops (1 XLM = 10,000,000 stroops). |
| 13 | `InvalidDeadline` | The `deadline` timestamp is ≤ the current ledger timestamp at the time the proposal creation transaction is processed. | Set a deadline strictly in the future. Account for block-time variance by adding a buffer of at least a few minutes. |
| 14 | `InvalidToken` | The address passed as `token` does not implement the Soroban token interface — specifically, at least one of `decimals()`, `symbol()`, or `name()` failed when probed. | Use a verified SEP-41 token address. On Testnet, use the canonical XLM, USDC, or EURC addresses listed in the frontend constants. |
| 15 | `TransferFailed` | The on-chain `token.transfer(contract_address, recipient, amount)` call failed, typically because the contract does not hold sufficient token balance. | Fund the contract with the required token balance before executing the proposal, then retry `execute`. |
| 16 | `EmptyDescription` | The `description` field is an empty string (length = 0). Checked in all four proposal-creation functions. | Provide a non-empty, human-readable description of the proposal's intent. |
| 17 | `DescriptionTooLong` | The `description` field exceeds **300 characters** (`MAX_DESCRIPTION_LEN = 300`). Checked in all four proposal-creation functions. | Trim the description to 300 characters or fewer before submitting. |
| 18 | `TooManyActiveProposals` | The number of proposals currently in `Pending` or `Ready` status has reached the cap of **50** (`MAX_ACTIVE_PROPOSALS = 50`). New proposals cannot be created until existing ones are executed or expired. | Execute or sweep at least one active proposal using `execute` or `cancel_expired`, then retry creation. |
| 19 | `DuplicateOwner` | Two or more identical addresses appear in the owner list during `initialize`, or an address being added via `create_add_owner_proposal` already exists in the current owner list. Also checked in `set_guardian`, `unfreeze`, and `upgrade` for duplicate approver addresses. | Deduplicate all address lists before submitting. |
| 20 | `ArithmeticError` | An integer overflow occurred — for example, the internal proposal ID counter wrapped when incrementing past `u64::MAX`, or an `approvals` counter underflowed during `checked_sub`. This is a safety guard that should never trigger in normal operation. | If encountered, contact the contract maintainers; this indicates an edge case at extreme scale. |
| 21 | `InvalidDuration` | The gap between the current ledger timestamp and the `deadline` exceeds **7,776,000 seconds** (90 days, `MAX_PROPOSAL_DURATION`). Checked in all four proposal-creation functions. | Set a deadline no more than 90 days in the future from the current time. |
| 22 | `InvalidRecipient` | The `to` address in `create_proposal` is the contract's own address (`env.current_contract_address()`). Self-transfers are explicitly rejected to prevent accidental fund loops. | Supply an external recipient address. The contract cannot transfer tokens to itself. |
| 23 | `TimeLockActive` | `execute` was called before the time-lock delay has elapsed since the proposal first reached `Ready` status (`now < ready_at + time_lock_delay`). Only raised when a non-zero `time_lock_delay` was set during `initialize`. | Wait until `ready_at + time_lock_delay` has passed. Query `get_time_lock_delay` to determine the required wait period. |
| 24 | `WouldBreakThreshold` | `create_remove_owner_proposal` was rejected because executing the removal would leave fewer owners than the current threshold (`owners.len() <= threshold`) in flat-threshold configurations. Note that weight-based quorum violations return `WouldBreakQuorum` (34). | Lower the threshold first via `create_change_threshold_proposal`, then remove the owner, or ensure the owner count exceeds the threshold before attempting removal. |
| 25 | `OwnerNotFound` | The address supplied to `create_remove_owner_proposal` as `owner_to_remove` is not present in the current owner list. | Verify the address is a registered owner with `is_owner` or `get_owners` before submitting a removal proposal. |
| 26 | `ContractFrozen` | The contract's frozen flag is `true`. `create_proposal`, `create_add_owner_proposal`, `create_remove_owner_proposal`, `create_change_threshold_proposal`, and `execute` are all blocked while frozen. | The guardian must call `freeze` (already done if this error appears). Only `unfreeze` (requiring threshold co-signers) can restore normal operation. |
| 27 | `NoGuardian` | `freeze` was called but no guardian address has been stored in the contract (the `GUARD` storage key is absent). | Call `set_guardian` with distinct owner co-signers whose combined weight reaches threshold. |
| 28 | `SpendingLimitExceeded` | The proposer's aggregate amount for a token in `create_proposal` exceeds the per-owner spending limit stored for that `(owner, token)` pair. Raised only when a limit has been set; unrestricted owners are unaffected. | Lower the proposal amount so it fits under the limit, or raise/clear the limit via the spending-limit governance path before retrying. |
| 34 | `WouldBreakQuorum` | A proposal creation or owner weight modification was rejected because total remaining weight would fall below threshold, or executing the weight change would leave an active (`Pending` or `Ready`) proposal's required quorum weight unreachable (`active_proposal.quorum_weight > new_total_weight`). | Lower the threshold first via `create_change_threshold_proposal`, wait for active proposals to complete or expire, or ensure remaining total weight is sufficient to satisfy all active proposal quorums. |

| 29 | `InvalidWeight` | An owner weight supplied to `initialize` or `create_change_weight_proposal` is above the maximum allowed value (`MAX_OWNER_WEIGHT`). | Use a weight within the allowed range. |
| 30 | `WeightBelowMinimum` | An owner weight supplied to `initialize` or `create_change_weight_proposal` is below the minimum allowed value (`MIN_OWNER_WEIGHT`). Zero is never a valid weight. | Use a positive weight. To revoke voting rights, use `create_remove_owner_proposal` instead of setting weight to zero. |
| 31 | `SingleOwnerWeightCapExceeded` | A `ChangeOwnerWeight` proposal was rejected because the `new_weight` would give the `target_owner` a share of the resulting total weight greater than the configured maximum (default 50%). | Choose a lower `new_weight` that respects the cap, or have a quorum of owners deliberately raise the cap via `set_max_single_owner_weight_pct`. |
| 32 | `TargetOwnerNoLongerExists` | A `ChangeOwnerWeight` proposal was executed, but the `target_owner` had been removed from the multisig between proposal creation and execution. | This is an expected guard for an edge case. The proposal has no effect. A new proposal would be needed to change the weight of a current owner. |
| 33 | `AlreadyMigrated` | `migrate_to_weighted_governance` was called on a contract that already has per-owner weights, either from initialization or a prior migration. The call is rejected to prevent accidental state changes. | Do not call `migrate_to_weighted_governance` again. The contract is already using the weighted governance model. |
| 39 | `RecurringPaymentNotFound` | No recurring-payment schedule exists for the given `schedule_id` (`RECUR` persistent key missing, `lib.rs:608`). Thrown by `get_recurring_payment`, `get_claimable_amount`, `disburse_recurring`, and `create_cancel_recurring_proposal`. | Verify the ID with `get_active_recurring_count` and `get_recurring_payment`; confirm the schedule was created on the correct contract/network and has not been pruned. |
| 40 | `InvalidInterval` | The `interval_secs` supplied to `create_recurring_proposal` is outside `[60, 31536000]` (`MIN_INTERVAL_SECS=60` / `MAX_INTERVAL_SECS=31536000`, `lib.rs:589`). | Pass an interval between 1 minute (60s) and 1 year (31536000s). |
| 41 | `ScheduleNotActive` | `disburse_recurring` was called for a schedule whose `status != Active` (`lib.rs:2664` — `Paused`, `Completed`, or `Cancelled`). Also returned when trying to disburse after cancellation. | Check `get_recurring_payment(...).status` is `Active` before calling `disburse_recurring`; only `Active` schedules are disbursable. |
| 42 | `DisbursementTooEarly` | The current ledger timestamp is before `start_time`/`cliff_time`, or for `FixedAmountPerPeriod` the interval since `last_disbursed_at` has not elapsed (`lib.rs:2690`), or for `LinearVesting` the vested amount does not exceed `total_disbursed` (`lib.rs:2777`). | Wait until `start_time`/`cliff_time` and `last_disbursed_at + interval_secs` have passed; poll `get_claimable_amount(schedule_id)` until it returns `> 0` before calling `disburse_recurring`. |
| 43 | `ScheduleEnded` | The schedule has reached `end_time` or its `total_cap` has been fully disbursed (`lib.rs:2678`, `lib.rs:2748`). `disburse_recurring` marks the schedule `Completed` and decrements `ACTREC`. | The schedule is `Completed`; no further disbursements will succeed. Create a new recurring-payment proposal if continued payments are needed. |
| 44 | `TooManyActiveRecurring` | Creating or executing a `CreateRecurringPayment` proposal would exceed `MAX_ACTIVE_RECURRING=20` (`lib.rs:594`, checked at `lib.rs:2546` and at execution). | Cancel an existing schedule via `create_cancel_recurring_proposal` or let a schedule complete/expire to free a slot, then retry. |
| 45 | `ScheduleAlreadyCancelled` | `create_cancel_recurring_proposal` was called for a schedule whose `status == Cancelled` (`lib.rs:2613`). | The schedule is already `Cancelled`; no second cancel is needed. Verify with `get_recurring_payment`. |

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
| `Proposal` | `ScVal::Map` | N/A (output only) | `scValToNative(scval)` → object with the fields below (see also [ARCHITECTURE.md §3](./ARCHITECTURE.md#3-storage-layout-soroban)) |
| `OwnerWeight` | `ScVal::Map` | N/A (output only) | `{ owner: "G…", weight: number }` |
| `ProposalKind` | `ScVal::Vec` / enum | Built by the SDK when forming governance calls | Discriminated union — variants listed below |
| `()` (unit) | `ScVal::Void` | N/A (no input) | `scValToNative(scval)` → `undefined` |

### `Proposal` fields (weighted governance)

Decoded `Proposal` maps include these weight-related fields alongside the rest of the proposal state:

| Field | Rust Type | XDR SCVal Type | Description |
|-------|-----------|----------------|-------------|
| `quorum_weight` | `u32` | `ScVal::U32` | Absolute weight this proposal must accumulate to become `Ready`. Snapshotted from `THRESH` / `get_required_quorum_weight()` at creation. |
| `approval_weight` | `u32` | `ScVal::U32` | Cumulative effective weight from owners who have approved so far. |
| `approvals` | `u32` | `ScVal::U32` | Same running total as `approval_weight` (legacy field name retained for compatibility; both are updated together in `approve` / `revoke`). |
| `kind` | `ProposalKind` | enum / nested vals | Action this proposal will perform when executed (see variants below). |

```rust
struct Proposal {
    id: u64,
    proposer: Address,
    description: String,
    deadline: u64,
    approvals: u32,
    approval_weight: u32,
    status: ProposalStatus,
    kind: ProposalKind,
    ready_at: u64,
    quorum_weight: u32,
    category: ProposalCategory,
}
```

### `ProposalKind` variants

| Variant | Payload | Purpose |
|---------|---------|---------|
| `Transfer` | `Vec<Transfer>` | Multi-asset treasury transfer |
| `AddOwner` | `(Address, u32)` | Add owner with initial weight |
| `RemoveOwner` | `Address` | Remove an owner |
| `ChangeThreshold` | `u32` | Change the quorum threshold (absolute weight) |
| `SetSpendingLimit` | `(Address, Address, i128)` | Per-owner per-token spending limit |
| `ChangeOwnerWeight` | `(Address /* target_owner */, u32 /* new_weight */)` | Update an existing owner's voting weight (must be ≥ 1; use `RemoveOwner` instead of zeroing) |
| `CreateRecurringPayment` | `CreateRecurringParams` | Create a recurring payment schedule |
| `CancelRecurringPayment` | `u64` | Cancel schedule by id |
| `PauseRecurringPayment` | `u64` | Pause schedule by id |
| `ResumeRecurringPayment` | `u64` | Resume a paused schedule |
| `ModifyRecurringPayment` | `ModifyRecurringParams` | Adjust schedule parameters |

```rust
enum ProposalKind {
    Transfer(Vec<Transfer>),
    AddOwner(Address, u32),
    RemoveOwner(Address),
    ChangeThreshold(u32),
    SetSpendingLimit(Address, Address, i128),
    ChangeOwnerWeight(Address, u32),
    CreateRecurringPayment(CreateRecurringParams),
    CancelRecurringPayment(u64),
    PauseRecurringPayment(u64),
    ResumeRecurringPayment(u64),
    ModifyRecurringPayment(ModifyRecurringParams),
}
```

---

## Event Payloads

Each Soroban event has an ordered **topics array** followed by a **data payload**. The contract address is implicitly prepended as the first element of the topics array by the network. The remainder is published explicitly by the contract via `env.events().publish((symbol,), data)`.

### `ProposalCreatedEvent`

**Topics:**
| Index | Value | XDR Type |
|-------|-------|----------|
| 0 | Contract address (implicit) | `ScVal::Address` |
| 1 | `"created"` | `ScVal::Symbol` |

**Data fields:**
| Field | Rust Type | XDR SCVal Type | Description |
|-------|-----------|----------------|-------------|
| `id` | `u64` | `ScVal::U64` | Unique proposal ID assigned by the counter |
| `proposer` | `Address` | `ScVal::Address` | Owner who created the proposal |
| `threshold` | `u32` | `ScVal::U32` | Approval threshold in effect at creation |
| `category` | `ProposalCategory` | `ScVal::U32` (enum discriminant) | Spending category tag (`Transfer`, `Payroll`, `Grant`, `Ops`, `Other`) |
| `transfers` | `Vec<Transfer>` | `ScVal::Vec` | Asset transfers attached to the proposal; empty for governance proposals (add/remove owner, change threshold, spending limit) |
| `quorum_weight` | `u32` | `ScVal::U32` | The weighted quorum this proposal must reach to become `Ready`. Snapshotted from the threshold at the moment of creation so auditors can reconstruct the exact approval requirement even if the threshold is changed by a later governance proposal. |
| `total_weight_at_creation` | `u32` | `ScVal::U32` | Sum of all owner weights at the moment this proposal was created. Because owners can be added, removed, or re-weighted after creation, this field is the only way to recover the original total-weight context from the event log alone — it is not derivable from current contract state once ownership changes. |

```rust
struct ProposalCreatedEvent {
    id: u64,
    proposer: Address,
    threshold: u32,
    category: ProposalCategory,
    transfers: Vec<Transfer>,
    quorum_weight: u32,
    total_weight_at_creation: u32,
}
```

### `ProposalApprovedEvent`

**Topics:**
| Index | Value | XDR Type |
|-------|-------|----------|
| 0 | Contract address (implicit) | `ScVal::Address` |
| 1 | `"approved"` | `ScVal::Symbol` |

**Data fields:**
| Field | Rust Type | XDR SCVal Type | Description |
|-------|-----------|----------------|-------------|
| `id` | `u64` | `ScVal::U64` | Proposal ID that received the approval |
| `approver` | `Address` | `ScVal::Address` | Owner who approved |
| `approvals` | `u32` | `ScVal::U32` | Running cumulative approval weight after this vote |
| `threshold` | `u32` | `ScVal::U32` | Approval threshold (quorum weight) at vote time |
| `weight` | `u32` | `ScVal::U32` | Individual weight contributed by the approver |
| `cumulative_weight` | `u32` | `ScVal::U32` | Resulting cumulative approval weight after this vote |

```rust
struct ProposalApprovedEvent {
    id: u64,
    approver: Address,
    approvals: u32,
    threshold: u32,
    weight: u32,
    cumulative_weight: u32,
}
```

### `ProposalRevokedEvent`

**Topics:**
| Index | Value | XDR Type |
|-------|-------|----------|
| 0 | Contract address (implicit) | `ScVal::Address` |
| 1 | `"revoked"` | `ScVal::Symbol` |

**Data fields:**
| Field | Rust Type | XDR SCVal Type | Description |
|-------|-----------|----------------|-------------|
| `id` | `u64` | `ScVal::U64` | Proposal ID the approval was revoked from |
| `approver` | `Address` | `ScVal::Address` | Owner who revoked their approval |
| `approvals` | `u32` | `ScVal::U32` | Remaining cumulative approval weight after the revoke |
| `weight` | `u32` | `ScVal::U32` | Individual weight that was removed by the revoke |
| `cumulative_weight` | `u32` | `ScVal::U32` | Resulting cumulative approval weight after the revoke |

```rust
struct ProposalRevokedEvent {
    id: u64,
    approver: Address,
    approvals: u32,
    weight: u32,
    cumulative_weight: u32,
}
```

### `ProposalExecutedEvent`

**Topics:**
| Index | Value | XDR Type |
|-------|-------|----------|
| 0 | Contract address (implicit) | `ScVal::Address` |
| 1 | `"executed"` | `ScVal::Symbol` |

**Data fields:**
| Field | Rust Type | XDR SCVal Type | Description |
|-------|-----------|----------------|-------------|
| `id` | `u64` | `ScVal::U64` | Proposal ID that was executed |
| `executor` | `Address` | `ScVal::Address` | Owner who triggered the execution |
| `to` | `Address` | `ScVal::Address` | Recipient of the transferred tokens |
| `amount` | `i128` | `ScVal::I128` | Transferred amount (see [Token Amounts](#token-amounts-and-decimals)) |

```rust
struct ProposalExecutedEvent {
    id: u64,
    executor: Address,
    to: Address,
    amount: i128,
}
```

### `RecurringPaymentCreatedEvent`

Emitted when a `CreateRecurringPayment` proposal is **executed** and a new schedule becomes `Active` (`lib.rs:2415` topic `r_crt`).

**Topics:**
| Index | Value | XDR Type |
|-------|-------|----------|
| 0 | Contract address (implicit) | `ScVal::Address` |
| 1 | `"r_crt"` | `ScVal::Symbol` |

**Data fields:**
| Field | Rust Type | XDR SCVal Type | Description |
|-------|-----------|----------------|-------------|
| `id` | `u64` | `ScVal::U64` | Schedule ID assigned from `RNEXT` |
| `proposer` | `Address` | `ScVal::Address` | Owner who proposed the schedule (from `Proposal.proposer`) |
| `recipient` | `Address` | `ScVal::Address` | Recipient of recurring transfers |
| `token` | `Address` | `ScVal::Address` | Token contract address |
| `amount` | `i128` | `ScVal::I128` | Per-period amount (for `FixedAmountPerPeriod`; `0` for `LinearVesting`) |
| `interval_secs` | `u64` | `ScVal::U64` | Interval between disbursements (60–31536000) |
| `start_time` | `u64` | `ScVal::U64` | First eligible disbursement timestamp |
| `end_time` | `u64` | `ScVal::U64` | Schedule end timestamp (`0` = no end) |
| `cliff_time` | `u64` | `ScVal::U64` | Cliff timestamp (`0` = no cliff) |
| `total_cap` | `i128` | `ScVal::I128` | Total cap (`0` = uncapped for fixed) |
| `kind` | `RecurringKind` | `ScVal::Vec` (enum) | `FixedAmountPerPeriod` or `LinearVesting` |

```rust
struct RecurringPaymentCreatedEvent {
    id: u64,
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
}
```

### `RecurringPaymentDisbursedEvent`

Emitted on each successful `disburse_recurring` call (`lib.rs:2765` topic `r_disb`).

**Topics:**
| Index | Value | XDR Type |
|-------|-------|----------|
| 0 | Contract address (implicit) | `ScVal::Address` |
| 1 | `"r_disb"` | `ScVal::Symbol` |

**Data fields:**
| Field | Rust Type | XDR SCVal Type | Description |
|-------|-----------|----------------|-------------|
| `id` | `u64` | `ScVal::U64` | Schedule ID that was disbursed |
| `recipient` | `Address` | `ScVal::Address` | Recipient that received the transfer |
| `amount` | `i128` | `ScVal::I128` | Amount transferred in this disbursement (smallest units) |
| `total_disbursed` | `i128` | `ScVal::I128` | Cumulative total disbursed after this call |

```rust
struct RecurringPaymentDisbursedEvent {
    id: u64,
    recipient: Address,
    amount: i128,
    total_disbursed: i128,
}
```

### `RecurringPaymentCancelledEvent`

Emitted when a `CancelRecurringPayment` proposal is executed (`lib.rs:2448` topic `r_cncl`).

**Topics:**
| Index | Value | XDR Type |
|-------|-------|----------|
| 0 | Contract address (implicit) | `ScVal::Address` |
| 1 | `"r_cncl"` | `ScVal::Symbol` |

**Data fields:**
| Field | Rust Type | XDR SCVal Type | Description |
|-------|-----------|----------------|-------------|
| `id` | `u64` | `ScVal::U64` | Schedule ID that was cancelled |
| `caller` | `Address` | `ScVal::Address` | Executor of the cancel proposal (`executor` at `lib.rs:2451`) |

```rust
struct RecurringPaymentCancelledEvent {
    id: u64,
    caller: Address,
}
```
