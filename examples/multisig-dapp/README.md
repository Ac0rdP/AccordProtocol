# Accord Multisig dApp — Example Integration

This example demonstrates how to build an end-to-end web application on Stellar Soroban using `@accord-protocol/sdk` and `@stellar/freighter-api`.

---

## What This Example Demonstrates

1. **Freighter Wallet Integration**: Connects to the user's Freighter extension without managing private keys or seeds.
2. **Reading On-Chain State**: Queries current owners, approval threshold, active proposals, and emergency freeze/recovery flags via simulation reads.
3. **Proposal Workflow**:
   - Submits a transfer proposal via `client.createProposal`.
   - Approves a pending proposal via `client.approve`.
   - Executes a ready proposal via `client.execute`.
4. **Typed Error Handling**: Catches and displays user-friendly messages for typed contract errors (such as `RecoveryActive`, `ContractFrozen`, and `ThresholdNotMet`).

---

## Setup and Running

### 1. Prerequisites
- Node.js 20 LTS installed.
- [Freighter Wallet](https://www.freighter.app/) extension installed in your browser, set to **Stellar Testnet**.

### 2. Configure Environment
From this directory:

```bash
cp .env.example .env
```

The default values point to the Stellar Testnet RPC and the official testnet contract deployment (`CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS`).

### 3. Install and Run Locally

```bash
npm install
npm run dev
```

Open [http://localhost:5174](http://localhost:5174) in your browser.

---

## SDK Package Dependency & Switching to Registry Version

Until the initial release of `@accord-protocol/sdk` is published to the npm registry by project maintainers, this example depends on the local SDK package via `file:` path in `package.json`:

```json
"dependencies": {
  "@accord-protocol/sdk": "file:../../packages/sdk"
}
```

### How to Switch to the Published Registry Version

After maintainers publish the first release (`0.1.0`) to npm:

1. Update `package.json` to reference the registry version:
   ```bash
   npm install @accord-protocol/sdk@^0.1.0
   ```
   Or edit `package.json` directly:
   ```json
   "dependencies": {
     "@accord-protocol/sdk": "^0.1.0"
   }
   ```
2. Re-run `npm install`.

> [!NOTE]
> The acceptance criterion "uses the published SDK" can only be fully satisfied after a human maintainer creates the first release tag and publishes the package to npm with the necessary registry credentials.

---

## Verification & Build Checks

To verify compilation and run the automated smoke test (which mocks the SDK and asserts create, approve, and execute happen in the expected order with the right parameters):

```bash
npm run build
npm run test:smoke
```

### Verification Limitations
- Automated smoke tests verify contract call sequences, argument mapping, and type safety using a mock adapter.
- Real wallet signing and live Soroban testnet submission require a browser with the Freighter extension active and were not executed during automated CI.
