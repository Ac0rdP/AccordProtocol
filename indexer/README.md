# Accord Protocol Indexer

The indexer is a standalone Node.js service that polls the Soroban RPC for events emitted by Accord Protocol contracts and their configured tokens. One process can track several contracts across several networks.

## Features

- **Multi-contract, multi-network**: one deployment indexes any number of (network, contract) targets, each with its own RPC endpoint, tokens, start ledger and checkpoints.
- **Token Transfers**: indexes `transfer` events from configured tokens to/from each treasury address, tracking balances natively per contract.
- **Accord Protocol Events**: indexes core protocol events (proposals, roles, thresholds) using the typed catalog and exposes them decoded.
- **Reconciliation**: periodically compares on-chain values to the indexed view, records every check, and raises alerts and metrics on drift.
- **Retention**: rolls raw history into daily aggregates, then archives or prunes it on configurable windows.

## Architecture

The indexer persists events in a local SQLite database (`data/treasury.sqlite` by default). Every row carries the `network` and `contract_id` it came from, and `indexer_state` is keyed on `(network, contract_id, key)`, so each target's `next_ledger` and `event_cursor` advance independently and a restart resumes each one where it left off.

A database written before multi-network support is migrated in place on first open: its rows are tagged with the target named by `ACCORD_CONTRACT_ID` and `NETWORK_PASSPHRASE`. Without those variables the migration refuses to guess and the service exits with an explanation.

## Configuration

Set `INDEXER_TARGETS` (inline JSON) or `INDEXER_TARGETS_FILE` (a path to the same JSON) to index more than one target:

```json
[
  {
    "id": "testnet-ops",
    "contractId": "CA...TESTNET_TREASURY",
    "startLedger": 1200000
  },
  {
    "id": "pubnet-main",
    "contractId": "CA...PUBNET_TREASURY",
    "networkPassphrase": "Public Global Stellar Network ; September 2015",
    "rpcUrl": "https://soroban-mainnet.example.org",
    "startLedger": 54000000,
    "tokens": [
      { "name": "XLM", "address": "CA...XLM" },
      { "name": "USDC", "address": "CA...USDC" }
    ]
  }
]
```

Any field a target omits falls back to the single-target environment variables, so the shared RPC URL, passphrase, simulation source, start ledger and token list only need stating once. A target's `network` defaults to the name of its passphrase (`testnet`, `pubnet`, `futurenet`, `standalone`, or `custom`). Two targets for the same network and contract, or two with the same `id`, are rejected at startup.

With neither variable set, the single-target environment variables describe exactly one target, so an existing single-contract deployment needs no configuration change.

| Variable | Default | Description |
| --- | --- | --- |
| `INDEXER_TARGETS` / `INDEXER_TARGETS_FILE` | — | The full target list as JSON, inline or in a file. |
| `ACCORD_CONTRACT_ID` | — | Contract for the single legacy target, and the tag used when migrating an old database. |
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | Default RPC endpoint. Use an archival endpoint that covers your start ledger. |
| `NETWORK_PASSPHRASE` | testnet passphrase | Default network passphrase. |
| `SIM_SOURCE` | — | Account used to simulate read-only contract calls. Must exist and be funded on each network. |
| `INDEXER_START_LEDGER` | — | Default ledger to begin indexing from. |
| `XLM_TOKEN_ADDRESS`, `USDC_TOKEN_ADDRESS` | — | Default token list. |
| `DATABASE_PATH` | `./data/treasury.sqlite` | SQLite file. |
| `INDEX_INTERVAL_MS` | `5000` | How often to poll for new events. |
| `RECONCILE_INTERVAL_MS` | `60000` | How often to reconcile against the chain. |
| `ALERT_WEBHOOK_URL` | — | POST target for drift alerts. Retried three times with linear backoff. |
| `RETENTION_RAW_EVENT_DAYS` | `0` | Days of raw entries and events to keep. `0` keeps everything. |
| `RETENTION_AGGREGATE_DAYS` | `0` | Days of daily aggregates to keep. Must be ≥ the raw window. |
| `RETENTION_RECONCILIATION_DAYS` | `0` | Days of reconciliation results to keep. The latest per check and subject is always kept. |
| `RETENTION_ARCHIVE_DIR` | — | Archive rows as JSON Lines here before removing them. Unset prunes without archiving. |
| `RETENTION_INTERVAL_MS` | `86400000` | How often retention runs. |
| `HOST`, `PORT` | `127.0.0.1`, `8787` | API bind address. |

See [docs/ANALYTICS_API.md](../docs/ANALYTICS_API.md#data-retention-and-archival) for what a retention run does and why reports still work after a prune.

## Endpoints

`network` and `contract` scope any read to one target; omitting them returns every target's data, with each row tagged.

- `GET /health` — per-target checkpoints and last index time.
- `GET /targets` — the configured targets.
- `GET /ledger?network=&contract=&token=&from=&to=&limit=&offset=` — historical treasury token transfers.
- `GET /events?network=&contract=&topic=&from=&to=` — decoded Accord Protocol events.
- `GET /balances?network=&contract=` — current running balance per token.
- `GET /aggregates?network=&contract=&token=&fromDay=&toDay=` — daily rollups, including days whose raw rows have been pruned.
- `GET /reconciliation?network=&contract=&check=` — latest result for each check and subject.
- `POST /reconciliation/run?network=&contract=` — reconcile now; `409` while a run is in progress.
- `GET /retention` — the active policy and recent runs.
- `POST /retention/run?network=&contract=` — apply retention now; `409` if disabled or already running.
- `GET /metrics` — Prometheus gauges for drift, check status, last run time and checkpoints.

## Running

```sh
cd indexer
npm install
npm start
```

## Tests

```sh
cd indexer
npm test
```

Coverage includes indexing two contracts into one store, per-target checkpoints and filtering, retention roll-up and pruning, drift detection and alert retries.
