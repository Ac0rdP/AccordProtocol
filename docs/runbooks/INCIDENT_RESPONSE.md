# Runbook: Incident Response

This runbook establishes standard operating procedures for identifying, triaging, containing, remediating, and investigating security incidents involving the Accord Protocol smart contract (`contracts/accord/src/lib.rs`) and treasury operations.

---

## 1. Prerequisites and Required Access

Before executing any emergency containment action, ensure the operator has:

- **Stellar CLI** installed and configured for the target network (Testnet or Mainnet).
- Network RPC endpoint: `<rpc-endpoint>` (e.g. `https://soroban-testnet.stellar.org` or authorized private RPC).
- Target Contract ID: `<contract-id>`.
- Guardian signing key or hardware wallet: `<guardian-signer>` (required for `freeze` and `enter_recovery`).
- Multisig owner signing keys: distinct registered owners whose aggregate voting weight reaches or exceeds `threshold` (required for `unfreeze`, `exit_recovery`, and governance proposals).
- Communication bridge: secured, out-of-band communication channel `<incident-war-room>` (e.g. encrypted Signal group or dedicated incident Slack channel).

> [!CAUTION]
> **Secrets Handling Policy**: Never paste secret keys, seed phrases, private tokens, or credentials into incident tickets, chat rooms, terminal history, or public logs. Use environment variables (`STELLAR_SECRET_KEY`) or secure hardware key prompts.

---

## 2. Severity Classification

| Level | Classification | Impact Definition | Initial Response SLA | Containment Target |
|---|---|---|---|---|
| **SEV-1** | **Critical** | Active unauthorized treasury drain, confirmed vulnerability actively being exploited, or compromise of >= threshold owner keys. | Immediate (< 15 minutes) | Full Freeze (`freeze`) within 30 minutes |
| **SEV-2** | **High** | Single owner key compromise, guardian key compromise, malicious unexecuted proposal approved, or unexpected contract execution revert blocking valid transfers. | < 1 hour | Enter Recovery (`enter_recovery`) or Freeze |
| **SEV-3** | **Medium** | Indexer balance drift, frontend RPC desynchronization, spam proposal griefing (approaching 50 active proposal cap). | < 4 hours | Proposal cancellation (`cancel_expired`) / Indexer replay |
| **SEV-4** | **Low** | Minor UI display bug, event parser warning, non-critical documentation discrepancy. | Next business day | Standard ticket and patch cycle |

---

## 3. Detection and Triage Flow

When an alert fires or an anomalous event is reported, answer these four triage questions:

1. **Are funds actively moving out of the contract?**
   - Check contract token balances against recent `execute` or `rpay` events.
   - *If YES*: Immediately trigger **SEV-1** and execute [Step 4.1: Full Contract Freeze](#step-41-full-contract-freeze).

2. **Is a compromised key suspected?**
   - Did an owner or guardian report unauthorized transactions, lost devices, or credential leakage?
   - *If Guardian Compromised*: Proceed to [Key Rotation Runbook](./KEY_ROTATION.md#step-2-guardian-rotation) to execute `set_guardian`.
   - *If Owner Key Compromised*: Execute [Step 4.2: Enter Recovery Mode](#step-42-enter-recovery-mode) to halt outflows while keeping governance proposals open.

3. **Are unauthorized proposals currently pending or approved?**
   - Run `get_proposals_paged` or inspect active IDs via RPC.
   - Check if any suspicious proposal has reached `Ready` status.
   - *If pending*: Execute [Step 4.3: Revoke Approval](#step-43-revoke-approval) or [Step 4.4: Cancel Expired Proposals](#step-44-cancel-expired-proposals).

4. **Is the issue an on-chain failure or an off-chain indexer/frontend drift?**
   - Query the contract directly via `simulateTransaction` using the Stellar CLI. If contract state is correct but the UI or indexer is wrong, escalate to the off-chain maintenance team (see `docs/RUNBOOK.md`).

---

## 4. Emergency Containment Procedures

### Step 4.1: Full Contract Freeze

*Who does this*: The configured **Guardian** (`<guardian-signer>`).
*When to use*: SEV-1 active exploit or systemic vulnerability where all contract activity must halt immediately.
*Contract entrypoint*: `freeze(guardian: Address)`
*Effect*: Sets `FROZEN = true`. Blocks all calls to `create_proposal*`, `approve`, `revoke`, `execute`, and recurring payment disbursements. Emits `FrozenEvent { guardian, version: 1 }`.

**Execution Command**:
```bash
stellar contract invoke \
  --network "<network>" \
  --source-account "<guardian-signer>" \
  --id "<contract-id>" \
  -- freeze \
  --guardian "<guardian-address>"
```

**Verification**:
```bash
stellar contract invoke \
  --network "<network>" \
  --source-account "<any-account>" \
  --id "<contract-id>" \
  -- is_frozen
```
*Expected Result*: Output returns `true`. Any attempt to call `create_proposal` or `execute` returns `ContractError::ContractFrozen (code 26)`.

---

### Step 4.2: Enter Recovery Mode

*Who does this*: The configured **Guardian** (`<guardian-signer>`).
*When to use*: SEV-2 single-owner compromise, suspected rogue transfer proposal, or recurring schedule anomaly.
*Contract entrypoint*: `enter_recovery(guardian: Address)`
*Effect*: Sets `RECOV = true`. Treasury transfer executions (`execute` for `Transfer` kinds) and recurring disbursements (`disburse_recurring`) are immediately blocked and return `ContractError::RecoveryActive (code 57)`. **Governance proposals (adding/removing owners, changing threshold, roles, and limits) remain fully executable** so owners can remediate the compromise without lifting the outflow lock! Emits `RecoveryEnteredEvent { guardian, version: 1 }`.

**Execution Command**:
```bash
stellar contract invoke \
  --network "<network>" \
  --source-account "<guardian-signer>" \
  --id "<contract-id>" \
  -- enter_recovery \
  --guardian "<guardian-address>"
```

**Verification**:
```bash
stellar contract invoke \
  --network "<network>" \
  --source-account "<any-account>" \
  --id "<contract-id>" \
  -- is_in_recovery
```
*Expected Result*: Output returns `true`. Transfer execution returns error 57 (`RecoveryActive`), while governance proposals can be approved and executed normally.

---

### Step 4.3: Revoke Approval

*Who does this*: Any registered owner who previously approved a proposal that is now suspected.
*When to use*: An unauthorized proposal is in `Pending` or `Ready` state and must be stopped before execution.
*Contract entrypoint*: `revoke(approver: Address, proposal_id: u64)`
*Effect*: Deducts the approver's voting weight from the proposal's cumulative approval weight. If approvals drop below `quorum_weight`, proposal status reverts from `Ready` to `Pending`. Emits `ProposalRevokedEvent`.

**Execution Command**:
```bash
stellar contract invoke \
  --network "<network>" \
  --source-account "<owner-signer>" \
  --id "<contract-id>" \
  -- revoke \
  --approver "<owner-address>" \
  --proposal_id <proposal-id>
```

**Verification**:
```bash
stellar contract invoke \
  --network "<network>" \
  --source-account "<any-account>" \
  --id "<contract-id>" \
  -- get_proposal \
  --proposal_id <proposal-id>
```
*Expected Result*: `status` returns `"Pending"` or approvals show decreased weight.

---

### Step 4.4: Cancel Expired Proposals

*Who does this*: Any caller (public entrypoint).
*When to use*: An attacker is attempting to fill the `MAX_ACTIVE_PROPOSALS` cap (50 proposals) to grief the multisig.
*Contract entrypoint*: `cancel_expired(caller: Address, ids: Vec<u64>)`
*Effect*: Transitions expired proposals (`deadline < ledger_timestamp` and not `Executed`) to `Expired`, freeing active proposal slots.

**Execution Command**:
```bash
stellar contract invoke \
  --network "<network>" \
  --source-account "<caller-signer>" \
  --id "<contract-id>" \
  -- cancel_expired \
  --caller "<caller-address>" \
  --ids '[<expired-id-1>, <expired-id-2>]'
```

**Verification**:
Query `get_proposals_paged` or observe returned count of cancelled proposals.

---

## 5. Escalation and Communication Pathways

During a SEV-1 or SEV-2 incident, appoint specific roles:

1. **Incident Commander (IC)**: Coordinates overall response, directs containment actions, and logs timeline.
2. **Security Investigator**: Conducts bytecode, transaction, and RPC log analysis.
3. **Signer Coordinator**: Communicates with multisig owners to gather co-signatures out of band.
4. **Communications Lead**: Prepares internal and external notifications.

**Communication Templates**:
- *Internal Alert*: `"SEV-[1/2] declared for Accord treasury <contract-id>. Containment action [freeze/enter_recovery] executed at ledger <ledger-sequence>. War room: <war-room-url>."`
- *External Notice (if funds impacted)*: Publish verified facts only. Never speculate on exploit mechanics until verified.

---

## 6. Evidence Preservation

Do not wipe or overwrite test scripts, environment logs, or node state:

1. **Capture Chain State**:
   ```bash
   # Snapshot contract instance and persistent entries
   stellar contract read --id "<contract-id>" --network "<network>" > incident_storage_snapshot.json
   ```
2. **Collect Recent Events**:
   Query Soroban RPC `getEvents` for the contract over the affected ledger range.
3. **Save Transaction Hashes**:
   Log all suspicious transaction hashes and the corresponding ledger sequences.

---

## 7. Recovery and Resumption

Once the root cause is resolved (e.g. compromised owner removed via [Key Rotation Runbook](./KEY_ROTATION.md), or bug patched via [Upgrade Rollback Runbook](./UPGRADE_ROLLBACK.md)):

### Step 7.1: Exit Recovery Mode

*Who does this*: Distinct registered owners whose combined weight reaches `threshold`.
*Contract entrypoint*: `exit_recovery(approvers: Vec<Address>)`
*Effect*: Sets `RECOV = false`. Restores normal treasury transfer capability. Emits `RecoveryExitedEvent`.

**Execution Command**:
```bash
stellar contract invoke \
  --network "<network>" \
  --source-account "<approver-1>" \
  --id "<contract-id>" \
  -- exit_recovery \
  --approvers '["<approver-1>", "<approver-2>"]'
```
*(All co-signers in `approvers` must authorize the invocation).*

**Verification**:
`is_in_recovery` returns `false`.

---

### Step 7.2: Unfreeze Contract

*Who does this*: Distinct registered owners whose combined weight reaches `threshold`.
*Contract entrypoint*: `unfreeze(approvers: Vec<Address>)`
*Effect*: Sets `FROZEN = false`. Restores proposal creation, voting, and execution. Emits `UnfrozenEvent`.

**Execution Command**:
```bash
stellar contract invoke \
  --network "<network>" \
  --source-account "<approver-1>" \
  --id "<contract-id>" \
  -- unfreeze \
  --approvers '["<approver-1>", "<approver-2>"]'
```

**Verification**:
`is_frozen` returns `false`. Normal operations resume.

---

## 8. Abort / Rollback Points

- If during containment `freeze` or `enter_recovery` fails with `Unauthorized` (Error 3) or `NoGuardian` (Error 27), the guardian key is either wrong or not initialized. Immediately pivot to multisig owners to invoke `set_guardian`.
- If owners cannot reach quorum to unfreeze, the contract remains safely locked. **Do not attempt repeated brute-force invocations**; coordinate key recovery offline.

---

## 9. Post-Incident Review (PIR) Checklist

Within 48 hours of resolving a SEV-1 or SEV-2 incident:

- [ ] Complete chronological timeline of events (detection to full resumption).
- [ ] Determine root cause: smart contract bug, key compromise, external token behavior, or off-chain dependency.
- [ ] Document all funds impacted, recovered, or lost.
- [ ] Evaluate containment response time against SLAs.
- [ ] Track corrective action items (code patches, test coverage additions, runbook updates) with assigned owners and deadlines.
- [ ] Publish public post-mortem if user or external funds were affected.

---

## 10. Dry Run & Verification Log

- **Date**: 2026-10-18
- **Environment**: Static verification against `contracts/accord/src/lib.rs` and unit test suite `contracts/accord/src/test.rs`.
- **Review Scope**: Checked `freeze`, `unfreeze`, `enter_recovery`, `exit_recovery`, `revoke`, `cancel_expired` entrypoint signatures, authorization checks (`guardian.require_auth()`, `require_weighted_approvers()`), error codes (26 `ContractFrozen`, 27 `NoGuardian`, 57 `RecoveryActive`, 3 `Unauthorized`), and event schemas.
- **Gaps Identified & Documented**:
  - Confirmed the contract does NOT have a general `pause()` entrypoint; emergency controls are specifically `freeze(guardian)` and `enter_recovery(guardian)`.
  - Confirmed `enter_recovery` leaves governance proposals executable by design, providing an essential operational bridge during key remediation.
- **Human Drill Requirements**: A live testnet drill with multiple hardware key signers co-authorizing `exit_recovery` and `unfreeze` should be conducted quarterly.
