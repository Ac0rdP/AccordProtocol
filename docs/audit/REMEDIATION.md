# Security Audit Remediation & Tracking Process

This document defines the procedure for receiving, triaging, resolving, and verifying findings delivered in external security audit reports for Accord Protocol.

---

## 1. Confidentiality & Tracking Rule

> [!CAUTION]
> **Strict Anti-Zero-Day Policy**: Unfixed vulnerability details must **never** be committed to public branches, issues, or pull requests in this repository.
> 
> All findings identified by auditors must be tracked privately (via GitHub Private Security Advisories or an encrypted internal tracker) until a verified patch has been merged and deployed. Only after fixes are in place will the public remediation tracker below be populated.

---

## 2. Remediation Workflow

```text
  [Intake of Draft Report] ──▶ [Severity & Triage Alignment]
                │
                ▼
  [Private Fix Development] ──▶ [Internal Peer Review & Tests]
                │
                ▼
  [Auditor Re-Test Review] ──▶ [Final Verification Sign-Off]
                │
                ▼
  [Public Closure & Report Publication]
```

### Step 1: Report Intake
1. Upon receipt of the preliminary audit report from the auditor, the **Security Lead** acknowledges receipt.
2. The report is uploaded to the private maintainer security repository or internal advisory tracker.
3. An internal audit tracking log is initialized using the finding IDs assigned by the auditor (e.g., `AUDIT-01`, `AUDIT-02`).

### Step 2: Triage Alignment
- Maintainers review each finding alongside the auditor's recommendations.
- Findings are mapped directly against the severity tiers defined in [`SECURITY.md`](../../SECURITY.md#4-severity-tiers) (**Critical**, **High**, **Medium**, **Low / Informational**). The project does not maintain a separate severity rubric for audits.
- If maintainers disagree with an assessment, technical evidence or invariant definitions are presented to the auditor for reconsideration during the preliminary review window.

### Step 3: Private Remediation Development
- For each finding marked for remediation, an isolated branch is created in the private advisory repository.
- The **Contract Maintainer** implements the fix and authors accompanying regression unit tests in `contracts/accord/src/test.rs`.
- Two maintainers must review and approve the patch before submitting it to the auditor.

### Step 4: Auditor Re-Test & Verification
- Patches and test runs are shared with the auditing firm for re-testing.
- The auditor reviews the code changes to verify that:
  1. The reported vulnerability is effectively eliminated; and
  2. The fix does not introduce regressions or new attack vectors.

### Step 5: Closure & Evidence Requirements
An audit item is marked closed when one of the following conditions is met:
- **Verified**: The auditor provides written confirmation that the fix resolves the issue, citing the commit hash in the final audit report.
- **Accepted Risk**: The maintainers formally accept the risk with a documented rationale explaining why the behavior is intended, mitigated by external factors, or deemed an acceptable operational trade-off.

---

## 3. Lifecycle Status Values

| Status | Definition | Closure Evidence Required |
|---|---|---|
| `Open` | Finding received and acknowledged; remediation has not yet begun. | N/A |
| `In Progress` | Patch is actively under development in a private branch. | Private branch / PR reference |
| `Fixed` | Patch has been implemented and internally reviewed; pending auditor re-test. | Commit SHA + test output |
| `Verified` | The auditor has reviewed the patch and confirmed resolution in the final report. | Final report citation / sign-off |
| `Accepted Risk` | Decision made not to modify code; operational risk accepted. | Documented rationale signed by maintainers |

---

## 4. Remediation Tracker Template

The table below serves as the public summary template. It is kept clean of sensitive unpatched findings during active engagements and populated following final verification.

| Finding ID | Title | Severity | Status | Fix Reference / Commit | Verified By |
|---|---|---|---|---|---|
| *None* | *Template row — populated after verified remediation* | *N/A* | *N/A* | *N/A* | *N/A* |

---

## Related Documents
- [Audit Scope & Specifications](./SCOPE.md)
- [Auditor Selection & RFQ Template](./AUDITOR_SELECTION.md)
- [Coordinated Disclosure Policy](../../SECURITY.md)
- [Internal Vulnerability Workflow](../DISCLOSURE_WORKFLOW.md)
