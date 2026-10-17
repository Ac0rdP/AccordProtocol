# Operations: Metrics, Health and Alerts

The indexer (Node, default port 8787) and the analytics API (Rust, default port 8080) both expose Prometheus metrics and liveness/readiness endpoints.

| | Indexer | Analytics API |
| --- | --- | --- |
| Metrics | `GET /metrics` | `GET /metrics` |
| Liveness | `GET /healthz` | `GET /livez` |
| Readiness | `GET /readyz` | `GET /readyz` |
| Legacy | `GET /health` | `GET /health` |

Both serve `text/plain; version=0.0.4`. Neither endpoint is authenticated: keep them on a private network or behind your ingress.

## Health and readiness

- **Liveness** answers `200` whenever the process can respond. Restart on failure; it never depends on the database or RPC, so an outage elsewhere does not cause restart loops.
- **Indexer readiness** is `200` only when the store answers and an indexing batch succeeded within `READY_MAX_STALENESS_MS` (default: the larger of 60s and six poll intervals). It is `503` before the first batch, when the RPC or database is failing, and when indexing has stalled. The JSON body names the failing check.
- **API readiness** pings the database with a 2 second timeout: `200 {"status":"ok"}` or `503`.

```yaml
livenessProbe:  { httpGet: { path: /healthz, port: 8787 } }   # API: /livez on 8080
readinessProbe: { httpGet: { path: /readyz,  port: 8787 } }
```

## Indexer metrics

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `accord_indexer_events_processed_total` | counter | | Events newly written (duplicates excluded). |
| `accord_indexer_events_held_back_total` | counter | | Events deferred because their ledger was not yet final. |
| `accord_indexer_reorgs_total` | counter | | Rollbacks detected; each rewound the store. |
| `accord_indexer_errors_total` | counter | `stage` = `index`, `reconcile`, `webhook`, `api` | Failures by stage. |
| `accord_indexer_batches_total` | counter | `outcome` = `success`, `error` | Indexing batches. |
| `accord_indexer_batch_duration_seconds` | histogram | | Wall time of a batch. |
| `accord_indexer_chain_latest_ledger` | gauge | | Latest ledger reported by the RPC. |
| `accord_indexer_chain_final_ledger` | gauge | | Latest ledger old enough to index. |
| `accord_indexer_indexed_ledger` | gauge | | Last ledger covered by the checkpoint. |
| `accord_indexer_ingestion_lag_ledgers` | gauge | | Final ledgers not yet indexed. **The ingestion lag.** |
| `accord_indexer_last_successful_batch_timestamp_seconds` | gauge | | Unix time of the last clean batch. |
| `accord_indexer_http_requests_total` | counter | `method`, `route`, `status` | API requests (`route` is `unmatched` for unknown paths). |
| `accord_indexer_http_request_duration_seconds` | histogram | `method`, `route` | API latency. |
| `accord_indexer_webhook_deliveries_total` | counter | `subscription`, `result` = `delivered`, `retry`, `dead` | Delivery attempts. |
| `accord_indexer_webhook_delivery_duration_seconds` | histogram | `subscription` | Receiver latency. |
| `accord_indexer_webhook_deliveries` | gauge | `status` = `pending`, `delivered`, `dead` | Outbox size. |

## Analytics API metrics

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `accord_api_http_requests_total` | counter | `method`, `route`, `status` | Requests (`route` is the matched pattern, or `unmatched`). |
| `accord_api_http_request_duration_seconds` | histogram | `method`, `route` | **API latency.** |
| `accord_api_errors_total` | counter | `kind` = `database`, `graphql_database` | Failed queries. |
| `accord_api_graphql_rejections_total` | counter | `reason` = `depth`, `complexity`, `page_size`, `timeout`, `batch` | GraphQL requests stopped by the safety limits. |
| `accord_api_db_pool_connections` | gauge | `state` = `idle`, `active` | Connection pool usage. |
| `accord_api_indexed_ledger` | gauge | | Ledger in the `checkpoints` row for `CONTRACT_ID` (absent if none). |
| `accord_api_checkpoint_age_seconds` | gauge | | Seconds since that checkpoint was written. **The API's view of ingestion lag.** |

## Suggested alerts

```yaml
groups:
  - name: accord
    rules:
      - alert: AccordIndexerNotReady
        expr: up{job="accord-indexer"} == 0
        for: 5m
      - alert: AccordIndexingStalled
        expr: time() - accord_indexer_last_successful_batch_timestamp_seconds > 300
        for: 2m
        annotations: { summary: "No successful indexing batch for 5 minutes (RPC or database down?)" }
      - alert: AccordIngestionLagHigh
        expr: accord_indexer_ingestion_lag_ledgers > 100   # ~8 minutes at 5s per ledger
        for: 10m
      - alert: AccordIndexerErrors
        expr: sum by (stage) (increase(accord_indexer_errors_total[10m])) > 5
      - alert: AccordReorgDetected
        expr: increase(accord_indexer_reorgs_total[1h]) > 0
        annotations: { summary: "Chain view rolled back; check the RPC node" }
      - alert: AccordWebhookDeadLetters
        expr: accord_indexer_webhook_deliveries{status="dead"} > 0
        annotations: { summary: "Webhook deliveries exhausted retries; see GET /webhooks/deliveries?status=dead" }
      - alert: AccordWebhookBacklog
        expr: accord_indexer_webhook_deliveries{status="pending"} > 500
        for: 15m
      - alert: AccordApiCheckpointStale
        expr: accord_api_checkpoint_age_seconds > 600
        for: 5m
      - alert: AccordApiLatencyHigh
        expr: histogram_quantile(0.95, sum by (le, route) (rate(accord_api_http_request_duration_seconds_bucket[5m]))) > 1
        for: 10m
      - alert: AccordApiErrors
        expr: sum(rate(accord_api_http_requests_total{status=~"5.."}[5m])) / sum(rate(accord_api_http_requests_total[5m])) > 0.05
        for: 10m
      - alert: AccordApiDbPoolSaturated
        expr: accord_api_db_pool_connections{state="idle"} == 0 and accord_api_db_pool_connections{state="active"} > 0
        for: 5m
```

Tune thresholds to your poll interval and finality lag: the indexer's lag floor is `LEDGER_FINALITY_LAG` ledgers by design, so alert on a value comfortably above it.
