# Accord Protocol — Operational Runbooks

This directory contains standardized, step-by-step operational runbooks for emergency response, contract lifecycle management, and administrative key maintenance for Accord Protocol on Stellar Soroban.

---

## Directory Index

| Runbook | Primary Trigger / Scenario | Key Entrypoints Used | Authorizing Roles |
|---|---|---|---|
| [Incident Response](./INCIDENT_RESPONSE.md) | Suspected exploit, malicious proposal, key compromise, abnormal outflow | `freeze`, `enter_recovery`, `unfreeze`, `exit_recovery`, `revoke` | Guardian, Multisig Owners (Threshold) |
| [Upgrade Rollback](./UPGRADE_ROLLBACK.md) | Flawed contract upgrade, unexpected reverts, data schema incompatibility | `upgrade`, `freeze`, `get_version`, `get_storage_version` | Multisig Owners (Threshold), Guardian |
| [Key Rotation](./KEY_ROTATION.md) | Scheduled signer rotation, compromised signer replacement, guardian handover | `create_add_owner_proposal`, `create_remove_owner_proposal`, `set_guardian`, `approve`, `execute` | Multisig Owners (Threshold) |

---

## General Operating Principles

1. **Strict Secrets Policy**:
   - **Never** paste private keys, seed phrases, secret seed keys (`S...`), API tokens, or session tokens into chat channels, issue trackers, tickets, emails, shell history, or CI/CD logs.
   - Use environment variables or hardware wallet prompts when interacting via the Stellar CLI.
   - If a private key is ever exposed in any communication channel or log, treat it as compromised immediately and execute the [Key Rotation Runbook](./KEY_ROTATION.md).

2. **Grounded in On-Chain Logic**:
   - These procedures reflect the real smart contract capabilities implemented in `contracts/accord/src/lib.rs`.
   - Accord has no central admin key or unilateral pause button. Emergency containment is split between the configured **Guardian** (`freeze`, `enter_recovery`) and the **Multisig Owners** who hold voting weight meeting or exceeding `threshold` (`unfreeze`, `exit_recovery`, `upgrade`, `set_guardian`, and proposal execution).

3. **Verification Before and After**:
   - Every action must be verified against current ledger state before moving to the next step.
   - Use simulation queries (`get_proposal`, `is_frozen`, `is_in_recovery`, `get_owners`, `get_threshold`) to confirm status transitions.

4. **Placeholders**:
   - All addresses, endpoints, and contacts in these documents use `<placeholder>` formatting (e.g. `<contract-id>`, `<guardian-address>`, `<security-contact>`). Substitute with authorized organizational values during an incident.
