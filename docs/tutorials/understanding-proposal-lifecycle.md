# Understanding Proposal Lifecycle

Accord proposals are the unit of work that owners use to move funds or change multisig settings, so understanding the lifecycle matters before you approve, revoke, or execute anything. If you know which state a proposal is in, you can tell what actions are still available, what can still go wrong, and whether the proposal is about to become unusable.

## State diagram

<pre>
Pending -- approvals reach threshold --> Ready -- execute called --> Executed
   ^                                      |
   |                                      |
   | revoke drops approvals below threshold
   |                                      |
   +--------------------------------------+

Pending -- deadline passes -----------> Expired
Ready   -- deadline passes -----------> Expired
Pending -- explicit proposal revoke --> Revoked
Ready   -- explicit proposal revoke --> Revoked
</pre>

## Status at a glance

| Status | What it means | Can be approved | Can be executed | Can be revoked |
| --- | --- | --- | --- | --- |
| Pending | The proposal is active but does not yet have enough approvals. | Yes | No | Yes, if the caller already approved |
| Ready | The proposal is active and has reached the threshold. | Yes, if another owner has not approved yet | Yes | Yes |
| Executed | The proposal has already been carried out on-chain. | No | No | No |
| Expired | The deadline passed before execution completed. | No | No | No |
| Revoked | The proposal was explicitly closed instead of remaining active. | No | No | No |

## Pending

Pending means the proposal exists, is still before its deadline, and has fewer approvals than the current threshold requires. A proposal enters Pending immediately after creation, and it can also return to Pending later if someone revokes an approval from a proposal that had previously become Ready. While Pending, owners can review it, approve it, or revoke their own approval if they already signed it.

## Ready

Ready means the proposal is still active and the approval count has reached or exceeded the threshold. A proposal enters Ready when enough owners approve it, but being Ready does not move funds by itself because an owner still has to call execute. While Ready, owners can execute the proposal or revoke an approval, and that revoke can move the proposal back to Pending if the approval count drops under the threshold.

## Executed

Executed means the final on-chain action already happened, such as transferring funds or applying a governance change. A proposal enters Executed only after an owner calls execute successfully while the proposal is still eligible to run. Once Executed, the proposal is terminal, so it cannot be approved, revoked, or executed again.

## Expired

Expired means the deadline passed before the proposal was successfully executed. A proposal enters Expired automatically when it is read after the deadline, which means the contract can derive that status from the current ledger time without a separate maintenance transaction. Once Expired, the proposal is terminal and owners cannot approve, execute, or revoke it.

## Revoked

Revoked means the proposal was explicitly closed out of the active workflow instead of being left Pending or Ready. In practice, this is different from an owner revoking their approval, because an approval revoke usually just lowers the count and can move Ready back to Pending. Revoked is the terminal closed state in the status model, so once a proposal reaches it, no further owner actions are available.

## Edge Cases and Gotchas

### Ready but expired before execution

A proposal can reach Ready and still fail to move funds if nobody submits execute before the deadline passes. In that case, the proposal reads back as Expired even though it once had enough approvals, so owners must create a new proposal if they still want the action to happen.

### Revoking an approval can move Ready back to Pending

Ready is not permanent until execution succeeds. If a signer revokes their approval and that drops the count below the threshold, the proposal becomes Pending again and cannot be executed until more approvals are collected.

### The 50 active-proposal limit can block new proposals

Accord enforces a cap of 50 active proposals at one time, where active means Pending or Ready. If teams allow too many proposals to sit unexecuted or unexpired, new proposal creation can fail until the active set shrinks.

### Expired status is derived at read time

Expired is not something an operator needs to write back to the contract in a cleanup step. When the current ledger time is past the deadline, the contract can derive Expired when someone fetches the proposal, which is why stale proposals can appear to change state without a dedicated update transaction.

## Next steps

If you want to use this lifecycle model in practice, continue with [create-a-payment-proposal.md](./create-a-payment-proposal.md) to learn how to draft a transfer, then read [approve-and-execute-a-proposal.md](./approve-and-execute-a-proposal.md) to see how owners move an active proposal all the way to completion.
