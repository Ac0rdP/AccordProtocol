# Runbook: Upgrade Rollback

This runbook defines the operational procedure for diagnosing a failed or buggy smart contract deployment on Accord Protocol and rolling back the contract WASM bytecode in-place using Soroban's native deployer capabilities.

---

## 1. Prerequisites and Required Access

Before initiating an upgrade rollback, verify:

- **Target Contract ID**: `<contract-id>`.
- **Previous WASM Artifact & Hash**:
  - Pinned Git commit of the last known-good release: `<previous-commit-sha>`.
  - Retained compiled bytecode file: `target/wasm32v1-none/release/accord_v<prev>.wasm`.
  - 32-byte hex hash of the previous WASM: `<previous-wasm-hash>` (e.g. from `wasm-manifest.json` or deployment records).
- **Previous WASM Ledger-Entry Lifetime**:
  - The previous WASM bytecode must exist on-chain in an active (unexpired) `ContractCode` ledger entry. If its TTL has expired, it must be re-uploaded before invoking `upgrade`.
- **Multisig Approver Access**:
  - A set of distinct registered multisig owner accounts whose combined voting weight reaches or exceeds the current `threshold`: `["<approver-1>", "<approver-2>", ...]`.
  - Each approver must be prepared to co-authorize the rollback transaction.
- **Guardian Access**: `<guardian-signer>` (optional but recommended if immediate containment is needed before consensus on rollback).

> [!CAUTION]
> **Secrets Handling Policy**: Never paste private keys, seed phrases, or credentials into chat channels, issues, or command histories. Ensure all signing takes place through local secure environments or hardware signing prompts.

---

## 2. Recognizing a Flawed Deployment

A contract upgrade must be flagged for rollback triage if any of the following symptoms occur immediately following an `upgrade` invocation:

1. **Transaction Reversion on Core Entrypoints**:
   - Standard calls to `create_proposal`, `approve`, `revoke`, or `execute` trap or return unexplained host or VM errors.
2. **Storage Deserialization Failures**:
   - Reading existing proposals or owner lists via view functions (`get_proposal`, `get_owners`, `get_threshold`) fails with storage decoding errors.
3. **Indexer Reconciliation Drift**:
   - The treasury indexer logs continuous reconciliation errors (`accord_reconciliation_drift != 0`) due to unparseable event payloads or dropped event fields.
4. **Version Discrepancies**:
   - `get_version()` or `get_storage_version()` reports unexpected numbers or panics.

---

## 3. Decision Points: Containment vs. Rollback

```text
               Flawed Upgrade Detected
                         │
        Is funds security immediately at risk?
                 ├── YES ──► Guardian invokes freeze() or enter_recovery()
                 │           (Immediate containment; blocks rogue execution)
                 │                   │
                 └── NO ─────────────┘
                         │
       Did the flawed version modify storage schema
            or write corrupt persistent state?
                 ├── YES ──► STOP. Execute Step 4.2 (Storage Analysis)
                 │           Assess schema compatibility before WASM revert.
                 │
                 └── NO ───► Proceed immediately to Step 4.3
                             (WASM In-Place Rollback)
```

---

## 4. Step-by-Step Rollback Procedure

### Step 4.1: Optional Containment (Freeze)

If the flawed WASM exposes an exploitable bug or unauthorized transfer vector, immediately freeze the contract.

*Who does this*: The **Guardian** (`<guardian-signer>`).
*Entrypoint*: `freeze(guardian: Address)`

```bash
stellar contract invoke \
  --network "<network>" \
  --source-account "<guardian-signer>" \
  --id "<contract-id>" \
  -- freeze \
  --guardian "<guardian-address>"
```
*Verification*: `is_frozen` returns `true`.

---

### Step 4.2: Storage Layout & Compatibility Check

Before replacing bytecode, determine if the flawed version wrote incompatible state:

1. **Check Storage Version**:
   ```bash
   stellar contract invoke \
     --network "<network>" \
     --source-account "<any-account>" \
     --id "<contract-id>" \
     -- get_storage_version
   ```
2. **Compatibility Analysis**:
   - If the previous contract was `STORAGE_SCHEMA_VERSION = 1` and the flawed version did NOT alter instance or persistent keys, rolling back WASM is **safe and transparent**.
   - If the flawed contract wrote new keys or mutated key structures, rolling back the bytecode might cause the older WASM to fail when deserializing mutated entries. If new proposals were written with new fields, consider cancelling those proposals before reverting code.

---

### Step 4.3: Verify or Re-Upload Previous WASM

The Soroban deployer requires that the bytecode for `<previous-wasm-hash>` resides on the ledger.

1. **Verify Local Hash**:
   ```bash
   shasum -a 256 target/wasm32v1-none/release/accord_v<prev>.wasm
   ```
   *Expected Result*: Must match `<previous-wasm-hash>` character-for-character.

2. **Verify / Refresh On-Chain WASM Existence**:
   If the previous WASM was deployed long ago and its bytecode entry TTL may have expired:
   ```bash
   stellar contract upload \
     --network "<network>" \
     --source-account "<approver-1>" \
     --wasm target/wasm32v1-none/release/accord_v<prev>.wasm
   ```
   *Expected Result*: The CLI outputs the WASM hash matching `<previous-wasm-hash>`.

---

### Step 4.4: Execute Rollback Upgrade

*Who does this*: Multisig owners whose combined voting weight reaches `threshold`.
*Entrypoint*: `upgrade(approvers: Vec<Address>, new_wasm_hash: BytesN<32>)`
*Effect*: In-place bytecode replacement via `env.deployer().update_current_contract_wasm(new_wasm_hash)`. Emits `UpgradeExecutedEvent { caller, new_wasm_hash, version: 1 }`. Storage entries remain untouched.

**Execution Command**:
```bash
stellar contract invoke \
  --network "<network>" \
  --source-account "<approver-1>" \
  --id "<contract-id>" \
  -- upgrade \
  --approvers '["<approver-1>", "<approver-2>"]' \
  --new_wasm_hash "<previous-wasm-hash>"
```
*(Every co-signer specified in `--approvers` must provide their cryptographic signature).*

---

### Step 4.5: Post-Rollback State Verification

Verify all core view functions and state structures:

1. **Verify Contract Version**:
   ```bash
   stellar contract invoke \
     --network "<network>" \
     --source-account "<any-account>" \
     --id "<contract-id>" \
     -- get_version
   ```
   *Expected Result*: Returns the previous version number (e.g. `1`).

2. **Verify Storage Version**:
   ```bash
   stellar contract invoke \
     --network "<network>" \
     --source-account "<any-account>" \
     --id "<contract-id>" \
     -- get_storage_version
   ```
   *Expected Result*: Returns the expected previous schema version (e.g. `1`).

3. **Verify Governance Invariants**:
   - `get_owners`: returns the correct owner list.
   - `get_threshold`: returns the active threshold.
   - `get_total_weight`: returns total weight matching owner weights sum.
   - `get_total_proposals`: returns correct proposal counter.

4. **Verify Proposal Deserialization**:
   Read the latest proposal:
   ```bash
   stellar contract invoke \
     --network "<network>" \
     --source-account "<any-account>" \
     --id "<contract-id>" \
     -- get_proposal \
     --proposal_id <latest-id>
   ```
   *Expected Result*: Deserializes cleanly without error.

---

### Step 4.6: Unfreeze (if previously frozen)

If Step 4.1 was executed, unfreeze the contract once state verification succeeds:

```bash
stellar contract invoke \
  --network "<network>" \
  --source-account "<approver-1>" \
  --id "<contract-id>" \
  -- unfreeze \
  --approvers '["<approver-1>", "<approver-2>"]'
```
*Verification*: `is_frozen` returns `false`.

---

## 5. Abort and Escalation Points

- **Missing Approver Quorum**: If owners cannot reach threshold weight to co-authorize `upgrade`, the rollback cannot proceed on-chain. If frozen, the contract remains protected while signers coordinate out-of-band.
- **Bytecode Re-Upload Failure**: If `stellar contract upload` fails due to network or account resource constraints, resolve fee or funding issues on the source account first.
- **Corrupt Storage Incompatibility**: If post-rollback view queries return `ContractError` or panic due to unparseable state written during the bad deploy, escalate to emergency contract migration (re-deploying a fresh instance and migrating assets via governance transfer if feasible).

---

## 6. Verification Checklist

- [ ] Previous WASM hash independently verified against git commit and build artifact.
- [ ] On-chain WASM bytecode entry confirmed active or refreshed via upload.
- [ ] Multisig approvers meeting threshold co-signed the `upgrade` invocation.
- [ ] `UpgradeExecutedEvent` emitted and recorded.
- [ ] `get_version` and `get_storage_version` return expected rollback targets.
- [ ] Existing proposals and owner weight maps read cleanly without error.
- [ ] Contract unfreezes successfully and resumes normal operations.

---

## 7. Dry Run & Verification Log

- **Date**: 2026-10-18
- **Environment**: Code and script review against `contracts/accord/src/lib.rs` (`upgrade`, `STORAGE_SCHEMA_VERSION`, `bump_instance`, `require_weighted_approvers`), `scripts/deploy.sh`, and `docs/UPGRADE_SAFETY.md`.
- **Review Scope**: Checked `upgrade` entrypoint mechanics:
  - Takes `approvers: Vec<Address>` and `new_wasm_hash: BytesN<32>`.
  - Verifies `require_weighted_approvers(&env, &approvers)?`.
  - Calls `env.deployer().update_current_contract_wasm(new_wasm_hash)`.
  - Emits `UpgradeExecutedEvent { version: 1, caller, new_wasm_hash }`.
  - Verified that there is no timelock on `upgrade()`; it executes synchronously within the transaction.
- **Gaps Identified & Documented**:
  - Emphasized the critical requirement to retain the previous WASM hash and ensure its bytecode entry TTL has not expired on the network.
  - Clarified that if the flawed WASM introduced storage layout mutations, rollback alone might encounter deserialization issues unless handled carefully.
- **Human Drill Requirements**: Simulated in-place upgrade and rollback drills should be executed in a testnet sandbox prior to major mainnet migrations.
