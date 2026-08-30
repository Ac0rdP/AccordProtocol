# Set Up Payroll with Recurring Payments

This guide walks you through setting up and managing automated, recurring payroll and token vesting schedules using Accord Protocol. 

While a standard payroll flow requires creating, approving, and executing a new proposal every month (see [Payroll Multisig](payroll-multisig.md)), recurring payments allow the multisig owners to approve a single long-term schedule once. Once active, funds can be disbursed periodically without requiring new approvals for each payment.

---

## Before You Start

Make sure the following are in place before setting up a recurring payment:

- **The multisig is initialized.** The contract must be deployed and owners configured.
- **The contract holds sufficient tokens.** The multisig contract is the vault from which recurring payments are drawn. Ensure the contract has a sufficient balance of the target token (e.g., USDC) to cover the schedule's total cap or upcoming disbursements.
- **Recipient address is verified.** Verify the contributor’s Stellar public key (`G...` address). Copy-paste this carefully.

---

## Vesting vs. Fixed Interval Schedules

Accord Protocol supports two types of recurring schedules via the `RecurringKind` parameter:

### 1. Fixed Amount Per Period (`FixedAmountPerPeriod`)
This kind is ideal for standard ongoing payroll (e.g., salary paid monthly or bi-weekly).
- **Interval (`interval_secs`):** The duration of each pay cycle (e.g., `2592000` seconds for 30 days).
- **Amount (`amount`):** The fixed amount transferred to the recipient at the end of each interval.
- **Total Cap (`total_cap`):** The maximum cumulative amount that can ever be disbursed under this schedule. Once reached, the schedule automatically transitions to the `Completed` status.

### 2. Linear Vesting (`LinearVesting`)
This kind is ideal for token vesting, equity-like compensation, or grant schedules where funds accrue continuously second-by-second.
- **Start Time (`start_time`) & End Time (`end_time`):** Define the vesting window.
- **Total Cap (`total_cap`):** The total amount that will vest linearly over the duration.
- **No Intervals:** The claimable amount is calculated on-the-fly based on how much time has elapsed since the start time.

### Optional Cliff (`cliff_time`)
Both schedule types support an optional **Cliff Time**. 
- If set, no disbursements can be made before the cliff timestamp.
- Once the cliff time is reached, all accrued or vested funds from the start of the schedule become claimable at once in the very next disbursement.

---

## Creating a Recurring Payment Schedule

To start a schedule, an owner must first propose it. Since creating a recurring schedule commits the multisig's future funds, this action goes through the standard proposal creation, approval, and execution lifecycle.

### Parameters for the Schedule Proposal:

| Parameter | Type | Description |
|-----------|------|-------------|
| `recipient` | Address | The contributor's Stellar address receiving the funds. |
| `token` | Address | The token contract address (e.g. USDC). |
| `amount` | i128 | Payout amount per interval (used for `FixedAmountPerPeriod`, ignored/set to `0` for `LinearVesting`). |
| `interval_secs` | u64 | Seconds between payments (used for `FixedAmountPerPeriod`, set to `0` for `LinearVesting`). |
| `start_time` | u64 | Unix timestamp when the schedule begins. |
| `end_time` | u64 | Unix timestamp when the schedule stops (optional for `FixedAmountPerPeriod`, required for `LinearVesting`). |
| `cliff_time` | u64 | Optional Unix timestamp before which no funds can be released. |
| `total_cap` | i128 | Maximum total amount to be disbursed (optional for `FixedAmountPerPeriod`, required for `LinearVesting`). |
| `kind` | RecurringKind | Either `FixedAmountPerPeriod` or `LinearVesting`. |
| `description` | String | A clear label (e.g., "Engineering Lead Vesting - Alice"). Max 300 characters. |
| `deadline` | u64 | Proposal voting deadline. |

Once submitted, the proposal is assigned a proposal ID (e.g., `Proposal #5`) with a status of **Pending**.

---

## Approving and Activating the Schedule

Like any other proposal, the recurring payment schedule must collect approvals from the owners to reach the multisig's threshold.

1. **Review:** Owners log into the dashboard, open the proposal, and verify all parameters (recipient, token, cap, times, and kind).
2. **Approve:** Owners click **Approve** to sign via Freighter.
3. **Execute:** Once the approval threshold is met, the status changes to **Ready**. Any owner can click **Execute** to sign the execution transaction.

Once executed, the schedule is registered on-chain with a status of **Active**. No further owner approvals are required to disburse the funds.

---

## Disbursing Funds (Cranking the Schedule)

Smart contracts are passive and cannot run on a timer. To transfer funds from the contract to the recipient, the schedule must be explicitly triggered, or **cranked**.

### 1. Checking Claimable Funds
Anyone can query the contract's view function `get_claimable_amount(schedule_id)` to see how many tokens are currently vested/accrued and ready to be claimed.

### 2. Calling the Crank
To disburse the available funds, call the contract's `disburse_recurring(schedule_id)` function.
- This is a public function that does not require multisig owner signatures.
- **Who can call it?** The recipient, the multisig owners, or anyone else can call this function.
- When called, the contract calculates the claimable amount, transfers the tokens from the contract to the recipient, updates the schedule’s `total_disbursed` and `last_disbursed_at` records, and publishes a `r_disb` event.

### 3. Automating with Keepers
To ensure payments are disbursed on a precise schedule without manual intervention, teams typically set up an off-chain **Keeper**.
- A Keeper is a script or bot running on a server that regularly polls the contract.
- It checks if the current time satisfies the interval or vesting constraints.
- When funds are claimable, the Keeper automatically sends a transaction calling `disburse_recurring(schedule_id)`.

---

## Cancelling a Schedule

If a contributor leaves the team or the terms of the agreement change, the multisig owners can cancel an active schedule.

1. An owner creates a cancellation proposal by calling `create_cancel_recurring_proposal(schedule_id, description, deadline)`.
2. This proposal goes through the standard voting lifecycle.
3. Once approved and executed, the schedule's status is set to **Cancelled**.
4. The remaining undisbursed weight/tokens remain in the multisig vault, and no further disbursements can be made.

---

## Tips and Best Practices

- **Monitor Contract Balances:** If the multisig contract runs out of tokens, `disburse_recurring` calls will fail. Check balances regularly or set up alerts.
- **Choose Sensible Cliffs:** Cliffs are irreversible once the schedule is approved. Ensure the cliff timestamp is set correctly.
- **Use Testnet First:** Before deploying a 4-year vesting schedule on mainnet, create a 10-minute vesting schedule on testnet to verify that your Keeper automation and claiming interface work as expected.
