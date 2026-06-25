# Connecting Your Wallet

This guide walks you through everything you need to do before you can interact with Accord Protocol — from installing the Freighter browser extension to funding your test account. No blockchain experience is required.

---

## Step 1 — Install the Freighter browser extension

Freighter is a browser wallet for Stellar. It lets you create a Stellar account, keep your keys secure, and sign transactions with one click.

**How to install:**

1. Open the [Freighter download page](https://www.freighter.app) in your browser.
2. Click **Add to Chrome** (or the equivalent button for your browser).
3. Your browser will ask for permission — click **Add Extension** to confirm.

**How to confirm it worked:** A small wallet icon will appear in your browser's extension bar. Click it and you should see the Freighter welcome screen.

---

## Step 2 — Create or import a Stellar account

If you already have a Stellar account you would like to use, you can import it. If you are new to Stellar, create a fresh account now.

**To create a new account:**

1. Click the Freighter icon in your extension bar.
2. Click **Create New Account**.
3. Write down your 12-word recovery phrase and store it somewhere safe. This phrase is the only way to recover your account if you lose access to your browser.
4. Confirm the phrase when prompted, then set a password for the extension.

**To import an existing account:**

1. Click the Freighter icon and choose **Import Account** (or **Import Wallet**).
2. Enter your existing 12-word or 24-word recovery phrase.
3. Set a password when prompted.

**How to confirm it worked:** After setup, the Freighter popup will show your Stellar account address — a long string that starts with `G`. This is your public key.

---

## Step 3 — Switch to the Testnet network

Accord Protocol is deployed on Stellar **Testnet**. Testnet is a separate environment for testing; tokens here have no real value, and mistakes do not cost real money.

**How to switch:**

1. Click the Freighter icon.
2. Look for the network selector at the top of the popup — it may say **Mainnet** or **Public Network** by default.
3. Click it and select **Testnet** from the dropdown.

**How to confirm it worked:** The network selector will now show **Testnet**. The account address will remain the same — only the network changes.

---

## Step 4 — Fund your account with test XLM via Friendbot

Stellar accounts must hold a small amount of XLM to exist on the network and pay transaction fees. On Testnet you can get free test XLM from **Friendbot**, a faucet maintained by the Stellar Development Foundation.

**How to fund your account:**

1. Copy your Stellar address from Freighter (click the address shown in the popup to copy it).
2. Open the Friendbot page at `https://friendbot.stellar.org/?addr=YOUR_ADDRESS` — replace `YOUR_ADDRESS` with the address you just copied — or use the Stellar Laboratory at `https://laboratory.stellar.org/#account-creator?network=test`.
3. Wait a few seconds. Friendbot will credit your account with 10,000 test XLM.

**How to confirm it worked:** Open Freighter and check your balance. You should see **10,000 XLM** (Testnet).

---

## You're ready

Once Freighter shows your Testnet balance, the Accord app will detect your wallet automatically when you open it. You do not need to click "connect" on every visit — Freighter reconnects on page load as long as you have already approved the site.

You are now ready to view proposals, approve transfers, and interact with the Accord multisig.
