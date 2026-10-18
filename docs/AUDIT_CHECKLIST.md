# Audit Readiness Checklist

This checklist tracks everything that must be in place before Accord Protocol engages a third-party security auditor. It expands on the audit status note in [`docs/SECURITY.md`](./SECURITY.md), which states that the contract is unaudited and that a formal review is required before mainnet deployment.

**When to complete this:** Work through every item while preparing for audit engagement. All boxes should be checked—and verifiable—before sharing the codebase with an auditor or scheduling the review kickoff. Revisit the checklist after major contract, frontend, or infrastructure changes.

---

## Contract Readiness

- [ ] Every `pub fn` exported from [`contracts/accord/src/lib.rs`](../contracts/accord/src/lib.rs) has at least one corresponding test in [`contracts/accord/src/test.rs`](../contracts/accord/src/test.rs) (run `cd contracts/accord && cargo test` and confirm all tests pass).
- [ ] Every `ContractError` variant used in the contract is documented with its numeric code in the **Error Codes** table in [`docs/CONTRACT_API.md`](./CONTRACT_API.md).
- [ ] `cargo clippy -- -D warnings` completes with zero warnings when run from `contracts/accord/` (see [`docs/CONTRIBUTING.md`](./CONTRIBUTING.md)).
- [ ] `stellar contract build` succeeds and produces `target/wasm32v1-none/release/accord.wasm`; the WASM binary size is within the limit enforced by the CI size gate in [`.github/workflows/contract.yml`](../.github/workflows/contract.yml).
- [ ] [`docs/SECURITY.md`](./SECURITY.md) documents the threat model: **In-Scope**, **Out-of-Scope**, **Known Limitations**, and **Explicit Trust Assumptions** sections are complete and reflect the current contract behaviour.

---

## Documentation Readiness

- [ ] [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) contains a system overview diagram and a storage model (instance vs persistent keys, proposal struct fields) that matches [`contracts/accord/src/lib.rs`](../contracts/accord/src/lib.rs).
- [ ] [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) documents testnet deployment (build, deploy, initialize, fund treasury, wire frontend) and mainnet deployment steps, including the contract upgrade procedure via `upgrade()` where applicable.
- [ ] [`docs/SECURITY.md`](./SECURITY.md) **Known Limitations** section lists all material on-chain risks (e.g. stolen owner keys, proposal-cap griefing, token re-validation gaps) with no stale or missing entries.
- [ ] [`docs/SECURITY.md`](./SECURITY.md) **Explicit Trust Assumptions** section documents assumptions about owner key secrecy, RPC accuracy, and token contract behaviour.
- [ ] [`docs/SECURITY.md`](./SECURITY.md) **Responsible Disclosure** section publishes the reporting channel (GitHub private advisory), acknowledgement target (72 hours), and fix timeline for Critical/High issues (14 days).

---

## Frontend & Integration Readiness

- [ ] A search of `frontend/src/` finds no hardcoded private keys, seed phrases, or signing secrets (only public addresses and `import.meta.env` references are acceptable).
- [ ] `frontend/.env.local` is excluded from version control via the `*.local` entry in [`frontend/.gitignore`](../frontend/.gitignore) (and `.env` is listed in the root [`.gitignore`](../.gitignore)).
- [ ] Every `ContractError` code documented in [`docs/CONTRACT_API.md`](./CONTRACT_API.md) has a human-readable message in [`frontend/src/lib/soroban.ts`](../frontend/src/lib/soroban.ts) (`CONTRACT_ERRORS` map) and is surfaced in the UI through `contractErrorMessage()` (verified by `frontend/src/lib/__tests__/soroban.test.ts`).
- [ ] The frontend has been manually tested end-to-end against the deployed testnet contract ID configured in `frontend/.env.local` (`VITE_CONTRACT_ADDRESS`): create, approve, execute, and read-only views all behave correctly.

---

## Infra & Process Readiness

- [ ] GitHub Actions workflows under [`.github/workflows/`](../.github/workflows/) (e.g. `contract.yml`, `frontend-ci.yml`, `indexer-analytics.yml`) trigger on every pull request to `main`.
- [ ] The contract CI workflow runs `cargo test`, `cargo clippy -- -D warnings`, and `stellar contract build` and reports a green status on the latest `main` commit.
- [ ] The frontend CI workflow runs `npm run build` (and lint where configured) and reports a green status on the latest `main` commit.
- [ ] A WASM binary-size gate is enforced in [`.github/workflows/contract.yml`](../.github/workflows/contract.yml) and fails the build when `accord.wasm` exceeds the configured threshold.
- [ ] [`docs/SECURITY.md`](./SECURITY.md) **Responsible Disclosure** section is publicly visible and includes both the contact method and expected response timelines before audit kickoff.
