# Indexer & Analytics API Runbook

Operational procedures for the treasury indexer (Node, port 8787) and the analytics API (Rust, port 8080). Metrics, health endpoints and alert rules are in [OPERATIONS.md](OPERATIONS.md); the dashboard is `ops/grafana/accord-indexer-api.json`. Every alert links to a section below.

Commands run from `indexer/` and read `../.env`.

## Quick triage

1. Open the **Accord Indexer & API Health** dashboard. Red tiles show which side is unhealthy.
2. `curl -s localhost:8787/readyz` names the failing check (`store` or `indexing`); `curl -s localhost:8080/readyz` checks the API's database.
3. `curl -s localhost:8787/health` shows `nextLedger` (the checkpoint) and `latestLedger`.
4. Find the matching alert section below.

`curl -s localhost:8787/status` and `curl -s localhost:8080/status` return the same document the [public status page](STATUS.md) shows, with one entry per dependency.

## Common operations

### Restart the indexer

Safe at any time: progress lives in the store (`next_ledger`, `event_cursor`), inserts are keyed by event id, and shutdown on `SIGTERM`/`SIGINT` closes the API and the store.

1. Restart the process (`npm start`, or your orchestrator's restart).
2. Wait for `/readyz` to return `200`: it stays `503` until the first batch succeeds.
3. Confirm `accord_indexer_ingestion_lag_ledgers` falls back towards `LEDGER_FINALITY_LAG`.

If it will not become ready, see [indexer-not-ready](#indexer-not-ready).

### Backfill a ledger range

Use after downtime longer than the RPC's event window, or to load older history.

```bash
node src/index.js backfill --from 1000 --to 2000   # or omit both for "oldest retained → final"
```

- The end is always clamped to the final ledger; non-final ledgers are never indexed.
- It is resumable: re-run the identical command after an interruption.
- Re-ingesting an overlap is a no-op, and balances are re-folded in chain order afterwards.
- The live checkpoint only ever moves forward.

### Reindex (rebuild from chain)

**Destructive:** clears entries, protocol events, balances and reconciliation results, then re-walks history. Stop the live indexer first so it does not write while the store is being rebuilt.

```bash
node src/index.js reindex --from <first-ledger>
```

- An interrupted reindex resumes only for the **same range**; a different range starts over.
- The RPC can only serve history it still retains. Reindexing from a later ledger than the original start loses older rows, so use the deployment ledger as `--from` (or `INDEXER_START_LEDGER`) when it is still retained.
- Restart the indexer afterwards.

### Replay a range to debug (non-destructive)

Replay re-runs a range into a private SQLite store and prints every event. The live store is never written.

```bash
node src/index.js replay --from 1000 --to 1100
node src/index.js replay --before-checkpoint 50     # last 50 indexed ledgers
node src/index.js replay --after-checkpoint 50      # next 50 ledgers
node src/index.js replay --from 1000 --to 1100 --replay-store ./data/replay.sqlite --json
```

Compare the printed events and resulting balances against what the live store holds (`GET /ledger`, `GET /events`). `ignored` events were not treasury transfers or catalogued Accord events.

### Requeue dead-lettered webhooks

```bash
node src/index.js webhooks-requeue [--subscription <id>]
```

### Recover from balance drift

Drift is `actual − implied`: the on-chain token balance minus the balance the indexer folded from events. The indexer logs `[reconciliation] <TOKEN> drift: …` and `GET /reconciliation` shows the latest result per token.

1. Check the indexer is caught up (`accord_indexer_ingestion_lag_ledgers` near the finality lag). Drift during lag is expected and clears by itself.
2. If drift persists, **replay** the ledgers around the first mismatch to see which event was missed or mis-decoded.
3. If events are missing (e.g. an outage past the RPC's retention, a bad deploy), **backfill** the affected range.
4. If the store is inconsistent in ways a backfill will not repair, **reindex**.
5. Confirm `GET /reconciliation` reports `drift: "0"` for every token on the next cycle (`RECONCILE_INTERVAL_MS`, default 60s).

Persistent drift after a full reindex is not an indexer fault: investigate a token transfer the contract does not emit events for, and escalate.

## Alert response

### indexer-not-ready

Alert `AccordIndexerNotReady`: Prometheus cannot scrape the indexer.

1. Is the process running? Restart it ([Restart the indexer](#restart-the-indexer)).
2. Check logs for a startup error (missing `ACCORD_CONTRACT_ID`, token addresses, `DATABASE_URL`).
3. Check the network path and port (`HOST`, `PORT`).

### indexing-stalled

Alert `AccordIndexingStalled`: no successful batch for 5 minutes.

1. `curl localhost:8787/readyz` — which check fails?
2. `store` failing: the database is unreachable or locked; fix it, the next batch recovers on its own.
3. `indexing` failing: look at the `detail` field and the logs for `Treasury event indexing failed`. Usually the Soroban RPC is down, rate limiting, or has pruned the checkpoint ledger. Test with `curl -s -X POST "$SOROBAN_RPC_URL" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'`.
4. If the RPC no longer retains `next_ledger`, point `SOROBAN_RPC_URL` at an archival endpoint, or accept the gap and [backfill](#backfill-a-ledger-range) what remains.

### ingestion-lag-high

Alert `AccordIngestionLagHigh`: more than 100 final ledgers behind. The floor is `LEDGER_FINALITY_LAG` by design.

1. If `indexing-stalled` is also firing, start there.
2. Otherwise the indexer is slow: check `accord_indexer_batch_duration_seconds` and RPC latency. Lowering `INDEX_INTERVAL_MS` helps only if batches finish well inside the interval; each batch already pages 1000 events at a time.
3. After a long outage, let it catch up, or run a [backfill](#backfill-a-ledger-range) from the checkpoint.

### indexer-errors

Alert `AccordIndexerErrors`: more than 5 errors in 10 minutes. The `stage` label says where:

- `index`: RPC or store failure while ingesting; see [indexing-stalled](#indexing-stalled).
- `reconcile`: the balance simulation failed. Check `SIM_SOURCE` is a funded account and the token addresses are right.
- `webhook`: delivery bookkeeping failed; see [webhook-dead-letters](#webhook-dead-letters).
- `api`: a request hit a store failure; check the database.

### reorg-detected

Alert `AccordReorgDetected`: the chain head moved backwards and the store was rewound to the new final ledger.

1. This is self-healing: the indexer re-walks from the rewound ledger. Confirm lag returns to the floor.
2. Repeated reorgs mean the RPC node is unstable or load-balanced across diverging nodes. Pin to one node.
3. If `LEDGER_FINALITY_LAG` is smaller than the reorg depth you see, raise it.
4. Verify balances afterwards ([drift recovery](#recover-from-balance-drift)).

### webhook-dead-letters

Alert `AccordWebhookDeadLetters`: deliveries exhausted `WEBHOOK_MAX_ATTEMPTS`.

1. `curl 'localhost:8787/webhooks/deliveries?status=dead'` for the subscription and last error.
2. Fix the receiver (or the subscription URL/secret in `WEBHOOK_SUBSCRIPTIONS_FILE`).
3. Run `node src/index.js webhooks-requeue --subscription <id>`.

### webhook-backlog

Alert `AccordWebhookBacklog`: more than 500 pending deliveries for 15 minutes. Receivers are slow or failing: check `accord_indexer_webhook_delivery_duration_seconds` and the retry counts, then fix the receiver. Run one indexer per database; two outbox processors double-send.

### api-checkpoint-stale

Alert `AccordApiCheckpointStale`: the API's `checkpoints` row for `CONTRACT_ID` has not advanced for 10 minutes.

1. Check the indexer is healthy ([indexing-stalled](#indexing-stalled)).
2. Confirm the API's `CONTRACT_ID` matches the indexer's `ACCORD_CONTRACT_ID`, and both use the same database.
3. If the indexer is healthy and writing, check the API's database connection ([api-db-pool-saturated](#api-db-pool-saturated)).

### api-latency-high

Alert `AccordApiLatencyHigh`: p95 above 1s for 10 minutes. Find the slow `route` in the dashboard. For `/graphql`, check `accord_api_graphql_rejections_total` for clients hitting the depth/complexity limits and look for slow queries in Postgres. Restart does not help; scale the database or tighten limits.

### api-errors

Alert `AccordApiErrors`: more than 5% of requests are 5xx. `accord_api_errors_total{kind}` shows `database` or `graphql_database`. Check `curl localhost:8080/readyz` and the Postgres server; fix the database and the errors stop.

### api-db-pool-saturated

Alert `AccordApiDbPoolSaturated`: no idle connections with active ones for 5 minutes. Look for long-running queries in Postgres (`pg_stat_activity`), then raise the pool size or fix the slow query. A restart clears stuck connections as a stopgap.

## Configuration reference

Keep this table in step with the code: `indexer/test/ops-assets.test.js` fails if the indexer reads an environment variable that is missing here. When you add, rename or remove a setting, update this table, [OPERATIONS.md](OPERATIONS.md) if a metric or alert changes, and the affected section above.

| Variable | Default | Runbook relevance |
| --- | --- | --- |
| `ACCORD_CONTRACT_ID` | required | Contract whose events are indexed; must match the API's `CONTRACT_ID`. |
| `XLM_TOKEN_ADDRESS` | required | XLM token contract. |
| `USDC_TOKEN_ADDRESS` | required | USDC token contract. |
| `SIM_SOURCE` | required for `serve` | Funded account for balance simulations; see [indexer-errors](#indexer-errors). |
| `SOROBAN_RPC_URL` | testnet RPC | See [indexing-stalled](#indexing-stalled). |
| `NETWORK_PASSPHRASE` | testnet | Network used to build simulations. |
| `INDEXER_START_LEDGER` | none | First ledger for live indexing; fallback start for backfill/reindex. |
| `LEDGER_FINALITY_LAG` | see `--help` | Ledgers held back before indexing; the lag floor ([reorg-detected](#reorg-detected)). |
| `INDEX_INTERVAL_MS` | `5000` | Poll interval; see [ingestion-lag-high](#ingestion-lag-high). |
| `RECONCILE_INTERVAL_MS` | `60000` | Drift check cadence; see [drift recovery](#recover-from-balance-drift). |
| `READY_MAX_STALENESS_MS` | max(60000, 6× poll) | How stale a batch may be before `/readyz` fails. |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Indexer API bind address. |
| `STORE_BACKEND` | `sqlite` | `sqlite` or `postgres`. |
| `DATABASE_PATH` | `./data/treasury.sqlite` | SQLite file; never use it as a replay store. |
| `DATABASE_URL` | none | Postgres URL (`STORE_BACKEND=postgres`). |
| `DATABASE_POOL_MAX` | `10` | Postgres pool size. |
| `DATABASE_AUTO_MIGRATE` | `true` | Apply Postgres migrations on start; or run `npm run migrate`. |
| `WEBHOOK_SUBSCRIPTIONS_FILE` | none | JSON file of subscriptions. |
| `WEBHOOK_SUBSCRIPTIONS` | none | Inline JSON subscriptions. |
| `WEBHOOK_MAX_ATTEMPTS` | `8` | Attempts before dead-lettering. |
| `WEBHOOK_BACKOFF_BASE_MS` | `5000` | First retry delay. |
| `WEBHOOK_BACKOFF_MAX_MS` | `3600000` | Retry delay cap. |
| `WEBHOOK_TIMEOUT_MS` | `10000` | Per-delivery timeout. |
| `WEBHOOK_POLL_INTERVAL_MS` | `2000` | Outbox poll cadence. |
