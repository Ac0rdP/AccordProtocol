# Scripts

Helper scripts for Accord Protocol.

| Script | Purpose |
|---|---|
| `deploy.sh` | Build WASM, upload and deploy contract to testnet |
| `fund-account.sh` | Fund a Stellar identity via Friendbot |
| `check-wasm-size.sh` | Verify WASM stays under size limit |
| `keeper-recurring.js` | **Off-chain keeper** — polls due recurring schedules and calls `disburse_recurring` |

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
