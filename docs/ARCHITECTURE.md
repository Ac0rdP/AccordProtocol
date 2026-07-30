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

| Key                   | Type           | Description                          | TTL — bump / threshold (ledgers) | Approx. cost (XLM / 30 days) |
| --------------------- | -------------- | ------------------------------------ | -------------------------------- | ---------------------------- |
| `OWNERS`              | `Vec<Address>` | Fixed owner set (max 20 addresses)   | 518,400 / 17,280                 | ~0.052 XLM                   |
| `("PROP", id)`        | `Proposal`     | Per-proposal state                   | 518,400 / 17,280                 | ~0.052 XLM                   |
| `("APPR", id, owner)` | `bool`         | Per-owner approval flag per proposal | 518,400 / 17,280                 | ~0.052 XLM                   |

### Proposal Struct Fields

```
id            u64
proposer      Address
to            Address
amount        i128          (token's native unit — stroop for XLM-derived tokens)
token         Address       (Soroban token contract)
description   String        (max 300 chars)
deadline      u64           (Unix timestamp)
approvals     u32
status        ProposalStatus
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
| `OWNERS` | Owner address list                  |

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

**XDR byte breakdown — `("PROP", id)` Proposal entry (100-char description):**

| Field                                                      | XDR bytes                    |
| ---------------------------------------------------------- | ---------------------------- |
| Key (`"PROP"` symbol + u64 id)                             | 16                           |
| `id` (u64)                                                 | 8                            |
| `proposer` (Address)                                       | 44                           |
| `description` (String, 100 chars)                          | 108                          |
| `deadline` (u64)                                           | 8                            |
| `approvals` (u32)                                          | 4                            |
| `status` (enum)                                            | 4                            |
| `kind` (Transfer: discriminant + Address + i128 + Address) | 108                          |
| `ready_at` (u64)                                           | 8                            |
| `threshold` (u32)                                          | 4                            |
| `category` (enum)                                          | 4                            |
| LedgerEntry framing and metadata                           | ~80                          |
| **Total**                                                  | **~396 bytes → 1 KB billed** |

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

## 6. Event Schema

The contract emits events using `env.events().publish()`. Each Soroban event has two components that external consumers must understand:

**Event envelope structure:**

- **Contract address** — the deployed Accord contract ID, which Soroban attaches implicitly to every event. External consumers use this as a first-level filter to select only events from a specific deployment.
- **Topic string** — a short symbol published explicitly by the contract (`"created"`, `"approved"`, `"revoked"`, `"executed"`). This is the second filter consumers apply to select a specific event type.
- **Data payload** — a typed struct carrying the event details, as described in the table below.

The contract address plus one topic string together uniquely identify a stream of events from a specific action type on a specific deployment.

| Topics          | Data Type                                                      | Consumer            |
| --------------- | -------------------------------------------------------------- | ------------------- |
| `("created",)`  | `ProposalCreatedEvent { id, proposer, to, amount, threshold }` | Proposal feed       |
| `("approved",)` | `ProposalApprovedEvent { id, approver, approvals, threshold, weight, cumulative_weight }` | Approval bar update |
| `("revoked",)`  | `ProposalRevokedEvent { id, approver, approvals, weight, cumulative_weight }`             | Approval bar update |
| `("executed",)` | `ProposalExecutedEvent { id, executor, to, amount }`           | Execution history   |

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

## 7. Frontend Polling Strategy

1. Load current proposals on mount, then poll every 15-30s for active proposals.
2. After a confirmed transaction (approve, execute), re-fetch the affected proposal immediately for optimistic UI.
3. Deduplicate events by `(ledger, topic, data-hash)`.
4. Back off on RPC failure: 1s → 2s → 4s, cap at 30s.

## 8. Token Handling

All token amounts are stored and transferred in the token's **smallest unit** (stroops for XLM: 1 stroop = 0.0000001 XLM). Use `BigInt` in the frontend — never `Number` for on-chain amounts.

| Token Amount | Stroops       |
| ------------ | ------------- |
| 1.0 XLM      | 10,000,000    |
| 100.5 XLM    | 1,005,000,000 |

Frontend utilities should live in `frontend/src/lib/soroban.ts`:

- `toBaseUnit(amount: string, decimals: number): bigint`
- `fromBaseUnit(amount: bigint, decimals: number): string`

## 9. Token Deposit Flow

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

## 10. Related Documents

| Document                                                                  | Description                                                    |
| ------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [DESIGN.md](DESIGN.md)                                                    | Design decisions — why the protocol is built the way it is     |
| [docs/guides/connecting-your-wallet.md](guides/connecting-your-wallet.md) | End-user guide: Freighter setup and Testnet funding            |
| [docs/guides/reading-the-dashboard.md](guides/reading-the-dashboard.md)   | End-user guide: proposal list, status badges, and approval bar |
| [CONTRACT_API.md](CONTRACT_API.md)                                        | Full contract function reference                               |
| [SETUP.md](SETUP.md)                                                      | Developer setup and deployment instructions                    |

## 11. Owner-Authorization Check Resource Cost

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

## Security Note: Governance Controls vs Spending Limits

**Spending limits and voting weights are strictly independent.**
An owner's voting weight controls their governance power (e.g. approving proposals), while their spending limit controls the maximum token amount they can propose to transfer. Changing an owner's voting weight does not affect their spending limits, and vice versa. They are managed by completely separate storage keys and governance proposals.
