# Troubleshooting

This guide covers the most common errors you will encounter when using Accord Protocol — from wallet connection issues to on-chain transaction failures and network problems. Each entry explains what the error means, why it happens, and how to fix it.

---

## Wallet Connection Issues

### Freighter not detected

**What you see:** The dashboard shows a prompt asking you to install Freighter, or the Connect Wallet button does nothing.

**Why it happens:** The Freighter browser extension is not installed, is disabled, or your browser does not support it.

**How to fix it:**

1. Open the [Freighter download page](https://www.freighter.app) and install the extension for your browser.
2. If Freighter is already installed, check that it is enabled. In Chrome, go to **Settings → Extensions** and make sure the Freighter toggle is on.
3. Restart your browser after installing or re-enabling the extension.
4. If you are using a browser that does not support extensions (such as Safari on iOS), switch to a desktop browser like Chrome, Firefox, or Brave.

For a full walkthrough, see the [Connecting Your Wallet](connecting-your-wallet.md) guide.

---

### Wallet connected to the wrong network

**What you see:** The dashboard loads but shows no proposals, or you see an error that the contract is not found.

**Why it happens:** Your Freighter wallet is set to **Mainnet** (or another network) while the Accord contract is deployed on **Testnet**.

**How to fix it:**

1. Click the Freighter icon in your browser toolbar.
2. Look at the network selector at the top of the popup.
3. Switch it to **Testnet**.
4. Refresh the Accord dashboard page.

---

### Read-only banner appears for non-owners

**What you see:** The dashboard shows a banner or message indicating you are in read-only mode. You can view proposals but cannot create, approve, or execute them.

**Why it happens:** The wallet address you have connected is not one of the registered owners of the multisig contract. Only addresses that were included in the owner list during contract initialization (or added later via a governance proposal) can perform owner actions.

**How to fix it:**

1. Confirm you are using the correct Freighter account. If you have multiple accounts in Freighter, click the account switcher and select the one that was registered as an owner.
2. If you believe your address should be an owner, ask an existing owner to verify the owner list in the dashboard. Your address may have been entered incorrectly during initialization.
3. If you need to be added as an owner, an existing owner must create and execute an Add Owner governance proposal through the dashboard.

---

## Failed Transaction Errors

These errors appear when a transaction is submitted to the Stellar network but is rejected by the Accord smart contract. Freighter will show the error name in the transaction failure message.

### Unauthorized

**What it means:** The wallet address that signed the transaction is not a registered owner of the multisig contract.

**Why it happens:** You are trying to create a proposal, approve, revoke, or execute using a wallet that is not on the owner list. This can also happen if you switched Freighter accounts after loading the dashboard.

**How to fix it:** Switch to the Freighter account that is registered as an owner. If you are unsure which account that is, check the owner list displayed on the dashboard.

---

### ThresholdNotMet

**What it means:** The proposal does not have enough approvals to be executed yet.

**Why it happens:** You clicked Execute on a proposal that is still in **Pending** status. For a 2-of-3 multisig, at least two owners must approve before the proposal can be executed.

**How to fix it:** Wait for more owners to approve the proposal. You can see the current approval count on the proposal's approval bar. Once the bar is full and the status changes to **Ready**, any owner can execute.

---

### ProposalExpired

**What it means:** The proposal's deadline has passed. It can no longer be approved or executed.

**Why it happens:** The team did not collect enough approvals or did not execute the proposal before the deadline. Once the ledger timestamp exceeds the deadline, the contract permanently marks the proposal as expired.

**How to fix it:** Create a new proposal with the same details and set a longer deadline this time. Consider using a two-week or one-month deadline to give all owners enough time to review and approve. The maximum allowed deadline is 90 days from the time of creation.

---

### TooManyActiveProposals

**What it means:** The contract has reached its limit of 50 active proposals (proposals that are in **Pending** or **Ready** status).

**Why it happens:** Too many proposals were created without being executed or cleaned up. The contract enforces a hard cap of 50 active proposals to keep storage costs bounded.

**How to fix it:**

1. Execute any **Ready** proposals that are waiting to be finalized.
2. Ask an owner to clean up expired proposals using the dashboard's cleanup function. This frees up active-proposal slots by removing proposals whose deadlines have already passed.
3. After cleanup, try creating your proposal again.

---

## RPC and Network Problems

### Dashboard shows a loading spinner indefinitely

**What you see:** The Accord dashboard stays on a loading state and never displays proposals or contract data.

**Why it happens:** The dashboard cannot reach the Soroban RPC endpoint. This could be because the RPC server is down, your internet connection is interrupted, or the RPC URL in the application configuration is incorrect.

**How to fix it:**

1. Check your internet connection by opening another website.
2. Refresh the dashboard page. Transient network issues often resolve on a retry.
3. If the problem persists, the RPC endpoint may be experiencing downtime. Try switching to a backup RPC endpoint (see below).

---

### Switching to a backup RPC endpoint

If the default RPC endpoint is unresponsive, you can point the Accord frontend at a different Soroban RPC server.

1. Open the environment configuration file for the frontend. If you are running the app locally, this is `frontend/.env.local`. See [Development Setup](../SETUP.md) for details on the configuration file.
2. Find the `VITE_SOROBAN_RPC_URL` variable (or the equivalent RPC URL setting).
3. Replace the current URL with a working Soroban RPC endpoint. Community-run endpoints and lists of public RPC nodes can be found on the [Stellar Developers site](https://developers.stellar.org).
4. Save the file and restart the frontend dev server, or redeploy if you are running a production build.

---

### Checking the Stellar Testnet status

If you suspect the problem is with the Stellar Testnet itself rather than a single RPC node, check the network status:

1. Visit the [Stellar Dashboard](https://dashboard.stellar.org) to see the current health of the public Stellar networks, including Testnet.
2. Look for any ongoing incidents or degraded performance notices.
3. If Testnet is down, you will need to wait for the Stellar Development Foundation to restore it. Testnet outages are usually resolved within a few hours.

---

## What's Next

- **Setting up your wallet for the first time?** See the [Connecting Your Wallet](connecting-your-wallet.md) guide.
- **Learning what each part of the dashboard means?** See the [Reading the Dashboard](reading-the-dashboard.md) guide.
- **Managing grant disbursements?** See the [Grant Management](grant-management.md) guide.
- **Running payroll through Accord?** See the [Payroll Multisig](payroll-multisig.md) guide.
- **Need the full list of error codes?** See the [Contract API Reference](../CONTRACT_API.md) for every error code, its numeric value, and when it is thrown.
