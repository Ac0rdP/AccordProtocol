# ADR-0007: Contract Bytecode Upgradeability and Schema Migration

- **Status**: accepted (backfilled and reconstructed record)
- **Date**: 2026-05-04 (initial upgrade mechanism in commit `94adbe3`), updated 2026-10-16 (storage schema versioning in commit `7cd944f`)
- **Type**: Upgrade & Lifecycle Management

## Context

Smart contracts holding treasury funds must be capable of upgrading their business logic to patch vulnerabilities, optimize gas, and support protocol additions. However, upgradeability introduces central points of failure and risks storage layout incompatibility between deployed state and new WASM bytecode.

## Decision

1. **Host-Level WASM Replacement**:
   - The contract implements an `upgrade(new_wasm_hash)` entrypoint using Soroban's native host function `env.deployer().update_current_contract_wasm(new_wasm_hash)`.
   - The call is guarded by `require_weighted_approvers`, requiring multi-owner threshold co-signatures.
2. **Storage Schema Versioning**:
   - The contract maintains an explicit schema version in instance storage under the `STOVER` key (`STORAGE_SCHEMA_VERSION`), exposed via the `get_storage_version` view.
   - Any release modifying the storage layout increments this version.
3. **One-Time Explicit Migrations**:
   - Upgrades that restructure stored data provide explicit, idempotent migration functions (e.g. `migrate_to_weighted_governance`, `migrate_to_rbac`).
   - Each migration checks that it has not already been executed, transitions storage to the target schema, and stamps `STOVER`.

## Consequences

### Positive
- Contract preserves its deployed address (`C...`) and state while updating executable code.
- Multi-owner threshold authorization prevents unilateral or malicious code injection.
- Explicit schema versioning and migration entrypoints allow operators to verify compatibility and state health before resuming normal traffic.

### Negative / Trade-offs
- Upgrades must be strictly validated before deployment; an incompatible storage read in new code could trap and freeze state.
- Operators must execute migrations immediately following code replacement.

### Neutral
- Standard upgrade verification steps and checklist are documented in `docs/UPGRADE_SAFETY.md`.

## Alternatives Considered

- *Rationale not recorded; reconstructed from code and documentation.*

## Links & Evidence

- Source: `contracts/accord/src/lib.rs` (`upgrade`, `STORAGE_SCHEMA_VERSION`, `STOVER`, `migrate_to_weighted_governance`, `migrate_to_rbac`)
- Documentation: `docs/UPGRADE_SAFETY.md`, `docs/ARCHITECTURE.md` §3 (Storage Schema Versioning)
- Commits: `94adbe3` (2026-05-04), `7cd944f` (2026-10-16)
