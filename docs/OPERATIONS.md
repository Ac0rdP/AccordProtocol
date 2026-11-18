# Operations: Metrics, Health and Alerts

The indexer (Node, default port 8787) and the analytics API (Rust, default port 8080) both expose Prometheus metrics and liveness/readiness endpoints.

| | Indexer | Analytics API |
| --- | --- | --- |
| Metrics | `GET /metrics` | `GET /metrics` |
| Liveness | `GET /healthz` | `GET /livez` |
| Readiness | `GET /readyz` | `GET /readyz` |
| Status | `GET /status` | `GET /status` |
| Legacy | `GET /health` | `GET /health` |

Both serve `text/plain; version=0.0.4`. Neither endpoint is authenticated: keep them on a private network or behind your ingress.

## Health and readiness

- **Liveness** answers `200` whenever the process can respond. Restart on failure; it never depends on the database or RPC, so an outage elsewhere does not cause restart loops.
- **Indexer readiness** is `200` only when the store answers and an indexing batch succeeded within `READY_MAX_STALENESS_MS` (default: the larger of 60s and six poll intervals). It is `503` before the first batch, when the RPC or database is failing, and when indexing has stalled. The JSON body names the failing check.
- **API readiness** pings the database with a 2 second timeout: `200 {"status":"ok"}` or `503`.
- **Status** reports every dependency separately so the [public status page](STATUS.md) can name the failing part. Both services answer with the same document: `service`, `status` (`operational`, `degraded` or `outage`), a `checks` object with one entry per dependency, and the time of the check. It is `503` only when a dependency the service cannot work without is down.

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

Every alert carries a `runbook_url` annotation pointing at its response steps in [RUNBOOK.md](RUNBOOK.md); a test fails if an alert has none or the section does not exist. The dashboard is `ops/grafana/accord-indexer-api.json` (scrape config: `ops/prometheus/prometheus.yml`).

```yaml
groups:
  - name: accord
    rules:
      - alert: AccordIndexerNotReady
        expr: up{job="accord-indexer"} == 0
        for: 5m
        annotations: { runbook_url: "https://github.com/Ac0rdP/AccordProtocol/blob/main/docs/RUNBOOK.md#indexer-not-ready" }
      - alert: AccordIndexingStalled
        expr: time() - accord_indexer_last_successful_batch_timestamp_seconds > 300
        for: 2m
        annotations: { summary: "No successful indexing batch for 5 minutes (RPC or database down?)", runbook_url: "https://github.com/Ac0rdP/AccordProtocol/blob/main/docs/RUNBOOK.md#indexing-stalled" }
      - alert: AccordIngestionLagHigh
        expr: accord_indexer_ingestion_lag_ledgers > 100   # ~8 minutes at 5s per ledger
        for: 10m
        annotations: { runbook_url: "https://github.com/Ac0rdP/AccordProtocol/blob/main/docs/RUNBOOK.md#ingestion-lag-high" }
      - alert: AccordIndexerErrors
        expr: sum by (stage) (increase(accord_indexer_errors_total[10m])) > 5
        annotations: { runbook_url: "https://github.com/Ac0rdP/AccordProtocol/blob/main/docs/RUNBOOK.md#indexer-errors" }
      - alert: AccordReorgDetected
        expr: increase(accord_indexer_reorgs_total[1h]) > 0
        annotations: { summary: "Chain view rolled back; check the RPC node", runbook_url: "https://github.com/Ac0rdP/AccordProtocol/blob/main/docs/RUNBOOK.md#reorg-detected" }
      - alert: AccordWebhookDeadLetters
        expr: accord_indexer_webhook_deliveries{status="dead"} > 0
        annotations: { summary: "Webhook deliveries exhausted retries; see GET /webhooks/deliveries?status=dead", runbook_url: "https://github.com/Ac0rdP/AccordProtocol/blob/main/docs/RUNBOOK.md#webhook-dead-letters" }
      - alert: AccordWebhookBacklog
        expr: accord_indexer_webhook_deliveries{status="pending"} > 500
        for: 15m
        annotations: { runbook_url: "https://github.com/Ac0rdP/AccordProtocol/blob/main/docs/RUNBOOK.md#webhook-backlog" }
      - alert: AccordApiCheckpointStale
        expr: accord_api_checkpoint_age_seconds > 600
        for: 5m
        annotations: { runbook_url: "https://github.com/Ac0rdP/AccordProtocol/blob/main/docs/RUNBOOK.md#api-checkpoint-stale" }
      - alert: AccordApiLatencyHigh
        expr: histogram_quantile(0.95, sum by (le, route) (rate(accord_api_http_request_duration_seconds_bucket[5m]))) > 1
        for: 10m
        annotations: { runbook_url: "https://github.com/Ac0rdP/AccordProtocol/blob/main/docs/RUNBOOK.md#api-latency-high" }
      - alert: AccordApiErrors
        expr: sum(rate(accord_api_http_requests_total{status=~"5.."}[5m])) / sum(rate(accord_api_http_requests_total[5m])) > 0.05
        for: 10m
        annotations: { runbook_url: "https://github.com/Ac0rdP/AccordProtocol/blob/main/docs/RUNBOOK.md#api-errors" }
      - alert: AccordApiDbPoolSaturated
        expr: accord_api_db_pool_connections{state="idle"} == 0 and accord_api_db_pool_connections{state="active"} > 0
        for: 5m
        annotations: { runbook_url: "https://github.com/Ac0rdP/AccordProtocol/blob/main/docs/RUNBOOK.md#api-db-pool-saturated" }
```

Tune thresholds to your poll interval and finality lag: the indexer's lag floor is `LEDGER_FINALITY_LAG` ledgers by design, so alert on a value comfortably above it.

## Security control operations

The security-control CLI is the operator evidence and preflight surface for
workspace actions. It is intentionally separate from wallet signing and cannot
weaken the on-chain owner quorum or contract RBAC.

### Policy and audit workflow

Maintain a restricted JSON policy file with this shape:

```json
{
  "roles": {
    "alice": ["treasury_operator"],
    "privacy-team": ["privacy_admin"]
  },
  "permissions": {
    "treasury_transfer": ["treasury_operator"],
    "privacy_export": ["privacy_admin"],
    "privacy_delete": ["privacy_admin"],
    "policy_change": ["policy_admin"]
  },
  "allowRecipients": ["G..."],
  "contractAllowList": ["C..."],
  "screening": {
    "provider": "provider-name",
    "required": true,
    "results": { "g...": "clear" }
  }
}
```

The `results` map is a deliberately small adapter boundary: production
operators populate it from the approved screening provider and record the
provider request ID and timestamp in the audit details. The CLI never accepts a
missing or non-`clear` result. Review policy changes through the normal change
process and append an audit record for each privileged action.

Examples:

```bash
node scripts/security-controls.mjs treasury preflight \
  --policy=./config/security-policy.json --actor=alice \
  --recipient=G... --contract=C...

node scripts/security-controls.mjs audit append \
  --log=./data/security-audit.jsonl --policy=./config/security-policy.json \
  --actor=alice --action=treasury_transfer --resource=C... \
  --details='{"recipient":"G...","provider":"provider-name","requestId":"..."}'

node scripts/security-controls.mjs audit verify --log=./data/security-audit.jsonl

node scripts/security-controls.mjs policy update \
  --policy=./config/security-policy.json --actor=policy-admin \
  --list=allowRecipients --mode=add --value=G... \
  --audit=./data/security-audit.jsonl
```

Run the verification command in scheduled compliance checks and before a
release. Record the command output, log hash, policy revision, and operator in
the evidence system. A failed verification, missing audit file, or failed
preflight is a stop condition; contact Security and Compliance and do not
submit the transaction.

### Privacy requests

The privacy administrator exports first, verifies the subject and destination,
then performs deletion only after checking the retention-exception file:

```bash
node scripts/security-controls.mjs privacy export \
  --data=./data/personal-records.json --policy=./config/security-policy.json \
  --actor=privacy-team --subject=SUBJECT --out=./data/export.json \
  --audit=./data/security-audit.jsonl

node scripts/security-controls.mjs privacy delete \
  --data=./data/personal-records.json --exceptions=./config/retention.json \
  --policy=./config/security-policy.json --actor=privacy-team \
  --subject=SUBJECT --out=./data/personal-records.redacted.json \
  --audit=./data/security-audit.jsonl
```

Keep the export access-controlled and delete it according to the approved
retention schedule. A current exception blocks the second command; the failed
request and exception should be recorded manually in the case system. After
the exception expires, rerun the request and verify the resulting audit record.

### Verification record

Automated verification is `node --test scripts/security-controls.test.mjs` and
the audit-chain command above. Manual evidence consists of the provider request
ID and response, policy revision, retention-exception decision, command output,
and the protected audit-log head hash. The control owner reviews this evidence
monthly and after any incident or policy change.
