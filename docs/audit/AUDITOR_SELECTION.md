# Security Auditor Selection & RFQ Template

This document establishes the evaluation criteria for selecting an independent third-party security auditing firm, provides a standardized Request-for-Quote (RFQ) template, and lists prospective audit candidates.

> [!IMPORTANT]
> **Maintainer Responsibility**: Requesting quotes, evaluating proposals, negotiating terms, selecting an auditor, and committing budget are decisions reserved exclusively for repository maintainers. No quote requests may be initiated from an open branch.

---

## 1. Selection Criteria

Prospective security audit firms will be evaluated against the following criteria:

| Criterion | Evaluation Standard |
|---|---|
| **Ecosystem & Language Expertise** | Demonstrated experience auditing Soroban smart contracts on Stellar, Substrate/Polkadot, or Rust-based WASM runtimes. Familiarity with Soroban SDK storage models, host metering, and TTL semantics. |
| **Published Track Record** | Verifiable public audit reports for production smart contract protocols, showing depth in business logic and invariant testing. |
| **Audit Methodology** | Multi-faceted approach combining manual line-by-line code review, static analysis, formal property/invariant verification, and fuzz testing. |
| **Remediation & Retest Policy** | Contract includes at least one round of re-testing to review and verify fixes within the baseline engagement scope. |
| **Confidentiality & Reporting** | Strict NDA and secure private disclosure processes for vulnerability reporting prior to public disclosure. |
| **Schedule & Availability** | Ability to commence review and deliver preliminary findings within the project's release timeline. |
| **Pricing Structure** | Transparent fixed-price or bounded milestone pricing covering the complete scope and re-test. |

---

## 2. Request for Quote (RFQ) Template

Maintainers may use the following standardized template when soliciting proposals from prospective audit firms. It contains only public repository information.

```markdown
# Request for Quote: Accord Protocol Smart Contract Security Audit

## 1. Project Overview
Accord Protocol is a multi-signature smart contract deployed on the Stellar network using Soroban. It provides role-based access control (RBAC), weighted governance, recurring disbursements, and per-owner spending limits.

- Repository: https://github.com/Ac0rdP/AccordProtocol
- Target Commit / Code Freeze: [Insert Tag or Commit SHA]
- Documentation: https://github.com/Ac0rdP/AccordProtocol/tree/main/docs

## 2. Scope of Review
- Primary Module: `contracts/accord/src/lib.rs` (Multisig, RBAC, recurring payments, storage)
- Validation Module: `contracts/accord/src/validate.rs` (Input and schedule validation)
- Total In-Scope Code: Approximately 4,930 non-test lines of Rust code
- Toolchain: Rust 2021 Edition, `soroban-sdk` = "=25.3.1", target `wasm32v1-none`
- Detailed Scope Document: `docs/audit/SCOPE.md`

## 3. Key Invariants & Areas of Concern
- Authorization and role separation (Proposer, Approver, Executor, Viewer).
- Quorum weight snapshotted at creation versus dynamic owner additions/removals.
- Reentrancy and token interaction safety when calling external Soroban token contracts.
- Accurate interval and cap accounting in recurring disbursements.
- Storage TTL extension safety and schema version migration integrity.

## 4. Expected Deliverables
1. Interim audit report detailing all discovered issues classified by severity.
2. Direct collaboration with maintainers during the remediation window.
3. Final audit report verifying all applied fixes and documenting any accepted risks.
4. Permission to publish the final report (or public summary) upon mainnet release.

## 5. Timeline & Proposal Submission
- Desired Start Date: [Insert Desired Date]
- Fieldwork Duration Target: 2–3 weeks
- Please provide estimated pricing, team availability, and lead auditor bios to:
  [Insert Maintainer Security Contact]
```

---

## 3. Candidate Auditor Directory

The following firms have published audit reports in the Stellar/Soroban ecosystem or are recognized for smart contract security reviews.

> [!NOTE]
> **Status:** All entries are listed as **candidate, not vetted or endorsed**. Listing here does not imply an existing commercial relationship, endorsement, guaranteed pricing, or confirmed availability.

| Auditor Firm | Primary Specialization | Public Reference / Source | Date Retrieved | Notes |
|---|---|---|---|---|
| **CertiK** | Smart contract audits, formal verification, Rust/WASM | [CertiK Official Site](https://www.certik.com/) | 2026-10-18 | Candidate, not vetted or endorsed |
| **OtterSec** | Rust, Solana, Aptos, Soroban smart contract audits | [OtterSec Official Site](https://osec.io/) | 2026-10-18 | Candidate, not vetted or endorsed |
| **OpenZeppelin** | Smart contract security audits, protocol architecture | [OpenZeppelin Audits](https://www.openzeppelin.com/security-audits) | 2026-10-18 | Candidate, not vetted or endorsed |
| **Kudelski Security** | Blockchain security, cryptography, smart contracts | [Kudelski Security](https://kudelskisecurity.com/) | 2026-10-18 | Candidate, not vetted or endorsed |

---

## Related Documents
- [Audit Scope & Specifications](./SCOPE.md)
- [Audit Remediation & Tracking Process](./REMEDIATION.md)
- [Coordinated Disclosure Policy](../../SECURITY.md)
