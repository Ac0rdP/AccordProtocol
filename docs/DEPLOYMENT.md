# Deployment Guide

This guide covers deploying the Accord contract to Stellar testnet and wiring the frontend to it.

## Prerequisites

- Stellar CLI installed and `accord-deployer` identity created (see [`docs/SETUP.md`](./SETUP.md))
- Funded testnet account: `stellar keys fund accord-deployer --network testnet`

---

## 1. Build the Contract WASM

From the repository root:

```bash
stellar contract build
```

The compiled WASM will be at:
```
target/wasm32v1-none/release/accord.wasm
```

---

## 2. Deploy to Testnet

```bash
bash scripts/deploy.sh
```

The script:
1. Uploads the WASM to the network
2. Deploys a new contract instance
3. Prints the **Contract ID** — save this value

Alternatively, run manually:

```bash
stellar network use testnet

# Upload WASM
stellar contract upload \
  --network testnet \
  --source-account accord-deployer \
  --wasm target/wasm32v1-none/release/accord.wasm

# Deploy contract
stellar contract deploy \
  --network testnet \
  --source-account accord-deployer \
  --wasm target/wasm32v1-none/release/accord.wasm
```

---

## 3. Initialize the Contract

Replace `CONTRACT_ID`, `OWNER_1`, `OWNER_2`, `OWNER_3`, and `THRESHOLD` with your values:

```bash
stellar contract invoke \
  --network testnet \
  --source-account accord-deployer \
  --id CONTRACT_ID \
  -- initialize \
  --owners '["OWNER_1","OWNER_2","OWNER_3"]' \
  --threshold 2
```

**Important:** All owner addresses must sign this transaction (each must authorize). In the CLI, use `--source-account` for each owner or handle via multi-auth in the frontend.

---

## 4. Fund the Contract Treasury

Send tokens to the contract address so it can pay out approved proposals:

```bash
# Example: send 100 XLM (using the native XLM SAC on testnet)
stellar contract invoke \
  --network testnet \
  --source-account accord-deployer \
  --id NATIVE_TOKEN_CONTRACT_ID \
  -- transfer \
  --from accord-deployer \
  --to CONTRACT_ID \
  --amount 1000000000
```

The native XLM SAC contract ID on testnet:
```
CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
```

---

## 5. Wire the Frontend

Add the contract address to `frontend/.env.local`:

```bash
VITE_CONTRACT_ADDRESS=YOUR_CONTRACT_ID
VITE_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
VITE_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
```

Then restart the dev server:

```bash
cd frontend && npm run dev
```

---

## 6. Verify the Deployment

Check the contract on the testnet explorer:

```
https://stellar.expert/explorer/testnet/contract/YOUR_CONTRACT_ID
```

Or use Stellar Lab:

```
https://lab.stellar.org/smart-contracts/contract-explorer?contractId=YOUR_CONTRACT_ID&network=testnet
```

---

## Current Testnet Deployment

| Field | Value |
|-------|-------|
| Contract ID | _(fill in after your first deploy)_ |
| Network | Testnet |
| WASM hash | _(printed by deploy script)_ |
| Deploy tx | _(printed by deploy script)_ |
| Explorer | `https://stellar.expert/explorer/testnet` |

---

## Re-deploying

The contract does not support upgradeability in the current version (planned roadmap item). To deploy a new version, deploy a fresh contract instance and re-initialize with the same owners.

---

## Mainnet Deployment

### Pre-flight Checks

Before deploying to mainnet, verify the following:

- [ ] All tests pass: `cargo test`
- [ ] WASM binary built in release mode: `stellar contract build`
- [ ] Deployer account funded with sufficient XLM
- [ ] Owners and threshold agreed upon and addresses verified
- [ ] Contract code audited and reviewed

### Deploy to Mainnet

```bash
stellar network use mainnet

# Upload WASM
stellar contract upload \
  --network mainnet \
  --source-account accord-deployer \
  --wasm target/wasm32v1-none/release/accord.wasm

# Deploy contract
stellar contract deploy \
  --network mainnet \
  --source-account accord-deployer \
  --wasm target/wasm32v1-none/release/accord.wasm
```

### Initialize on Mainnet

```bash
stellar contract invoke \
  --network mainnet \
  --source-account accord-deployer \
  --id CONTRACT_ID \
  -- initialize \
  --owners '["OWNER_1","OWNER_2","OWNER_3"]' \
  --threshold 2
```

### Fund the Multisig with XLM and USDC

```bash
# Fund with XLM (native SAC on mainnet)
stellar contract invoke \
  --network mainnet \
  --source-account accord-deployer \
  --id CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
  -- transfer \
  --from accord-deployer \
  --to CONTRACT_ID \
  --amount 1000000000

# Fund with USDC (mainnet USDC SAC)
stellar contract invoke \
  --network mainnet \
  --source-account accord-deployer \
  --id CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7EJJUD \
  -- transfer \
  --from accord-deployer \
  --to CONTRACT_ID \
  --amount 1000000000
```

### Verify the Deployment

Check the contract on the mainnet explorer:
C
### Mainnet Environment Variables

```bash
VITE_CONTRACT_ADDRESS=YOUR_CONTRACT_ID
VITE_SOROBAN_RPC_URL=https://soroban-mainnet.stellar.org
VITE_NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015
```

### Current Mainnet Deployment

| Field | Value |
|-------|-------|
| Contract ID | _(fill in after deploy)_ |
| Network | Mainnet |
| WASM hash | _(printed by deploy script)_ |
| Deploy tx | _(printed by deploy script)_ |
| Explorer | `https://stellar.expert/explorer/public` |
