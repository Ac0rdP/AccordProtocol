# External Security Audit Scope

This document specifies the target scope, objectives, environment specifications, and readiness requirements for an independent third-party security audit of Accord Protocol.

---

## 1. Audit Objectives

The primary objectives of the external security audit are:
1. **Multisig Governance & Quorum Invariants**: Verify that proposals can never be executed without reaching the configured quorum weight (`quorum_weight`), and that voting weights, delegations, and thresholds cannot be manipulated or bypassed.
2. **Fund Safety & Authorization**: Ensure that multisig treasury assets cannot be drained, locked, or transferred to unauthorized recipients through any combination of proposal creation, approval, or execution paths.
3. **Role-Based Access Control (RBAC)**: Verify that operational role gates (`Proposer`, `Approver`, `Executor`, `Viewer`) are strictly enforced and cannot be circumvented to perform unauthorized operations.
4. **State & Storage Integrity**: Verify that Soroban persistent and instance storage keys, time-to-live (TTL) extensions, and migration flags behave safely under all ledger execution conditions.
5. **Recurring Payments & Spending Limits**: Validate the accounting of recurring payment intervals, caps, cliffs, and spending window rollups against overflow, underflow, or griefing attacks.

---

## 2. In-Scope Components

### Source Code and Measured Size

The audit scope comprises the core smart contract source files within [`contracts/accord/src/`](../../contracts/accord/src/):

| File | Module / Purpose | Measured Lines of Code |
|---|---|---|
| [`contracts/accord/src/lib.rs`](../../contracts/accord/src/lib.rs) | Core multisig logic, RBAC, recurring payments, spending limits, events, storage layout | 4,870 |
| [`contracts/accord/src/validate.rs`](../../contracts/accord/src/validate.rs) | Input validation for proposals, deadlines, amounts, and recurring schedules | 60 |
| **Total In-Scope Code** | **Production Soroban Smart Contract** | **4,930 lines** |

> [!NOTE]
> Code size measured on non-test source files at commit `f6d1e1b`. Test suites (`test.rs`) and benchmarks (`bench.rs`) are excluded from production WASM builds.

### Features & Entrypoints in Scope

1. **Multisig Governance**:
   - `initialize(owners, threshold)`
   - `create_proposal(...)`, `approve(...)`, `revoke(...)`, `execute(...)`
   - `create_add_owner_proposal(...)`, `create_remove_owner_proposal(...)`
   - `create_change_threshold_proposal(...)`, `create_change_owner_weight_proposal(...)`
   - `set_max_single_owner_weight_pct(...)`
   - Contract code upgrades: `upgrade(caller, new_wasm_hash)`
2. **Role-Based Access Control (RBAC)**:
   - `migrate_to_rbac(approvers)`
   - `create_grant_role_proposal(...)`, `create_revoke_role_proposal(...)`
   - Role queries: `get_roles(...)`, `has_role(...)`, `get_role_members(...)`, `get_role_version()`
3. **Delegation Logic**:
   - Delegation queries and effective weight calculations: `get_delegations(...)`, `get_active_delegations()`, `get_effective_weight(...)`
   - Internal helper: `compute_effective_weight(...)`
   - Automatic delegation revocation upon owner removal in `execute(RemoveOwner)`
   - *(Note: No public entrypoint currently writes delegations; `write_delegation` is an internal helper tested in unit tests.)*
4. **Recurring Payments**:
   - `create_recurring_proposal(...)`, `create_cancel_recurring_proposal(...)`
   - `create_pause_recurring_proposal(...)`, `create_resume_recurring_proposal(...)`, `create_modify_recurring_proposal(...)`
   - `disburse_recurring(...)`, `get_claimable_amount(...)`, `get_recurring_payment(...)`
5. **Spending Limits & Windows**:
   - `create_spending_limit_proposal(...)`, `create_spending_limit_window_proposal(...)`
   - Spending queries: `get_spending_limit(...)`, `get_owner_spending_limits(...)`, `get_remaining_spending_limit(...)`, `get_spending_window(...)`
6. **Emergency Controls**:
   - `set_guardian(...)`, `freeze(...)`, `unfreeze(...)`
   - Recovery mode transitions: `enter_recovery(...)`, `exit_recovery(...)`
7. **Event Logging & Schema Versioning**:
   - Constant `EVENT_SCHEMA_VERSION = 1`
   - All 22 contract event structures emitted across governance and operational lifecycles.

### Build and Toolchain Environment

- **Language / Edition**: Rust (2021 edition)
- **Soroban SDK Version**: `soroban-sdk = "=25.3.1"`
- **Target**: `wasm32v1-none`
- **Build Tool**: Stellar CLI (`stellar contract build`)

---

## 3. Explicitly Out of Scope

The following components are excluded from this audit engagement:
- **Test Harnesses & Benchmarks**: [`contracts/accord/src/test.rs`](../../contracts/accord/src/test.rs) and [`contracts/accord/src/bench.rs`](../../contracts/accord/src/bench.rs) (used for verification; not included in production bytecode).
- **Frontend Client Application**: [`frontend/`](../../frontend/) (off-chain user interface).
- **Off-Chain Indexer & Analytics API**: [`indexer/`](../../indexer/) and [`analytics-api/`](../../analytics-api/) (downstream consumer of emitted events; read-only service).
- **Upstream Toolchain & Wallet Extensions**: The Soroban runtime environment, Stellar network consensus validators, and the Freighter wallet extension.

---

## 4. Audit-Readiness Checklist

Prior to commencement of auditor fieldwork, maintainers must verify:

- [ ] **Code Freeze**: Target commit tagged with a dedicated audit tag (e.g., `audit-v1.0.0-rc1`) with no functional modifications permitted during the review.
- [ ] **Passing Test Suites**: All contract unit tests, property tests, and adversarial test scenarios pass cleanly (`cargo test`).
- [ ] **WASM Size Budget**: WASM binary size verified within limits via [`scripts/check-wasm-size.sh`](../../scripts/check-wasm-size.sh).
- [ ] **Current Documentation**: [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md), [`docs/CONTRACT_API.md`](../CONTRACT_API.md), and [`docs/SECURITY.md`](../SECURITY.md) reflect current code.
- [ ] **Documented Invariants & Known Risks**: Audit prep pack dependencies (referenced in plain text as `docs/AUDIT_PREP.md`, maintained in governance planning) and known risks in `docs/SECURITY.md` provided to auditors.
- [ ] **Designated Point of Contact**: A named contributor acting in the **Security Lead** role available for real-time auditor inquiries.

---

## 5. Auditor Deliverables & Success Criteria

The audit engagement will be considered complete when:
1. **Audit Report**: The auditing firm delivers a formal, signed security audit report detailing all findings, methodology, and severity classifications.
2. **Issue Remediation**: Every **Critical** and **High** severity finding is either:
   - Remediated via a verified patch reviewed and signed off by the auditing firm; or
   - Formally accepted with documented risk rationale in [`docs/audit/REMEDIATION.md`](./REMEDIATION.md).
3. **Re-Test Verification**: The auditing firm verifies and confirms all remediations in an updated final report.
4. **Public Disclosure**: A public summary or full report is published in coordination with the project release.

---

## Related Documents
- [Auditor Selection & RFQ Template](./AUDITOR_SELECTION.md)
- [Audit Remediation & Tracking Process](./REMEDIATION.md)
- [Coordinated Disclosure Policy](../../SECURITY.md)
