# Scripts

Helper scripts for Accord Protocol.

| Script | Purpose |
|---|---|
| `deploy.sh` | Build WASM, upload and deploy contract to testnet |
| `fund-account.sh` | Fund a Stellar identity via Friendbot |
| `check-wasm-size.sh` | Verify WASM stays under size limit |
| `keeper-recurring.js` | **Off-chain keeper** — polls due recurring schedules and calls `disburse_recurring` |
| `query-analytics.js` | **Analytics query CLI** — queries indexed data and prints human-readable tables for spend, treasury flow, and summary metrics |

---

## Indexer Configuration & Local Run Guide

The off-chain indexer polls Soroban RPC for events emitted by the Accord multisig contract (`created`, `approved`, `revoked`, `executed`, `rpay`, etc.), decodes XDR topics and values, persists them to a datastore, and updates materialized aggregates (proposal statuses, spend-by-category, spend-by-owner, and treasury inflow/outflow time series). See [ARCHITECTURE.md §13](../docs/ARCHITECTURE.md#13-indexer--analytics-architecture) and [ANALYTICS_API.md](../docs/ANALYTICS_API.md) for architecture details.

### Configuration Reference

The indexer reads configuration from environment variables or a `.env` file in the repository root:

| Variable | Required | Default | Example Value | Description |
|---|---|---|---|---|
| `SOROBAN_RPC_URL` / `VITE_SOROBAN_RPC_URL` | **yes** | `https://soroban-testnet.stellar.org` | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint URL |
| `CONTRACT_ID` / `VITE_CONTRACT_ADDRESS` | **yes** | — | `CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS` | Deployed Accord contract ID (`C...`) |
| `NETWORK_PASSPHRASE` / `VITE_NETWORK_PASSPHRASE` | no | `Test SDF Network ; September 2015` | `Test SDF Network ; September 2015` | Passphrase for network (`Standalone Network ; February 2017` for local quickstart) |
| `START_LEDGER` | no | Latest or deployment ledger | `1000` | Sequence number to begin event ingestion from |
| `STORE_PATH` / `INDEXER_STORE_PATH` | no | `./data/indexer-store.json` | `./data/indexer-store.json` | Filesystem path for persisted indexer store and checkpoints |
| `POLL_INTERVAL_MS` / `INDEXER_POLL_INTERVAL_MS` | no | `5000` | `5000` | Interval between polling cycles in milliseconds |
| `LOG_LEVEL` | no | `info` | `debug` | Logging level (`debug`, `info`, `warn`, `error`) |

Example `.env`:

```env
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
CONTRACT_ID=CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS
NETWORK_PASSPHRASE=Test SDF Network ; September 2015
START_LEDGER=1000000
STORE_PATH=./data/indexer-store.json
POLL_INTERVAL_MS=5000
LOG_LEVEL=info
```

### Step-by-Step Instructions for a First Local Run

1. **Install dependencies:**
   Ensure Node.js (≥ 18) and frontend dependencies are installed:
   ```bash
   npm --prefix frontend install
   ```

2. **Configure environment:**
   Create a `.env` file in the project root with your deployed contract address and target RPC endpoint:
   ```bash
   cp .env.example .env # or create .env with variables above
   ```

3. **Run the indexer:**
   Start the indexer service or run with explicit environment variables:
   ```bash
   CONTRACT_ID=CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS \
   SOROBAN_RPC_URL=https://soroban-testnet.stellar.org \
   START_LEDGER=1000 \
   STORE_PATH=./data/indexer-store.json \
   node scripts/query-analytics.js summary
   ```

4. **Expected Output:**
   On startup, the indexer verifies RPC connectivity, determines the starting ledger from the saved checkpoint (or `START_LEDGER` if uninitialized), and begins processing event batches:
   ```text
   [INFO] Accord Indexer starting...
   [INFO] RPC endpoint: https://soroban-testnet.stellar.org
   [INFO] Contract ID: CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS
   [INFO] Resuming from checkpoint ledger: 1000000
   [INFO] Ingesting ledger range 1000000..1000100 (found 3 events)
   [INFO] Processed event [executed] id=42 tx=a1b2...
   [INFO] Checkpoint updated to ledger: 1000100
   ```

### Replaying History and Resetting the Local Store

- **Resetting the Local Store:**
  To completely clear the local store and checkpoint data:
  ```bash
  rm -f ./data/indexer-store.json
  ```
  On the next run, the indexer will initialize a fresh empty store.

- **Replaying History:**
  To replay all events from a specific point in time or from the deployment ledger:
  1. Stop the indexer process.
  2. Remove or backup the current store file:
     ```bash
     mv ./data/indexer-store.json ./data/indexer-store.bak.json
     ```
  3. Run the indexer with `START_LEDGER` set to the desired starting ledger:
     ```bash
     START_LEDGER=1000 STORE_PATH=./data/indexer-store.json node scripts/query-analytics.js summary
     ```
  **Why replay is safe and idempotent:**
  - Events are keyed by `(contract_id, ledger, tx_hash, event_index)`. Re-processing an already ingested range performs idempotent upserts and produces no duplicate records.
  - Materialized aggregates (spend by category, spend by owner, treasury balance snapshots) are derived by folding raw events in order rather than incrementing independent counters.

---

## query-analytics.js — Analytics Query CLI

A command-line tool to inspect and query indexed analytics data from the terminal without needing a browser.

### Features
- Aggregates spend by proposal category with totals, counts, and percentage shares.
- Buckets treasury inflow and outflow by date and granularity (`day`, `week`, `month`).
- Summarizes high-level metrics (total disbursed per token, active proposal count, largest outflow).
- Renders results in clean, formatted console tables.
- Gracefully handles empty stores, missing files, and invalid CLI arguments without stack traces.

### Commands

#### 1. Spend by Category
Aggregates executed transfer spend grouped by category:
```bash
node scripts/query-analytics.js spend-by-category
node scripts/query-analytics.js spend-by-category --token=USDC
node scripts/query-analytics.js spend-by-category --start=2026-09-01 --end=2026-09-30
```

#### 2. Treasury Flow
Inspects inflows and outflows over time:
```bash
node scripts/query-analytics.js treasury-flow
node scripts/query-analytics.js treasury-flow --granularity=month
node scripts/query-analytics.js treasury-flow --token=XLM --granularity=week
```

#### 3. Summary
Displays high-level multisig metrics:
```bash
node scripts/query-analytics.js summary
node scripts/query-analytics.js summary --token=USDC
```

### Options & Flags

| Flag | Description | Default |
|---|---|---|
| `--file=<path>` | Path to the indexed datastore JSON file | Value of `STORE_PATH` or `INDEXER_STORE_PATH` |
| `--token=<symbol>` | Filter queries to a specific token (`XLM`, `USDC`, etc.) | All tokens |
| `--start=<iso-date>` | Filter starting date (e.g. `2026-09-01`) | None |
| `--end=<iso-date>` | Filter ending date (e.g. `2026-09-30`) | None |
| `--granularity=<g>` | Time bucket granularity: `day`, `week`, or `month` | `day` |
| `--help`, `-h` | Display usage instructions and available options | — |

---

## keeper-recurring.js — Recurring Disbursement Keeper

The contract's `disburse_recurring(schedule_id)` entrypoint (`contracts/accord/src/lib.rs:2661`) is permissionless — any funded address may call it. The keeper automates this.

It emulates the `get_due_recurring_payments` view client-side (the current contract exposes `get_claimable_amount` / `get_recurring_payment` / `get_active_recurring_count`; see `lib.rs:2777`). If a bulk `get_due_recurring_payments() -> Vec<u64>` view is added later, replace `getDueScheduleIds()` with a single `simulateView("get_due_recurring_payments")`.

Follows the SDK patterns in `frontend/src/lib/submit.ts` (simulate → assemble → sign → send → poll) and `frontend/src/lib/contract.ts:29` (simulateView).

### Prerequisites

* Node.js ≥ 18
* A funded Stellar account for the keeper (any testnet account — keeper does not need to be an owner; it only pays the tx fee)
* Dependencies:

```bash
npm install @stellar/stellar-sdk dotenv
# or, if you already have frontend deps installed:
# npm --prefix frontend install && NODE_PATH=frontend/node_modules node scripts/keeper-recurring.js
```

### Configuration

Set via environment variables or a `.env` file in the repo root (loaded automatically via `dotenv` if installed).

| Variable | Required | Default | Notes |
|---|---|---|---|
| `CONTRACT_ID` / `VITE_CONTRACT_ADDRESS` | **yes** | — | Deployed Soroban contract ID (`C...`) |
| `KEEPER_SECRET_KEY` | **yes** unless `--dry-run` | — | Stellar secret `S...` of the keeper account (funded with XLM for fees) |
| `SOROBAN_RPC_URL` / `VITE_SOROBAN_RPC_URL` | no | `https://soroban-testnet.stellar.org` | RPC endpoint |
| `NETWORK_PASSPHRASE` / `VITE_NETWORK_PASSPHRASE` | no | `Test SDF Network ; September 2015` | Use `Standalone Network ; February 2017` for local `stellar quickstart` |
| `KEEPER_POLL_INTERVAL_MS` | no | `30000` | Poll interval in ms |
| `KEEPER_MAX_SCAN_IDS` | no | `100` | Upper bound for schedule-ID scan (MAX_ACTIVE is 20 — 100 is plenty) |
| `VITE_SIM_SOURCE` | no | keeper pubkey | Only used for `--dry-run` without a secret |

Example `.env`:

```env
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
CONTRACT_ID=CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS
NETWORK_PASSPHRASE=Test SDF Network ; September 2015
KEEPER_SECRET_KEY=SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
KEEPER_POLL_INTERVAL_MS=30000
```

> The keeper secret is **never** committed. `.gitignore` already excludes `.env`.

### How to run

```bash
# Single check (no txs) — good for testing config
node scripts/keeper-recurring.js --dry-run --once

# Single disbursement cycle (submits txs if due)
node scripts/keeper-recurring.js --once

# Continuous polling (default 30s)
node scripts/keeper-recurring.js
KEEPER_POLL_INTERVAL_MS=60000 node scripts/keeper-recurring.js

# Custom scan bound / interval via flags
node scripts/keeper-recurring.js --max-scan=200 --interval=15000 --once

# Help
node scripts/keeper-recurring.js --help
```

With a `.env` file the `CONTRACT_ID`/`KEEPER_SECRET_KEY` can be omitted from the command line.

### What it does each cycle

1. Reads `get_active_recurring_count` for logging.
2. Scans schedule IDs `1..KEEPER_MAX_SCAN_IDS` calling `get_claimable_amount(id)`. If `> 0`, the schedule is due (covers both `FixedAmountPerPeriod` interval checks and `LinearVesting` vested-amount math from `lib.rs:2777`).
3. For each due schedule, builds a `disburse_recurring` transaction, simulates, assembles, signs with the keeper keypair, submits, and polls `getTransaction` up to 30s (same flow as `frontend/src/lib/submit.ts:34`).
4. Logs success or expected skips (`DisbursementTooEarly #42`, `ScheduleNotActive #41`, `ScheduleEnded #43`, `ContractFrozen #26`) and continues to the next due schedule.

### Running continuously

**Cron (once per minute):**

```cron
* * * * * /usr/bin/env CONTRACT_ID=C... KEEPER_SECRET_KEY=S... /usr/bin/node /path/to/AccordProtocol/scripts/keeper-recurring.js --once >> /var/log/accord-keeper.log 2>&1
```

**systemd (example unit):**

```ini
[Unit]
Description=Accord recurring keeper
After=network.target

[Service]
WorkingDirectory=/opt/AccordProtocol
EnvironmentFile=/opt/AccordProtocol/.env
ExecStart=/usr/bin/node scripts/keeper-recurring.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**Docker:**

```bash
docker run --env-file .env -v $(pwd)/scripts:/app/scripts node:20 \
  node /app/scripts/keeper-recurring.js
```

### Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| `Missing CONTRACT_ID` | Set `CONTRACT_ID` or `VITE_CONTRACT_ADDRESS` |
| `Missing KEEPER_SECRET_KEY` | Set `KEEPER_SECRET_KEY` or use `--dry-run` |
| `simulation failed` / `NotInitialized` | Contract not deployed at `CONTRACT_ID` or wrong `SOROBAN_RPC_URL`/`NETWORK_PASSPHRASE` |
| `Account not found` | Keeper account not funded — run `bash scripts/fund-account.sh` or Friendbot |
| `ContractFrozen #26` | Contract is frozen (`freeze` guardian action) — keeper will skip until unfrozen |
| Nothing due every cycle | Normal — schedules only become claimable after `start_time`/`cliff_time` and `interval_secs` have elapsed; check `get_claimable_amount` manually via `stellar contract invoke` |

### Adapting to a future bulk view

If `get_due_recurring_payments() -> Vec<u64>` is added to the contract, replace the body of `getDueScheduleIds()` with:

```js
async function getDueScheduleIds() {
  const retval = await simulateView("get_due_recurring_payments");
  const ids = scValToNative(retval); // Vec<u64>
  return ids.map(id => ({ id: Number(id), claimable: null }));
}
```
