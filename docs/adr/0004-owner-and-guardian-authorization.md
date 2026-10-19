# ADR-0004: Owner Multi-Signature and Guardian Pause Authorization

- **Status**: accepted (backfilled and reconstructed record)
- **Date**: 2026-09-26 (commit `b0e9c9a` / PR #723)
- **Type**: Security & Access Control

## Context

Treasury contracts require mechanisms to respond to active security incidents (such as key compromise or hostile token behavior) without granting any single party unilateral authority to drain funds or alter contract rules.

## Decision

1. **Multi-Owner Threshold Co-Signing**:
   - Administrative and security actions (`set_guardian`, `unfreeze`, `upgrade`, `migrate_to_weighted_governance`, `migrate_to_rbac`) cannot be executed by single callers or through standard single-owner calls.
   - They strictly enforce `require_weighted_approvers`, requiring a list of distinct registered owners whose summed voting weight satisfies the active `threshold`.
2. **Guardian Emergency Pause**:
   - A single guardian address can be designated via `set_guardian`.
   - The registered guardian has unilateral permission to invoke `freeze()`, which immediately pauses proposal creation and execution contract-wide.
   - The guardian has no authority to disburse funds, alter ownership, change threshold, or resume operations.
   - Resuming normal operation requires calling `unfreeze()`, which requires full multi-owner threshold co-signatures.

## Consequences

### Positive
- Rapid incident response: a guardian key or automated monitoring agent can halt fund movements immediately upon anomaly detection.
- Strong containment: a compromised guardian key can cause a denial of service by pausing, but cannot steal funds or alter governance state.
- Single keys cannot resume or alter the contract; recovery requires threshold consensus among distinct owners.

### Negative / Trade-offs
- A compromised or misbehaving guardian key can grief operations by pausing the contract until owners coordinate to unfreeze and rotate the guardian.

### Neutral
- Guardian registration is optional; contracts operate with standard multisig governance if no guardian is configured.

## Alternatives Considered

- *Rationale not recorded; reconstructed from code and documentation.*

## Links & Evidence

- Source: `contracts/accord/src/lib.rs` (`set_guardian`, `freeze`, `unfreeze`, `require_weighted_approvers`)
- Documentation: `docs/SECURITY.md` (Mitigations — Guardian Emergency Pause), `docs/ARCHITECTURE.md` §12
- Commit: `b0e9c9a` (2026-09-26, PR #723)
