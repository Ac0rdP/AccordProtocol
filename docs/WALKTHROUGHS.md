# Visual Walkthroughs & Core Flows

This guide provides visual, step-by-step walkthroughs (in responsive animated SVG and lightweight GIF formats) for onboarding and core Accord Protocol workflows.

---

## Table of Contents

1. [Flow 1: Onboarding & Wallet Connection](#flow-1-onboarding--wallet-connection)
2. [Flow 2: Creating a Multisig Proposal](#flow-2-creating-a-multisig-proposal)
3. [Flow 3: Reviewing, Approving & Executing Proposals](#flow-3-reviewing-approving--executing-proposals)
4. [Flow 4: Recurring Payments & Contributor Payroll](#flow-4-recurring-payments--contributor-payroll)
5. [Flow 5: Treasury Analytics & Activity Monitoring](#flow-5-treasury-analytics--activity-monitoring)
6. [Maintenance & Update Guide](#maintenance--update-guide)
7. [CI & Asset Integrity Validation](#ci--asset-integrity-validation)

---

## Flow 1: Onboarding & Wallet Connection

Learn how to install Freighter, switch to the Stellar Testnet, acquire test XLM via Friendbot, and connect your wallet to Accord Protocol.

![Onboarding & Wallet Connection Walkthrough](./assets/walkthroughs/01-wallet-connection-onboarding.svg)

> **GIF Alternative**: Available at [`docs/assets/walkthroughs/01-wallet-connection-onboarding.gif`](./assets/walkthroughs/01-wallet-connection-onboarding.gif).

### Step-by-Step Breakdown:

1. **Install Freighter Extension**:
   - Download Freighter from [freighter.app](https://www.freighter.app).
   - Create or import a Stellar keypair (`G...`).
2. **Switch to Stellar Testnet**:
   - Open Freighter, click the network dropdown in the top bar, and select **Testnet**.
   - Note: Accord Testnet contracts run on Soroban Testnet (`https://soroban-testnet.stellar.org`).
3. **Fund Account with Friendbot**:
   - Use [Friendbot](https://friendbot.stellar.org) to receive free testnet XLM for transaction fees.
4. **Connect to Accord**:
   - Click the **Connect Wallet** button on the top-right header of the Accord dApp.
   - Accept the Freighter connection request. Once connected, your public key, role, and voting weight are displayed.

*Detailed written guide:* [Connecting Your Wallet](./guides/connecting-your-wallet.md).

---

## Flow 2: Creating a Multisig Proposal

Owners can initiate payment transfers, configuration updates, or recurring payment schedules through the proposal wizard.

![Create Multisig Proposal Walkthrough](./assets/walkthroughs/02-create-multisig-proposal.svg)

> **GIF Alternative**: Available at [`docs/assets/walkthroughs/02-create-multisig-proposal.gif`](./assets/walkthroughs/02-create-multisig-proposal.gif).

### Step-by-Step Breakdown:

1. **Initiate Proposal**:
   - Click the **+ Create Proposal** button on the dashboard or proposals view.
2. **Configure Parameters**:
   - **Recipient**: Enter a valid Stellar `G...` public key.
   - **Amount & Token**: Choose token (XLM, USDC, EURC) and enter the transfer amount.
   - **Category**: Classify under Transfer, Payroll, Grant, or Ops.
   - **Description**: Provide clear justification (up to 300 characters).
   - **Deadline**: Select expiration ledger timestamp (up to 90 days).
3. **Simulate & Sign**:
   - The dApp executes a zero-cost `simulateTransaction` call via Soroban RPC to verify contract balance and validity.
   - Freighter prompts you to sign `create_proposal`. Once mined, the proposal receives a monotonic ID and enters `Pending` state.

*Detailed written guide:* [Setting Up a Team Multisig](./guides/team-multisig.md).

---

## Flow 3: Reviewing, Approving & Executing Proposals

Understand how co-owners review proposal details, cast weighted approvals, reach quorum, and trigger autonomous execution.

![Approve and Execute Proposal Walkthrough](./assets/walkthroughs/03-approve-and-execute-proposal.svg)

> **GIF Alternative**: Available at [`docs/assets/walkthroughs/03-approve-and-execute-proposal.gif`](./assets/walkthroughs/03-approve-and-execute-proposal.gif).

### Step-by-Step Breakdown:

1. **Review Pending Proposal**:
   - Inspect proposal card: recipient address, amount, description, and the approval progress bar.
2. **Cast Approval**:
   - Connected owners with the `Approver` role click **Approve**.
   - Freighter signs the `approve` invocation. The contract increments the cumulative approval weight.
3. **Quorum & Execution**:
   - Once total approved weight reaches or exceeds `threshold`, the proposal transitions to `Ready`.
   - Any authorized owner clicks **Execute**. The contract transfers tokens directly from contract custody to the recipient and transitions the proposal to `Executed`.

*Detailed written guide:* [Reading the Dashboard](./guides/reading-the-dashboard.md).

---

## Flow 4: Recurring Payments & Contributor Payroll

Set up automated recurring payment streams or linear token vesting for team salaries and grant tranches.

![Recurring Payroll Schedule Walkthrough](./assets/walkthroughs/04-recurring-payroll-schedule.svg)

> **GIF Alternative**: Available at [`docs/assets/walkthroughs/04-recurring-payroll-schedule.gif`](./assets/walkthroughs/04-recurring-payroll-schedule.gif).

### Step-by-Step Breakdown:

1. **Create Schedule Proposal**:
   - Select **Recurring Payments** and specify recipient, disbursement interval (e.g. 30 days), per-period amount, and total disbursement cap.
2. **Owner Quorum Approval**:
   - Multisig owners review the recurring payment parameters and approve the proposal.
3. **Autonomous Disbursement & Controls**:
   - When each interval elapses, calling `disburse_recurring` distributes the scheduled tokens.
   - Multisig owners retain emergency governance controls: `pause_recurring`, `resume_recurring`, or `cancel_recurring`.

*Detailed written guide:* [Payroll with Recurring Payments](./guides/payroll-recurring.md).

---

## Flow 5: Treasury Analytics & Activity Monitoring

Monitor treasury health, token reserves, proposal throughput, and inspect live on-chain Soroban event telemetry.

![Treasury Analytics & Monitoring Walkthrough](./assets/walkthroughs/05-treasury-analytics-monitoring.svg)

> **GIF Alternative**: Available at [`docs/assets/walkthroughs/05-treasury-analytics-monitoring.gif`](./assets/walkthroughs/05-treasury-analytics-monitoring.gif).

### Step-by-Step Breakdown:

1. **Treasury Overview**:
   - View aggregated Total Value Locked (TVL), breakdown by token asset, and historical disbursement volume.
2. **Quorum & Participant Health**:
   - Analyze average approval turnaround times, owner voting participation rates, and inactive owner alerts.
3. **Real-Time Event Stream**:
   - Inspect decoded Soroban events (`created`, `approved`, `executed`, `rpay`) synced from the indexer API.
   - Filter by date range or proposal ID, and export audit trails to CSV or PDF.

*Detailed written guide:* [Treasury Analytics](./guides/treasury-analytics.md).

---

## Maintenance & Update Guide

As Accord Protocol's user interface and smart contract features evolve, walkthrough assets must be kept in sync.

### When to Update Walkthroughs

Update the visual walkthroughs whenever:
- The UI workflow or navigation hierarchy is altered.
- New proposal types or governance parameters are introduced.
- Stellar / Freighter wallet connection flows change.
- New status states or lifecycle transitions are added.

### How to Regenerate Vector & GIF Walkthroughs

The visual assets can be generated and regenerated reproducibly using the Python generator script:

```bash
python3 scripts/generate_walkthroughs.py
```

This updates both `.svg` and `.gif` files under `docs/assets/walkthroughs/`.

### Recording Real Screen Captures

When replacing generated animations with full video/screencast recordings:

1. **Resolution & Aspect Ratio**:
   - Record at 16:9 ratio (1280x720 or 1920x1080) at 30 fps.
2. **Recommended Tools**:
   - QuickTime Screen Recording / OBS Studio.
   - [Loom](https://www.loom.com) for video with voiceover commentary.
3. **GIF Compression**:
   - Convert video clips to high-efficiency GIFs using `ffmpeg`:
     ```bash
     ffmpeg -i input.mov -vf "fps=15,scale=800:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop 0 output.gif
     ```
   - Keep file size under **1.5 MB** per GIF to maintain fast documentation loading times.
4. **Placeholders**:
   - Never commit broken or placeholder image links; ensure every image referenced in documentation exists in the repository.

---

## CI & Asset Integrity Validation

Accord Protocol maintains markdown and asset link integrity:
- All asset paths are relative to `docs/` (`./assets/walkthroughs/<filename>`).
- CI validates that every media file linked in `README.md` and `docs/` exists in the repository.
- Both SVG and GIF variants are checked for valid header framing and zero-corruption.
