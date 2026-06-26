# Development Setup

This guide walks through setting up Accord Protocol for local development on macOS, Linux, and Windows.

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| **Git** | Any | Version control |
| **Rust** | stable | Soroban contracts |
| **Node.js** | 20 LTS | Frontend |
| **Stellar CLI** | latest | Build, test, and deploy contracts |
| **Docker** | optional | Local Soroban node |

---

## 1. Install Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# Add the WASM target required by Soroban
rustup target add wasm32v1-none
```

Verify: `rustc --version`

---

## 2. Install Stellar CLI

```bash
cargo install --locked stellar-cli --features opt
```

Verify: `stellar --version`

---

## 3. Install Node.js

Use [nvm](https://github.com/nvm-sh/nvm) (recommended) or download from [nodejs.org](https://nodejs.org):

```bash
nvm install 20
nvm use 20
```

Verify: `node --version`

---

## 4. Clone and Configure

```bash
git clone https://github.com/thegreatfeez/accord-protocol.git
cd accord-protocol

# Copy environment templates
cp .env.example .env
cp .env.example frontend/.env.local
```

Edit `frontend/.env.local` and fill in `VITE_CONTRACT_ADDRESS` after deploying (see [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md)).

---

## 5. Frontend Setup

```bash
cd frontend
npm ci
npm run dev    # starts at http://localhost:5173
```

Other useful commands:

```bash
npm run build  # type-check + production build
npm run lint   # ESLint
```

---

## 6. Connecting Freighter

The Accord frontend uses the [Freighter](https://freighter.app) browser extension wallet to sign transactions. Install and configure it before interacting with proposals.

### Install Freighter

- **Chrome / Brave / Edge**: Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/freighter/ejadnnkphdlanekannbhbpgkgepknjcf)
- **Firefox**: Install from the [Firefox Add-ons store](https://addons.mozilla.org/en-US/firefox/addon/freighter/)

After installing, create a new wallet or import an existing one by following the extension's onboarding flow.

### Switch to Testnet

1. Click the Freighter icon in your browser toolbar.
2. Open **Settings** (gear icon) → **Network**.
3. Select **Testnet** from the dropdown.
4. The icon badge should now read **TESTNET**.

> The Accord frontend only connects to Testnet. If Freighter is set to Mainnet or Pubnet the app will not detect the wallet.

### Confirm the Connection

1. Start the frontend: `cd frontend && npm run dev`
2. Open `http://localhost:5173` in your browser.
3. Freighter should prompt you to approve a connection. If not, click **Connect Wallet** in the app header.
4. Once connected, your public key (G…) appears in the header.

### Troubleshooting

| Problem | Fix |
|---------|-----|
| Freighter not detected by the app | Reload the page. Ensure Freighter has permission to access `localhost` (Chrome: extension icon → right-click → **Inspect popup** → check console for errors; ensure **Allow access to file URLs** is enabled in extension settings). |
| Wrong network selected | Open Freighter → Settings → Network → switch to **Testnet**. The app will ignore connections on Mainnet or Pubnet. |
| Extension not appearing after install | Restart your browser. Freighter requires Chrome 88+, Firefox 109+, or any Chromium-based browser; it does not support Safari or mobile browsers. |

---

## 7. Contract Setup

From the **repository root**:

```bash
# Build all contracts in the workspace
stellar contract build

# Run contract tests
stellar contract test
# or equivalently from the contract directory:
cd contracts/accord && cargo test
```

---

## 8. Local Soroban Node (optional)

A `docker-compose.yml` at the repo root starts a standalone Soroban node:

```bash
docker compose up
```

- Soroban RPC: `http://localhost:8000`
- Horizon: `http://localhost:8001`

Update `.env` to point `SOROBAN_RPC_URL` at `http://localhost:8000` when developing locally.

---

## 9. Create a Deployer Identity

The Stellar CLI uses local key aliases (no browser extension needed for deployment):

```bash
stellar keys generate accord-deployer
stellar keys public-key accord-deployer
```

This prints a `G…` public key. Fund it with testnet XLM:

```bash
stellar network use testnet
stellar keys fund accord-deployer --network testnet
```

Or use [Friendbot](https://friendbot.stellar.org/?addr=YOUR_PUBLIC_KEY) directly.

### Fund a Freighter Wallet on Testnet

If you are a regular user (not deploying contracts), fund your Freighter wallet via Friendbot instead:

1. Copy your Freighter wallet address (the `G…` public key displayed in the extension).
2. Open the following URL in your browser, replacing `G…` with your address:
   ```
   https://friendbot.stellar.org?addr=G…
   ```
3. Friendbot returns a JSON response with a `"hash"` field — this is the transaction hash of the funding operation.
4. Your wallet now has **10,000 test XLM**. Check the balance in Freighter.

> The CLI `stellar keys fund` command is for deployer identities. Regular users should always use the Friendbot URL above. Friendbot is rate-limited to one request per 60 seconds per IP.

---

## 10. Verify Your Setup

```bash
# From repo root
stellar contract test          # all Rust tests should pass

cd frontend
npm run lint && npm run build  # should exit 0 with no errors
```

If both commands succeed, your environment is ready. See [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) to deploy to testnet.

---

## Windows

You can develop on Windows using either **WSL2** (recommended) or a **native Windows** setup.

### WSL2 (recommended)

- Run all commands inside a WSL2 terminal (Ubuntu recommended).
- Docker Desktop for Windows with WSL2 integration enabled is required for the local node.
- Node.js and Rust should be installed inside WSL2, not on the Windows host.

### Windows Native (PowerShell or Git Bash)

- **Rust**: Download and run `rustup-init.exe` from [rustup.rs](https://rustup.rs), then follow the standard installer prompts.
- **Node.js**: Download the LTS installer from [nodejs.org](https://nodejs.org) or install via `winget install OpenJS.NodeJS.LTS`.
- **Stellar CLI**: Open a terminal and run `cargo install stellar-cli`. The Rust WASM target (`wasm32v1-none`) is added automatically by the Stellar CLI installer on Windows — if it is not, run `rustup target add wasm32v1-none` manually.
- **Docker**: Optional. Skip if you are using a remote Testnet RPC endpoint (the default). Docker Desktop for Windows is only required if you want a local Soroban node.

> **Known limitations:** The local Soroban node (Docker) is not well-tested on Windows native. If you encounter issues, switch to WSL2 or use the remote Testnet.

---

## Common Issues

| Problem | Fix |
|---------|-----|
| `wasm32v1-none target not found` | Run `rustup target add wasm32v1-none` |
| `stellar: command not found` | Ensure `~/.cargo/bin` is in your `$PATH` |
| `npm ci` fails with peer errors | Ensure you are on Node.js 20+ |
| Friendbot rate-limit | Wait 60s and retry, or use Stellar Lab account tools |
