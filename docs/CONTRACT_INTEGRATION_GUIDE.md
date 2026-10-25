# Contract Integration Guide for External dApps

This guide demonstrates how external decentralized applications (dApps), DAOs, payroll tools, and backend services integrate with the **Accord Protocol** smart contract on Stellar Soroban. It covers network configuration, call construction, Soroban authorization entries, and event consumption.

---

## Table of Contents

1. [Integration Overview & Architecture](#integration-overview--architecture)
2. [Network Configuration & Contract Identifiers](#network-configuration--contract-identifiers)
3. [Soroban Authorization & Call Construction](#soroban-authorization--call-construction)
4. [Step-by-Step Integration Examples (TypeScript SDK)](#step-by-step-integration-examples-typescript-sdk)
   - [Reading Contract State (Free Simulation)](#1-reading-contract-state-free-simulation)
   - [Creating a Proposal from an External dApp](#2-creating-a-proposal-from-an-external-dapp)
   - [Approving a Proposal](#3-approving-a-proposal)
   - [Executing a Ready Proposal](#4-executing-a-ready-proposal)
5. [Cross-Contract Calls (Soroban Rust SDK)](#cross-contract-calls-soroban-rust-sdk)
6. [Consuming & Decoding Events](#consuming--decoding-events)
   - [Event Topics and Payload Catalog](#event-topics-and-payload-catalog)
   - [Querying Events via Soroban RPC (`getEvents`)](#querying-events-via-soroban-rpc-getevents)
   - [Event Schema Versioning](#event-schema-versioning)
7. [Error Handling & Status Codes](#error-handling--status-codes)

---

## Integration Overview & Architecture

Accord Protocol manages M-of-N multisig treasuries with configurable weights, role-based access control (RBAC), and recurring payments on Soroban. External systems interact with Accord via two primary channels:

```
┌────────────────────────────────────────────────────────┐
│                   External dApp                        │
│                                                        │
│  ┌───────────────────────┐    ┌─────────────────────┐  │
│  │ Read-only View Calls  │    │ State-changing Calls│  │
│  │ (simulateTransaction) │    │ (Freighter/Keypair) │  │
│  └───────────┬───────────┘    └──────────┬──────────┘  │
└──────────────┼───────────────────────────┼─────────────┘
               │                           │
               ▼                           ▼
       Soroban RPC Node (RPC: testnet.stellar.org)
               │                           │
               │                           ▼
               │                ┌───────────────────────┐
               │                │ Accord Smart Contract │
               │                │ (Rust / Soroban WASM) │
               │                └──────────┬────────────┘
               │                           │ Emits Events
               ▼                           ▼
       getEvents Poller ◄─────── Event Log (`created`, `approved`...)
```

- **Read Operations (`simulateTransaction`)**: Querying proposal status, owners, voting weights, or spending limits. These require **no wallet signature** and incur **zero transaction fees**.
- **Write Operations (`sendTransaction`)**: Creating proposals, casting approvals, or executing transfers. These require cryptographic authorization (`require_auth()`) signed by an authorized Stellar account.
- **Event Telemetry (`getEvents`)**: Indexing state changes, triggers, and accounting entries emitted on-chain.

---

## Network Configuration & Contract Identifiers

Configure your external dApp environment with the appropriate network RPC endpoints and contract addresses:

| Environment | RPC Endpoint | Network Passphrase | Deployed Contract ID |
|---|---|---|---|
| **Stellar Testnet** | `https://soroban-testnet.stellar.org` | `Test SDF Network ; September 2015` | `CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS` |
| **Stellar Mainnet** | `https://mainnet.stellar.org` | `Public Global Stellar Network ; September 2015` | *(Refer to deployment announcement)* |
| **Local Standalone** | `http://localhost:8000/soroban/rpc` | `Standalone Network ; February 2022` | *(Set from local deploy script)* |

### Example Environment Configuration (`.env`)

```env
SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"
STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
ACCORD_CONTRACT_ADDRESS="CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS"
```

---

## Soroban Authorization & Call Construction

Soroban enforces explicit cryptographic authorization. When calling a mutating method on Accord, the contract enforces `address.require_auth()`:

- **`create_proposal(proposer, ...)`**: Requires `proposer.require_auth()`. Proposer must be registered in the contract's owners map or hold the `Proposer` role.
- **`approve(approver, proposal_id)`**: Requires `approver.require_auth()`. Approver must be an owner or hold the `Approver` role.
- **`revoke(approver, proposal_id)`**: Requires `approver.require_auth()`.
- **`execute(executor, proposal_id)`**: Requires `executor.require_auth()`. Executor must hold the `Executor` role. When executing a token transfer, the **contract itself** authorizes token transfers from its own balance via the SEP-41 token contract client. The caller does **not** need token allowances.

### The 4-Step Call Pipeline:

1. **Build**: Construct an `Operation.invokeHostFunction` specifying contract ID, function name, and typed `ScVal` arguments.
2. **Simulate**: Send transaction to Soroban RPC via `server.simulateTransaction(tx)`. The RPC returns resource footprint, ledger storage rent, and authorization entries.
3. **Assemble**: Merge the simulation results into the transaction using `rpc.assembleTransaction(tx, simResponse)`.
4. **Sign & Submit**: Sign with the caller's keypair or wallet extension (e.g. Freighter `signTransaction`), then submit via `server.sendTransaction(tx)`.

---

## Step-by-Step Integration Examples (TypeScript SDK)

Install dependencies in your external project:

```bash
npm install @stellar/stellar-sdk
```

### Shared Client Setup

```typescript
import {
  Contract,
  Keypair,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

const RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";
const CONTRACT_ID = process.env.ACCORD_CONTRACT_ADDRESS!;

export const server = new rpc.Server(RPC_URL);
export const accordContract = new Contract(CONTRACT_ID);
```

### 1. Reading Contract State (Free Simulation)

Querying proposal status, owners, or voting thresholds requires no signatures or gas:

```typescript
export async function getProposalDetails(proposalId: number, simSourceAddress: string) {
  const simSource = await server.getAccount(simSourceAddress);

  // Build simulated call to `get_proposal(id)`
  const tx = new TransactionBuilder(simSource, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      accordContract.call(
        "get_proposal",
        nativeToScVal(BigInt(proposalId), { type: "u64" })
      )
    )
    .setTimeout(30)
    .build();

  const simResponse = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(simResponse)) {
    throw new Error(`Simulation failed: ${simResponse.error}`);
  }

  // Parse returned ScVal
  const resultScVal = simResponse.result.retval;
  const proposal = scValToNative(resultScVal);
  return proposal;
}
```

### 2. Creating a Proposal from an External dApp

External dApps (e.g. governance dashboards, automated payroll services) create payment proposals on-chain:

```typescript
export async function createTransferProposal(
  signerKeypair: Keypair,
  recipientAddress: string,
  tokenAddress: string,
  amountStroops: bigint,
  description: string,
  deadlineUnixSecs: bigint
) {
  const account = await server.getAccount(signerKeypair.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: "10000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      accordContract.call(
        "create_proposal",
        nativeToScVal(signerKeypair.publicKey(), { type: "address" }),
        nativeToScVal(recipientAddress, { type: "address" }),
        nativeToScVal(amountStroops, { type: "i128" }),
        nativeToScVal(tokenAddress, { type: "address" }),
        nativeToScVal(description, { type: "string" }),
        nativeToScVal(deadlineUnixSecs, { type: "u64" })
      )
    )
    .setTimeout(300)
    .build();

  // 1. Simulate
  const simResponse = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(simResponse)) {
    throw new Error(`Simulation error: ${simResponse.error}`);
  }

  // 2. Assemble transaction with footprints and authorization entries
  const preparedTx = rpc.assembleTransaction(tx, simResponse).build();

  // 3. Sign with authorized proposer
  preparedTx.sign(signerKeypair);

  // 4. Submit to Soroban RPC
  const sendResponse = await server.sendTransaction(preparedTx);
  if (sendResponse.status === "ERROR") {
    throw new Error(`Transaction submission error: ${JSON.stringify(sendResponse)}`);
  }

  // 5. Poll for confirmation
  let statusResponse = await server.getTransaction(sendResponse.hash);
  while (statusResponse.status === "NOT_FOUND") {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    statusResponse = await server.getTransaction(sendResponse.hash);
  }

  return {
    txHash: sendResponse.hash,
    status: statusResponse.status,
    returnValue: statusResponse.returnValue ? scValToNative(statusResponse.returnValue) : null,
  };
}
```

### 3. Approving a Proposal

Co-owners cast signatures via `approve`:

```typescript
export async function approveProposal(signerKeypair: Keypair, proposalId: number) {
  const account = await server.getAccount(signerKeypair.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: "10000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      accordContract.call(
        "approve",
        nativeToScVal(signerKeypair.publicKey(), { type: "address" }),
        nativeToScVal(BigInt(proposalId), { type: "u64" })
      )
    )
    .setTimeout(300)
    .build();

  const simResponse = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(simResponse)) {
    throw new Error(`Approval simulation failed: ${simResponse.error}`);
  }

  const preparedTx = rpc.assembleTransaction(tx, simResponse).build();
  preparedTx.sign(signerKeypair);

  return await server.sendTransaction(preparedTx);
}
```

### 4. Executing a Ready Proposal

When cumulative approval weight reaches or exceeds the threshold, anyone with the `Executor` role can trigger execution:

```typescript
export async function executeProposal(signerKeypair: Keypair, proposalId: number) {
  const account = await server.getAccount(signerKeypair.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: "50000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      accordContract.call(
        "execute",
        nativeToScVal(signerKeypair.publicKey(), { type: "address" }),
        nativeToScVal(BigInt(proposalId), { type: "u64" })
      )
    )
    .setTimeout(300)
    .build();

  const simResponse = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(simResponse)) {
    throw new Error(`Execution failed: ${simResponse.error}`);
  }

  const preparedTx = rpc.assembleTransaction(tx, simResponse).build();
  preparedTx.sign(signerKeypair);

  return await server.sendTransaction(preparedTx);
}
```

---

## Cross-Contract Calls (Soroban Rust SDK)

If another smart contract on Stellar needs to interact directly with Accord, import the contract interface and invoke methods using the generated client:

```rust
use soroban_sdk::{contractclient, Address, Env, String, Vec};

#[contractclient(name = "AccordClient")]
pub trait AccordTrait {
    fn create_proposal(
        env: Env,
        proposer: Address,
        to: Address,
        amount: i128,
        token: Address,
        description: String,
        deadline: u64,
    ) -> u64;

    fn approve(env: Env, approver: Address, proposal_id: u64);
    fn execute(env: Env, executor: Address, proposal_id: u64);
    fn get_threshold(env: Env) -> u32;
}

pub fn trigger_dao_payment(
    env: &Env,
    accord_address: &Address,
    dao_treasury_manager: &Address,
    vendor: &Address,
    amount: i128,
    token: &Address,
) -> u64 {
    // Contract authorizes call on behalf of the DAO
    dao_treasury_manager.require_auth();

    let client = AccordClient::new(env, accord_address);
    let deadline = env.ledger().timestamp() + 86400 * 7; // 7 days

    client.create_proposal(
        dao_treasury_manager,
        vendor,
        &amount,
        token,
        &String::from_str(env, "Automated DAO disbursement"),
        &deadline,
    )
}
```

---

## Consuming & Decoding Events

Accord emits structured Soroban events for all state changes. Events are mapped by a short symbol topic to a versioned data payload.

### Event Topics and Payload Catalog

| Topic Symbol | Emitted When | Payload Structure |
|---|---|---|
| `created` | New proposal created | `{ id: u64, proposer: Address, threshold: u32, category: ProposalCategory, transfers: Vec<Transfer>, quorum_weight: u32, total_weight_at_creation: u32, version: u32 }` |
| `approved` | Owner votes in favor | `{ id: u64, approver: Address, approvals: u32, threshold: u32, weight: u32, cumulative_weight: u32, version: u32 }` |
| `revoked` | Owner revokes vote | `{ id: u64, approver: Address, approvals: u32, weight: u32, cumulative_weight: u32, version: u32 }` |
| `executed` | Proposal is executed | `{ id: u64, executor: Address, transfers: Vec<Transfer>, version: u32 }` |
| `rpay` | Recurring payment disbursed | `{ schedule_id: u64, recipient: Address, token: Address, amount: i128, total_disbursed: i128, periods_disbursed: u32, version: u32 }` |
| `frozen` | Emergency freeze activated | `{ guardian: Address, version: u32 }` |
| `unfrozen` | Multisig unfreezes | `{ approvers: Vec<Address>, version: u32 }` |

For the complete schema of all 22 contract events, see [`docs/EVENTS.md`](./EVENTS.md).

### Querying Events via Soroban RPC (`getEvents`)

External indexers or webhook listeners subscribe to Accord events using `server.getEvents`:

```typescript
export async function pollAccordEvents(startLedger: number) {
  const response = await server.getEvents({
    startLedger,
    filters: [
      {
        type: "contract",
        contractIds: [CONTRACT_ID],
      },
    ],
  });

  for (const event of response.events) {
    // Topic is the first ScVal in the topic array
    const rawTopic = scValToNative(event.topic[0]);
    const rawPayload = scValToNative(event.value);

    console.log(`[Ledger ${event.ledger}] Event: ${rawTopic}`, {
      schemaVersion: rawPayload.version,
      payload: rawPayload,
    });

    if (rawTopic === "created") {
      console.log(`Proposal #${rawPayload.id} created by ${rawPayload.proposer}`);
    } else if (rawTopic === "executed") {
      console.log(`Proposal #${rawPayload.id} executed successfully!`);
    }
  }

  return response.latestLedger;
}
```

### Event Schema Versioning

Every event payload includes a trailing `version: u32` field set to `EVENT_SCHEMA_VERSION` (currently `2`). External indexers should check `payload.version` to ensure forward compatibility with contract upgrades.

---

## Error Handling & Status Codes

When an invocation fails, Soroban returns a `ContractError` code:

| Error Code | Identifier | Explanation & Integrator Action |
|---|---|---|
| `3` | `Unauthorized` | Caller lacks required owner permission or RBAC role. |
| `4` | `InvalidThreshold` | Threshold exceeds total weight or is zero. |
| `6` | `ProposalNotFound` | Queried proposal ID does not exist in persistent storage. |
| `7` | `ProposalNotActive` | Proposal is already executed, cancelled, or expired. |
| `8` | `AlreadyApproved` | Approver has already voted on this proposal. |
| `10` | `ThresholdNotMet` | `execute` called before cumulative approved weight reached quorum. |
| `11` | `ProposalExpired` | Proposal deadline ledger timestamp has passed. |
| `15` | `TransferFailed` | SEP-41 token transfer failed (e.g. contract has insufficient funds). |
| `18` | `TooManyActiveProposals` | Active proposal limit (50) reached; wait for proposals to settle. |
| `26` | `ContractFrozen` | Emergency guardian freeze is active; write operations blocked. |
| `31` | `SpendingLimitExceeded` | Proposed transfer exceeds the owner's per-token spending limit. |

For detailed method-by-method parameter specifications and invariants, consult [`docs/CONTRACT_API.md`](./CONTRACT_API.md).
