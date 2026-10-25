# Glossary

This glossary defines the Stellar, Soroban, and Accord-specific terms used throughout this repository's documentation, so contributors and users don't need prior blockchain experience to follow along. It covers four term families: **Stellar network** concepts (the underlying public ledger), **Soroban platform** concepts (the smart contract runtime Stellar provides), **Accord protocol** concepts (the multisig logic this project implements on top of Soroban), and **analytics & indexer** concepts (the off-chain event-indexing and treasury-reporting layer built on top of the contract). Where a term is explained in more depth elsewhere in the docs, a "See also" link points you there.

---

## Stellar Network Terms

**EURC**
EURC is a Euro-backed stablecoin, also issued by Circle and available on Stellar, that works the same way as USDC for the purposes of a proposal — it's simply another Soroban token contract address supplied to `create_proposal`. Amounts are expressed in EURC's smallest base unit, not whole euros.
See also: **USDC**, **XLM**.

**Freighter**
Freighter is a browser-extension wallet for Stellar and Soroban that stores a user's keys and signs transactions on their behalf, similar to a wallet extension you might know from other chains. Accord's frontend uses Freighter so owners can authorize proposal actions (approve, revoke, execute) without ever exposing their private key to the web page.
See also: [Architecture §1 — System Overview](./ARCHITECTURE.md#1-system-overview).

**Friendbot**
Friendbot is a free faucet service on Stellar's testnet that funds a newly created account with starting testnet XLM, so developers don't need real money to test against. It only exists on testnet/futurenet — there is no equivalent on the public mainnet network.
See also: [SETUP.md](./SETUP.md).

**Horizon**
Horizon is Stellar's REST API server that indexes ledger data (accounts, balances, transactions, payments) so applications can query it without running their own node. Horizon serves classic Stellar data; Soroban contract calls instead go through a separate RPC endpoint (see **Soroban RPC**, below).
See also: [SETUP.md](./SETUP.md).

**Ledger**
A ledger is the fundamental unit of state and time on the Stellar network, similar to a "block" on other blockchains. Validators close a new ledger roughly every 5 seconds, and each one has a sequence number and a closing timestamp. Soroban contracts read the current ledger's timestamp to make time-based decisions, such as checking whether a proposal's deadline has passed.

**Stellar account address (G-address)**
A Stellar account address — often called a "G-address" because it always starts with the letter `G` — is the public identifier for a Stellar account, derived from that account's key pair. Owners, proposers, approvers, and proposal recipients in Accord Protocol are all represented as G-addresses (Soroban's `Address` type).

**Stroop**
A stroop is the smallest indivisible unit of XLM, equal to one ten-millionth (0.0000001) of one XLM. Smart contracts and on-chain balances always work in stroops (or the equivalent smallest unit for other tokens) rather than fractional amounts, since computers can't represent fractional currency exactly.
See also: [Architecture §9 — Token Handling](./ARCHITECTURE.md#9-token-handling).

**Testnet**
The testnet is a public Stellar network that behaves like the real (mainnet) network but uses worthless test tokens, making it safe to build and experiment against. Accord Protocol is deployed to testnet during development, and Friendbot is used to fund test accounts there.

**USDC**
USDC is a USD-backed stablecoin issued by Circle and available on Stellar as a Soroban token. A proposal can name USDC as its token so owners can move stablecoin funds, with amounts expressed in USDC's smallest base unit rather than whole dollars.
See also: **EURC**, **XLM**.

**XLM**
XLM ("lumens") is the native digital currency of the Stellar network, used to pay transaction fees and to fund the minimum balance every Stellar account must hold. In Accord Protocol, XLM can also be the asset a proposal transfers, in which case its amount is expressed in stroops.
See also: **Stroop**.

---

## Soroban Terms

**Instance storage**
Instance storage is a Soroban storage tier tied to the contract instance itself — cheap and well-suited to small, frequently-read values, but with a shorter default TTL than persistent storage. Accord Protocol keeps its initialization guard, approval threshold, next proposal ID counter, and active proposal count here.
See also: [Architecture §3 — Storage Layout](./ARCHITECTURE.md#3-storage-layout-soroban).

**nativeToScVal**
`nativeToScVal` is a Stellar JS SDK helper that converts an ordinary JavaScript value (a string, number, address, and so on) into the SCVal format a Soroban contract call requires. Frontend code calls it when building arguments for functions like `create_proposal` or `approve` before sending them to Soroban RPC.
See also: **SCVal**, **Soroban RPC**.

**Persistent storage**
Persistent storage is a Soroban storage tier meant for data that needs to survive long-term, with a longer default TTL than instance storage at a higher storage cost. Accord Protocol stores its owner list, per-owner roles, delegations, and every individual proposal (plus each owner's per-proposal approval flag) here.
See also: [Architecture §3 — Storage Layout](./ARCHITECTURE.md#3-storage-layout-soroban).

**SCVal**
An SCVal ("Soroban Contract Value") is the strongly-typed internal value format Soroban uses to represent every contract parameter and return value — numbers, addresses, strings, structs, and so on. Frontend code never builds SCVals by hand; helpers like `nativeToScVal` convert ordinary JavaScript values for you.
See also: **nativeToScVal**, **XDR**.

**simulateTransaction**
`simulateTransaction` is a Soroban RPC method that runs a contract call against current ledger state without submitting it on-chain, returning the result (and the resources it would consume) instantly and for free. Accord's frontend uses it for read-only calls like fetching a proposal, and as a dry run before sending a real, signed transaction.
See also: [Architecture §1 — System Overview](./ARCHITECTURE.md#1-system-overview).

**Soroban**
Soroban is Stellar's smart contract platform: it lets developers write contracts in Rust that compile to WebAssembly and run on the Stellar network. Accord Protocol's multisig logic — proposals, approvals, execution — is implemented entirely as a Soroban smart contract.
See also: [Architecture §1 — System Overview](./ARCHITECTURE.md#1-system-overview).

**Soroban RPC**
Soroban RPC is the network endpoint frontends and tools use to simulate and submit smart contract calls, distinct from Horizon (which serves classic Stellar data). Accord's frontend talks to Soroban RPC, via the Stellar JS SDK, to read proposals and submit approve/execute transactions.
See also: [Architecture §1 — System Overview](./ARCHITECTURE.md#1-system-overview).

**TTL (time to live)**
TTL is the number of ledgers remaining before a piece of contract storage is automatically archived and becomes inaccessible until restored. Both instance storage and persistent storage carry their own TTL, and a contract must periodically extend ("bump") it to keep long-lived data like proposals and owner lists from expiring.
See also: [Architecture §3 — Storage Layout](./ARCHITECTURE.md#3-storage-layout-soroban).

**TTL bump**
A TTL bump is the act of extending a storage entry's remaining time-to-live so it doesn't expire and get archived. Accord's coding standards call for bumping TTLs on every storage read, which is why the contract's read paths call `bump_instance` / `bump_persistent` throughout.
See also: [CONTRIBUTING.md — Coding Standards](./CONTRIBUTING.md#coding-standards).

**WASM**
WASM (WebAssembly) is the compact, sandboxed binary format that Soroban contracts compile down to before deployment. Writing a contract in Rust and compiling it to WASM is what lets the Soroban host run contracts from many different developers safely, in a predictable, resource-metered way.

**XDR**
XDR (External Data Representation) is the binary serialization format Stellar and Soroban use to encode transactions, ledger entries, and contract values for transmission over the network. You'll run into XDR when inspecting raw transaction data or debugging a failed simulation, since errors are often returned as XDR-encoded structures that tooling then decodes into something readable.

---

## Accord Protocol Terms

**Active proposal count**
The active proposal count is a running tally of proposals that haven't yet reached a terminal state, kept as a budget guard against unbounded growth. Creating a new proposal checks this count against a fixed limit and fails if the limit has been reached.
See also: [Architecture §3 — Storage Layout](./ARCHITECTURE.md#3-storage-layout-soroban).

**Approver (role)**
The Approver **role** (`Role::Approver`) allows an **owner** to call `approve` and `revoke`. Non-owners cannot cast weighted votes even if granted Approver; voting weight always requires listed ownership.
See also: **Approver (vote)**, **Owner**, **Role (RBAC)**.

**Approver (vote)**
An approver (lowercase usage in lifecycle docs) is an owner who has cast an approval vote on a specific proposal. The contract stores the weight credited for that approval under `("APPR", id, owner)` so a later revoke can reverse the exact same amount.
See also: **Approver (role)**, **Effective weight**, **ProposalApprovedEvent / ProposalRevokedEvent**.

**Deadline**
A deadline is the Unix timestamp (seconds since epoch) after which a proposal can no longer be approved or executed, and is instead treated as `Expired`. A new proposal's deadline must be in the future and within a bounded window, and the contract checks it against the current ledger's timestamp rather than wall-clock time on any one machine.
See also: [Contract API — create_proposal](./CONTRACT_API.md#create_proposal).

**DEFAULT_OWNER_ROLES**
The default role set granted to every owner at `initialize` and by `migrate_to_rbac`: `[Role::Proposer, Role::Approver, Role::Executor]`. It preserves classic "owners can do everything" behavior until roles are narrowed deliberately.
See also: **migrate_to_rbac**, **Owner**, **Role (RBAC)**.

**Delegate**
A delegate is an owner who receives voting weight from another owner via an on-chain delegation (`Delegation.delegate`). When casting an approval, the delegate's effective voting power includes all active delegations received from other owners.
See also: **Delegation**, **Delegator**, **Effective weight**, **Owner**.

**Delegation**
A delegation (`Delegation`) represents an owner transferring a portion of their voting weight to another owner on the multisig. Each delegation specifies a `delegator`, a `delegate`, the delegated `weight`, and an optional `expiry` timestamp. Note: while delegation queries (`get_delegations`, `get_active_delegations`) and effective weight adjustments exist in the contract, no public proposal or entrypoint is currently exposed to create new delegations on-chain.
See also: **Delegate**, **Delegator**, **Delegation expiry**, **DelegationInfo**, **Effective weight**.
Link: [Architecture §3 — Storage Layout](./ARCHITECTURE.md#3-storage-layout-soroban).

**Delegation expiry**
Delegation expiry (`Delegation.expiry`) is the optional ledger timestamp in seconds after which a delegation ceases to be active. When the current ledger timestamp exceeds this value, `compute_effective_weight` ignores the delegation and restores the raw weight to the delegator.
See also: **Delegation**, **Effective weight**.
Link: [Architecture §4 — Proposal Lifecycle](./ARCHITECTURE.md#4-proposal-lifecycle).

**DelegationInfo**
`DelegationInfo` is the contract struct returned by `get_delegations`, bundling an owner's outgoing delegation vector (`outgoing`) together with all delegations currently received from other owners (`incoming`).
See also: **Delegation**, **Effective weight**.
Link: [Architecture §3 — Storage Layout](./ARCHITECTURE.md#3-storage-layout-soroban).

**Delegator**
A delegator is an owner who assigns part of their voting weight to another owner (`Delegation.delegator`). An owner may hold at most one active outgoing delegation at a time, and their effective weight is reduced by the delegated amount for as long as the delegation remains active.
See also: **Delegate**, **Delegation**, **Effective weight**, **Owner**.

**Effective weight**
Effective weight is an owner's net voting weight at the current ledger timestamp, calculated by `compute_effective_weight` (and queried via `get_effective_weight`) as raw weight minus active outgoing delegation plus active incoming delegations. When an owner calls `approve`, this effective weight is credited toward quorum and recorded on the proposal.
See also: **Approver (vote)**, **Delegation**, **Owner**, **Quorum weight**, **Weighted approval**.
Link: [Architecture §4 — Proposal Lifecycle](./ARCHITECTURE.md#4-proposal-lifecycle).

**Executor (role)**
The Executor **role** (`Role::Executor`) allows an address to call `execute` and `cancel_expired`. This can be held by a human owner or an automated keeper bot that does not hold Approver or Proposer permissions.
See also: **Owner**, **ProposalExecutedEvent**, **Role (RBAC)**.

**Governance version**
Governance version marks whether a deployed Accord contract uses flat (M-of-N approval count) or weighted (per-owner weight sum) voting logic. The `is_governance_migrated` query returns `false` for flat and `true` for weighted. A multisig deployed before weighted governance was added must call `migrate_to_weighted_governance` to transition to the new model.
See also: [DEPLOYMENT.md — Migrating to Weighted Governance](./DEPLOYMENT.md#migrating-to-weighted-governance).

**GrantRole / RevokeRole**
Governance proposal kinds (`ProposalKind::GrantRole` and `ProposalKind::RevokeRole`) that add or remove an operational role for a target address. Created via `create_grant_role_proposal` and `create_revoke_role_proposal`, then approved and executed by owners.
See also: **Role (RBAC)**, **RoleGrantedEvent / RoleRevokedEvent**.
Link: [Architecture §RBAC & Access Control](./ARCHITECTURE.md#rbac--access-control).

**InvalidRole**
`InvalidRole` is a contract error code (`ContractError::InvalidRole = 55`) returned when an invalid, unsupported, or unrecognized role symbol is supplied in a role management proposal.
See also: **ContractError**, **Role (RBAC)**.
Link: [Architecture §RBAC & Access Control](./ARCHITECTURE.md#rbac--access-control).

**M-of-N threshold**
An M-of-N threshold means M approvals are required out of a fixed set of N owners before a proposal can execute — for example, "2-of-3" means any 2 of the 3 owners must approve. In flat governance, Accord Protocol checks this count directly; in weighted governance, quorum is instead governed by quorum weight.
See also: [Architecture §3 — Storage Layout](./ARCHITECTURE.md#3-storage-layout-soroban), **Quorum weight**, **Weighted approval**.

**migrate_to_rbac**
`migrate_to_rbac` is a one-time, owner-weight-gated migration entrypoint that grants `DEFAULT_OWNER_ROLES` to every current owner and sets the on-chain `role_version` flag. Subsequent calls are rejected with `AlreadyMigrated` and leave contract state unchanged.
See also: **DEFAULT_OWNER_ROLES**, **RbacMigratedEvent**, **Role (RBAC)**.
Link: [Architecture §RBAC & Access Control](./ARCHITECTURE.md#rbac--access-control).

**MissingRole**
`MissingRole` is a contract error code (`ContractError::MissingRole = 52`) returned when an address attempts to invoke an entrypoint without holding the required operational role (`Proposer`, `Approver`, or `Executor`).
See also: **Role (RBAC)**.
Link: [Contract API — Errors](./CONTRACT_API.md#error-reference).

**Multisig**
Multisig (multi-signature) describes a contract or account that requires approval from more than one party before an action takes effect, rather than trusting a single key. Accord Protocol is a multisig contract: no single owner can move funds alone — a proposal must collect enough approvals first.
See also: **Owner**, **Proposal**, **Weighted approval**.

**Owner**
An owner is an address registered in the multisig's owner-weight map (`OWNERS`). Ownership supplies voting weight for quorum and is required (alongside the Approver role) to approve or revoke proposals. High-privilege actions (upgrades, emergency freeze/recovery, parameter changes) require owner-weighted consensus rather than operational roles alone.
See also: [Architecture §RBAC & Access Control](./ARCHITECTURE.md#rbac--access-control), **Approver (role)**, **Effective weight**, **Total weight**.

**Proposal**
A proposal is a single proposed action — such as a token transfer, recurring disbursement, or owner change — that one address drafts and owners must approve before execution. Every proposal has a sequential ID, a proposer, a description, a deadline, a category, and a lifecycle status.
See also: [Architecture §4 — Proposal Lifecycle](./ARCHITECTURE.md#4-proposal-lifecycle), **ProposalStatus**, **Quorum weight**.

**ProposalStatus**
ProposalStatus is a proposal's current lifecycle state (`ProposalStatus` enum). It includes `Pending` (created, not yet enough approvals), `Ready` (quorum weight reached, awaiting execution), `Executed` (successfully run), `Expired` (deadline passed before execution), `Revoked`, and `Cancelled` (withdrawn by its proposer before reaching quorum).
See also: [Architecture §4 — Proposal Lifecycle](./ARCHITECTURE.md#4-proposal-lifecycle), **Proposal**.

**Continuous stream**
A continuous stream is a recurring payment schedule that accrues its configured token rate per second from its start time through its end time. The recipient can claim accrued funds at any time after the cliff, subject to the schedule's total cap.
See also: [Contract API — claim_stream](./CONTRACT_API.md#claim_stream), **RecurringPayment**.

**Proposer (proposal field)**
On a given proposal, the proposer (`Proposal.proposer`) is the address that submitted that proposal. Their address is recorded in the proposal struct and emitted in `ProposalCreatedEvent`.
See also: **Proposal**, **ProposalCreatedEvent**, **Proposer (role)**.

**Proposer (role)**
The Proposer **role** (`Role::Proposer`) allows an address to call proposal-creation entrypoints (`create_*_proposal`). Non-owners may be granted Proposer to draft proposals for owners to review; owner proposers are also subject to configured spending limits.
See also: [Architecture §Entrypoint Gating Matrix](./ARCHITECTURE.md#entrypoint-gating-matrix), **Role (RBAC)**.

**Quorum weight**
Quorum weight (`Proposal.quorum_weight`) is the minimum total voting weight required for a proposal to transition from `Pending` to `Ready`. It is snapshotted from the contract threshold when the proposal is created so subsequent owner or threshold changes do not retroactively alter an existing proposal's approval requirement.
See also: [Architecture §4 — Proposal Lifecycle](./ARCHITECTURE.md#4-proposal-lifecycle), **Effective weight**, **Total weight**, **Weighted approval**.

**RbacMigratedEvent**
`RbacMigratedEvent` is the event emitted when `migrate_to_rbac` executes, recording the number of initialized owners (`owner_count`), the activated role version (`role_version`), and the `EVENT_SCHEMA_VERSION`.
See also: **migrate_to_rbac**, **Role (RBAC)**.
Link: [Architecture §RBAC & Access Control](./ARCHITECTURE.md#rbac--access-control).

**Role (RBAC)**
A role (`Role` enum) is an operational permission granted per address: `Proposer`, `Approver`, `Executor`, or `Viewer`. Roles separate day-to-day multisig tasks (drafting, approving, executing) while leaving core governance tied to owner weight.
See also: [Roles & Permissions guide](./guides/roles-and-permissions.md), **Approver (role)**, **Executor (role)**, **Proposer (role)**, **Viewer (role)**.

**RoleAlreadyGranted**
`RoleAlreadyGranted` is a contract error code (`ContractError::RoleAlreadyGranted = 53`) returned when executing a `GrantRole` proposal for an address that already possesses the specified role.
See also: **GrantRole / RevokeRole**, **Role (RBAC)**.
Link: [Architecture §RBAC & Access Control](./ARCHITECTURE.md#rbac--access-control).

**RoleGrantedEvent / RoleRevokedEvent**
Contract events (`RoleGrantedEvent` and `RoleRevokedEvent`) emitted when a role proposal is executed. They record the affected `target` address, the modified `role`, and the full list of roles assigned to the target before and after execution.
See also: **GrantRole / RevokeRole**, **Role (RBAC)**.
Link: [Architecture §RBAC & Access Control](./ARCHITECTURE.md#rbac--access-control).

**RoleNotGranted**
`RoleNotGranted` is a contract error code (`ContractError::RoleNotGranted = 54`) returned when executing a `RevokeRole` proposal targeting a role that the address does not currently hold.
See also: **GrantRole / RevokeRole**, **Role (RBAC)**.
Link: [Architecture §RBAC & Access Control](./ARCHITECTURE.md#rbac--access-control).

**Total weight**
Total weight is the sum of all current owner weights stored in the contract (`TWEIGHT`). It sets the maximum possible quorum requirement — a proposal's quorum weight cannot exceed total weight. Total weight updates dynamically whenever owners are added, removed, or re-weighted.
See also: [DEPLOYMENT.md — Migrating to Weighted Governance](./DEPLOYMENT.md#migrating-to-weighted-governance), **Owner**, **Quorum weight**, **Weighted approval**.

**Viewer (role)**
The Viewer **role** (`Role::Viewer`) designates an address as having view-only status in product and interface contexts. It does not confer permission to create, approve, or execute proposals.
See also: [Roles & Permissions guide](./guides/roles-and-permissions.md), **Role (RBAC)**.

**Weighted approval**
Weighted approval is the governance model where each owner possesses an individual voting weight, and a proposal reaches quorum when the cumulative effective weight of approving owners meets or exceeds `quorum_weight`. This enables nuanced ownership structures where voting power reflects capital or organizational responsibility.
See also: [Architecture §4 — Proposal Lifecycle](./ARCHITECTURE.md#4-proposal-lifecycle), **Effective weight**, **Quorum weight**, **Total weight**.

---

## Analytics & Indexer Terms

**Analytics API**
The analytics API is the HTTP interface serving historical data and aggregates from the indexer's datastore. It provides REST endpoints for proposals, treasury flows, category breakdowns, and system health, alongside Prometheus metrics and GraphQL query capabilities.
See also: [ANALYTICS_API.md](./ANALYTICS_API.md), **GraphQL API**, **Indexer**, **Prometheus metrics**.

**Checkpoint (indexer)**
A checkpoint is the ledger sequence number through which an indexer has fully processed events, persisted to its datastore so the service can resume gracefully after restarts without rescanning past ledgers from the genesis sequence.
See also: [Architecture §13.3 — Checkpointing, Resume, and Idempotency](./ARCHITECTURE.md#133-checkpointing-resume-and-idempotency), **Indexer**.

**Event schema version**
The event schema version (`EVENT_SCHEMA_VERSION = 2`) is an integer version identifier included in every contract event payload. It allows off-chain consumers and indexers to detect schema changes, ensure forward compatibility, and reliably decode historical events.
See also: [Architecture §8 — Off-Chain Event Indexer](./ARCHITECTURE.md#indexing-accord-events), **Indexer**.

**Granularity**
Granularity is the bucket size (`day`, `week`, or `month`) used to group time-series analytics data, such as treasury flow or balance history, into discrete intervals. It is supplied as a query parameter on supported analytics endpoints.
See also: [ANALYTICS_API.md — Standardized Query Parameters](./ANALYTICS_API.md#standardized-query-parameters), **Treasury flow**.

**GraphQL API**
The GraphQL API (`POST /graphql`) is a query endpoint provided by the analytics backend allowing clients to request customized shapes of proposals, owners, spend aggregates, and flows in a single round-trip, protected by query-cost analyzers.
See also: [ANALYTICS_API.md — GraphQL](./ANALYTICS_API.md#graphql), **Analytics API**.

**Idempotent replay**
Idempotent replay is the design property ensuring that re-processing a range of ledgers — such as during crash recovery — produces identical datastore records without duplicating rows or inflating aggregates. It is achieved by keying on immutable contract-ledger-transaction tuples and deriving aggregates from log state.
See also: [Architecture §13.3 — Checkpointing, Resume, and Idempotency](./ARCHITECTURE.md#133-checkpointing-resume-and-idempotency), **Checkpoint (indexer)**.

**Indexer**
An indexer is an off-chain daemon that continuously polls Soroban RPC for contract events, decodes XDR event payloads, and writes structured records into a relational database to power high-performance analytics queries.
See also: [Architecture §8 — Off-Chain Event Indexer](./ARCHITECTURE.md#indexing-accord-events), [Architecture §13 — Indexer & Analytics Architecture](./ARCHITECTURE.md#13-indexer--analytics-architecture).

**Prometheus metrics**
Prometheus metrics are operational time-series telemetries exposed at `GET /metrics` by `analytics-api`. They instrument HTTP request rates, response latencies, database connection pool statistics, and event ingestion lag.
See also: [ANALYTICS_API.md](./ANALYTICS_API.md), **Analytics API**.

**ProposalApprovedEvent / ProposalRevokedEvent**
Contract events (`ProposalApprovedEvent` and `ProposalRevokedEvent`) emitted when an approver adds or revokes their vote on a proposal. The payloads record the proposal ID, voter address, credited voting weight, and the updated cumulative approval weight.
See also: [ANALYTICS_API.md](./ANALYTICS_API.md), **Approver (vote)**, **Effective weight**, **Indexer**.

**ProposalCreatedEvent**
`ProposalCreatedEvent` is the event emitted when any new proposal is created on-chain. It carries the proposal ID, proposer address, approval threshold, category, transfer list, snapshotted quorum weight, and total weight at creation.
See also: [ANALYTICS_API.md](./ANALYTICS_API.md), **Indexer**, **Proposal**, **Quorum weight**.

**ProposalExecutedEvent**
`ProposalExecutedEvent` is the event emitted upon successful execution of a ready proposal, capturing the proposal ID, the executor address, and the event schema version. The executed transfers are not repeated in the event; read them from `ProposalCreatedEvent` or `get_proposal`.
See also: [ANALYTICS_API.md](./ANALYTICS_API.md), **Executor (role)**, **Indexer**, **Proposal**.

**RecurringPaymentDisbursedEvent**
`RecurringPaymentDisbursedEvent` is emitted whenever an installment is disbursed under a recurring payment schedule, recording the schedule ID, recipient, token, disbursed amount, cumulative disbursements to date, and the number of periods disbursed.
See also: [ANALYTICS_API.md](./ANALYTICS_API.md), **Indexer**, **Treasury flow**.

**Retention policy**
A retention policy is an indexer configuration specifying the time duration or ledger depth for which granular event records and raw time-series data are retained before being purged or rolled up into daily aggregates.
See also: [Architecture §13 — Indexer & Analytics Architecture](./ARCHITECTURE.md#13-indexer--analytics-architecture), **Indexer**.

**Spend by category**
Spend by category is an analytics aggregation that totals executed transfer amounts grouped by proposal category (`Transfer`, `Payroll`, `Grant`, `Ops`, `Other`), along with each category's percentage share of total spend. It powers the Analytics page's "Spend by Category" chart and the `GET /spend/by-category` endpoint.
See also: [Treasury Analytics guide](./guides/treasury-analytics.md#the-charts), [ANALYTICS_API.md](./ANALYTICS_API.md#get-spendby-category).

**Spend by owner**
Spend by owner is an aggregation grouping executed transfer totals by proposer address, measuring how much capital each owner has proposed and disbursed. It powers the "Spend by Owner" chart and the `GET /spend/by-owner` endpoint.
See also: [Treasury Analytics guide](./guides/treasury-analytics.md#the-charts), [ANALYTICS_API.md](./ANALYTICS_API.md#get-spendby-owner).

**Time-series snapshot**
A time-series snapshot is a single historical record capturing token balances or treasury states at a specific timestamp, enabling queries for historical balance curves rather than merely current balances.
See also: [ANALYTICS_API.md — GET /treasury/balance](./ANALYTICS_API.md#get-treasurybalance), **Treasury flow**.

**Treasury flow**
Treasury flow is a time-bucketed analysis of inflows (deposits to the contract) and outflows (executed transfers and recurring disbursements) per token over a chosen granularity. It powers the "Treasury Outflow Over Time" visualization and the `GET /treasury/flow` endpoint.
See also: [Treasury Analytics guide](./guides/treasury-analytics.md#the-charts), [ANALYTICS_API.md](./ANALYTICS_API.md#get-treasuryflow).
