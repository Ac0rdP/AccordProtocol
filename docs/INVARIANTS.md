# Protocol Invariants

Each security claim below is enforced in the contract and asserted after every
step of a randomized operation sequence by
[`invariants_hold_under_randomized_operations`](../contracts/accord/src/invariants.rs).
A violation fails the test with the invariant ID in the message. Run it with:

```bash
cargo test -p accord --locked invariants
```

| ID | Invariant | Enforced in (`contracts/accord/src/lib.rs`) | Property test |
| --- | --- | --- | --- |
| INV-01 | `total_weight == sum(owner weights)` | `execute` (AddOwner, RemoveOwner, ChangeOwnerWeight) | `invariants_hold_under_randomized_operations`; also `total_weight_matches_all_current_owner_weights` |
| INV-02 | `1 <= threshold <= total_weight` | `validate_threshold`, `execute` (ChangeThreshold, RemoveOwner, ChangeOwnerWeight) | `invariants_hold_under_randomized_operations` |
| INV-03 | `1 <= owner count <= MAX_OWNERS (20)` | `initialize`, `execute` (AddOwner, RemoveOwner) | `invariants_hold_under_randomized_operations` |
| INV-04 | A proposal's `approvals` equals the sum of the weights recorded for its current approvers; an owner approves at most once, only owners approve, and a revoke needs a standing approval | `approve`, `revoke`, `execute` (RemoveOwner clears the removed owner's approvals) | `invariants_hold_under_randomized_operations`; also `approval_weight_always_equals_sum_of_approved_weights` |
| INV-05 | `quorum_weight` is fixed at creation and never changes | `create_*_proposal`, `derive_status` | `invariants_hold_under_randomized_operations` |
| INV-06 | A proposal executes at most once, only with `approvals >= quorum_weight`, and not after its deadline | `execute`, `derive_status` | `invariants_hold_under_randomized_operations` |
| INV-07 | A proposal executes only once `ready_at + time_lock_delay <= now` | `execute` | `invariants_hold_under_randomized_operations` |
| INV-08 | At most `MAX_ACTIVE_PROPOSALS (50)` live proposals | `register_active_proposal` | `invariants_hold_under_randomized_operations`; also `active_count_never_exceeds_max` |
| INV-09 | Proposal ids are sequential from 1 | `create_*_proposal`, `write_next_id` | `invariants_hold_under_randomized_operations` |
| INV-10 | Value is conserved: `treasury == minted - sum(executed transfers)` and recipients hold exactly what was paid | `execute` (Transfer) | `invariants_hold_under_randomized_operations` |

`ChangeOwnerWeight` previously checked only the quorum snapshots of active
proposals, so a threshold raised after the proposal was created could be left
above the new total weight (INV-02). `execute` now also checks the live
threshold.
