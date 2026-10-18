# ADR-0010: Multi-Tier Testing, Coverage Gates, and Metered Benchmark Baselines

- **Status**: accepted (backfilled and reconstructed record)
- **Date**: 2026-10-16 / 2026-10-17 (commits `ada62ee`, `1b2ef7f`)
- **Type**: Quality Engineering & CI

## Context

Financial smart contracts require rigorous quality assurance to guard against fund drains, privilege escalations, edge cases, and unexpected gas/CPU consumption surges. Relying solely on happy-path unit tests is insufficient for smart contract and frontend security.

## Decision

1. **Multi-Tier Contract Testing**:
   - **Deterministic Unit Testing**: Tests in `contracts/accord/src/test.rs` utilizing Soroban's native test environment (`env.mock_all_auths()`, `env.mock_auths()`).
   - **Property-Based Testing**: Uses `proptest` to test invariant assertions across thousands of randomized owner weights, thresholds, and execution configurations.
   - **Adversarial Mocks**: Dedicated mock tokens (`AdversarialToken`, `FalseReturnToken`) asserting reentrancy resistance and non-unit transfer failure handling.
2. **Coverage Gate**:
   - CI runs `cargo-llvm-cov` to measure line coverage of contract source code (excluding test and bench modules).
   - Enforces a minimum line coverage threshold defined in `contracts/accord/Cargo.toml` (`min-line-coverage = 85`), failing CI if coverage drops.
3. **Metered Resource Benchmark Gate**:
   - Runs `bench_hot_entrypoints` (`contracts/accord/src/bench.rs`) to meter CPU instructions, memory, and ledger write entries for hot paths against `contracts/accord/bench-baseline.txt`.
   - CI gate fails if any metered metric increases by more than 5% without an intentional baseline update and documented justification.
4. **Frontend Testing & Performance Budgets**:
   - Vitest for unit tests, accessibility (`axe-core`, `vitest-axe`), and visual snapshot regressions.
   - Playwright for end-to-end user flows.
   - Automated bundle and load-performance budgets gating pull requests.

## Consequences

### Positive
- Strict regression prevention for CPU instructions, ledger writes, and code coverage.
- Continuous verification of mathematical and state invariants through property tests.
- High developer confidence during contract refactors and dependency upgrades.

### Negative / Trade-offs
- Adding contract features requires updating coverage tests and potentially re-recording benchmark baselines.
- Running the full testing and coverage pipeline in CI takes several minutes.

### Neutral
- Coverage and benchmark deltas are automatically reported in GitHub Actions step summaries.

## Alternatives Considered

- *Rationale not recorded; reconstructed from code and documentation.*

## Links & Evidence

- Source: `contracts/accord/src/test.rs`, `contracts/accord/src/bench.rs`, `contracts/accord/bench-baseline.txt`
- CI configuration: `.github/workflows/contract.yml`, `.github/workflows/frontend-ci.yml`
- Documentation: `CONTRIBUTING.md` §9 (Testing and quality gates), `docs/ARCHITECTURE.md` §12
- Commits: `ada62ee` (2026-10-16), `1b2ef7f` (2026-10-17)
