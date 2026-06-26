# Deploy Your Own Multisig

## What You Will Build

By the end of this tutorial you will have a working 2-of-3 Accord multisig contract deployed to the Stellar testnet. The contract will be initialized with three owner addresses and a threshold of two, meaning any two of the three owners must approve a proposal before it can be executed. You will verify the deployment by querying the on-chain state to confirm that the owner list and threshold match what you configured.

---

## Prerequisites

Before you begin, make sure you have the following installed and working. If anything is missing, follow the linked setup instructions — this tutorial will not repeat them.

| Requirement | How to check | Install instructions |
|-------------|--------------|----------------------|
| **Git** | `git --version` | [git-scm.com](https://git-scm.com) |
| **Rust** (stable) with the `wasm32v1-none` target | `rustc --version` and `rustup target list --installed` | [docs/SETUP.md — Install Rust](../SETUP.md#1-install-rust) |
| **Stellar CLI** | `stellar --version` | [docs/SETUP.md — Install Stellar CLI](../SETUP.md#2-install-stellar-cli) |
| **A funded testnet identity** | `stellar keys public-key accord-deployer` | Created in the next section if you don't have one |

---

## Clone and Build

Start by cloning the Accord repository and building the contract.

**1. Clone the repository:**

```bash
git clone https://github.com/thegreatfeez/accord-protocol.git
cd accord-protocol
```

**2. Build the contract WASM:**

```bash
stellar contract build
```

This compiles the Soroban smart contract and produces a WASM binary. When the build finishes, the compiled file will be at:

```
target/wasm32v1-none/release/accord.wasm
```

You can confirm the file exists:

```bash
ls -lh target/wasm32v1-none/release/accord.wasm
```

If the build fails with a "wasm32v1-none target not found" error, you need to add the target to your Rust toolchain:

```bash
rustup target add wasm32v1-none
```

Then run `stellar contract build` again.

---

## Create a Testnet Identity and Fund It

You need a Stellar identity (keypair) to sign deployment transactions. If you already have an `accord-deployer` identity, skip to the funding step.

**1. Generate a named keypair:**

```bash
stellar keys generate accord-deployer
```

This creates a new Stellar keypair stored locally under the name `accord-deployer`. Print the public key to confirm it was created:

```bash
stellar keys public-key accord-deployer
```

You should see a `G…` address printed to the terminal.

**2. Switch the CLI to testnet:**

```bash
stellar network use testnet
```

**3. Fund the account via Friendbot:**

The repository includes a convenience script that funds an account through Stellar's Friendbot faucet:

```bash
bash scripts/fund-account.sh accord-deployer
```

The script will print the public key and a link to view the account on Stellar Expert. Friendbot credits the account with 10,000 test XLM — more than enough for deploying and interacting with the contract.

If Friendbot returns an error saying the account is already funded, that is fine — your account already has XLM and you can proceed.

---

## Deploy the Contract

You have two options: the `deploy.sh` convenience script, or the manual CLI commands. Both produce the same result — a live contract instance on testnet with a Contract ID printed to your terminal.

### Option A — Use the deploy script

From the repository root:

```bash
bash scripts/deploy.sh
```

The script does three things in sequence:

1. Builds the contract WASM (so you can skip the earlier build step if you go straight here).
2. Uploads the WASM to the Stellar testnet.
3. Deploys a new contract instance and prints the **Contract ID**.

The output will look something like this:

```
==========================================
  Contract deployed successfully!
  Contract ID: CABC...XYZ123
  Network: testnet
==========================================
```

Copy the Contract ID and save it somewhere safe — you will need it for every subsequent step.

### Option B — Manual CLI commands

If you prefer to run each step yourself, or if you need to customize the identity or network, use these commands:

```bash
stellar network use testnet

# Upload the WASM to the network
stellar contract upload \
  --network testnet \
  --source-account accord-deployer \
  --wasm target/wasm32v1-none/release/accord.wasm

# Deploy a new contract instance
stellar contract deploy \
  --network testnet \
  --source-account accord-deployer \
  --wasm target/wasm32v1-none/release/accord.wasm
```

The `deploy` command prints the Contract ID. Copy and save it.

---

## Initialize the Contract

Deploying the contract creates an empty instance on the network. You now need to initialize it with your list of owners and an approval threshold.

For this tutorial, you will set up a 2-of-3 multisig with three owner addresses. Replace the placeholder addresses below with real Stellar public keys — these are the wallets that will control the multisig.

```bash
stellar contract invoke \
  --network testnet \
  --source-account accord-deployer \
  --id YOUR_CONTRACT_ID \
  -- initialize \
  --owners '["GALICE0000000000000000000000000000000000000000000AAAA","GBOBBB0000000000000000000000000000000000000000000BBBB","GCHARLIE00000000000000000000000000000000000000000CCCC"]' \
  --threshold 2 \
  --time_lock_delay 0
```

**What each argument means:**

| Argument | Value | Purpose |
|----------|-------|---------|
| `--id` | Your Contract ID | The contract you just deployed |
| `--owners` | JSON array of three `G…` addresses | The Stellar accounts that will control this multisig |
| `--threshold` | `2` | The number of approvals required to execute any proposal |
| `--time_lock_delay` | `0` | Seconds to wait after threshold is met before execution is allowed (0 means no delay) |

**Important:** The `initialize` function requires authorization from every owner in the list, not just the deployer. When initializing via the CLI, the `--source-account` signs as one of the owners. For a production setup, the other owners would authorize the transaction through their own wallets (typically via the Accord frontend). On testnet, if you control all three keypairs locally, you can initialize directly from the CLI.

The command prints no output on success. If you see an `AlreadyInitialized` error, the contract has already been initialized and you can move on to verification.

---

## Verify the Deployment

Confirm that the on-chain state matches what you configured during initialization.

**1. Check the owner list:**

```bash
stellar contract invoke \
  --network testnet \
  --source-account accord-deployer \
  --id YOUR_CONTRACT_ID \
  -- get_owners
```

This returns a JSON array of the three owner addresses you provided. Verify that all three addresses are present and correct.

**2. Check the threshold:**

```bash
stellar contract invoke \
  --network testnet \
  --source-account accord-deployer \
  --id YOUR_CONTRACT_ID \
  -- get_threshold
```

This returns `2` — confirming that two out of three owners must approve before any proposal can be executed.

**3. View the contract on Stellar Expert (optional):**

Open the following URL in your browser, replacing `YOUR_CONTRACT_ID` with your actual contract ID:

```
https://stellar.expert/explorer/testnet/contract/YOUR_CONTRACT_ID
```

This shows the contract's on-chain state, transaction history, and WASM hash.

If both `get_owners` and `get_threshold` return the values you expect, your multisig is live and ready to use.

---

## Next Steps

Your multisig contract is deployed and initialized. Here is where to go from here:

- **Create your first proposal.** Head to the [user guides](../guides/) to learn how to create a payment proposal, collect approvals, and execute a transfer through the Accord dashboard.
- **Set up the frontend.** Add your Contract ID to `frontend/.env.local` and start the dev server — see [docs/DEPLOYMENT.md](../DEPLOYMENT.md#5-wire-the-frontend) for the configuration variables.
- **Plan for mainnet.** When you are ready to deploy to production, review [docs/DEPLOYMENT.md](../DEPLOYMENT.md) for mainnet deployment considerations, contract upgrades, and post-deployment verification checklists.
