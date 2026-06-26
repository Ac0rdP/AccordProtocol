# Glossary

This glossary defines the Stellar, Soroban, and Accord-specific terms used throughout this repository's documentation, so contributors and users don't need prior blockchain experience to follow along. It covers three term families: **Stellar network** concepts (the underlying public ledger), **Soroban platform** concepts (the smart contract runtime Stellar provides), and **Accord protocol** concepts (the multisig logic this project implements on top of Soroban). Where a term is explained in more depth elsewhere in the docs, a "See also" link points you there.

---

## Stellar Network Terms

**Ledger**
A ledger is the fundamental unit of state and time on the Stellar network, similar to a "block" on other blockchains. Validators close a new ledger roughly every 5 seconds, and each one has a sequence number and a closing timestamp. Soroban contracts read the current ledger's timestamp to make time-based decisions, such as checking whether a proposal's deadline has passed.

**Stroop**
A stroop is the smallest indivisible unit of XLM, equal to one ten-millionth (0.0000001) of one XLM. Smart contracts and on-chain balances always work in stroops (or the equivalent smallest unit for other tokens) rather than fractional amounts, since computers can't represent fractional currency exactly.
See also: [Architecture §7 — Token Handling](./ARCHITECTURE.md#7-token-handling).

**XLM**
XLM ("lumens") is the native digital currency of the Stellar network, used to pay transaction fees and to fund the minimum balance every Stellar account must hold. In Accord Protocol, XLM can also be the asset a proposal transfers, in which case its amount is expressed in stroops.

**USDC**
USDC is a USD-backed stablecoin issued by Circle and available on Stellar as a Soroban token. A proposal can name USDC as its token so owners can move stablecoin funds, with amounts expressed in USDC's smallest base unit rather than whole dollars.

**EURC**
EURC is a Euro-backed stablecoin, also issued by Circle and available on Stellar, that works the same way as USDC for the purposes of a proposal — it's simply another Soroban token contract address supplied to `create_proposal`. Amounts are expressed in EURC's smallest base unit, not whole euros.

**Horizon**
Horizon is Stellar's REST API server that indexes ledger data (accounts, balances, transactions, payments) so applications can query it without running their own node. Horizon serves classic Stellar data; Soroban contract calls instead go through a separate RPC endpoint (see **Soroban RPC**, below).
See also: [SETUP.md](./SETUP.md).

**Friendbot**
Friendbot is a free faucet service on Stellar's testnet that funds a newly created account with starting testnet XLM, so developers don't need real money to test against. It only exists on testnet/futurenet — there is no equivalent on the public mainnet network.
See also: [SETUP.md](./SETUP.md).

**Freighter**
Freighter is a browser-extension wallet for Stellar and Soroban that stores a user's keys and signs transactions on their behalf, similar to a wallet extension you might know from other chains. Accord's frontend uses Freighter so owners can authorize proposal actions (approve, revoke, execute) without ever exposing their private key to the web page.
See also: [Architecture §1 — System Overview](./ARCHITECTURE.md#1-system-overview).

**Testnet**
The testnet is a public Stellar network that behaves like the real (mainnet) network but uses worthless test tokens, making it safe to build and experiment against. Accord Protocol is deployed to testnet during development, and Friendbot is used to fund test accounts there.

**Stellar account address (G-address)**
A Stellar account address — often called a "G-address" because it always starts with the letter `G` — is the public identifier for a Stellar account, derived from that account's key pair. Owners, proposers, approvers, and proposal recipients in Accord Protocol are all represented as G-addresses (Soroban's `Address` type).

---

## Soroban Terms

**Soroban**
Soroban is Stellar's smart contract platform: it lets developers write contracts in Rust that compile to WebAssembly and run on the Stellar network. Accord Protocol's multisig logic — proposals, approvals, execution — is implemented entirely as a Soroban smart contract.
See also: [Architecture §1](./ARCHITECTURE.md#1-system-overview).

**WASM**
WASM (WebAssembly) is the compact, sandboxed binary format that Soroban contracts compile down to before deployment. Writing a contract in Rust and compiling it to WASM is what lets the Soroban host run contracts from many different developers safely, in a predictable, resource-metered way.

**Soroban RPC**
Soroban RPC is the network endpoint frontends and tools use to simulate and submit smart contract calls, distinct from Horizon (which serves classic Stellar data). Accord's frontend talks to Soroban RPC, via the Stellar JS SDK, to read proposals and submit approve/execute transactions.
See also: [Architecture §1](./ARCHITECTURE.md#1-system-overview).

**SCVal**
An SCVal ("Soroban Contract Value") is the strongly-typed internal value format Soroban uses to represent every contract parameter and return value — numbers, addresses, strings, structs, and so on. Frontend code never builds SCVals by hand; helpers like `nativeToScVal` (below) convert ordinary JavaScript values for you.

**XDR**
XDR (External Data Representation) is the binary serialization format Stellar and Soroban use to encode transactions, ledger entries, and contract values for transmission over the network. You'll run into XDR when inspecting raw transaction data or debugging a failed simulation, since errors are often returned as XDR-encoded structures that tooling then decodes into something readable.

**TTL (time to live)**
TTL is the number of ledgers remaining before a piece of contract storage is automatically archived and becomes inaccessible until restored. Both instance storage and persistent storage carry their own TTL, and a contract must periodically extend ("bump") it to keep long-lived data like proposals and owner lists from expiring.
See also: [Architecture §3 — Storage Layout](./ARCHITECTURE.md#3-storage-layout-soroban).

**Instance storage**
Instance storage is a Soroban storage tier tied to the contract instance itself — cheap and well-suited to small, frequently-read values, but with a shorter default TTL than persistent storage. Accord Protocol keeps its initialization guard, approval threshold, next proposal ID counter, and active proposal count here.
See also: [Architecture §3](./ARCHITECTURE.md#3-storage-layout-soroban).

**Persistent storage**
Persistent storage is a Soroban storage tier meant for data that needs to survive long-term, with a longer default TTL than instance storage at a higher storage cost. Accord Protocol stores its owner list and every individual proposal (plus each owner's per-proposal approval flag) here.
See also: [Architecture §3](./ARCHITECTURE.md#3-storage-layout-soroban).

**TTL bump**
A TTL bump is the act of extending a storage entry's remaining time-to-live so it doesn't expire and get archived. Accord's coding standards call for bumping TTLs on every storage read, which is why the contract's read paths call `bump_instance` / `bump_persistent` throughout.
See also: [CONTRIBUTING.md — Coding Standards](./CONTRIBUTING.md#coding-standards).

**simulateTransaction**
`simulateTransaction` is a Soroban RPC method that runs a contract call against current ledger state without submitting it on-chain, returning the result (and the resources it would consume) instantly and for free. Accord's frontend uses it for read-only calls like fetching a proposal, and as a dry run before sending a real, signed transaction.
See also: [Architecture §1](./ARCHITECTURE.md#1-system-overview).

**nativeToScVal**
`nativeToScVal` is a Stellar JS SDK helper that converts an ordinary JavaScript value (a string, number, address, and so on) into the SCVal format a Soroban contract call requires. Frontend code calls it when building arguments for functions like `create_proposal` or `approve` before sending them to Soroban RPC.

---

## Accord Protocol Terms

**Multisig**
Multisig (multi-signature) describes a contract or account that requires approval from more than one party before an action takes effect, rather than trusting a single key. Accord Protocol is a multisig contract: no single owner can move funds alone — a proposal must collect enough approvals first.

**M-of-N threshold**
An M-of-N threshold means M approvals are required out of a fixed set of N owners before a proposal can execute — for example, "2-of-3" means any 2 of the 3 owners must approve. Accord Protocol stores this threshold as a single number set during initialization, and a proposal only becomes executable once its approval count reaches it.
See also: [Architecture §3](./ARCHITECTURE.md#3-storage-layout-soroban).

**Proposal**
A proposal is a single proposed action — such as a token transfer — that one owner creates and the others must approve before it can run. Every proposal has an ID, a proposer, a description, a deadline, and a status that tracks where it is in its lifecycle.
See also: [Architecture §4 — Proposal Lifecycle](./ARCHITECTURE.md#4-proposal-lifecycle).

**ProposalStatus**
ProposalStatus is a proposal's current lifecycle state. The contract defines five values: `Pending` (created, not yet enough approvals), `Ready` (enough approvals, awaiting execution), `Executed` (successfully run), `Expired` (deadline passed before execution), and `Revoked` (a terminal "cancelled" state defined in the contract's types, though no function currently sets a proposal to it — calling `revoke()` only withdraws one approver's vote, which can drop a `Ready` proposal back to `Pending`, rather than cancelling it outright).
See also: [Architecture §4](./ARCHITECTURE.md#4-proposal-lifecycle).

**Owner**
An owner is one of the addresses authorized to propose, approve, revoke, and execute on the contract. The initial owner set is established when the contract is initialized, and every action — including casting an approval — checks that the caller is a current owner before proceeding.

**Proposer**
The proposer is the owner who originates a specific proposal. Their address is recorded on the proposal and emitted in its creation event, but a proposer does not automatically count as having approved their own proposal — they still need to approve separately, like any other owner.

**Approver**
An approver is an owner who has cast an approval vote on a specific proposal. The contract tracks each owner's approval per-proposal as an individual flag, which is what lets an owner later withdraw just their own vote without affecting anyone else's.

**Active proposal count**
The active proposal count is a running tally of proposals that haven't yet reached a terminal state, kept as a budget guard against unbounded growth. Creating a new proposal checks this count against a fixed limit and fails if the limit has been reached.
See also: [Architecture §3](./ARCHITECTURE.md#3-storage-layout-soroban).

**Deadline**
A deadline is the Unix timestamp (seconds since epoch) after which a proposal can no longer be approved or executed, and is instead treated as `Expired`. A new proposal's deadline must be in the future and within a bounded window, and the contract checks it against the current ledger's timestamp rather than wall-clock time on any one machine.
See also: [Contract API — create_proposal](./CONTRACT_API.md#create_proposal).
