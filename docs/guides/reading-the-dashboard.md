# Reading the Dashboard

This guide explains everything you see on the Accord Protocol dashboard — what each part of a proposal card means, how to interpret proposal statuses, and what actions are available to you depending on your role.

![Proposal Approval & Execution Walkthrough](../assets/walkthroughs/03-approve-and-execute-proposal.svg)

> **Visual Summary**: Review Pending Proposal → Sign Approval → Quorum Reached (`Ready`) → Execute On-Chain.  
> See the complete visual catalog in [`docs/WALKTHROUGHS.md`](../WALKTHROUGHS.md).

---

## The Proposal List

When you open Accord, the main screen shows a list of proposals. Each proposal is displayed as a card. Here is what each element on a card means:

**Proposer** — The Stellar address of the person who created the proposal. This tells you who is requesting the payment.

**Recipient** — The Stellar address that will receive the tokens if the proposal is approved and executed. Always verify this address before approving.

**Token amount** — The number of tokens to be transferred and the token type (for example, "500 USDC"). Amounts are shown in human-readable units, not raw stroops.

**Deadline countdown** — A timer showing how long is left before the proposal expires. Once the countdown reaches zero, the proposal can no longer be approved or executed, regardless of how many approvals it has.

**Status badge** — A coloured label indicating the current state of the proposal (see [Proposal Statuses](#proposal-statuses) below).

**Approval bar** — A progress bar showing how many owners have approved the proposal out of the total required. For example, if the threshold is 3-of-5 and two owners have approved, the bar will be at 40%.

---

## Proposal Statuses

Every proposal is in exactly one of four states at any given moment:

**Pending** — Approvals are still being collected. The proposal has been created but has not yet received enough owner signatures to be executable. If you are an owner and you agree with the proposal, you can click Approve to add your signature.

**Ready** — The approval threshold has been met. The required number of owners have approved and the deadline has not passed. Any owner can now click Execute to send the tokens to the recipient. The proposal will remain in this state until it is executed or the deadline passes, whichever comes first.

**Executed** — The transfer has happened. The tokens have been sent to the recipient and the proposal is permanently closed. No further action is possible.

**Expired** — The deadline passed before the proposal was executed. This can happen if a Ready proposal was not executed in time, or if a Pending proposal never received enough approvals before the deadline. Expired proposals cannot be approved or executed and will be removed from the active list when an owner calls the cleanup function.

---

## The Approval Bar

The approval bar below each proposal card shows progress toward the required threshold.

- The number on the left is how many owners have approved so far.
- The number on the right is the total number of approvals required.
- The filled portion of the bar represents the percentage of required approvals received.

When the bar is completely filled, the proposal status changes to **Ready** and the Execute button becomes available.

---

## Owner Actions vs Read-Only Visitors

What you can do on the dashboard depends on whether your connected wallet address is one of the contract's registered owners.

**Owners can:**
- Create new proposals
- Approve proposals (adds your signature)
- Revoke a previous approval (removes your signature, which may change a Ready proposal back to Pending)
- Execute a Ready proposal (triggers the on-chain token transfer)
- Clean up expired proposals to free the active-proposal budget

**Read-only visitors can:**
- View the proposal list and all proposal details
- See the approval bar and countdown timers
- Browse the owner list and current threshold setting

Read-only visitors cannot create, approve, revoke, or execute proposals. If you believe you should be an owner but cannot see the action buttons, check that your Freighter wallet is connected and set to Testnet — see the [Connecting Your Wallet](connecting-your-wallet.md) guide.
