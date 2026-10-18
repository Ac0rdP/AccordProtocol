# ADR-0008: Strongly-Typed Errors and Topic-Based Event Architecture

- **Status**: accepted (backfilled and reconstructed record)
- **Date**: 2026-05-04 (commit `94adbe3`), updated 2026-10-16 / 2026-10-17 (commits `0b018e8`, `e6938fc`)
- **Type**: Interface & Integration Architecture

## Context

Decentralized applications and off-chain indexing services require clear diagnostic visibility into transaction reverts and state changes. Un-typed panics create opaque host traps that cannot be reliably translated into UI feedback, and unstructured event logging complicates off-chain state replication.

## Decision

1. **Discrete Typed Errors**:
   - The contract defines an explicit `ContractError` enum annotated with `#[contracterror]`.
   - Every error variant maps to a distinct, unique `u32` code (e.g. `AlreadyInitialized = 1`, `Unauthorized = 3`, `ThresholdNotMet = 10`, `ProposalExpired = 11`, `TransferFailed = 22`).
   - Panics on user inputs are forbidden; fallible operations return `Result<T, ContractError>`.
2. **Topic-Based Event Architecture**:
   - Every state mutation publishes an event via `env.events().publish()` before returning.
   - Events use short symbol topics (`created`, `approved`, `revoked`, `executed`, `rpay`, etc.) and structured payload structs (e.g. `ProposalCreatedEvent`, `ProposalApprovedEvent`).
   - All events carry an explicit schema version field to support evolution and backfilling in the off-chain indexer.

## Consequences

### Positive
- Client applications can inspect reverted transaction XDR in Stellar Lab or Horizon and match numeric error codes directly to user-facing messages.
- The off-chain event indexer can reliably decode events using topic dispatch and replay ledger history idempotently.
- CI unit tests verify error uniqueness and coverage.

### Negative / Trade-offs
- Adding new error variants requires maintaining manual numeric assignment to avoid numbering collisions.

### Neutral
- Event topic symbols are constrained to ≤ 9 ASCII characters by Soroban's `Symbol` type.

## Alternatives Considered

- *Rationale not recorded; reconstructed from code and documentation.*

## Links & Evidence

- Source: `contracts/accord/src/lib.rs` (`ContractError`, `ProposalCreatedEvent`, `ProposalApprovedEvent`, `ProposalExecutedEvent`)
- Documentation: `docs/CONTRACT_API.md` (Error Reference, Event Payloads), `docs/EVENTS.md`, `docs/ARCHITECTURE.md` §7
- Commits: `94adbe3` (2026-05-04), `0b018e8` (2026-10-16), `e6938fc` (2026-10-17)
