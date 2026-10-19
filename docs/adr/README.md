# Architecture Decision Records (ADRs)

This directory contains the Architecture Decision Records (ADRs) for the Accord Protocol.

An Architecture Decision Record captures an important architectural decision made along with its context, consequences, and alternatives considered.

## Format

Each record follows the structure defined in [template.md](./template.md):
- **Title**: Descriptive name prefixed by a four-digit sequential ID (e.g. `ADR-0001: Soroban Smart Contract Platform and Rust SDK`).
- **Status**: The current state of the decision (see [Statuses](#statuses)).
- **Date**: The date the decision was approved, or the commit date for backfilled records.
- **Context**: The architectural problem, forces, and requirements that necessitated a decision.
- **Decision**: The chosen technical approach and design.
- **Consequences**: The positive, negative, and neutral trade-offs resulting from the decision.
- **Alternatives Considered**: Other options evaluated and why they were not chosen (or marked as not recorded if backfilled).
- **Evidence / Links**: Pointers to source code, documentation, PRs, or commits supporting the record.

## Statuses

A decision record has one of the following statuses:
- **`proposed`**: The decision is submitted for review and under discussion.
- **`accepted`**: The decision has been approved and implemented in the repository.
- **`superseded`**: A newer architecture decision has replaced this one. The record remains unmodified except for updating its status to `superseded by [ADR-XXXX](./XXXX-title.md)`.
- **`deprecated`**: The decision has been retired or is no longer relevant, without being directly replaced by another decision.

## Numbering and Supersession Rules

1. **Four-digit numbering**: Decisions are numbered sequentially with four digits (`0001`, `0002`, `0003`, ...).
2. **One file per decision**: Each decision lives in its own file named `XXXX-kebab-case-title.md`.
3. **Numbers are never reused**: Even if a proposal is rejected, deprecated, or superseded, its number is retired.
4. **Immutability and supersession**: An accepted record is not rewritten to reflect later architecture changes. Instead, a new ADR is written, accepted, and linked to the old one. The older record's status is updated to `superseded by [ADR-XXXX](./XXXX-new-title.md)` with a link to the new record, and the new record references the one it supersedes.

## When to Write an ADR

Write an ADR for decisions with cross-cutting or long-term consequences that would be costly or difficult to reverse:
- Changes to the contract's authorization model, governance rules, or operational roles
- Changes to the storage layout, key schemas, entry lifetime (TTL) strategy, or data types
- Changes to the contract upgrade mechanism or on-chain data migration approach
- Changes to public contract interfaces, events, or error handling conventions
- Adoption of a new platform, language, major runtime dependency, or development framework
- Broad architectural standards spanning multiple services (contract, indexer, frontend, analytics)

Do **not** write an ADR for:
- Routine bug fixes or minor patches
- Code refactoring that preserves existing public interfaces and data models
- Routine dependency version bumps within established major versions
- Minor UI styling, component tweaks, or presentational changes

## Index of Records

| Number | Title | Status | Date | Backfilled |
|---|---|---|---|---|
| [0001](./0001-soroban-platform-and-rust-sdk.md) | Soroban Smart Contract Platform and Rust SDK | Accepted | 2026-05-04 | Yes |
| [0002](./0002-storage-layout-and-ttl-strategy.md) | Storage Layout and Threshold-and-Bump TTL Strategy | Accepted | 2026-05-04 | Yes |
| [0003](./0003-proposal-lifecycle-and-threshold.md) | Proposal Lifecycle and Quorum Threshold Enforcement | Accepted | 2026-05-04 | Yes |
| [0004](./0004-owner-and-guardian-authorization.md) | Owner Multi-Signature and Guardian Pause Authorization | Accepted | 2026-09-26 | Yes |
| [0005](./0005-weighted-governance-model.md) | Stakeholder-Weighted Governance and Quorum Snapshots | Accepted | 2026-09-25 | Yes |
| [0006](./0006-role-based-access-control.md) | Operational Role-Based Access Control (RBAC) | Accepted | 2026-09-26 | Yes |
| [0007](./0007-contract-upgradeability-and-migration.md) | Contract Bytecode Upgradeability and Schema Migration | Accepted | 2026-05-04 | Yes |
| [0008](./0008-typed-errors-and-event-architecture.md) | Strongly-Typed Errors and Topic-Based Event Architecture | Accepted | 2026-05-04 | Yes |
| [0009](./0009-frontend-stack-and-wallet-integration.md) | Frontend Stack and Freighter Browser Wallet Integration | Accepted | 2026-05-04 | Yes |
| [0010](./0010-testing-strategy-and-quality-gates.md) | Multi-Tier Testing, Coverage Gates, and Metered Benchmark Baselines | Accepted | 2026-10-16 | Yes |
