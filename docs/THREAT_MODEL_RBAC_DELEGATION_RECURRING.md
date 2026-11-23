# Threat Model Extension: RBAC, Delegation and Recurring Payments

This extends the [Threat Model in SECURITY.md](./SECURITY.md#threat-model), which
predates these three features in full. Code links point at
[`contracts/accord/src/lib.rs`](../contracts/accord/src/lib.rs); line numbers
drift, so the function name is the stable anchor.

Residual-risk status: **Accepted** (documented, operator-managed), **Open**
(a code change would close it and is not yet made).

## Shared trust assumptions

- Owner keys are secret, and fewer than `threshold` weight is colluding.
- The ledger timestamp is accurate within normal Stellar close-time skew.
- Token contracts follow the token interface and are not maliciously upgraded.
- Anything gated by a proposal is only as safe as the approvers' review of the
  proposal payload.

## 1. Role-Based Access Control

**Surfaces:** role-gated entrypoints ([`require_role`](../contracts/accord/src/lib.rs#L1233),
[`has_role`](../contracts/accord/src/lib.rs#L1223)); role changes via
[`create_grant_role_proposal`](../contracts/accord/src/lib.rs#L4890) /
[`create_revoke_role_proposal`](../contracts/accord/src/lib.rs#L4976) and their
execution in `execute` (`ProposalKind::GrantRole` / `RevokeRole`); role storage
([`update_owner_roles`](../contracts/accord/src/lib.rs#L1183)); non-owner roles.

**Trust assumptions:** roles never grant voting weight, only owners vote;
admin actions (`upgrade`, `set_guardian`, `unfreeze`, migrations) are not
role-gated and need owner weight ([`require_weighted_approvers`](../contracts/accord/src/lib.rs#L1815)).

| ID | Misuse case | Mitigation (code) | Residual |
| --- | --- | --- | --- |
| RB-1 | Attacker grants themselves `Approver`/`Executor` | Role grants are proposals needing quorum and the `Proposer` role to draft ([`create_grant_role_proposal`](../contracts/accord/src/lib.rs#L4890), `execute` → `GrantRole`) | Accepted: colluding quorum can grant anything |
| RB-2 | Non-owner with `Approver` role votes | `approve` requires both the role and owner membership/weight ([`approve`](../contracts/accord/src/lib.rs#L3509), [`require_owner_and_weight`](../contracts/accord/src/lib.rs#L1782)) | None |
| RB-3 | Revoking `Approver` strands quorum (remaining approver weight < threshold) | Checked at creation ([`create_revoke_role_proposal`](../contracts/accord/src/lib.rs#L4976)) and again at execution (`RevokeRole`, via [`remaining_approver_weight_after_revoke`](../contracts/accord/src/lib.rs#L1283)) → `WouldBreakQuorum`. SECURITY.md still describes this as operator-only; the on-chain guard exists. | Accepted: guard compares to the live threshold, not to snapshotted `quorum_weight` of in-flight proposals |
| RB-4 | Rogue/compromised non-owner `Executor` | Cannot alter payload or fabricate approvals; needs `Ready` status, time-lock, deadline, no freeze ([`execute`](../contracts/accord/src/lib.rs#L3662)); owners can `revoke` before execution | Accepted: executor controls *when* a Ready proposal runs |
| RB-5 | Non-owner `Proposer` floods the proposal cap or sidesteps owner-keyed spending limits | Quorum still required to move funds; `MAX_ACTIVE_PROPOSALS` bounds storage; limits apply to owner proposers only ([`create_proposal`](../contracts/accord/src/lib.rs#L2499)) | Accepted: a non-owner proposer can fill the cap (DoS) until proposals expire or are cancelled |
| RB-6 | Removed owner keeps roles or approvals | Removal clears roles ([`update_owner_roles`](../contracts/accord/src/lib.rs#L1183) with empty set) and strips their approval weight from live proposals (`execute` → `RemoveOwner`) | None |
| RB-7 | One key holds Proposer+Approver+Executor (default) | Default owner roles kept for M-of-N compatibility; single-owner weight cap (`ChangeOwnerWeight`) | Accepted: operators should prune roles after bootstrap (see SECURITY.md RBAC addendum) |

## 2. Delegation

**Surfaces:** delegation storage and expiry
([`read_delegation`](../contracts/accord/src/lib.rs#L1331),
[`is_delegation_active`](../contracts/accord/src/lib.rs#L1352)); weight used at
approval time ([`compute_effective_weight`](../contracts/accord/src/lib.rs#L1364),
called by `approve`); cleanup on owner removal (`execute` → `RemoveOwner`,
[`remove_delegation`](../contracts/accord/src/lib.rs#L1346)); views
`get_delegations`, `get_effective_weight`.

**Scope note:** at this commit nothing in the contract calls `write_delegation`,
so no entrypoint creates a delegation. The analysis below covers the read/approve
path that exists and the risks any creating entrypoint must satisfy.

**Trust assumptions:** a delegator trusts the delegate with that weight until
revoked or expired; delegation moves weight between owners, it never creates it.

| ID | Misuse case | Mitigation (code) | Residual |
| --- | --- | --- | --- |
| DL-1 | Weight inflation through chains or cycles | Effective weight is `raw − own outgoing + direct incoming` only; it is not transitive ([`compute_effective_weight`](../contracts/accord/src/lib.rs#L1364)); one outgoing delegation per owner | None |
| DL-2 | Delegation to or from a removed owner survives | `RemoveOwner` deletes the removed owner's outgoing delegation and every incoming one | None |
| DL-3 | Expired delegation still counts | `is_delegation_active` compares expiry to the ledger time on every computation | Accepted: timestamp trust |
| DL-4 | Weight counted twice on one proposal: delegate approves with delegated weight, delegation is then revoked/expires, delegator approves with restored weight | `revoke` reverses the exact weight stored at approval ([`revoke`](../contracts/accord/src/lib.rs#L3581)) | **Open:** `approve` snapshots effective weight, so a later delegation change does not adjust existing approvals and the same weight can count twice. Close it before a creation entrypoint ships (for example block delegation changes while the delegator or delegate has live approvals, or recompute at execute). |
| DL-5 | Delegation used to exceed the single-owner weight cap | Cap applies to raw weights ([`owner_weight_within_cap`](../contracts/accord/src/lib.rs#L843)) only | **Open:** effective weight can pass the cap and reach threshold alone |
| DL-6 | Gas/storage DoS from reading every owner's delegation | Owner count bounded by `MAX_OWNERS` (20), so the loop is bounded | None |

## 3. Recurring payments

**Surfaces:** schedule creation/modification by proposal
([`create_recurring_proposal`](../contracts/accord/src/lib.rs#L4469),
[`create_cancel_recurring_proposal`](../contracts/accord/src/lib.rs#L4599),
[`create_pause_recurring_proposal`](../contracts/accord/src/lib.rs#L4666),
[`create_modify_recurring_proposal`](../contracts/accord/src/lib.rs#L4797),
executed in `execute` → `CreateRecurringPayment` / `Cancel…` / `Pause…` / `Modify…`);
permissionless payout ([`disburse_recurring`](../contracts/accord/src/lib.rs#L2679));
recipient-driven streams ([`claim_stream`](../contracts/accord/src/lib.rs#L2823)).
See also [SECURITY_RECURRING.md](./SECURITY_RECURRING.md).

**Trust assumptions:** approvers review schedule parameters (amount, interval,
cap, recipient) as carefully as a one-off transfer; keepers are untrusted.

| ID | Misuse case | Mitigation (code) | Residual |
| --- | --- | --- | --- |
| RC-1 | Unauthorized schedule | Creation, pause, cancel and modify are quorum proposals (`execute` arms above); the old direct entrypoints are deprecated ([`cancel_recurring_schedule`](../contracts/accord/src/lib.rs#L2457) returns `DeprecatedEntrypoint`) | Accepted |
| RC-2 | Keeper redirects or accelerates payouts | `disburse_recurring` pays only the stored recipient/amount, enforces interval, status and `total_cap`; any caller gets the same result | None |
| RC-3 | Many schedules drain the treasury or storage | `MAX_ACTIVE_RECURRING` (20) checked at creation and execution ([line 4529](../contracts/accord/src/lib.rs#L4529), [`CreateRecurringPayment`](../contracts/accord/src/lib.rs#L4057)); interval bounds | Accepted: schedules reserve no balance, so they compete with proposals (escrow is the only reserved balance, [`available_balance`](../contracts/accord/src/lib.rs#L1492)); payout fails with `TransferFailed` when short |
| RC-4 | Spending limits bypassed through schedules | Disbursements are attributed to the proposer's spent tracker | **Open:** limits are checked at creation only; `disburse_recurring` updates the tracker without enforcing the limit, and `Modify` can raise `amount` without a limit check |
| RC-5 | Malicious modify (raise amount, shorten interval) | Needs quorum; `r_mod` event records old and new values; amount, interval and end time are bounds-checked | Accepted: approvers must read the diff |
| RC-6 | Payouts during an incident | `disburse_recurring` blocks on freeze and recovery | **Open:** `claim_stream` blocks on freeze but not recovery, so continuous streams still pay out in recovery mode |
| RC-7 | Fund lock on paused/cancelled schedule | No funds are reserved per schedule, so none can be locked; terminal states reject further payouts | None |
| RC-8 | Token changes behaviour after approval | `validate_token` runs at each disbursement; failed transfers revert without advancing the schedule | Accepted: same token-upgrade gap as one-off transfers |

## Review record

The model is reviewed through the pull request that changes this file: it is not
considered reviewed until the PR is approved by someone other than the author.

| Reviewer | Area | Date | Outcome |
| --- | --- | --- | --- |
| _pending_ | RBAC | | |
| _pending_ | Delegation | | |
| _pending_ | Recurring | | |
