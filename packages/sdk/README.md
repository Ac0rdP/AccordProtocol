# @accord-protocol/sdk

Official TypeScript client SDK for **Accord Protocol** multisig treasury smart contracts on Stellar Soroban.

[![npm version](https://img.shields.io/npm/v/@accord-protocol/sdk.svg)](https://www.npmjs.com/package/@accord-protocol/sdk)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

---

## Features

- **Full Contract Surface**: Wraps every entrypoint and view exposed by `contracts/accord/src/lib.rs`.
- **Zero Secrets Custody**: Signing is delegated via a caller-supplied `signTransaction` callback (compatible with Freighter, Albedo, Ledger, or Keypair).
- **Exact Precision**: All 64-bit and 128-bit integers are represented as native JavaScript `bigint`.
- **Pre-flight Validation**: Addresses (G... and C...) and parameters are validated before any network dispatch.
- **Typed Contract Errors**: Automatically maps on-chain Soroban error codes (1–57) to typed `AccordContractError` classes.
- **Dual Bundle**: Ships ESM, CommonJS, and TypeScript declarations (`sideEffects: false`).

---

## Installation

```bash
npm install @accord-protocol/sdk @stellar/stellar-sdk
```

---

## Quickstart

### 1. Initialize the Client

```typescript
import { AccordClient } from "@accord-protocol/sdk";
import type { Transaction } from "@stellar/stellar-sdk";

const client = new AccordClient({
  contractId: "CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  // Optional signing callback for state-changing calls:
  signTransaction: async (tx: Transaction) => {
    // e.g. return window.freighter.signTransaction(tx.toXDR());
    return tx;
  },
});
```

### 2. Read Contract State (Simulation Views)

```typescript
// Query multisig owners and threshold
const owners = await client.getOwners();
const threshold = await client.getThreshold();
const isFrozen = await client.isFrozen();

console.log(`Multisig threshold: ${threshold} of ${owners.length} owners`);
console.log(`Emergency freeze status: ${isFrozen}`);

// Read a proposal by ID
const proposal = await client.getProposal(1n);
console.log(`Proposal #${proposal.id} status: ${proposal.status}, approvals: ${proposal.approvals}`);
```

### 3. Create, Approve, and Execute Proposals

```typescript
import { AccordContractError, ContractError } from "@accord-protocol/sdk";

const ownerAddress = "GD5JDFYKNL23W2CQOXW6V57JMGDUQMK2M27B2L67MQK7Y65J42B67I7J";
const recipient = "GB3K5Z7P66V336K3M5O4J2B67I7JGD5JDFYKNL23W2CQOXW6V57JMGDU";
const usdcToken = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

try {
  // 1. Create a transfer proposal (amount in stroops / smallest unit)
  const txHash = await client.createProposal(
    ownerAddress,
    [
      {
        to: recipient,
        token: usdcToken,
        amount: 10000000n, // 1 USDC (7 decimals)
      },
    ],
    "Q4 Contributor Grant",
    BigInt(Math.floor(Date.now() / 1000) + 86400 * 7), // 7 days deadline
    "Grant"
  );
  console.log(`Proposal created: ${txHash}`);

  // 2. Approve proposal
  await client.approve(ownerAddress, 1n);

  // 3. Execute once Ready
  await client.execute(ownerAddress, 1n);
} catch (error) {
  if (error instanceof AccordContractError) {
    if (error.errorCode === ContractError.RecoveryActive) {
      console.error("Treasury is in recovery mode; outflows temporarily locked.");
    } else if (error.errorCode === ContractError.ThresholdNotMet) {
      console.error("Cannot execute: quorum threshold not yet reached.");
    } else {
      console.error(`Contract error [${error.codeName}]: ${error.message}`);
    }
  } else {
    console.error("Submission failed:", error);
  }
}
```

---

## API Overview

### Read Methods (Zero Fees)
- `getProposal(id)`: Returns full proposal details.
- `getProposalsPaged(offset, limit)`: Paginated proposal list.
- `getOwners()`: Returns array of owner addresses.
- `getThreshold()`: Returns current approval threshold.
- `getRequiredQuorumWeight()`: Returns required quorum weight.
- `getTotalWeight()`: Returns total voting weight across all owners.
- `getOwnerWeight(owner)`: Returns voting weight for specified owner.
- `getOwnerWeights()`: Returns list of `{ owner, weight }` records.
- `isOwner(address)`: Checks ownership for given address.
- `hasApproved(id, owner)`: Checks if owner voted on proposal.
- `getProposalApprovalProgress(id)`: Returns cumulative weight vs quorum requirement.
- `getApprovers(id)`: Returns addresses of signers who approved.
- `getTimeLockDelay()`: Returns execution delay in seconds.
- `getTotalProposals()`: Returns total count of proposals created.
- `getVersion()`: Returns contract code version.
- `getStorageVersion()`: Returns on-chain storage schema version.
- `getRoles(address)` / `hasRole(address, role)` / `getRoleMembers(role)`: RBAC queries.
- `getSpendingLimit(owner, token)` / `getRemainingSpendingLimit(owner, token)`: Spending limits.
- `getSpendingWindow(owner, token)` / `getSpentTracker(owner, token)`: Spending window queries.
- `getClassicAsset(identifier)`: Resolves SAC address for `XLM`, `USDC`, `EURC`.
- `getGuardian()`: Returns configured guardian address.
- `isFrozen()`: Checks if contract is frozen.
- `isInRecovery()`: Checks if treasury outflows are in recovery mode.
- `getRecurringPayment(id)` / `getRecurringPaymentsPaged(offset, limit)`: Recurring payment schedules.
- `getNextDisbursementTime(id)` / `getActiveRecurringCount()`: Schedule disbursement queries.

### State-Changing Methods
- `createProposal(...)`: Transfer proposals.
- `createProposalWithAttachment(...)`: Proposals with 32-byte attachment hash.
- `createAssetProposal(...)`: Proposals with classic asset references.
- `createAddOwnerProposal(...)` / `createRemoveOwnerProposal(...)`: Owner changes.
- `createChangeThresholdProposal(...)` / `createChangeWeightProposal(...)`: Governance parameter changes.
- `createSpendingLimitProposal(...)` / `createSpendingWindowProposal(...)`: Spending limits.
- `createRecurringProposal(...)` / `createCancelRecurringProposal(...)`: Recurring schedules.
- `createGrantRoleProposal(...)` / `createRevokeRoleProposal(...)`: RBAC assignments.
- `approve(...)` / `revoke(...)`: Proposal voting.
- `execute(...)`: Execute approved proposals.
- `cancelExpired(...)`: Prune expired proposals.
- `disburseRecurring(...)`: Trigger due recurring payments.
- `setGuardian(...)`: Replace guardian address (multi-auth).
- `freeze(...)` / `unfreeze(...)`: Full emergency stop and resumption.
- `enterRecovery(...)` / `exitRecovery(...)`: Outflow stop and resumption.
- `setClassicAsset(...)`: Map classic asset to SAC address.
- `upgrade(...)`: In-place contract WASM bytecode upgrade.

---

## License

Apache-2.0
