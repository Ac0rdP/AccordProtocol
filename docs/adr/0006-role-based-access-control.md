# ADR-0006: Operational Role-Based Access Control (RBAC)

- **Status**: accepted (backfilled and reconstructed record)
- **Date**: 2026-09-26 (commits `644ca97`, `fb47efb`, PR #721)
- **Type**: Operational Security

## Context

Requiring multisig owners to draft proposals, cast votes, and trigger routine executions directly from their primary cold-storage signing keys creates high friction and operational security risk. Teams need the ability to delegate proposal creation to junior contributors and execution triggers to automated keeper bots without giving them custody or voting power.

## Decision

1. **Role Model**:
   - Four operational roles defined in the `Role` enum:
     - `Proposer`: Can create proposals via `create_*_proposal` entrypoints.
     - `Approver`: Can vote on proposals via `approve` and `revoke`.
     - `Executor`: Can trigger `execute` on `Ready` proposals and call `cancel_expired`.
     - `Viewer`: Informational / UI assignment with no mutating permissions.
2. **Ownership Anchor for Voting**:
   - Holding `Role::Approver` alone conveys zero voting power. `approve` and `revoke` strictly enforce **both** `require_role(..., Role::Approver)` and `require_owner_and_weight`.
3. **Unprivileged Execution Cranks**:
   - Non-owners holding `Role::Executor` act as permissionless cranks: they cannot modify proposal destinations, token amounts, or parameters. They can only execute proposals that have already achieved verified owner quorum and passed timelock delays.
4. **Governance Segregation**:
   - Role grants and revocations are governed via proposals (`GrantRole`, `RevokeRole`). Administrative recovery and contract upgrades completely bypass roles and require raw multi-owner threshold co-signatures.

## Consequences

### Positive
- Separation of duties: automated keepers can execute ready transfers without holding treasury keys.
- Reduced blast radius: operational drafters cannot approve proposals, and approvers can keep keys offline until voting is needed.
- Backward compatible: `initialize` and `migrate_to_rbac` grant `DEFAULT_OWNER_ROLES` (`Proposer`, `Approver`, `Executor`) to all owners by default.

### Negative / Trade-offs
- Revoking `Approver` roles must be done carefully to avoid stranding quorum if active approver weight drops below threshold.

### Neutral
- Reverse index `role_members_key(role)` is maintained in persistent storage to enable O(1) membership queries.

## Alternatives Considered

- *Rationale not recorded; reconstructed from code and documentation.*

## Links & Evidence

- Source: `contracts/accord/src/lib.rs` (`Role`, `require_role`, `migrate_to_rbac`, `create_grant_role_proposal`, `create_revoke_role_proposal`)
- Documentation: `docs/ARCHITECTURE.md` (RBAC & Access Control), `docs/SECURITY.md` (RBAC Threat Model Addendum)
- Commits: `644ca97` (2026-09-26), `fb47efb` (2026-09-26)
