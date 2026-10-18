# Runbook: Key Rotation

This runbook provides step-by-step procedures for rotating multisig owner keys and replacing the guardian address for the Accord Protocol smart contract (`contracts/accord/src/lib.rs`).

---

## 1. Prerequisites and Required Access

Before beginning a key rotation:

- **Target Contract ID**: `<contract-id>`.
- **Active Multisig Signers**: Access to existing owner signing keys with combined voting weight reaching or exceeding `threshold`.
- **New Key Material**:
  - Valid Stellar public key for the new owner or guardian: `<new-address>` (must be a valid G... address or contract C... address).
  - Verify that the private key or hardware device for `<new-address>` is initialized, secured, and ready to sign.
- **Network Configuration**: Stellar CLI configured with the target RPC endpoint (`<rpc-endpoint>`) and network passphrase.

> [!CAUTION]
> **Secrets Handling Policy**: Never transmit secret keys, seed phrases, or backup recovery keys via chat, email, ticketing systems, or shell history. All signing must occur locally on secure workstations or hardware wallets.

---

## 2. Architectural Realities and Governance Gaps

Operators must understand the on-chain mechanics implemented in `contracts/accord/src/lib.rs`:

1. **No Atomic Owner Swap**:
   - The contract does NOT provide a single atomic `rotate_owner(old, new)` function.
   - Owner rotation is a **two-step governance process**:
     1. Submit, approve, and execute an `AddOwner` proposal for the new key.
     2. Submit, approve, and execute a `RemoveOwner` proposal for the outgoing key.
   - Performing the steps in this order ensures that the multisig threshold and quorum are never broken during the transition.

2. **Weight and Cap Invariants**:
   - Every owner must have weight `>= 1` (`MIN_OWNER_WEIGHT`).
   - Maximum owners is 20 (`MAX_OWNERS`).
   - No single owner may hold more than 50% of the total voting weight (`MAX_SINGLE_OWNER_WEIGHT_PCT = 50%`). An `AddOwner` or `ChangeOwnerWeight` proposal violating this cap fails with `ContractError::SingleOwnerWeightCapExceeded (code 46)`.
   - Removing an owner must not cause the remaining total weight to drop below `threshold` (`WouldBreakQuorum` / `WouldBreakThreshold`, error 48 / 24).
   - The last remaining owner cannot be removed (`CannotRemoveLastOwner`, error 49).

3. **Guardian Rotation is Direct Co-Signed Governance**:
   - Unlike owner changes, updating the guardian does NOT use a proposal.
   - It is executed directly via `set_guardian(approvers, new_guardian)`, requiring a threshold of distinct registered owners to co-authorize a single transaction.

---

## 3. Procedure: Multisig Owner Rotation

### Step 3.1: Pre-Flight State Assessment

Check current owners, threshold, and total voting weight:

```bash
# 1. Query current owners
stellar contract invoke \
  --network "<network>" \
  --source-account "<any-account>" \
  --id "<contract-id>" \
  -- get_owners

# 2. Query threshold
stellar contract invoke \
  --network "<network>" \
  --source-account "<any-account>" \
  --id "<contract-id>" \
  -- get_threshold

# 3. Query total weight
stellar contract invoke \
  --network "<network>" \
  --source-account "<any-account>" \
  --id "<contract-id>" \
  -- get_total_weight
```
*Expected Result*: Confirm that adding the new owner's weight will not exceed the 50% single-owner weight cap or exceed 20 owners total.

---

### Step 3.2: Create `AddOwner` Proposal

*Who does this*: Any current owner holding the `Proposer` role.
*Entrypoint*: `create_add_owner_proposal(proposer, new_owner, weight, description, deadline, category)`

```bash
stellar contract invoke \
  --network "<network>" \
  --source-account "<proposer-owner>" \
  --id "<contract-id>" \
  -- create_add_owner_proposal \
  --proposer "<proposer-owner-address>" \
  --new_owner "<new-owner-address>" \
  --weight <assigned-weight> \
  --description "Add replacement signer <new-owner-address>" \
  --deadline <future-unix-timestamp> \
  --category "Ops"
```
*Verification*: The invocation returns the newly created proposal ID `<add-proposal-id>`. Emits `ProposalCreatedEvent`.

---

### Step 3.3: Approve and Execute `AddOwner` Proposal

1. **Collect Approvals** from owners until cumulative weight reaches `threshold`:
   ```bash
   stellar contract invoke \
     --network "<network>" \
     --source-account "<approver-owner>" \
     --id "<contract-id>" \
     -- approve \
     --approver "<approver-owner-address>" \
     --proposal_id <add-proposal-id>
   ```
2. **Execute Proposal** once status transitions to `Ready`:
   ```bash
   stellar contract invoke \
     --network "<network>" \
     --source-account "<executor-owner>" \
     --id "<contract-id>" \
     -- execute \
     --executor "<executor-owner-address>" \
     --proposal_id <add-proposal-id>
   ```
*Verification*: Emits `AddOwnerExecutedEvent { new_owner, owner_count, version: 1 }`. Verify with `is_owner(new_owner)` returning `true`.

---

### Step 3.4: Validate New Owner Signing Capability

Before removing the old owner, have the new owner sign a lightweight on-chain test or participate in an approval vote. Confirm that the new key can sign and that its transactions are accepted by the network.

---

### Step 3.5: Create `RemoveOwner` Proposal

*Who does this*: Any current owner holding the `Proposer` role.
*Entrypoint*: `create_remove_owner_proposal(proposer, owner_to_remove, description, deadline, category)`

```bash
stellar contract invoke \
  --network "<network>" \
  --source-account "<proposer-owner>" \
  --id "<contract-id>" \
  -- create_remove_owner_proposal \
  --proposer "<proposer-owner-address>" \
  --owner_to_remove "<old-owner-address>" \
  --description "Decommission departed signer <old-owner-address>" \
  --deadline <future-unix-timestamp> \
  --category "Ops"
```
*Verification*: Returns proposal ID `<remove-proposal-id>`.

---

### Step 3.6: Approve and Execute `RemoveOwner` Proposal

1. **Collect Approvals** from owners (the new owner may now participate as an approver):
   ```bash
   stellar contract invoke \
     --network "<network>" \
     --source-account "<approver-owner>" \
     --id "<contract-id>" \
     -- approve \
     --approver "<approver-owner-address>" \
     --proposal_id <remove-proposal-id>
   ```
2. **Execute Proposal**:
   ```bash
   stellar contract invoke \
     --network "<network>" \
     --source-account "<executor-owner>" \
     --id "<contract-id>" \
     -- execute \
     --executor "<executor-owner-address>" \
     --proposal_id <remove-proposal-id>
   ```
*Verification*: Emits `RemoveOwnerExecutedEvent { removed_owner, owner_count, version: 1 }`. Verify with `is_owner(old_owner)` returning `false`.

---

### Step 3.7: Optional Threshold Adjustment

If the rotation changed total weight or owner count such that the approval threshold should be adjusted:
Submit, approve, and execute a proposal using `create_change_threshold_proposal(proposer, new_threshold, description, deadline, category)`.

---

## 4. Procedure: Guardian Key Rotation

The Guardian holds critical emergency powers (`freeze` and `enter_recovery`). If the guardian key is compromised or the designated custodian changes, rotate the guardian address immediately.

### Step 4.1: Direct Co-Signed Governance Invocation

*Who does this*: Distinct registered multisig owners whose combined voting weight reaches or exceeds `threshold`.
*Entrypoint*: `set_guardian(approvers: Vec<Address>, new_guardian: Address)`
*Effect*: Overwrites the `GUARD` instance storage key with `<new-guardian-address>`. Emits `GuardianSetEvent { guardian: new_guardian, version: 1 }`.

**Execution Command**:
```bash
stellar contract invoke \
  --network "<network>" \
  --source-account "<owner-approver-1>" \
  --id "<contract-id>" \
  -- set_guardian \
  --approvers '["<owner-approver-1>", "<owner-approver-2>"]' \
  --new_guardian "<new-guardian-address>"
```
*(All addresses in `--approvers` must provide their cryptographic signatures).*

---

### Step 4.2: Verify Guardian State

Query the contract to confirm the update:

```bash
stellar contract invoke \
  --network "<network>" \
  --source-account "<any-account>" \
  --id "<contract-id>" \
  -- get_guardian
```
*Expected Result*: Output returns `Some("<new-guardian-address>")`.

---

## 5. Abort and Rollback Checklist

- **Quorum Risk during Removal**: If removing an owner would cause the remaining total weight to drop below `threshold`, the contract rejects execution with `WouldBreakQuorum` (Error 48). If this occurs, first execute a `ChangeThreshold` proposal to lower the threshold before re-attempting removal.
- **Single-Owner Cap Rejection**: If `AddOwner` fails with `SingleOwnerWeightCapExceeded` (Error 46), lower the weight assigned to the new owner.
- **Signer Verification Failure**: If the newly added owner is unable to sign transactions after Step 3.3, **DO NOT proceed to remove the old owner**. Submit a removal proposal for the defective new key, resolve the hardware/key issue, and start over.

---

## 6. Verification Checklist

- [ ] Current owners, weights, and threshold verified prior to starting.
- [ ] New owner added via approved and executed `AddOwner` proposal.
- [ ] New owner confirmed active (`is_owner` is `true`, weight verified).
- [ ] New owner successfully tested on a live signature.
- [ ] Old owner removed via approved and executed `RemoveOwner` proposal.
- [ ] Old owner confirmed inactive (`is_owner` is `false`).
- [ ] Guardian address rotated via `set_guardian` with valid multi-owner co-signatures.
- [ ] `get_guardian` returns new guardian address.

---

## 7. Dry Run & Verification Log

- **Date**: 2026-10-18
- **Environment**: Code verification against `contracts/accord/src/lib.rs` (`create_add_owner_proposal`, `create_remove_owner_proposal`, `set_guardian`, `require_weighted_approvers`, `execute`).
- **Review Scope**:
  - Validated that `set_guardian` takes `approvers: Vec<Address>` and `new_guardian: Address`, requires weighted approvers, and updates `write_guardian`.
  - Validated that `AddOwner` and `RemoveOwner` are variants of `ProposalKind` and must go through `create_*`, `approve`, and `execute`.
  - Validated weight invariants: `MIN_OWNER_WEIGHT`, `MAX_OWNERS = 20`, `MAX_SINGLE_OWNER_WEIGHT_PCT = 50%`, `CannotRemoveLastOwner`, `WouldBreakQuorum`.
- **Gaps Identified & Documented**:
  - Documented that Accord lacks an atomic swap entrypoint; owners must follow the Add-then-Remove two-step sequence to maintain quorum.
- **Human Drill Requirements**: Multisig signers should practice co-authorizing a testnet `set_guardian` transaction annually to ensure tooling familiarity.
