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

| Contract Function | Purpose | Frontend Caller |
|---|---|---|
| `initialize(owners, threshold)` | One-shot init — sets owners and M-of-N threshold | Deployment script only |
| `create_proposal(proposer, to, amount, token, description, deadline)` | Creates a transfer proposal | Proposal creation form |
| `approve(approver, proposal_id)` | Owner casts an approval vote | Proposal card approve button |
| `revoke(approver, proposal_id)` | Owner withdraws their approval | Proposal card revoke button |
| `execute(executor, proposal_id)` | Executes a Ready proposal, transfers tokens | Proposal card execute button |
| `get_proposal(proposal_id)` | Reads a single proposal | Proposal detail page |
| `get_proposals_paged(offset, limit)` | Paginated proposal list | Dashboard list |
| `get_owners()` | Returns owner list | Settings / owners panel |
| `get_threshold()` | Returns approval threshold | Dashboard header stat |
| `is_owner(address)` | Checks ownership for a connected wallet | Wallet-connected gating |
| `has_approved(proposal_id, owner)` | Per-owner approval flag | Approval bar UI |

## 3. Storage Layout (Soroban)

### Instance Storage (low-cost, short TTL)

All instance-storage keys share **one** `LedgerEntry` (the contract instance). The TTL bump and threshold apply to that single shared entry; all keys expire together.

| Key | Type | Description | TTL — bump / threshold (ledgers) |
|-----|------|-------------|----------------------------------|
| `INIT` | `bool` | Initialization guard | 518,400 / 17,280 |
| `THRESH` | `u32` | Approval threshold | 518,400 / 17,280 |
| `NEXT` | `u64` | Monotonic proposal ID counter | 518,400 / 17,280 |
| `ACTCNT` | `u32` | Active proposal count (budget guard) | 518,400 / 17,280 |
| `TLOCK` | `u64` | Time-lock delay in seconds (0 = disabled) | 518,400 / 17,280 |

**Instance entry cost**: all five keys together occupy roughly **~150 bytes** XDR-encoded (rounds to 1 KB for billing) → **~0.052 XLM per 30 days** (see [Storage Cost Methodology](#storage-cost-methodology) below).

### Persistent Storage (long TTL, bumped on access)

Each key is a separate `LedgerEntry` with its own independently tracked TTL.

| Key | Type | Description | TTL — bump / threshold (ledgers) | Approx. cost (XLM / 30 days) |
|-----|------|-------------|----------------------------------|-------------------------------|
| `OWNERS` | `Vec<Address>` | Fixed owner set (max 20 addresses) | 518,400 / 17,280 | ~0.052 XLM |
| `("PROP", id)` | `Proposal` | Per-proposal state | 518,400 / 17,280 | ~0.052 XLM |
| `("APPR", id, owner)` | `bool` | Per-owner approval flag per proposal | 518,400 / 17,280 | ~0.052 XLM |

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

### Storage Cost Methodology

Soroban charges rent based on entry size and TTL extension length (CAP-0046-08):

```
rent_fee_stroops = ceil(entry_size_bytes / 1024) × fee_rate_1kb × delta_ledgers
```

| Parameter | Assumed value | Source |
|-----------|--------------|--------|
| `fee_rate_1kb` | ~1 stroop / 1 KB / ledger | Stellar network config (verify current value via `soroban_rpc.getFeeStats` or Stellar Horizon) |
| `delta_ledgers` | 518,400 (full 30-day bump) | Worst case — entry TTL fully expired before access |
| `("PROP", id)` entry size | ~396 bytes (100-char description) | XDR field sum below; 300-char max adds ~200 bytes, still rounds to 1 KB |
| `("APPR", id, owner)` entry size | ~144 bytes | XDR field sum below |

**XDR byte breakdown — `("PROP", id)` Proposal entry (100-char description):**

| Field | XDR bytes |
|-------|-----------|
| Key (`"PROP"` symbol + u64 id) | 16 |
| `id` (u64) | 8 |
| `proposer` (Address) | 44 |
| `description` (String, 100 chars) | 108 |
| `deadline` (u64) | 8 |
| `approvals` (u32) | 4 |
| `status` (enum) | 4 |
| `kind` (Transfer: discriminant + Address + i128 + Address) | 108 |
| `ready_at` (u64) | 8 |
| `threshold` (u32) | 4 |
| `category` (enum) | 4 |
| LedgerEntry framing and metadata | ~80 |
| **Total** | **~396 bytes → 1 KB billed** |

**XDR byte breakdown — `("APPR", id, owner)` approval entry:**

| Field | XDR bytes |
|-------|-----------|
| Key (`"APPR"` symbol + u64 + Address) | 60 |
| Value (`bool`) | 4 |
| LedgerEntry framing and metadata | ~80 |
| **Total** | **~144 bytes → 1 KB billed** |

**Cost summary — one proposal at full 30-day bump:**

| Entry | Billed size | Stroops | XLM |
|-------|-------------|---------|-----|
| `("PROP", id)` | 1 KB | 518,400 | ~0.052 |
| `("APPR", id, owner)` per approver | 1 KB | 518,400 | ~0.052 |
| **3-of-5 multisig (3 approvers)** | — | — | **~0.208** |

> These figures use a fee rate of 1 stroop/KB/ledger. Verify the current network value before capacity-planning large deployments; the rate is adjustable via Stellar governance.

### Bump-on-Access Strategy

Every read or write of a storage entry calls `extend_ttl` with a **threshold** and a **bump**:

- **Threshold** (17,280 ledgers ≈ 1 day): if the entry's remaining TTL already exceeds this value no extension is triggered and no rent is charged on that call.
- **Bump** (518,400 ledgers ≈ 30 days): when the TTL *is* below the threshold, expiry is pushed to `current_ledger + bump`.

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

## 5. Event Schema

| Topics | Data Type | Consumer |
|--------|-----------|----------|
| `("created",)` | `ProposalCreatedEvent { id, proposer, to, amount, threshold }` | Proposal feed |
| `("approved",)` | `ProposalApprovedEvent { id, approver, approvals, threshold }` | Approval bar update |
| `("revoked",)` | `ProposalRevokedEvent { id, approver, approvals }` | Approval bar update |
| `("executed",)` | `ProposalExecutedEvent { id, executor, to, amount }` | Execution history |

## 6. Frontend Polling Strategy

1. Load current proposals on mount, then poll every 15-30s for active proposals.
2. After a confirmed transaction (approve, execute), re-fetch the affected proposal immediately for optimistic UI.
3. Deduplicate events by `(ledger, topic, data-hash)`.
4. Back off on RPC failure: 1s → 2s → 4s, cap at 30s.

## 7. Token Handling

All token amounts are stored and transferred in the token's **smallest unit** (stroops for XLM: 1 stroop = 0.0000001 XLM). Use `BigInt` in the frontend — never `Number` for on-chain amounts.

| Token Amount | Stroops |
|---|---|
| 1.0 XLM | 10,000,000 |
| 100.5 XLM | 1,005,000,000 |

Frontend utilities should live in `frontend/src/lib/soroban.ts`:
- `toBaseUnit(amount: string, decimals: number): bigint`
- `fromBaseUnit(amount: bigint, decimals: number): string`
