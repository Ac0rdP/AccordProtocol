# ADR-0002: Storage Layout and Threshold-and-Bump TTL Strategy

- **Status**: accepted (backfilled and reconstructed record)
- **Date**: 2026-05-04 (initial layout in commit `94adbe3`), updated 2026-10-16 (schema versioning in commit `7cd944f`)
- **Type**: State Architecture

## Context

Soroban state rent billing (CAP-0046-08) requires contracts to manage ledger entry lifetimes (TTLs). Ledger entries that expire without being bumped are permanently deleted by the network. Storing all state in a single entry creates contention and high write amplification, while using persistent entries for everything increases rent costs.

## Decision

1. **Instance vs. Persistent Separation**:
   - **Instance Storage**: Shared single `LedgerEntry` used for contract singleton metadata (`INIT`, `THRESH`, `NEXT`, `ACTCNT`, `TWGT`, `TLOCK`, `STOVER`).
   - **Persistent Storage**: Independent ledger entries used for dynamic collections and records (`OWNERS` map, `("PROP", id)` proposal records, `("APPR", id, owner)` approval records, and RBAC sets).
2. **Key Naming**:
   - Short uppercase singleton symbols (≤ 9 bytes) for zero-copy XDR storage.
   - Distinct tuple keys (e.g. `("PROP", id)`, `("APPR", id, owner)`) rather than concatenated strings to avoid heap allocations and string prefix collisions.
3. **Threshold-and-Bump Strategy**:
   - Both instance and persistent entries use a threshold of 17,280 ledgers (≈ 1 day) and a bump of 518,400 ledgers (≈ 30 days).
   - Extensions occur on access (`extend_ttl`). If remaining TTL exceeds the threshold, extension is a no-op, preventing rent charges on every transaction.

## Consequences

### Positive
- Predictable and bounded rent costs; frequently accessed entries are renewed without unnecessary writes.
- Proposal records are isolated, allowing concurrent voting on different proposals without write conflicts on a single shared proposal collection.
- Tuple keys provide collision-free, type-safe lookup.

### Negative / Trade-offs
- Dormant proposals or contracts that receive no on-chain interactions for 30 consecutive days risk entry deletion.
- Operators must ensure periodic access for active multisigs.

### Neutral
- Rent fees round up to 1 KB increments in Soroban billing.

## Alternatives Considered

- *Rationale not recorded; reconstructed from code and documentation.*

## Links & Evidence

- Source: `contracts/accord/src/lib.rs` (`INSTANCE_BUMP`, `INSTANCE_THRESHOLD`, `PERSISTENT_BUMP`, `PERSISTENT_THRESHOLD`)
- Documentation: `docs/ARCHITECTURE.md` §3 (Storage Layout, Storage Cost Methodology, TTL Bump Rationale)
- Commits: `94adbe3` (2026-05-04), `7cd944f` (2026-10-16)
