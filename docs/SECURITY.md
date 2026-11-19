# Security Policy & Threat Model

> [!TIP]
> **Reporting a Vulnerability:** See the canonical repository [Vulnerability Disclosure Policy and Bug Bounty Framework](../SECURITY.md) for vulnerability scope, severity tiers, reporting channels, and safe harbor terms.
> Maintainers handling reports should consult the [Coordinated Disclosure Workflow](./DISCLOSURE_WORKFLOW.md).
>
> This document details the protocol's threat model, token interaction safety arguments, adversarial test coverage, and operational security best practices.

## Supported Versions

| Version           | Supported                        |
| ----------------- | -------------------------------- |
| testnet (current) | Yes                              |
| mainnet           | Not yet deployed — audit pending |

## Audit Status

Accord Protocol is **unaudited**. Do not deploy to mainnet with significant funds until a formal third-party audit is completed. The contract has been reviewed for common Soroban anti-patterns but has not undergone a professional security review. Detailed scope, attack surface analysis, protocol invariants, and verification steps are consolidated in the [Audit Preparation Pack](./AUDIT_PREP.md).

External audit planning and preparation resources:
- [Audit Scope & Specifications](./audit/SCOPE.md): Defines in-scope entrypoints, files, and measured codebase metrics.
- [Auditor Selection & RFQ Template](./audit/AUDITOR_SELECTION.md): Selection criteria, Request-for-Quote template, and candidate directory.
- [Audit Remediation & Tracking](./audit/REMEDIATION.md): Post-audit triage, verification workflow, and public remediation tracker.

Known areas that require attention before mainnet:

- Reentrancy via external token calls (currently mitigated by Soroban's single-contract-call model, but warrants formal review)
- TTL expiry edge cases under high ledger load

## Security Best Practices for Multisig Administrators

### Key Management

- Use a hardware wallet or an air-gapped signing device for each multisig owner key whenever possible.
- Do not store a private key in a shared password manager, team vault, or any system that more than one person can access.
- Treat each Stellar signing key like a root credential: if it is exposed, assume an attacker can act as that owner until the owner is removed from the multisig.
- Keep recovery material, seed phrases, and backup exports offline and separate from day-to-day operational devices.

### Threshold Sizing

- Choose an M-of-N threshold that makes a single compromised key insufficient to move funds or approve sensitive actions on its own.
- At the same time, leave enough slack for normal operations when one owner is traveling, offline, or otherwise unavailable.
- For small teams, `2-of-3` is usually a practical baseline because it resists one-key compromise while still allowing continuity if one signer is down.
- For larger teams, `3-of-5` is a common starting point because it raises the approval bar without making routine coordination unworkable.
- Review the threshold whenever the team changes size, the treasury grows, or the approval process becomes operationally brittle.

### Owner Rotation

- Replace owners through the on-chain proposal flow rather than by sharing keys or making out-of-band changes.
- First submit an `add_owner` proposal for the new signer and wait for it to pass so the threshold is still met during the transition.
- Verify the new owner can sign a test transaction before removing the departing owner.
- After the replacement signer is confirmed, submit a `remove_owner` proposal for the old owner and wait for that proposal to execute.
- If you also need to adjust quorum, use the `change_threshold` proposal flow as part of the same planned rotation.

### What to Do If a Key Is Compromised

- Immediately assume the compromised owner can approve pending or future proposals until removed.
- Use a quorum of the remaining uncompromised owners to submit and approve a `remove_owner` proposal for the exposed key as soon as possible.
- Pause or cancel any pending proposals that the compromised owner already approved, then re-evaluate them after the owner set is cleaned up.
- If the threshold no longer makes quorum possible after the compromise, raise the issue operationally first and restore a safe threshold before resuming normal use.

## Token interaction safety

`execute` (for `Transfer` proposals) and `disburse_recurring` are the only entrypoints that move funds. Both call an external token contract through `token::Client`, so a hostile or buggy token is the main interaction risk. This section records the review of those two paths and the argument for why they are safe. It is covered by the adversarial tests listed at the end.

### Interaction order

`execute`, `Transfer` kind:

1. Checks: auth, `Executor` role, not frozen, proposal is `Ready`, time-lock elapsed, not in recovery mode, per-token spending limits.
2. Treasury balance check: for each token, the summed amount across all transfers is compared to the treasury balance via `try_balance` before anything moves.
3. Interaction: each transfer via `try_transfer`.
4. Effects: spent trackers, then `proposal.status = Executed`, then `remove_active_proposal` (active count), then the `executed` event.

`disburse_recurring`:

1. Checks: auth, not frozen, not in recovery, schedule status, due time, cap clamp, and every checked counter update (`total_disbursed`, `periods_disbursed`), computed up front.
2. Treasury balance check via `try_balance`.
3. Interaction: one `try_transfer`.
4. Effects: spent tracker, `last_disbursed_at`, `total_disbursed`, `periods_disbursed`, then the `rpay` event.

Both paths put the interaction before the effects, so they are not strict checks-effects-interactions. They are safe for the reasons below, not because of ordering alone.

### Why the order is safe

- **No re-entry.** The Soroban host rejects a call into a contract that is already on the call stack. A token that calls back into `execute`, `disburse_recurring`, `approve` or any other Accord entrypoint during `transfer` makes that inner call fail, which traps the token, which makes the outer `try_transfer` return an error. The contract therefore never runs while its own state is half-updated, and no token can observe an executed-looking proposal before the transfer completes. The tests `execute_with_reentrant_token_is_rejected_and_preserves_state` and `disburse_recurring_with_reentrant_token_preserves_state` exercise this.
- **Failure is atomic.** Every failure path returns `Err(TransferFailed)` (or another error) from the entrypoint. A contract-call error reverts all storage writes made during that invocation, including writes made by the token. Because no Accord state is written before the transfer loop in either path, there is nothing to unwind, and in a multi-transfer proposal an earlier successful transfer is rolled back when a later one fails. `execute_with_failing_second_transfer_reverts_the_first` checks this.
- **No partial effects.** The proposal is marked `Executed` and removed from the active set only after every transfer has succeeded. A failed `execute` therefore leaves the proposal `Ready` and the active count unchanged, so it can be retried. A failed `disburse_recurring` leaves `total_disbursed`, `periods_disbursed` and `last_disbursed_at` unchanged.

### Findings

- **Fixed: a token returning a non-unit value counted as success.** The generated `try_transfer` reports a mistyped return value as `Ok(Err(_))`, and the earlier code treated any outer `Ok` as success. A token whose `transfer` returned `false` without moving funds would have let `execute` mark a proposal `Executed` and `disburse_recurring` advance a schedule with nothing paid. Both paths now go through `transfer_succeeded`, which accepts only `Ok(Ok(()))`.
- **Fixed: `execute` had no balance check.** `disburse_recurring` checked the treasury balance first, but `execute` went straight to `try_transfer`. `execute` now checks the per-token total with `try_balance` before any transfer, so a shortfall fails up front. A token whose `balance` call traps is also reported as `TransferFailed` instead of aborting the call.
- **Confirmed: a failed `execute` does not mark the proposal executed or change the active count.** See `assert_execute_rejected_cleanly` in the tests.
- **Residual risk: a malicious token can lie.** A token can report a large `balance` and return normally from `transfer` without moving funds. The contract cannot detect this, and it trusts the token for what it moves. Proposers and approvers must only use tokens they trust. Recurring schedules validate that the token answers `decimals`, `symbol` and `name`, which is a sanity check, not a trust check.

### Adversarial tests

The tests in `contracts/accord/src/test.rs` use two mock tokens: `AdversarialToken` (traps, fails for a chosen recipient, re-enters `execute` or `disburse_recurring`, reports a configurable balance) and `FalseReturnToken` (returns `false` from `transfer`). They assert, for both `execute` and `disburse_recurring`, that each failure mode returns `TransferFailed` and leaves the proposal or schedule, and the active count, unchanged.

## Known Limitations

- A stolen owner key can still create and approve proposals up to the threshold gap before it is removed.
- There is no automatic on-chain emergency recovery; owner removal and threshold changes still require coordinated proposal approval.
- Token contracts are checked against the Soroban token interface at creation and execution, but interface checks cannot detect malicious behavior introduced by an upgrade between those events.
- A malicious owner can deliberately fill the active proposal cap and temporarily block new proposals from being created.
- Per-owner, per-token spending limits are available via `SetSpendingLimit` proposals and are enforced when a transfer proposal is created, but they are opt-in: an owner with no configured limit for a given token remains unrestricted for it, so the threshold is still the primary access-control mechanism.

## Explicit Trust Assumptions

- Owner keys are kept secret and not shared. If that assumption fails, the multisig should be treated as compromised until the exposed owner is removed and any impacted proposals are reviewed.
- The Stellar RPC node used by the frontend returns accurate ledger state. If it lies or falls behind, the UI can show stale proposal status, incorrect balances, or misleading approval state.
- Token contracts used in proposals follow the Soroban token interface and are not upgraded to malicious code after proposal creation. If that assumption fails, execution can transfer an asset the owners no longer intended to trust.

## Threat Model

> RBAC, delegation and recurring payments are analysed in full, with code links and residual risks, in [THREAT_MODEL_RBAC_DELEGATION_RECURRING.md](./THREAT_MODEL_RBAC_DELEGATION_RECURRING.md).

### Attack Surfaces

The protocol's attack surface includes the following external entry points:

- **Public Contract Functions**: `create_proposal` (and variants), `approve`, `revoke`, `execute`, `cancel_expired`, and `upgrade`. These are reachable by any actor via the Stellar network.
- **Guardian / Emergency Pause**: `set_guardian`, `freeze`, and `unfreeze`. `set_guardian` assigns or replaces the guardian address and requires a set of _distinct_ owners whose combined voting weight reaches the current threshold to co-sign in a single call. `freeze` can be called **only** by the currently registered guardian and immediately blocks new proposal creation and all proposal execution. `unfreeze` lifts the freeze and, like `set_guardian`, requires distinct owners whose combined weight reaches the threshold. A misconfigured or captured guardian key can therefore halt the contract (a denial-of-service pause), but on its own cannot move funds, change the owner set, or change the threshold.
- **Concurrent Governance Proposals**: Two governance proposals that each pass their own creation-time checks can be approved in parallel and executed back-to-back — for example two `RemoveOwner` proposals, or a `RemoveOwner` alongside a `ChangeThreshold`. Because each creation-time check evaluates the owner set and total weight as they stand at creation, executing both together can move the owner-count or total-weight past the point where the threshold is still reachable, risking a multisig that can no longer reach quorum.
- **Role-Based Access Control (RBAC)**: Operational roles (`Proposer`, `Approver`, `Executor`, `Viewer`) govern entrypoints, introducing distinct attack considerations: execution of `Ready` proposals by non-owner executors, role concentration on single signers, and approver role-revocation lockout risks (see [Role-Based Access Control Threat Model Addendum](#role-based-access-control-rbac-threat-model-addendum)).
- **Frontend Wallet Connection**: The boundary where the dApp interacts with browser-based wallets (Freighter). Malicious sites could attempt to intercept or spoof these calls.
- **RPC Layer Boundary**: The communication path between the frontend and a Stellar RPC node. A compromised node can feed dishonest state data to the user.

### Trust Assumptions

Accord relies on several explicit assumptions for its security properties to hold:

1. **Key Confidentiality**: Owner private keys are not compromised or shared.
2. **Honest RPC Node**: The RPC node used by the frontend and integrators returns accurate ledger state.
3. **Asset Integrity**: Token contracts passed to the multisig are non-malicious and do not contain backdoors or non-standard callback logic.
4. **Soroban Platform**: The underlying Soroban runtime correctly enforces `require_auth` and handles cryptographic verification.

## Operational Security Controls

The repository includes `scripts/security-controls.mjs`, an additive off-chain
control for operator workflows. It does not replace contract authorization: the
Accord contract remains the enforcement point for owner quorum, RBAC, guardian
pause, and treasury execution. The control is owned by the Security and
Compliance operator, applies to privileged workspace actions and every planned
treasury transfer, and fails closed when policy, authorization, allowlist, or
screening evidence is missing.

### Workspace roles and tamper-evident audit

The policy file maps actors to roles and actions to required roles. At minimum,
deployments should separate `treasury_operator`, `privacy_admin`,
`policy_admin`, and `security_auditor`; an actor with no matching role cannot
append a privileged record, change an allow/deny list, or pass treasury
preflight. Audit records are JSON Lines records chained
with SHA-256 hashes. Each record contains `previousHash`, and its `hash` covers
all unsigned fields. Operators must run:

```bash
node scripts/security-controls.mjs audit verify --log=./data/security-audit.jsonl
```

Any gap, modified record, malformed line, or missing log is an incident and
blocks approval until the log is restored from protected evidence. Store the
audit file with restricted permissions and copy it to write-once or otherwise
access-controlled evidence storage at the end of each operating period. The
hash chain is tamper-evident, not a substitute for access controls or an
independent backup.

This control addresses the existing RBAC risks of role concentration,
unreviewed privileged operations, and incomplete incident evidence described in
the [RBAC threat model](THREAT_MODEL_RBAC_DELEGATION_RECURRING.md). It does not
grant roles or voting power and does not handle private keys.

### Treasury recipient controls

Before a transfer is submitted, the `treasury_operator` must run the
`treasury preflight` command with the destination contract, recipient, and
policy. A non-empty recipient or contract allowlist is restrictive; any deny
list match wins. Screening is required by default and only a provider result of
`clear` permits the transfer. Provider name, query time, request ID, and result
must be included in the corresponding audit record. A provider outage,
ambiguous response, stale result, or missing result is a denial, never an
automatic approval. The contract's owner quorum and `Executor` role checks
still apply after preflight.

### Personal-data export, deletion, and retention

The `privacy_admin` owns subject access exports and deletion requests. Export
copies matching subject records to a new mode-`0600` file without changing the
source. Deletion replaces personal-data fields with `[REDACTED]` while retaining
stable record metadata and an audit record containing the actor, subject, and
redaction count. A valid, unexpired retention exception (for example, a legal
hold or reconciliation requirement) blocks deletion and must state its reason,
subject, and `retainUntil` timestamp. Once the exception expires, the request
must be retried; exceptions are not permission to retain data indefinitely.

### API key lifecycle, least privilege, and rotation

Machine-to-machine integrations, indexing services, and compliance tooling must
authenticate using least-privilege API keys managed via `scripts/security-controls.mjs`.

- **Owner**: Security Administrator (`apikey_admin`).
- **Scope**: All automated service credentials, background indexers, telemetry ingestors, and analytics query integrations.
- **Threat Model**:
  - Unscoped, immortal credentials compromised via logs, source control, or dev machines leading to unauthorized administrative actions.
  - Abrupt credential expiration causing production outages during key replacement.
  - Stale credentials remaining valid indefinitely after an operator or service deprecation.
  - Storing plaintext tokens in data files or logs allowing secondary theft.
- **Enforcement and Failure Behavior**:
  - **Fails closed**: Any request presenting an unrecognized, revoked, expired, or scope-deficient token is rejected immediately.
  - **Secret protection**: Plaintext tokens are returned exactly once upon issuance or rotation; only their cryptographic SHA-256 hash is persisted in `api-keys.json`. Plaintext tokens are never logged or stored.
  - **Least-privilege scoping**: Keys specify explicit permitted actions (e.g., `audit:read`, `audit:append`, `treasury:preflight`, `indexer:ingest`, `metrics:read`).
  - **Overlap grace windows**: During key rotation, the prior key transitions to `rotating` status and remains valid during a defined overlap window (default 7 days) to enable zero-downtime client cutover before hard expiration.
  - **Rotation reminders**: Automated checks flag active keys approaching expiration within the reminder window (default 14 days).
  - **Revocation**: Keys can be immediately revoked by administrators with a recorded justification, instantaneously barring authentication.
- **Link to Existing Risks**:
  - Directly mitigates the **Role Concentration Risk** and **Workstation Single Point of Failure (SPOF)** documented in the [RBAC threat model addendum](#role-concentration-risk) and the credential exposure threats in [`docs/SECRETS_MANAGEMENT.md`](./SECRETS_MANAGEMENT.md).

### SIEM streaming and security event forwarding

Operational audit logs, authorization decisions, and contract governance events
can be streamed to enterprise SIEM endpoints (Splunk, Datadog, or generic SIEM/HTTP endpoints).

- **Owner**: SOC Lead / Security Operations (`security_operator`).
- **Scope**: All authentication events, authorization checks, treasury preflight decisions, policy modifications, privacy actions, and contract emergency pause events.
- **Threat Model**:
  - Security incidents or compromised credentials escaping detection due to audit logs remaining isolated on local filesystems.
  - An attacker tampering with local JSONL logs to conceal malicious activity.
  - Transmission of plaintext tokens, passwords, or private keys to third-party log aggregation services.
  - Downstream SIEM outages causing service degradation or blocking operational processes.
- **Enforcement and Failure Behavior**:
  - **Automated sanitization**: Payloads are scrubbed before serialization. Fields containing tokens, secrets, private keys, or passwords are automatically redacted to `[REDACTED_SECRET]`.
  - **Categorization and severity**: Events are classified into functional categories (`authentication`, `authorization`, `governance`, `privacy`, `compliance`) and assigned security severities (`INFO`, `WARN`, `CRITICAL` for freezes or unauthorized attempts).
  - **Fail-safe forwarding**: SIEM streaming failures log errors without interrupting on-chain execution or local operational preflight. Dry-run export enables offline verification.
- **Link to Existing Risks**:
  - Addresses the **Role-Revocation Lockout Risk** and **Incomplete Incident Evidence** highlighted in the [threat model](#attack-surfaces) by guaranteeing external real-time event correlation and tamper protection.

### SOC 2 Trust Services Criteria mapping and auditor evidence

Accord's operational and protocol security controls are formally mapped to SOC 2 Trust Services Criteria (Security, Availability, Confidentiality, and Privacy).

- **Owner**: Compliance Officer / Security Auditor (`compliance_export`, `security_auditor`).
- **Scope**: All repository security controls, CI scanning mechanisms, smart contract invariants, and data management workflows.
- **Threat Model**:
  - Failure to demonstrate compliance during SOC 2 audits due to manual, ad-hoc, or incomplete evidence collection.
  - Retroactive modification of compliance evidence or audit chains.
  - Inadvertent disclosure of operational secrets or confidential user data during auditor handoff.
- **Enforcement and Failure Behavior**:
  - **Fails closed**: Evidence package generation verifies audit log hash chains, active policy definitions, and residency configurations. If the audit log is broken or missing, the package flags the control non-compliant or fails.
  - **Tamper-evident manifest**: Generates an auditor evidence package containing SHA-256 digests for all evaluated evidence files (`security-audit.jsonl`, `security-policy.json`, etc.).
  - **Mapped criteria**: Maps operational controls to CC6.1 (Access Security), CC6.2 (User Credentials), CC6.3 (Least Privilege), CC6.6 (Boundary Protection), CC6.7 (Data Integrity), CC6.8 (Software Invariants), CC7.1 (Vulnerability Scanning), CC7.2 (Security Monitoring), CC7.3 (Incident Containment), CC8.1 (Change Management), A1.2 (Availability & Backups), C1.1 (Confidentiality & Secret Protection), P1.1 (Privacy Rights), and P4.1 (Data Sovereignty).
- **Link to Existing Risks**:
  - Resolves governance and auditability gaps identified in the [Audit Preparation Pack](./AUDIT_PREP.md).

### Data residency pinning, regional backups, exports, and deletion

Workspace data, indexing databases, backups, and exports are pinned to specific geographic and cloud regions.

- **Owner**: Infrastructure Operator (`infra_operator`) and Privacy Administrator (`privacy_admin`).
- **Scope**: Workspace data repositories, persistent database snapshots, export packages, and tenant deletion routines.
- **Threat Model**:
  - Unintended cross-border data transfer or regulatory breach under sovereignty frameworks (GDPR, regional data protection mandates).
  - Silent backup data corruption or unverified recovery snapshots.
  - Inadvertent deletion of data subject to mandatory retention holds or regulatory preservation notices.
- **Enforcement and Failure Behavior**:
  - **Fails closed**: Operations attempting to access, back up, or export workspace data in an unapproved region or a region mismatched with the workspace's pinned region are rejected with an explicit error.
  - **Verified backups**: Backup archives include SHA-256 checksums and regional metadata headers to guarantee integrity and geographic provenance.
  - **Retention hold gates**: Workspace deletion validates active retention exceptions before purging data. Any unexpired legal hold or compliance exception hard-blocks deletion.
- **Link to Existing Risks**:
  - Mitigates multi-tenant data exfiltration risks and regulatory penalties associated with cross-border transfer violations and improper record destruction.

### Enterprise SSO (SAML / OIDC), just-in-time provisioning, and session policy

Team accounts can sign in through an enterprise identity provider (IdP) using
SAML 2.0 or OpenID Connect. `scripts/sso-controls.mjs` is the enforcement point
between the IdP and the workspace roles that `scripts/security-controls.mjs`
authorizes against. It is an off-chain operator control: it never holds wallet
keys, and SSO roles cannot satisfy or bypass on-chain owner quorum, RBAC, or
guardian checks.

- **Owner**: Security Administrator (`sso_admin` for deprovisioning, `policy_admin` for projecting SSO roles into the policy).
- **Scope**: Every interactive sign-in to a team workspace through a configured IdP, the resulting workspace roles, and the session used for privileged off-chain actions (treasury preflight, privacy, policy, key management).
- **Threat Model**:
  - Forged or tampered assertions/ID tokens, including `alg: none`, HMAC key-confusion against a published JWKS, or an assertion signed by a certificate the IdP did not intend.
  - Assertions or tokens issued for another service (wrong audience/issuer), or captured and replayed.
  - Sign-in by accounts outside the organization (unverified or off-domain email), or without MFA.
  - IdP compromise or misconfiguration granting roles through group membership, in particular control-plane roles.
  - Stale access after an employee leaves or changes teams: lingering roles or long-lived sessions.
  - Session token theft from the session store.
- **Enforcement and Failure Behavior** (all checks **fail closed** and are audited as `sso_login_denied` where applicable):
  - **Pinned trust**: OIDC tokens are verified with Node's crypto against a pinned JWKS (asymmetric `RS*`/`ES*`/`PS256` only; `none` and `HS*` are rejected; JWKs containing private or symmetric material are rejected at config load). SAML XML-DSig is verified by the SAML gateway library, and the control additionally requires `signatureVerified: true` from it plus a SHA-256 signing-certificate fingerprint that matches the pinned list.
  - **Claims**: exact issuer and audience (and `azp` for multi-audience tokens), validity window with bounded clock skew (default 120 s), nonce when the caller supplies one, verified email in an `allowedDomains` entry, and MFA (`amr` for OIDC, `AuthnContextClassRef` for SAML) when `session.requireMfa` is set.
  - **Replay**: every assertion ID / `jti` is recorded until it expires; a second use is denied.
  - **Just-in-time provisioning**: unknown users are created only when `jit.enabled` is true. Roles are recomputed from IdP groups on every login via `jit.groupRoles`, limited to `jit.allowedRoles`, so removing a group in the IdP removes the role at next login. A user with no mapped role is denied. Users are keyed by the stable IdP subject (`sso:<provider>:<subject>`), never by email, so a reassigned mailbox does not inherit access.
  - **Protected roles**: `policy_admin`, `apikey_admin`, and `sso_admin` can never be granted through SSO; config validation rejects them in `jit.allowedRoles`, and role mapping filters them again at runtime.
  - **Session policy**: absolute lifetime (`maxAgeMinutes`, further capped by the SAML `SessionNotOnOrAfter`), idle timeout, and step-up re-authentication windows per action (`reauthMinutesForActions`, for example 15 minutes for `treasury_transfer`). Session tokens are returned once; only their SHA-256 hash is stored.
  - **Deprovisioning**: suspends the user, clears SSO roles, and revokes every active session immediately; a suspended user cannot sign in again until an administrator restores them.
  - **No weakening of existing authorization**: `sync-policy` only adds or removes `sso:*` actors in the policy `roles` map. Manually managed actors and the `permissions` map are untouched, and `authorize()` remains the single authorization check.
- **Link to Existing Risks**:
  - Addresses the **Role Concentration Risk** and **Role-Revocation** concerns in the [RBAC threat model addendum](#role-based-access-control-rbac-threat-model-addendum) by tying off-chain roles to centrally managed IdP groups with prompt revocation, and the credential-exposure threats in [`docs/SECRETS_MANAGEMENT.md`](./SECRETS_MANAGEMENT.md) by hashing session tokens and refusing secret key material in config.
- **Residual risk**: a fully compromised IdP can still sign in as any user in an allowed domain and obtain that user's non-protected roles. Treasury movement still requires on-chain owner quorum. Keep `jit.allowedRoles` minimal, require MFA, and alert on `sso_role_sync` events in the SIEM.

### Frontend Content Security Policy (CSP) and Security Headers

- **Control**: Strict HTTP `Content-Security-Policy` and companion browser security headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, and `Strict-Transport-Security: max-age=31536000` on production HTTPS without `includeSubDomains` or `preload`) defined centrally in [`frontend/security-headers.mjs`](../frontend/security-headers.mjs) and applied to Vercel deployments ([`frontend/vercel.json`](../frontend/vercel.json)) and Vite servers ([`frontend/vite.config.ts`](../frontend/vite.config.ts)).
- **Owner**: Frontend Maintainer.
- **Scope**: All document and asset responses served by the Accord web frontend (`frontend/`).
- **Threat Model**:
  - **Cross-Site Scripting (XSS) & Injected Third-Party Scripts**: Production `script-src` is strictly `'self'` with no `'unsafe-inline'` and no `'unsafe-eval'`. The dark-mode theme bootstrap was moved from an inline `<script>` in `frontend/index.html` to a static external file (`frontend/public/theme-init.js`), preserving static CDN caching with zero nonces or hashes required.
  - **Clickjacking / UI Redressing**: `frame-ancestors 'none'` and `X-Frame-Options: DENY` prevent embedding the multisig approval UI in malicious frames; `frame-src 'none'` and `object-src 'none'` block active plugin or iframe injection.
  - **Data Exfiltration**: `connect-src` restricts outbound browser fetches and WebSockets to `'self'`, configured Stellar Soroban RPC / Horizon origins, the CoinGecko price feed origin, and any explicitly configured Analytics/Indexer/Push origins (stripped to `scheme://host[:port]` so paths, queries, and credentials can never appear in headers). `base-uri 'self'` and `form-action 'self'` prevent base-tag and form hijacking.
  - **Wallet Compatibility**: `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` are intentionally omitted so Freighter and wallet popups/bridges are not broken, and `Permissions-Policy` leaves `usb`, `hid`, and `publickey-credentials-get` unrestricted for Ledger and Passkey wallets.
- **Failure Behavior**:
  - **Browser runtime**: Fails closed — any unauthorized script, frame, or network origin is blocked by the browser.
  - **CI & config validation**: `scripts/check-frontend-headers.mjs` and `scripts/check-frontend-headers.test.mjs` fail closed if `frontend/vercel.json` drifts from `frontend/security-headers.mjs`, if `'unsafe-inline'` or `'unsafe-eval'` appears in production `script-src`, if an unexpected origin or wildcard is introduced, or if inline `<script>` tags reappear in `frontend/index.html`.
- **Rollback**: Set `VITE_CSP_REPORT_ONLY=true` (or `CSP_REPORT_ONLY=true`) or switch `"key": "Content-Security-Policy"` to `"key": "Content-Security-Policy-Report-Only"` in `frontend/vercel.json` and redeploy. See [`docs/OPERATIONS.md`](./OPERATIONS.md#frontend-csp-and-security-headers) for operator steps and the manual browser wallet checklist.
- **Link to Existing Risks**: Mitigates the frontend/contract integration attack surfaces in [Attack Surfaces](#attack-surfaces) (malicious script injection attempting to forge or alter transaction signing payloads before Freighter/hardware wallet confirmation). *(Note: the repository does not maintain a formal numbered risk register.)*

### Mitigations

Specific mechanisms are in place to enforce security boundaries:

- **M-of-N Threshold Guard**: The `execute` and `upgrade` functions enforce a strict approval count, preventing single-key fund transfers or governance takeovers. Threshold alone is not enough for upgrades: owners must still verify the WASM hash and follow the operational checks in [`docs/UPGRADE_SAFETY.md`](./UPGRADE_SAFETY.md).
- **Proposal Deadlines**: The `deadline` field and `derive_status` logic ensure proposals cannot be executed indefinitely, protecting against stale approvals.
- **Active Proposal Cap**: The `MAX_ACTIVE_PROPOSALS` check in `create_proposal` prevents an attacker from exhausting contract storage.
- **Owner Authorization**: Approval calls (`approve` and `approve_sponsored`) require the named owner to authorize the exact invocation, and enforce owner membership plus the Approver role. A sponsor may pay the network fee but cannot supply or change the owner's authorization.
- **Optional Approved-Token Registry**: When enabled, the registry is checked at proposal creation and again before transfer execution or recurring disbursement; governance changes emit events. With the default disabled setting, all interface-valid tokens remain allowed.
- **Escrow Reservation Accounting**: Proposal execution reserves escrow amounts against the contract's current token balance. Ordinary proposal payouts and recurring payments can spend only the unreserved balance; release and refund remove each escrow reservation exactly once.
- **Weighted sensitive-action co-signing (audit conclusion)**: `set_guardian`, `unfreeze`, and `upgrade` reject duplicate addresses before summing approver weights, so a single owner cannot repeat its address to count its weight more than once. They intentionally accept the smallest _distinct_ approver list whose combined weight reaches quorum; this may be one owner when that owner legitimately holds enough configured weight. This is acceptable only as an explicit weighted-governance outcome, and the default 50% `ChangeOwnerWeight` cap prevents granting a strict majority through a later weight-change proposal. **Follow-up concern:** initialization can establish a concentrated allocation, so deployers must review initial weights and quorum together; a future release could apply the cap at initialization too if that policy is required.
- **Guardian Emergency Pause**: A guardian registered through `set_guardian` (itself co-signed by owners whose combined weight meets the threshold) can call `freeze` to immediately block all new proposal creation and execution the moment a compromise or incident is detected. This bounds the damage from a detected compromise: it buys time to remove an exposed owner key or investigate before any funds move, without granting the guardian any power to transfer funds or alter the owner set or threshold. Resuming normal operation requires `unfreeze`, which again needs distinct owners whose combined weight reaches the threshold — so no single party, including the guardian, can both pause and silently resume the contract.
- **Execute-time invariant re-validation for weight changes**: Governance proposals are validated when created but executed later, so a `ChangeOwnerWeight` proposal re-checks _at execution time_ that the resulting total weight would not leave any still-active (Pending/Ready) proposal un-quorumable — if any active proposal's snapshotted `quorum_weight` would exceed the new total weight, execution is rejected with `WouldBreakQuorum`. Owner-removal is guarded at creation time (a removal that would drop remaining weight below the threshold is rejected up front by `create_remove_owner_proposal` with `WouldBreakQuorum`), and threshold changes are validated against total weight at creation. Because those removal and threshold checks evaluate state at creation rather than the combined effect of several proposals executing together, operators should still sequence interacting governance proposals deliberately — approving and executing one before creating the next — so two concurrent removals (or a removal plus a threshold change) cannot combine to push the multisig below a reachable quorum.
- **Role Separation & Non-Owner Execution Invariants**: Operational roles restrict who can propose, approve, or execute. The `execute` function requires `Role::ExecuteProposal` but cannot alter stored proposal parameters, requires un-revoked quorum approval evaluated strictly by `derive_status`, respects guardian freezes, and enforces timelocks and deadlines — ensuring non-owner executors act strictly as permissionless execution cranks without custody or discretionary authority.

### Delegation Effective-Weight Invariants

Delegation layers temporary or indefinite voting weight transfers between owners. The contract guarantees the following mathematical and temporal invariants across all operations:

1. **Conservation of Total Weight (Sum Invariant)**:
   For any owner set and any sequence of active, expired, or revoked delegations:
   $$\sum_{o \in \text{Owners}} \text{effective\_weight}(o) = \text{total\_weight}$$
   Delegation transfers voting power strictly between valid owners without minting or destroying total weight.
2. **Bounded Effective Weight**:
   For every owner $o \in \text{Owners}$:
   $$0 \le \text{effective\_weight}(o) \le \text{total\_weight}$$
   An owner's effective weight can never underflow or exceed the total multisig voting weight.
3. **Temporal Invariant (Expiry)**:
   Delegations configured with an expiration timestamp $T_{\text{expiry}}$ automatically lapse once the ledger timestamp satisfies $T_{\text{ledger}} \ge T_{\text{expiry}}$. Expired delegations contribute zero weight to the delegate and deduct zero weight from the delegator.
4. **Revocation Invariant**:
   Undelegating or revoking a delegation immediately restores the delegator's effective weight and removes the delegate's incoming weight contribution.
5. **Clean Removal Invariant**:
   Executing an owner removal via governance (`RemoveOwner`) deletes all outgoing delegations from the removed owner and all incoming delegations to the removed owner from remaining owners. This restores the remaining delegators' raw weights and prevents dangling delegations from persisting or reviving upon re-addition.

### Weighted Governance Threat Model Addendum

The threat model above predates weighted voting, where every owner's approval counted as exactly one vote. Weighted governance introduces a new class of risk: voting power concentrating in a single owner, or a colluding group of owners, until the multisig stops functioning as a multisig in practice even though it still looks like one on paper.

#### Whale-Owner Risk

A multisig's security rests on requiring _several_ independent parties to agree before funds move or governance changes take effect. Weighted voting weakens that guarantee the moment a single owner's weight reaches the current `threshold` on its own: `approve` sums weight from whichever owners call it, and `derive_status` only compares that sum against `quorum_weight` (the threshold snapshotted at proposal creation) — nothing in that check cares whether the weight came from one owner or several. An owner whose weight is `>= threshold` can therefore approve and execute any proposal alone, turning an "M-of-N" multisig into a single point of failure in every way that matters: one compromised key is enough to move the treasury, exactly the scenario a multisig exists to prevent. This can arise either from an unbalanced initial weight distribution passed to `initialize`, or from weight-change proposals executed over time.

#### Weight-Concentration via Repeated Small Proposals

A related but distinct risk is gradual concentration through a _sequence_ of individually-reasonable `ChangeOwnerWeight` proposals. Each such proposal is checked against the single-owner cap (below) only at the moment it is created and again at the moment it is executed — the check has no memory of earlier proposals and no visibility into whether the beneficiaries are acting independently or in concert. This means:

- **A single owner** cannot exceed the cap in any one step, because each `ChangeOwnerWeight` call re-derives the resulting total weight and re-checks the cap against it fresh (see Mitigations below) — there is no path for one owner to ratchet past the cap across multiple proposals, since every proposal is capped relative to the state it actually executes against.
- **A colluding group of owners**, however, can each individually raise their own weight — or raise each other's — through separate `ChangeOwnerWeight` proposals that every one of them, taken alone, satisfies the cap. Because the cap is evaluated per-owner against the total, not per-coalition, a group of colluding owners can accumulate a combined share of `TOTAL_WEIGHT` well past what any single one of them could reach unilaterally, with no individual proposal ever looking anomalous in isolation.

#### Existing Mitigations

- **Single-owner weight cap, enforced at both creation and execution**: `create_change_weight_proposal` computes the resulting total weight and rejects the proposal with `SingleOwnerWeightCapExceeded` if the target owner's new weight would exceed `MAX_SINGLE_OWNER_WEIGHT_PCT` (50% by default) of that resulting total. Because weights and owner membership can still shift between a proposal's creation and its execution, the identical check runs again inside `execute`'s `ChangeOwnerWeight` branch against the total weight as it stands at execution time, so a cap-violating outcome cannot slip through even if it would only have become a violation due to changes made after the proposal was created.
- **Zero-weight rejected in favor of explicit removal**: `ChangeOwnerWeight` validates `new_weight` against `MIN_OWNER_WEIGHT..=MAX_OWNER_WEIGHT` at both creation and execution, so it can never be used to silently zero out an owner's voting power. An owner who should no longer participate must instead go through `create_remove_owner_proposal`, which is a distinct, explicit action visible in the proposal history as a full removal rather than an easily-overlooked weight edit — and which itself checks at creation time that removal cannot drop the remaining total weight below the threshold.

#### Unmitigated Gap

The single-owner cap bounds what any _one_ `ChangeOwnerWeight` proposal can do to _one_ owner's share — it does not bound the combined share a coalition of owners can reach across several proposals, and it does not prevent an unbalanced set of weights from being accepted at `initialize` in the first place (initialization has no equivalent per-owner cap). Deployers and owners reviewing incoming `ChangeOwnerWeight` proposals should evaluate each one's effect on the _combined_ weight of any owners who might be acting in concert, not just the cap check the contract itself performs, and should review the initial weight distribution passed to `initialize` with the same scrutiny. See "Opt-in initialization weight review" in Residual Risks below.

### Role-Based Access Control (RBAC) Threat Model Addendum

Accord introduces an operational role-based access control (RBAC) layer on top of owner-weighted governance. While owner weights govern _how much voting influence_ an account possesses, operational roles define _what actions_ an account is permitted to take across the proposal lifecycle.

#### RBAC Model & Trust Assumptions

The RBAC implementation in [`contracts/accord/src/lib.rs`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs) categorizes permissions into four functional roles defined in the [`Role`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L24-L30) enum:

- **`Proposer` (`Role::CreateProposal`)**: Permits drafting new proposals via any `create_*_proposal` entrypoint (transfers, owner additions/removals, threshold changes, weight adjustments, recurring payments, spending limits, and role grants/revocations).
- **`Approver` (`Role::ApproveProposal`)**: Permits voting on pending proposals via [`approve`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L2537) and revoking votes via [`revoke`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L2596).
- **`Executor` (`Role::ExecuteProposal`)**: Permits triggering execution of proposals that have reached `Ready` status via [`execute`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L2641) and cleaning up expired proposals via `cancel_expired`.
- **`Viewer`**: Reserved for read-only interface views and off-chain policy auditing; carries no transaction execution permissions.

The protocol relies on the following core trust assumptions regarding RBAC:

1. **Separation of Functional Duties**: Operational responsibilities — drafting proposals, voting, and triggering execution — can be partitioned across different entities without granting treasury custody to operational drafters or automated execution bots.
2. **Ownership as the Sole Voting Anchor**: Roles alone never grant voting power. The [`approve`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L2537) and [`revoke`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L2596) entrypoints require both [`require_role`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L932) for `Role::ApproveProposal` **and** `require_owner_and_weight`. Granting `Approver` to a non-owner address grants zero voting weight and cannot advance proposals toward quorum.
3. **High-Privilege Administrative Actions Bypass Roles**: Core security controls — [`upgrade`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L1730), `set_guardian`, `freeze`, `unfreeze`, `migrate_to_weighted_governance`, `migrate_to_rbac`, and `set_max_single_owner_weight_pct` — are **not** role-gated. They strictly enforce [`require_weighted_approvers`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L1354), requiring a quorum of distinct registered owners whose combined weight reaches `threshold`. An operational role compromise cannot directly hijack contract bytecode, change guardians, or alter thresholds.
4. **Default Backward Compatibility**: Initialization and migration (`migrate_to_rbac`) grant `DEFAULT_OWNER_ROLES` (`Proposer`, `Approver`, `Executor`) to all registered owners. This maintains legacy M-of-N multisig behavior until roles are explicitly segregated.

#### Non-Owner Executor Safety

Under Accord's RBAC model, the `Executor` role (`Role::ExecuteProposal`) can be assigned to an account that is not an owner — such as an automated keeper bot, a cron relayer, or an operational service.

**Attack Scenario:** An untrusted, compromised, or rogue non-owner executor attempts to drain funds, redirect payments, execute unauthorized proposals, or front-run multisig signers.

**Why Executing an Already-`Ready` Proposal Is Low-Risk:**

- **Immutable Proposal Payloads**: When a proposal is created via any `create_*_proposal` entrypoint, its parameters (token address, recipients, disbursement amounts, or governance changes) are serialized and committed to immutable contract storage. The [`execute`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L2641) function takes only `(executor: Address, proposal_id: u64)` and contains no mechanism for the caller to alter the proposal's contents, destination, or amounts.
- **Strict On-Chain Status Verification (`derive_status`)**: Inside [`execute`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L2641), the contract invokes [`derive_status`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L1381). Execution immediately aborts with `ContractError::ThresholdNotMet` or `ContractError::ProposalNotActive` unless the proposal evaluates strictly to `ProposalStatus::Ready`. Proposals in `Pending`, `Executed`, or `Revoked` status are rejected, and expired proposals evaluate to `ProposalStatus::Expired` and return `ContractError::ProposalExpired`.
- **Authentic Owner Quorum Prerequisite**: A proposal transitions to `Ready` status only when the cumulative voting weight contributed by registered owners holding `Role::ApproveProposal` satisfies $\text{approvals} \ge \text{quorum\_weight}$ (the snapshot threshold recorded at creation). Because non-owners cannot cast approval weight, an executor cannot fabricate approvals.
- **Dynamic Approval Revocation Window**: Authorized approvers retain the right to call [`revoke`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L2596) at any time prior to execution. If an owner detects an error or suspicious activity on a `Ready` proposal, revoking their approval immediately drops total approvals below `quorum_weight`, reverting the status back to `Pending` and causing any subsequent call to [`execute`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L2641) to fail.
- **Timelock Delay Enforcement**: If a contract timelock delay is configured (`timelock_key`), [`execute`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L2641) enforces `now >= proposal.ready_at + time_lock_delay`, guaranteeing owners a predictable review window to inspect `Ready` proposals before they can be executed.
- **Guardian Freeze Backstop**: [`execute`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L2641) checks `require_not_frozen(&env)?`. In the event of an active incident or dispute, the guardian can call `freeze` to immediately block all execution contract-wide, overriding any attempts by an executor.
- **Deterministic Crank Property**: The `Executor` role functions strictly as an unprivileged, non-custodial operational crank. It cannot initiate actions or alter outcomes; it merely finalizes transactions that have already achieved owner consensus.

#### Role Concentration Risk

**Attack Scenario:** A single address holds all three operational roles (`Proposer`, `Approver`, and `Executor`), which is the default configuration for all owners following initialization or migration.

**Risks of Role Concentration:**

- **Unilateral Proposal Lifecycle Execution**: If an address holding all three roles also controls voting weight $\ge \text{threshold}$ (a whale owner, or in low-threshold configurations such as 1-of-N), the multisig's checks and balances completely collapse. That single key can draft a malicious proposal, immediately approve it to reach quorum, and execute it within a single ledger block without review or opposition from other owners.
- **Workstation Single Point of Failure (SPOF)**: Even when no single owner possesses sufficient weight to pass quorum alone, concentrating `Proposer`, `Approver`, and `Executor` on a single developer or operator machine concentrates risk. If that machine or signing key is compromised, an attacker can draft arbitrary proposals, vote with the owner's weight, and trigger execution scripts, eliminating defense-in-depth across the lifecycle.

**Mitigations & Recommendations:**

- **Enforce Separation of Duties**: Organizations should deliberately partition roles across distinct keys:
  - Assign `Role::CreateProposal` (`Proposer`) to operational team members or automated ingestion pipelines (governed by spending limits).
  - Restrict `Role::ApproveProposal` (`Approver`) exclusively to hardware-wallet or air-gapped signing keys held by designated multisig owners.
  - Assign `Role::ExecuteProposal` (`Executor`) to automated keeper bots or non-custodial relayers that possess no proposing or voting permissions.
- **Single-Owner Weight Cap (`MAX_SINGLE_OWNER_WEIGHT_PCT`)**: The contract enforces a 50% default cap on any single owner's voting weight at both creation and execution of `ChangeOwnerWeight` proposals, preventing any single key from legitimately acquiring unilateral quorum via governance proposals.
- **Post-Migration Role Pruning**: Deployers should treat `DEFAULT_OWNER_ROLES` as an initial bootstrap state. Once dedicated proposers and execution keepers are operational, owners should submit and approve `create_revoke_role_proposal` calls to strip `Proposer` and `Executor` from owner voting keys, reducing each owner key's blast radius to voting only.

#### Role-Revocation Lockout Risk (Stranded Quorum)

**Attack Scenario:** Roles are granted and revoked via `create_grant_role_proposal` and `create_revoke_role_proposal` (executing `ProposalKind::GrantRole` and `ProposalKind::RevokeRole`). If `Role::ApproveProposal` is revoked from one or more owners such that the total voting weight of the remaining owners holding the Approver role falls below the active contract `threshold`:

$$
\sum_{\text{owner} \in \text{Approvers}} \text{weight}(\text{owner}) < \text{threshold}
$$

the multisig enters a state of **Stranded Quorum (Deadlock)**.

**Impact:**

- Because [`approve`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L2537) strictly requires `require_role(&env, &approver, Role::ApproveProposal)`, owners who have had their Approver role revoked cannot cast approvals.
- If total remaining Approver weight is less than `threshold`, no future proposal can ever accumulate enough approvals to reach `ProposalStatus::Ready`.
- In-flight `Pending` proposals may become permanently un-quorumable if their snapshotted `quorum_weight` cannot be met by remaining approvers.
- Because role restoration itself requires passing a `create_grant_role_proposal` through the standard proposal lifecycle, the multisig cannot self-heal via normal proposal execution once Approver weight drops below threshold.

**Mitigations & Quorum-Safety Guards:**

- **Operational Quorum-Safety Verification**:
  - Unlike `remove_owner` (which programmatically validates that the resulting total weight remains $\ge \text{threshold}$ and rejects proposals that would leave active proposals un-quorumable with `ContractError::WouldBreakThreshold`), role revocation proposals operate at the permission layer.
  - **Signer Invariant Check**: Prior to creating or approving any `create_revoke_role_proposal` targeting `Role::ApproveProposal`, signers must verify:
    1. The remaining Approver weight satisfies:
       $$
       \left(\sum_{\text{owner} \in \text{Approvers}} \text{weight}(\text{owner})\right) - \text{weight}(\text{target\_owner}) \ge \text{current\_threshold}
       $$
    2. Active proposals remain quorumable: Ensure no `Pending` or `Ready` proposals have `quorum_weight` exceeding the resulting Approver weight.
  - If a planned Approver revocation would drop weight below threshold, operators must first lower the threshold via a `ChangeThreshold` proposal before executing the role revocation.
- **Emergency Governance Fail-Safe (Role-Bypassing Recovery)**:
  - Critical administrative recovery entrypoints do **not** depend on `Role::ApproveProposal` or the proposal lifecycle:
    - [`upgrade`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L1730)
    - `set_guardian`
    - `unfreeze`
    - `migrate_to_rbac`
  - These entrypoints bypass `require_role` entirely and validate multi-owner authorization via [`require_weighted_approvers`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L1354) directly against the raw owner map.
  - If a multisig's proposal pipeline is deadlocked due to accidental Approver role revocation, registered owners can coordinate out-of-band to execute an emergency [`upgrade`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L1730) using direct co-signatures to deploy updated logic or restore role state, ensuring contract control is never permanently lost.

### Residual Risks

The following risks are currently unmitigated by the protocol design:

- **No SOS Recovery**: If enough owner keys are lost, there is no emergency "recovery" mode; the funds remain locked if the threshold cannot be met.
- **Opt-in Spending Limits**: Per-owner, per-token spending limits exist via `SetSpendingLimit` proposals and are enforced at proposal creation (against a fixed 30-day spending window). They are not applied by default, however: an owner with no configured limit for a token can still propose any amount up to the treasury balance once the threshold is reached, so unrestricted tokens remain gated only by the approval threshold.
- **The Validation Gap**: A token contract could be upgraded to malicious code between a proposal's creation (where it is validated) and its execution.
- **Opt-in initialization weight review**: `initialize` enforces per-owner weight bounds and rejects a mismatched owners/weights length, but applies no cap on how concentrated the _initial_ weight distribution may be, and no cap prevents a colluding group of owners from accumulating a combined majority share through a sequence of individually-compliant `ChangeOwnerWeight` proposals after deployment (see "Weighted Governance Threat Model Addendum" above). Both are currently the deployer's and owners' operational responsibility rather than an on-chain guarantee.
- **Role-Revocation Quorum Stranding**: While owner removals strictly enforce `WouldBreakThreshold` and `WouldBreakQuorum` at both creation and execution, revoking the `Approver` role from owners relies on operational verification that remaining Approver weight meets `threshold`. If Approver roles are revoked below `threshold`, regular proposal progression stalls until restored by owners via an emergency upgrade or role re-grant.

## Responsible Disclosure

**Do not open a public GitHub issue for a security vulnerability.**

To report a security issue:

1. Navigate to the GitHub repository's **Security** tab.
2. Click **"Report a vulnerability"** to open a private advisory.
3. Describe the issue clearly: affected function(s), reproduction steps, and potential impact.

We aim to acknowledge reports within 72 hours and publish a fix within 14 days for confirmed Critical/High issues.

## In-Scope

- `contracts/accord/src/lib.rs` — the on-chain contract
- Contract ↔ frontend integration (authentication bypass, event spoofing)
- Denial-of-service patterns that make funds permanently inaccessible

## Out-of-Scope

- Stellar protocol-level issues (report to Stellar Development Foundation)
- Frontend-only UI bugs with no on-chain consequence
- Issues in third-party libraries we depend on (report upstream)

---

## Operational Runbooks

Operational runbooks provide step-by-step procedures for handling critical security events and emergency operations:

- [Incident Response Runbook](./runbooks/INCIDENT_RESPONSE.md): Severity classification, emergency containment (`freeze`, `enter_recovery`), escalation paths, evidence preservation, and post-incident reviews.
- [Upgrade Rollback Runbook](./runbooks/UPGRADE_ROLLBACK.md): Identifying flawed deployments, rolling back in-place WASM, and verifying state consistency.
- [Key Rotation Runbook](./runbooks/KEY_ROTATION.md): Step-by-step replacement of owner keys and guardian address using on-chain governance.
- [Runbooks Index](./runbooks/README.md): Comprehensive listing and operational prerequisites.

