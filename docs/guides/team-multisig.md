# Setting Up a Team Multisig

This guide walks five team members through setting up a 3-of-5 Accord multisig from scratch — from collecting wallet addresses to submitting the team's first proposal. By the end, three of the five members must approve any proposal before funds can move, ensuring no single person can release payments alone.

---

## Before You Start

Make sure the following are in place before you begin:

- **Freighter installed and on Testnet.** Every team member needs the Freighter browser extension installed, set to the Stellar Testnet network, and funded with test XLM. See the [Connecting Your Wallet](connecting-your-wallet.md) guide for step-by-step instructions.
- **All five owner addresses collected.** Gather the Stellar public key (`G…` address) from each team member's Freighter wallet. You will need all five addresses during initialization.
- **The contract deployed and funded.** The Accord contract must already be deployed to Stellar testnet and the contract address must hold enough tokens to cover your first test transfer. See [docs/DEPLOYMENT.md](../DEPLOYMENT.md) for deployment steps — this guide does not repeat them.

**The five team members used in this guide:**

| Role | Label | Placeholder address |
|------|-------|---------------------|
| Team lead | Alice | `GALC…AAAA` |
| Finance | Bob | `GBOB…BBBB` |
| Engineering | Carol | `GCAR…CCCC` |
| Operations | Dave | `GDAV…DDDD` |
| Advisor | Eve | `GEVE…EEEE` |

These placeholder addresses appear throughout the guide. In your setup, replace them with the real public keys from each team member's Freighter wallet.

---

## Choosing Your Threshold

The threshold is the number of owners who must approve a proposal before it can be executed. For a five-person team, you need to decide how many approvals to require.

**What 3-of-5 means in practice:**

- Any three of the five owners must approve before a proposal can be executed.
- Two owners can be unavailable (travelling, on leave, unresponsive) and the remaining three can still move funds.
- If a single private key is compromised, the attacker cannot execute anything alone — they would still need two more approvals from legitimate owners.

**The trade-off: security versus availability.**

A higher threshold is more secure but harder to coordinate:

| Threshold | Security | Availability |
|-----------|----------|-------------|
| **2-of-5** | Lower — only two people need to agree, so a compromised key plus one social-engineering attack could release funds. | Higher — easy to get two people online at any time. |
| **3-of-5** | Balanced — a bare majority must agree, and an attacker would need to compromise three separate keys. | Balanced — works well when at least three members are regularly available. |
| **4-of-5** | Higher — almost everyone must agree, making unauthorized transfers very difficult. | Lower — if two people are unavailable simultaneously, the team is blocked. |
| **5-of-5** | Highest — every member must sign. | Lowest — a single absent member blocks all operations. |

**When to choose something other than 3-of-5:**

- Choose **2-of-5** if your team operates across very different time zones and availability is your biggest concern.
- Choose **4-of-5** if you are managing a high-value treasury and can tolerate slower operations in exchange for stronger security.
- Avoid **5-of-5** for any team where members may be unavailable — a single absent owner will block every payment.

For most teams, **3-of-5 is the recommended default**. It provides a strong security guarantee while allowing the team to operate even when two members are temporarily unavailable.

---

## Initializing the Multisig

Initialization is a one-time step that registers the owner list and sets the approval threshold. After initialization, the configuration is locked and cannot be changed except through governance proposals.

**How it works:**

1. One team member (typically the person who deployed the contract) submits the initialization transaction through the Accord dashboard or CLI.
2. The transaction includes the list of all five owner addresses and the chosen threshold (3 in this example).
3. **Every one of the five owners must approve this transaction from their own Freighter wallet.** This is a security measure — it ensures that no one can be added as an owner without their knowledge and consent. The contract will not store the configuration until all five addresses have authorized.

**The initialization parameters for a 3-of-5 setup:**

| Parameter | Value |
|-----------|-------|
| Owners | `GALC…AAAA`, `GBOB…BBBB`, `GCAR…CCCC`, `GDAV…DDDD`, `GEVE…EEEE` |
| Threshold | `3` |
| Time-lock delay | `0` (no delay — proposals are executable immediately once the threshold is met) |

**What to expect:**

- The team lead (Alice) submits the initialization transaction.
- Freighter prompts each of the five owners to review and sign the transaction.
- Once all five have signed, the contract stores the owner list and threshold on-chain.
- If any owner declines or is not available to sign, the initialization does not go through. Coordinate with all five members before starting.

**After initialization:**

- The contract accepts proposals from any of the five owners.
- Any proposal requires three approvals before it can be executed.
- The owner list and threshold can only be changed through Add Owner, Remove Owner, or Change Threshold governance proposals, which themselves require three approvals to execute.

---

## Verifying the Setup

After initialization, confirm that the on-chain state matches what you intended.

**Check the owner list in the dashboard:**

1. Open the Accord dashboard in your browser.
2. Navigate to the settings or contract info section.
3. Verify that all five addresses are listed as owners: `GALC…AAAA`, `GBOB…BBBB`, `GCAR…CCCC`, `GDAV…DDDD`, and `GEVE…EEEE`.

**Check the threshold in the dashboard:**

The dashboard displays the current threshold alongside the owner list. Confirm it shows **3-of-5**.

**View the on-chain state on Stellar Expert (optional):**

Open the following URL in your browser, replacing `YOUR_CONTRACT_ID` with your actual contract ID:

```
https://stellar.expert/explorer/testnet/contract/YOUR_CONTRACT_ID
```

This shows the contract's transaction history, including the initialization transaction with all five owner signatures.

If the owner list and threshold both match your intended configuration, the multisig is live and ready to accept proposals.

---

## Submitting the First Proposal

Now that the multisig is initialized, test the full proposal flow by creating a small payment proposal.

**1. Create the proposal.**

One of the five owners opens the Accord dashboard and creates a new payment proposal with the following details:

| Field | Value |
|-------|-------|
| Token | USDC (or whichever token the contract holds) |
| Amount | A small test amount — for example, `10000000` (1 USDC in stroops) |
| Recipient | A test address outside the multisig (for example, a personal wallet) |
| Description | Test transfer — first proposal |
| Deadline | 14 days from now |

After submitting, the proposal appears in the dashboard with a **Pending** status badge and an empty approval bar.

**2. Collect three approvals.**

Three of the five owners each open the proposal in the dashboard, verify the details (recipient, amount, token), and click **Approve**. Each approval is signed independently through the owner's own Freighter wallet.

As each owner approves, the approval bar fills. Once the third approval is recorded, the proposal status changes from **Pending** to **Ready**.

**3. Execute the transfer.**

Any owner can now click **Execute** on the Ready proposal. Freighter prompts the owner to sign the execution transaction. After signing, the tokens are transferred from the contract to the recipient and the proposal status changes to **Executed**.

If all three steps complete successfully, your multisig is fully operational.

---

## What's Next

- **Learn the full approval and execution flow.** See the [Approve and Execute a Proposal](../tutorials/approve-and-execute-a-proposal.md) tutorial for a detailed walkthrough of each step.
- **Understand proposal statuses.** See the [Understanding Proposal Lifecycle](../tutorials/understanding-proposal-lifecycle.md) reference for how proposals move through Pending, Ready, Executed, and Expired states.
- **Set up payroll or grant disbursements.** See the [Payroll Multisig](payroll-multisig.md) guide or the [Grant Management](grant-management.md) guide for real-world use cases.
- **Troubleshoot issues.** See the [Troubleshooting](troubleshooting.md) guide if you encounter wallet, transaction, or network errors.
