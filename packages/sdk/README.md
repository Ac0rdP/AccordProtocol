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
- **Multi-language Codegen**: Generates typed Python and Go clients from the contract ABI ([details](#multi-language-code-generation)).
- **Bundle Budgets**: Per-entry-point size limits and forbidden-import rules keep the package tree-shakeable ([details](#bundle-size-budgets)).
- **Automated Releases**: Versions, changelog, and npm provenance derived from Conventional Commits ([details](#releases)).

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

## Multi-language Code Generation

Generate typed clients for other languages from the same contract ABI that the TypeScript SDK wraps. Supported languages: **Python** (dataclasses, `IntEnum`, typed client) and **Go** (structs, typed constants, `error`-implementing `ContractError`, typed client).

Generated clients are transport-agnostic: they own method names, argument order and types, and delegate the actual Soroban call to an `Invoker` you supply, so signing and secrets stay in your application.

```typescript
import { readFileSync, writeFileSync } from "node:fs";
import { generateClient, parseSorobanSpec } from "@accord-protocol/sdk";

// Produced by: stellar contract info interface --wasm accord.wasm --output json > accord-spec.json
const abi = parseSorobanSpec(readFileSync("accord-spec.json", "utf8"));

const python = generateClient(abi, { language: "python" });
writeFileSync(python.fileName, python.source); // accord_contract_client.py

const go = generateClient(abi, { language: "go", clientName: "Treasury", packageName: "treasury" });
writeFileSync(go.fileName, go.source); // treasury.go
```

From a checkout, the same thing is available as a CLI:

```bash
npm run build
npm run codegen -- --spec=accord-spec.json --out=generated --lang=python,go
```

| Soroban type | Python | Go |
|---|---|---|
| `u32` / `i32` / `u64` / `i64` | `int` | `uint32` / `int32` / `uint64` / `int64` |
| `u128` / `i128` / `u256` / `i256` | `int` | `*big.Int` |
| `address` / `string` / `symbol` | `str` | `string` |
| `bytes` / `BytesN<N>` | `bytes` | `[]byte` / `[N]byte` |
| `Vec<T>` / `Option<T>` / `Map<K, V>` | `List[T]` / `Optional[T]` / `Dict[K, V]` | `[]T` / `*T` / `map[K]V` |
| `Result<T, E>` | `T` (errors raised by the invoker) | `(T, error)` |
| `#[contracttype]` struct / enum / union | `@dataclass` / `IntEnum` / tagged dataclass | struct / typed consts / `Tag`+`Values` struct |

`parseSorobanSpec` and `generateClient` throw `AccordValidationError` (with the offending field path) for malformed specs, undeclared type references, unsupported languages and invalid names.

---

## Bundle Size Budgets

The package is `sideEffects: false` and the developer-tooling modules (`codegen`, `release`, `bundle-budget`) never import `AccordClient` or `@stellar/stellar-sdk`, so importing `parseContractError` does not pull in the client. [`bundle-budgets.json`](./bundle-budgets.json) enforces this per entry point: each budget lists the exports to import, a minified and/or gzip limit, and `forbiddenImports` that must not appear in that bundle.

```bash
npm run build
npm run size           # fails with exit code 1 on any violation
npm run size -- --json # machine-readable report
```

The same checks are available programmatically, for example to gate your own app's bundles:

```typescript
import { evaluateBudgets, formatBudgetReport, validateBudgets } from "@accord-protocol/sdk";

const budgets = validateBudgets([
  { name: "errors", exports: ["parseContractError"], maxGzipBytes: "3 KB", forbiddenImports: ["@stellar/stellar-sdk"] },
]);
const report = evaluateBudgets(budgets, [
  { name: "errors", bytes: 7600, gzipBytes: 2500, modules: ["dist/esm/errors.js"] },
]);
console.log(formatBudgetReport(report)); // PASS  errors ...
```

When a change legitimately grows an entry, raise its budget in the same PR and explain why in the description.

---

## React Hooks

Reusable hooks for building web applications and UI integrations:

```typescript
import { useAccordClient, useOwners, useProposal, useProposalActions } from "@accord-protocol/sdk";

function ProposalView({ client, proposalId }: { client: AccordClient; proposalId: number }) {
  const { data: proposal, loading, refetch } = useProposal(client, proposalId);
  const { approve, execute } = useProposalActions(client);

  if (loading) return <div>Loading...</div>;
  return (
    <div>
      <h3>{proposal?.description}</h3>
      <button onClick={() => approve(proposalId)}>Approve</button>
      <button onClick={() => execute(proposalId)}>Execute</button>
    </div>
  );
}
```

---

## Accord CLI

A machine-readable command-line interface for contract operations:

```bash
# Display help and available commands
accord help

# Propose a transfer with JSON output
accord propose --to=GA... --amount=1000 --token=USDC --json

# Approve and execute proposals
accord approve --id=1
accord execute --id=1
```

Programmatic CLI dispatcher is available via `runCli(argv)`:

```typescript
import { runCli } from "@accord-protocol/sdk";

const result = await runCli(["query", "owners", "--json"]);
console.log(result.output);
```

---

## Event Subscriptions

Typed event streams with cursor resumption, deduplication, and polling:

```typescript
import { subscribeEvents } from "@accord-protocol/sdk";

const sub = subscribeEvents(async (cursor) => {
  // Query indexed contract events from API or Horizon/Soroban RPC
  return fetchEventsSince(cursor);
}, { pollIntervalMs: 2500 });

sub.on("proposal_created", (event) => {
  console.log("New proposal created:", event.data);
});

sub.on("proposal_approved", (event) => {
  console.log("Proposal approved:", event.data);
});
```

---

## Resilience & Circuit Breaker

Automatic exponential backoff with jitter and circuit-breaker protection:

```typescript
import { CircuitBreaker, retryWithBackoff, withResilience } from "@accord-protocol/sdk";

const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 15000 });

// Wrap RPC queries with retry backoff and circuit protection
const owners = await withResilience(
  () => client.getOwners(),
  { retry: { maxRetries: 3, baseDelayMs: 200 }, breaker }
);
```

---

## Releases

Releases are automated from [Conventional Commits](https://www.conventionalcommits.org/) by `.github/workflows/sdk-release.yml` on every push to `main` that touches `packages/sdk/`:

| Commit | Release |
|---|---|
| `fix:`, `perf:`, `revert:` | patch |
| `feat:` | minor |
| `type!:` or a `BREAKING CHANGE:` footer | major (minor while on `0.x`) |
| anything else (`docs:`, `chore:`, `test:`, ...) | no release |

The workflow runs typecheck, tests, build and size budgets, then `scripts/release.mjs --publish` computes the next version, writes it and the new changelog section into the package, publishes to npm with **provenance attestations**, pushes an `sdk-v<version>` tag and creates a GitHub Release with the notes. The tag is the source of truth for the released version. Preview locally with:

```bash
npm run build && npm run release   # dry run: prints the next version and notes
```

The planner is exported for reuse:

```typescript
import { planRelease } from "@accord-protocol/sdk";

const plan = planRelease("0.1.0", ["feat(sdk): add codegen", "fix: handle empty spec", "docs: typo"]);
console.log(plan?.nextVersion); // "0.2.0"
console.log(plan?.tag);         // "sdk-v0.2.0"
```

---

## License

Apache-2.0
