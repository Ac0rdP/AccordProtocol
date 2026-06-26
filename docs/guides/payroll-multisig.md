# Running Payroll Through a Multisig

This guide shows how a team uses Accord Protocol as a payroll system. The scenario: a team pays two contributors monthly in USDC through a 2-of-3 multisig, so that no single person can move funds alone. Each pay period, the team creates a proposal for each contributor, collects two approvals, and executes the transfer before the deadline.

---

## Before You Start

Make sure the following are already in place before your first pay run:

- **The multisig is initialized.** The contract has been deployed and the three owner addresses have been registered with a threshold of 2. If you have not done this yet, see the [Connecting Your Wallet](connecting-your-wallet.md) guide for wallet setup, and the [Reading the Dashboard](reading-the-dashboard.md) guide for an overview of the Accord interface.
- **All three owners have Freighter on Testnet.** Each owner must have the Freighter browser extension installed, set to the Stellar Testnet network, and funded with test XLM for transaction fees.
- **The contract holds enough USDC.** Check the contract's USDC balance on the dashboard before creating proposals. The balance must cover at least one full pay run — that is, the sum of all contributor payments for the current period.

---

## Creating the Monthly Proposal

At the start of each pay cycle, one owner creates a payment proposal for each contributor. Here is how to fill in the fields for a single contributor:

**Token** — Select USDC. The dashboard displays the token symbol on the proposal card so reviewers can confirm the correct asset at a glance.

**Amount** — Enter the amount in stroops (the token's smallest unit). For USDC on Stellar, 1 USDC equals 10,000,000 stroops. For example, a 2,000 USDC monthly payment is entered as `20000000000`.

**Recipient address** — Paste the contributor's Stellar address (a `G…` public key). Copy it from your payroll records rather than typing it by hand to avoid mistakes.

**Description** — Write a short note that identifies the contributor and the pay period. For example:

> June 2025 — Alice

The description field accepts up to 300 characters. Keep it short and consistent so that anyone reviewing the proposal list can immediately see who is being paid and for which period.

**Deadline** — Set the deadline roughly two weeks from the proposal creation date. This gives all owners enough time to review and approve, even if someone is travelling or unavailable for a few days. The deadline must be in the future and cannot be more than 90 days out.

**Example proposals for a two-person team:**

| Contributor | Amount | Description | Deadline |
|-------------|--------|-------------|----------|
| Alice (`GALC…AAAA`) | `20000000000` (2,000 USDC) | June 2025 — Alice | 14 days from now |
| Bob (`GBOB…BBBB`) | `15000000000` (1,500 USDC) | June 2025 — Bob | 14 days from now |

After submitting each proposal, the dashboard assigns a proposal ID and the proposal appears with a **Pending** status badge.

---

## Collecting Approvals

Each of the two required owners opens the proposal in the Accord dashboard and approves it independently from their own Freighter wallet.

1. The first owner opens the proposal detail page, verifies the recipient address, amount, and description, then clicks **Approve** and signs the transaction in Freighter.
2. The second owner repeats the same steps from their own browser and wallet.
3. Once two approvals are recorded, the proposal status changes from **Pending** to **Ready** and the Execute button becomes available.

**What if an owner is unavailable before the deadline?**

In a 2-of-3 setup, only two of the three owners need to approve. If one owner is on leave or unresponsive, the other two can still approve and execute the proposal. This is one of the main advantages of a 2-of-3 threshold over a 3-of-3 threshold — a single absent owner cannot block payroll.

If two owners are unavailable and the deadline is approaching, the remaining owner cannot execute alone. In this case, wait for at least one other owner to return, or — if the deadline passes — create a new proposal with a longer deadline once the team is available again.

---

## Executing the Transfer

Once the proposal has reached the **Ready** status (meaning the approval threshold has been met), any owner can execute it.

1. Open the proposal detail page.
2. Click **Execute**. Freighter will prompt you to sign the execution transaction.
3. After signing, the USDC is transferred from the contract to the contributor's address. The proposal status changes to **Executed**.

**Important:** Execution will fail if the deadline has already passed. The contract checks the current ledger timestamp against the proposal deadline at execution time. If the deadline has expired, the proposal is marked as **Expired** and cannot be executed — you will need to create a new proposal. Always execute promptly once the threshold is met.

---

## Running the Next Pay Cycle

Accord does not have automatic recurrence. There is no built-in scheduler or recurring-payment feature in the contract. Each pay period requires a new proposal for each contributor.

To keep payroll running smoothly:

1. **Pick a consistent creation day.** For example, create all proposals on the last business day of the month for the following month's pay. This sets a predictable rhythm for the team.
2. **Repeat the process.** Create a new proposal for each contributor, collect two approvals, and execute. The steps are identical every cycle.
3. **Archive completed cycles.** Keep a note of which proposal IDs correspond to which pay periods. This makes it easy to audit payment history later.

---

## Tips for Reliable Payroll

**Set the deadline far enough in advance.** A two-week window is a reasonable default, but if your team spans multiple time zones or if owners travel frequently, consider a three- or four-week window. This gives a buffer for sick days, holidays, and unexpected absences. Remember that the maximum deadline is 90 days from the time of creation.

**Keep a simple off-chain log.** Maintain a spreadsheet or shared document that maps each proposal ID to the contributor name, amount, and pay period. The on-chain description field is limited to 300 characters, so an off-chain record is useful for longer notes, receipts, and audit trails.

**Prefer a 2-of-3 threshold over 3-of-3.** A 3-of-3 threshold means every single owner must approve every proposal. If one owner is on vacation, sick, or simply slow to respond, payroll is blocked. A 2-of-3 threshold ensures that one absent owner cannot delay payments while still requiring independent verification from two people.

---

## What's Next

- **Disbursing grants instead of payroll?** See the [Grant Management](grant-management.md) guide for a walkthrough tailored to grant rounds.
- **Hitting errors?** See the [Troubleshooting](troubleshooting.md) guide for help with common wallet, transaction, and network issues.
- **Need the full API details?** See the [Contract API Reference](../CONTRACT_API.md) for every function signature, parameter constraint, and error code.
