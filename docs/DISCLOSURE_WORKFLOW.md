# Coordinated Vulnerability Disclosure & Triage Workflow

This document outlines the internal procedure for repository maintainers when receiving, triaging, fixing, and disclosing security vulnerabilities reported against Accord Protocol.

All maintainers handling security reports must act according to assigned roles, not individual identities.

---

## 1. Roles and Responsibilities

| Role | Responsibilities |
|---|---|
| **Security Lead** | Primary responder for intake, logging reports, acknowledging submissions, coordinating timelines, and managing public advisories. |
| **Contract Maintainer** | Technical analysis of contract vulnerabilities, creating reproduction tests in `contracts/accord/src/test.rs`, and implementing private fixes. |
| **Frontend Maintainer** | Technical analysis and patch development for frontend authorization, transaction construction, or client-side issues. |
| **Communications Lead** | Drafts advisory announcements, coordinates with the researcher, and handles public notifications. |

---

## 2. Step-by-Step Triage Procedure

```text
  [Intake & Log] ──▶ [Acknowledge (≤3d)] ──▶ [Reproduction & Triage (≤7d)]
         │
         ▼
  [Private Fix Fork] ──▶ [Peer Review & Tests] ──▶ [Release & Upgrade]
         │
         ▼
  [Advisory Publication & Credit] ──▶ [Post-Mortem & Remediation Tracker]
```

### Step 1: Intake & Logging
- **Channel Monitoring**: The Security Lead monitors the GitHub Private Vulnerability Reporting inbox and the configured security contact inbox.
- **Record Entry**: Assign an internal tracking ID (`SEC-YYYY-NN`) and record:
  - Date received
  - Reporter identity / handle
  - Target component (`contract`, `frontend`, `indexer`)
  - Initial claimed severity

### Step 2: Confidential Acknowledgement
- Within **3 business days**, the Security Lead sends a confidential acknowledgement to the reporter confirming receipt and stating that preliminary triage has commenced.

### Step 3: Technical Reproduction & Severity Assignment
- The Contract Maintainer (or Frontend Maintainer) reproduces the reported behavior using a dedicated test in a private environment.
- Assign a definitive severity tier (**Critical**, **High**, **Medium**, **Low**) strictly according to the criteria defined in [`SECURITY.md`](../SECURITY.md#4-severity-tiers).
- Communicate the assessment result to the reporter within **7 calendar days**.

### Step 4: Private Fix Development
- **Private Advisory**: Open a private GitHub Security Advisory and create a linked private advisory fork.
- **Isolated Branch**: Implement the fix and accompanying regression tests exclusively within the private fork. Never push security patches to public branches before disclosure.
- **Peer Review**: Require two independent maintainer reviews on the private advisory pull request.

### Step 5: Verification & Pre-Deployment Review
- Verify that all unit tests (`cargo test`) and adversarial test scenarios pass.
- For contract changes, verify that WASM size ceilings and gas bounds are maintained (see [`scripts/check-wasm-size.sh`](../scripts/check-wasm-size.sh)).

### Step 6: Release & Contract Upgrade
- When preparing an upgrade for deployed contracts:
  - Follow the procedures documented in [`docs/UPGRADE_SAFETY.md`](./UPGRADE_SAFETY.md).
  - Execute the upgrade via the multisig upgrade flow (`upgrade` entrypoint) according to [`docs/RUNBOOK.md`](./RUNBOOK.md).
- Tag the patch release according to Semantic Versioning (e.g., `v0.X.Y`).

### Step 7: Coordinated Public Disclosure & Credit
- Finalize the GitHub Security Advisory text in consultation with the researcher.
- Publish the advisory simultaneously with the release of the patched contract and frontend code.
- If applicable, request a CVE identifier through GitHub's CNA advisory service.
- Add the researcher to release notes and acknowledge their contribution.

### Step 8: Post-Mortem & Lessons Learned
- Conduct an internal retrospective to identify root causes and evaluate whether test suites or CI linters can catch similar issues automatically.
- Update the remediation tracking log in accordance with [`docs/audit/REMEDIATION.md`](./audit/REMEDIATION.md).

---

## 3. Web Application Security Contact (`security.txt`)

> [!NOTE]
> **Future Follow-Up Item**: For the web application deployment (`frontend/`), maintainers should publish a standard `/.well-known/security.txt` file (RFC 9116) once a permanent domain name and official contact inbox are finalized.
