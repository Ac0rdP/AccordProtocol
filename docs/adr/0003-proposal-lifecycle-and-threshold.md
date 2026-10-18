# ADR-0003: Proposal Lifecycle and Quorum Threshold Enforcement

- **Status**: accepted (backfilled and reconstructed record)
- **Date**: 2026-05-04 (commit `94adbe3`)
- **Type**: Core Governance Workflow

## Context

Multi-signature treasury management requires an explicit, deterministic state machine governing proposal creation, voting, threshold validation, execution, and expiration.

## Decision

1. **Lifecycle States**:
   - Proposals follow an explicit status machine: `Pending` -> `Ready` -> `Executed` (or `Expired` / `Revoked`).
   - A proposal transitions to `Ready` when accumulated approval weight meets or exceeds the required quorum weight (`approvals >= quorum_weight`) before the deadline.
2. **Snapshot Quorum**:
   - The required quorum is snapshotted at creation time (`quorum_weight`) from the active contract threshold so subsequent threshold changes do not retroactively invalidate in-flight proposals.
3. **Revocation**:
   - An owner may call `revoke()` at any time while the proposal is `Pending` or `Ready` prior to execution. Revoking subtracts the credited weight and transitions `Ready` back to `Pending` if approvals fall below quorum.
4. **Execution Guarantees**:
   - `execute()` re-verifies `derive_status == Ready`, enforces any configured time-lock delay (`timelock_key`), performs pre-transfer token balance checks, and marks the proposal `Executed` atomically upon successful transfers.

## Consequences

### Positive
- Transparent, verifiable state transitions readable by off-chain clients.
- Prevents race conditions by allowing owners to withdraw votes before execution.
- Enforces deadlines so stale proposals cannot be executed indefinitely.

### Negative / Trade-offs
- Time-locks delay transaction finality for urgent disbursements.
- An owner must explicitly propose and vote; automated execution cranks must wait for full quorum.

### Neutral
- Active proposals are bounded by `MAX_ACTIVE_PROPOSALS` (`ACTCNT` ≤ 50) to prevent storage exhaustion.

## Alternatives Considered

- *Rationale not recorded; reconstructed from code and documentation.*

## Links & Evidence

- Source: `contracts/accord/src/lib.rs` (`create_proposal`, `approve`, `revoke`, `execute`, `derive_status`)
- Documentation: `docs/ARCHITECTURE.md` §4 (Proposal Lifecycle), §5 (Approve & Execute Flows)
- Commit: `94adbe3` (2026-05-04)
