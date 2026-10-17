# Reconciliation Runbook

The indexer builds its view of the treasury by replaying events. If it misses an
event, misreads one, or an RPC endpoint serves an incomplete window, that view
drifts away from the chain and nothing in the data itself says so. The
reconciliation job exists to find that drift before anyone relies on the wrong
number.

This runbook covers what the job checks, how it reports, and what to do when it
fires. The configuration reference lives in
[ANALYTICS_API.md — Reconciliation and Drift Detection](ANALYTICS_API.md#reconciliation-and-drift-detection).

---

## What is checked

The job runs per (network, contract) target on `RECONCILE_INTERVAL_MS` (default
60 s) and records a row for every check on every run, whether or not it agrees.

| Check | Subject | On-chain value | Indexed value |
| --- | --- | --- | --- |
| `token_balance` | each configured token symbol | `balance(treasury)` simulated against the token contract | the running balance in `token_balances` |
| `total_proposals` | `proposals` | `get_total_proposals()` on the Accord contract | the count of `created` events, live rows plus archived aggregates |

`drift` is always `actual - implied`:

- **positive** — the chain holds more than the indexer accounted for, so an
  inflow was missed.
- **negative** — the indexer counted more than the chain holds, so an outflow
  was missed or an event was double-counted.

Status is `ok` (drift is zero), `drift` (it is not), or `error` (the chain could
not be read). An `error` is never recorded as agreement: a failed read means the
value is unverified, which is a different thing from verified-correct.

## How drift reaches you

1. **Logs** — every non-`ok` result is written to stderr as
   `[reconciliation] <network>/<contract> <check>:<subject> status=… implied=… actual=… drift=…`.
2. **Webhook** — when `ALERT_WEBHOOK_URL` is set, each non-`ok` result is POSTed
   as JSON. Delivery is retried up to three times with linear backoff; a webhook
   that stays down is logged and never stops reconciliation.
3. **Metrics** — `GET /metrics` on the indexer serves Prometheus text:
   `accord_reconciliation_drift`, `accord_reconciliation_status` (1 for ok, 0
   otherwise), `accord_reconciliation_last_run_seconds` and
   `accord_indexer_next_ledger`, labelled by `network`, `contract_id`, `check`
   and `subject`.
4. **API** — `GET /reconciliation` returns the latest result for each check and
   subject, filterable with `network`, `contract`, and `check`.

### Suggested alerts

```
# Drift on any value, held for 10 minutes (a single scrape can race a new block).
min_over_time(accord_reconciliation_status[10m]) == 0

# Reconciliation has stopped running at all.
time() - accord_reconciliation_last_run_seconds > 900

# Indexing has stalled: the checkpoint has not moved in 15 minutes.
increase(accord_indexer_next_ledger[15m]) == 0
```

`accord_reconciliation_status` covers `error` as well as `drift`, so one alert
catches both a wrong value and an unverifiable one.

---

## Responding to an alert

### 1. Confirm it is real, not a race

Token balances move between the read of the indexed balance and the simulated
chain read. A single drifted sample that clears on the next run is usually that
race, which is why the suggested alert requires drift to persist. Re-run the job
and look again:

```sh
curl -X POST "http://127.0.0.1:8787/reconciliation/run?network=testnet&contract=CA...TREASURY"
curl "http://127.0.0.1:8787/reconciliation?network=testnet&contract=CA...TREASURY"
```

`POST /reconciliation/run` is synchronous and returns the results it recorded.
It responds `409` while another run is in progress. With no parameters it
reconciles every configured target.

### 2. Decide which way the drift points

Read `drift` as described above, then narrow the window. Compare the indexed
entries around the current checkpoint against the chain:

```sh
curl "http://127.0.0.1:8787/health"          # next ledger per target
curl "http://127.0.0.1:8787/ledger?network=testnet&contract=CA...TREASURY&limit=20"
```

A `total_proposals` drift with a correct balance usually means decoded events
were dropped while token transfers were not — check that
`indexer/src/catalog.json` covers every topic the deployed contract emits, since
an unknown topic is skipped silently.

### 3. Check for an `error` status first

If the status is `error`, the problem is the RPC endpoint or `SIM_SOURCE`, not
the data. `details.error` carries the simulation failure. Confirm the account in
`SIM_SOURCE` exists and is funded on that network, and that the target's
`rpcUrl` answers.

### 4. Re-index the affected range

Drift from a missed event is fixed by replaying the ledgers that were missed.
Rewind the checkpoint for the one affected target — not the others, since
checkpoints are per contract and network — and let the indexer catch up:

```sh
sqlite3 data/treasury.sqlite \
  "UPDATE indexer_state SET value = '<ledger to resume from>'
   WHERE network = 'testnet' AND contract_id = 'CA...TREASURY' AND key = 'next_ledger';
   DELETE FROM indexer_state
   WHERE network = 'testnet' AND contract_id = 'CA...TREASURY' AND key = 'event_cursor';"
```

Transfers are keyed on `(network, contract_id, event_id)`, so replaying a range
that was already indexed re-inserts nothing and leaves balances untouched. A
replay can only add what was missing.

Two cases need more than a rewind:

- **A double-counted event** will not be fixed by replaying, because the
  duplicate row is already there. Find it in `ledger_entries` by
  `transaction_hash`, and rebuild from a clean database if the running balance
  has diverged.
- **A range older than the retention window** has had its raw rows rolled into
  daily aggregates, so replaying re-inserts the raw rows while the aggregates
  still hold the old totals. Rebuild from a clean database and a start ledger
  before the gap, rather than replaying into pruned history.

### 5. Verify and close

Re-run reconciliation and confirm every check reports `ok`. Drift that returns
after a successful replay points at the ingestion path rather than a one-off
gap — an RPC endpoint without full history for `INDEXER_START_LEDGER` is the
usual cause, and an archival endpoint is the fix.

---

## Rebuilding from scratch

A rebuild is the safe answer whenever the running balance itself is wrong rather
than incomplete. Point `DATABASE_PATH` at a new file, set each target's
`startLedger` to the ledger its contract was deployed in, and start the indexer
against an archival RPC endpoint. Keep the old database until the new one
reconciles clean, so the two can be compared.

## Related documents

| Document | Description |
| --- | --- |
| [ANALYTICS_API.md](ANALYTICS_API.md) | Endpoint, scope, retention and metric reference |
| [ARCHITECTURE.md §13](ARCHITECTURE.md#13-indexer--analytics-architecture) | Indexer data flow and checkpointing |
| [indexer/README.md](../indexer/README.md) | Running and configuring the indexer |
