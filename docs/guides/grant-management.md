# Managing Grant Disbursements

This guide walks through a real-world scenario: a three-person grants committee uses a 2-of-3 Accord multisig to disburse USDC to approved applicants. Because the approval threshold is two, no single committee member can release funds alone — every payment requires independent sign-off from at least two of the three members.

---

## Preparing a Grant Round

Before creating any disbursement proposals, confirm that the contract holds enough USDC to cover every approved grant in the current round.

1. Open the Accord dashboard and check the contract's USDC balance displayed at the top of the page.
2. Compare that balance to the total amount you plan to disburse. If the balance is too low, transfer additional USDC to the contract address before proceeding.
3. Decide on a naming convention for the round. A clear convention makes it easy to search and audit later. For example, use the format **"Round 3 — Project Aurora — alice.stellar"** so that every proposal description includes the grant reference number, the project name, and the recipient.

> **Tip:** Preparing a spreadsheet of approved grants — with recipient addresses, amounts, and reference numbers — before you start creating proposals helps avoid data-entry mistakes and keeps the round moving quickly.

---

## Creating a Disbursement Proposal

For each approved grant, one committee member creates a proposal in the Accord dashboard. Here is what each field means and how to fill it in:

**Token** — Select the USDC token. The dashboard will show the token symbol so you can verify you are not accidentally selecting a different asset.

**Amount** — Enter the amount in the token's smallest unit (stroops). For USDC on Stellar, 1 USDC equals 10,000,000 stroops. For example, a 500 USDC grant is entered as `5000000000`. The dashboard converts this to a human-readable value on the proposal card so reviewers can double-check.

**Recipient address** — Paste the Stellar address of the grantee. This is a `G…` public key. Always copy it directly from your grants spreadsheet or the applicant's submitted information — never type it by hand.

**Description** — Write a short note that identifies the grantee, the grant round, and any reference number. For example:

> Round 3 — Project Aurora — GCRR…XYZQ

The description field accepts up to 300 characters, which is enough for a reference number, a project name, and a short note. Keep it concise so reviewers can scan it quickly.

**Deadline** — Set a deadline that gives all committee members enough time to review the proposal. Two weeks from today is a reasonable default for most grant rounds. The deadline must be in the future and cannot be more than 90 days out.

**Example proposal:**

| Field | Value |
|-------|-------|
| Token | USDC |
| Amount | `5000000000` (500 USDC) |
| Recipient | `GCRR…XYZQ` (Alice, Project Aurora) |
| Description | Round 3 — Project Aurora — GCRR…XYZQ |
| Deadline | 14 days from now |

After submitting, the dashboard assigns a proposal ID and the proposal appears in the list with a **Pending** status badge.

---

## Reviewing and Approving

Each committee member should independently review the proposal before approving. Rubber-stamping defeats the purpose of a multisig — the whole point is that two people verify every payment.

**What to check before approving:**

1. **Recipient address** — Does the `G…` address on the proposal match the address in your grants spreadsheet? Compare at least the first and last eight characters.
2. **Amount** — Does the human-readable amount shown on the proposal card match the approved grant amount? A misplaced zero is the most common data-entry error.
3. **Token symbol** — Confirm the token is USDC. If someone accidentally created the proposal with a different token, reject it and ask the proposer to create a new one.
4. **Description** — Does the description identify the correct grantee and round? If the description is vague or missing the reference number, ask the proposer to cancel and re-create with a clearer note.

**How to approve:**

1. Open the proposal detail page in the Accord dashboard.
2. Click **Approve**. Freighter will ask you to sign the transaction.
3. After signing, your approval is recorded on-chain and the approval bar on the proposal card updates.

Once two of the three committee members have approved, the proposal status changes from **Pending** to **Ready** and the Execute button becomes available.

---

## Completing the Disbursement

Once a proposal reaches the **Ready** status, any committee member can execute it.

1. Open the proposal detail page.
2. Click **Execute**. Freighter will ask you to sign the execution transaction.
3. After signing, the USDC is transferred from the contract to the recipient's address. The proposal status changes to **Executed** and no further action is possible.

**Important:** If the deadline passes before anyone clicks Execute, the proposal expires and the funds remain in the contract. You would need to create a new proposal to retry the disbursement. Set your deadlines with enough buffer to avoid this.

If the contract does not hold enough USDC to cover the transfer at execution time, the transaction will fail with a `TransferFailed` error. Top up the contract's USDC balance and try executing again.

---

## What's Next

- **Running recurring disbursements?** See the [Payroll Multisig](payroll-multisig.md) guide for guidance on managing repeated payment cycles — the same pattern applies to quarterly or monthly grant rounds.
- **Hitting errors?** See the [Troubleshooting](troubleshooting.md) guide for help with common wallet, transaction, and network issues.
- **Need the full API details?** See the [Contract API Reference](../CONTRACT_API.md) for every function signature, parameter constraint, and error code.
