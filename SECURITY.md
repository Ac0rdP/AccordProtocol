# Vulnerability Disclosure Policy and Bug Bounty Framework

Accord Protocol takes the security of our smart contracts, off-chain infrastructure, and users seriously. We appreciate the responsible efforts of security researchers in identifying and disclosing potential vulnerabilities.

This document defines the canonical disclosure policy, scope, severity framework, and reporting guidelines for Accord Protocol.

> [!NOTE]
> For the threat model, token interaction safety arguments, and administrator security best practices, see [`docs/SECURITY.md`](./docs/SECURITY.md).
> For the internal maintainer incident triage and remediation procedure, see [`docs/DISCLOSURE_WORKFLOW.md`](./docs/DISCLOSURE_WORKFLOW.md).

---

## 1. Scope

### In Scope
- **Smart Contract Codebase**: All Soroban smart contract source code located in [`contracts/accord/src/`](./contracts/accord/src/).
- **Deployed Testnet Instances**: Deployed contracts on Stellar Testnet specified in [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md).
- **Frontend Core Logic**: Client code under [`frontend/src/`](./frontend/src/) that directly impacts transaction building, signature verification, role gating, or authorization state.

### Out of Scope
- **Third-Party Infrastructure & Upstream Dependencies**: Vulnerabilities in the Stellar Horizon API, Soroban RPC, Freighter browser extension, Rust toolchain, or third-party npm/cargo packages (report these to upstream maintainers).
- **Denial of Service (DoS)**: High-volume request flooding or spamming against testnet nodes, public RPC infrastructure, or hosted frontend instances.
- **Social Engineering & Physical Attacks**: Phishing, social engineering, physical access, or credential compromise directed at contributors or maintainers.
- **Automated Scanner Output**: Unverified reports generated exclusively by automated security scanners without a reproducible, demonstrable proof-of-concept.
- **Known Prototype Risks**: Limitations explicitly documented as known risks or roadmap items in [`docs/SECURITY.md`](./docs/SECURITY.md) (e.g., prototype status, TTL expiration under extreme ledger load, or external token reentrancy considerations).

---

## 2. How to Report a Vulnerability

All vulnerability reports must be submitted through **private, confidential channels only**. Never open a public GitHub issue, pull request, or discussion for an unpatched vulnerability.

### Primary Channel
The primary and preferred reporting channel is **GitHub Private Vulnerability Reporting**:
1. Navigate to the [Security Advisories tab](https://github.com/Ac0rdP/AccordProtocol/security/advisories) of this repository.
2. Click **"Report a vulnerability"** to open a confidential report directly with project maintainers.

> [!IMPORTANT]
> **Maintainer Setting Action Required**: GitHub Private Vulnerability Reporting must be enabled in the repository settings by a repository administrator prior to public launch.

### Secondary Channel (Contact Placeholder)
If GitHub Private Vulnerability Reporting is unavailable, reports may be sent via encrypted email:

```text
[MAINTAINER_PLACEHOLDER: Security Contact Email (e.g., security@accordprotocol.org) and Optional PGP/GPG Key Fingerprint. Maintainers must configure this address before publishing/merging.]
```

*(Do not use personal contributor email addresses from commit history for vulnerability reports.)*

---

## 3. Report Contents and Rules of Engagement

### What to Include in a Report
To enable prompt verification and triage, please include:
1. **Title & Summary**: Clear description of the vulnerability and its potential impact.
2. **Component & Files**: The affected contract function, storage key, or source file.
3. **Proof of Concept (PoC)**: Minimal, reproducible Rust test case (`#[test]` in `contracts/accord/src/test.rs`) or step-by-step CLI simulation demonstrating the exploit.
4. **Impact Assessment**: What an attacker could gain (unauthorized token transfer, role escalation, quorum bypass).
5. **Remediation Suggestions**: Any proposed code fix or mitigation (optional).

### Rules of Engagement
- **Test in Isolation**: Perform all testing against local mock environments (`cargo test`) or Stellar Testnet accounts funded via Friendbot.
- **Do Not Touch User Funds**: Never interact with, drain, or disrupt testnet treasuries or accounts belonging to other developers or users.
- **Minimal Impact**: Keep proofs of concept strictly to the minimum operations required to prove the vulnerability.
- **Maintain Confidentiality**: Do not disclose details, proof-of-concept code, or advisory information publicly or to third parties until coordinated public disclosure is agreed upon.

---

## 4. Severity Tiers

Vulnerability severity is assessed based on the realistic exploitability and potential impact on Accord Protocol's assets, roles, and consensus invariants:

| Severity | Description & Contract Impact | Example Scenarios |
|---|---|---|
| **Critical** | Unauthorized theft or permanent freezing of multisig treasury assets, complete bypass of multisig quorum, or unauthorized contract upgrade. | - Executing token transfers without reaching `quorum_weight`.<br>- Forging owner votes or reversing legitimate approvals arbitrarily.<br>- Unauthorized invocation of `upgrade` replacing contract WASM. |
| **High** | Privilege escalation or state corruption that disrupts multisig governance without immediate fund loss. | - Bypassing role-based access control (`MissingRole`) to create or execute restricted proposals.<br>- Arbitrarily bypassing per-owner spending limits (`SetSpendingLimit`).<br>- Inducing permanent state locks that prevent owner addition, removal, or threshold updates. |
| **Medium** | Temporary operational disruption, parameter manipulation with limited scope, or griefing requiring significant owner collusion. | - Circumventing time-lock delay parameters under edge conditions.<br>- Inconsistencies in recurring payment interval accounting without capital loss.<br>- Resource exhaustion edge cases requiring excessive ledger entries. |
| **Low / Informational** | Minor logic deviations, gas/CPU inefficiencies, or documentation discrepancies with security implications. | - Unused storage keys or redundant TTL bumps.<br>- Confusing error returns where the call still safely fails.<br>- Misleading technical descriptions of access controls. |

*Note: Final severity classification is determined at the sole discretion of the project maintainers based on demonstrated risk.*

---

## 5. Response Timelines (Proposed Defaults)

The following response timelines are proposed service targets, subject to maintainer confirmation:

- **Initial Acknowledgement**: Within **3 business days** of receipt.
- **Triage & Severity Assessment**: Within **7 calendar days** of receipt.
- **Status Updates**: Every **7 calendar days** while a fix is actively under development.
- **Target Resolution Timeframes**:
  - Critical: Fix developed within **14 calendar days**.
  - High: Fix developed within **30 calendar days**.
  - Medium: Fix developed within **60 calendar days**.
  - Low / Informational: Addressed in next scheduled release cycle.
- **Coordinated Disclosure Window**: Public advisory published **14 to 30 days** following deployment of the fix, unless an alternative date is mutually agreed upon.

> [!NOTE]
> These timeframes represent proposed target benchmarks. The repository maintainers must confirm and adopt these operational targets.

---

## 6. Discretionary Bug Bounty Framework

Accord Protocol values security research and aspires to reward researchers who identify critical vulnerabilities. 

### Funding & Discretionary Status
Rewards under this framework are entirely **discretionary** and depend on funding availability that the maintainers have not yet formally confirmed. Maintainers will review funding allocation prior to mainnet launch.

### Reward Tiers (Placeholders)
When funding is active, rewards will be distributed according to assigned severity:

- **Critical**: `[MAINTAINER_PLACEHOLDER: Discretionary reward amount, e.g., up to $X,XXX USDC]`
- **High**: `[MAINTAINER_PLACEHOLDER: Discretionary reward amount, e.g., up to $X,XXX USDC]`
- **Medium**: `[MAINTAINER_PLACEHOLDER: Discretionary reward amount, e.g., up to $XXX USDC]`
- **Low**: `[MAINTAINER_PLACEHOLDER: Discretionary reward or Hall of Fame recognition]`

### Eligibility Criteria
- First valid report: Rewards are awarded to the first researcher to submit a reproducible report for a given vulnerability. Duplicate reports are not eligible.
- Compliance: The researcher must follow the rules of engagement set forth in this policy and refrain from public disclosure until authorized.
- Sanctions & Restrictions: Researchers must not be located in jurisdictions subject to international trade sanctions or on restricted party lists.

---

## 7. Good-Faith Research (Safe Harbor)

Accord Protocol considers vulnerability research conducted in strict compliance with this policy to be authorized and in good faith:

- The project will not initiate legal action against you for security research that follows these guidelines.
- If third-party legal action is initiated against you in connection with activities conducted under this policy, the project will affirm that your actions were authorized and conducted in accordance with this vulnerability disclosure policy.

> [!WARNING]
> **Legal Review Notice**: The safe harbor wording above is provided as standard open-source research guidance. It has not undergone formal legal review. The repository maintainers or legal counsel must review and approve this text before formal deployment.

---

## 8. Coordinated Disclosure & Credit

Once a fix is verified and deployed:
1. Maintainers will coordinate with the reporting researcher to finalize the public advisory text.
2. An official GitHub Security Advisory will be published.
3. The researcher will be publicly credited in the release notes and advisory (unless anonymity is requested).
4. If appropriate, a CVE identifier will be requested through GitHub's CNA advisory service.
