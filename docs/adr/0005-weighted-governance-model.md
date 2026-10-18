# ADR-0005: Stakeholder-Weighted Governance and Quorum Snapshots

- **Status**: accepted (backfilled and reconstructed record)
- **Date**: 2026-09-25 / 2026-10-16 (commits `2203f6b`, `bf2ba90`)
- **Type**: Governance Model Evolution

## Context

The initial Accord contract implemented a flat M-of-N voting model where each owner held an identical single vote. Real-world treasuries and DAOs frequently require proportional representation where voting power corresponds to capital contribution, token stake, or governance mandate.

## Decision

1. **Owner Weight Data Structure**:
   - The owner set is stored in persistent storage as a `Map<Address, u32>` under the `OWNERS` key, mapping each registered owner to a discrete voting weight (`MIN_OWNER_WEIGHT = 1` to `MAX_OWNER_WEIGHT = 100_000`).
   - The sum of all active owner weights is cached in instance storage under the `TWGT` key.
2. **Total Weight Invariant**:
   - The contract enforces the invariant `sum(get_owner_weights()) == get_total_weight()`.
   - Governance proposals that would reduce total weight below the required threshold or make in-flight proposals un-quorumable are rejected (`WouldBreakThreshold`, `WouldBreakQuorum`).
3. **Single-Owner Weight Cap**:
   - `ChangeOwnerWeight` proposals enforce that no single owner may hold more than `MAX_SINGLE_OWNER_WEIGHT_PCT` (50% by default) of the resulting total weight, checked at both proposal creation and execution time.
4. **Backward Compatibility**:
   - Setting all weights to `1` and threshold to `M` exactly replicates flat M-of-N behavior. Existing deployments can migrate via `migrate_to_weighted_governance`.

## Consequences

### Positive
- Allows flexible governance structures (unequal equity, core team vs. advisors) without deploying separate contracts.
- The 50% single-owner cap prevents unilateral governance capture through incremental weight changes.
- Invariant enforcement ensures the treasury cannot become permanently stranded due to weight misconfigurations.

### Negative / Trade-offs
- Increased complexity in threshold validation and accounting.
- Initialization weights must be reviewed carefully as the 50% cap is enforced on weight change proposals, not on initial setup.

### Neutral
- Storage rent is essentially unchanged because map encoding in Soroban fits within the 1 KB billing increment.

## Alternatives Considered

- *Rationale not recorded; reconstructed from code and documentation.*

## Links & Evidence

- Source: `contracts/accord/src/lib.rs` (`OWNERS`, `TWGT`, `ChangeOwnerWeight`, `migrate_to_weighted_governance`, `MAX_SINGLE_OWNER_WEIGHT_PCT`)
- Documentation: `docs/ARCHITECTURE.md` (Weighted Governance Model)
- Tests: `contracts/accord/src/test.rs` (`test_assert_owner_weight_sum_matches_stored_total_weight`)
- Commits: `2203f6b` (2026-09-25), `bf2ba90` (2026-10-16)
