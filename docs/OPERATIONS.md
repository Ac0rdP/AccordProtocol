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
| `accord_indexer_chain_tip_lag_ledgers` | gauge | | Chain tip minus newest indexed ledger (includes the finality lag). |
| `accord_indexer_chain_tip_lag_seconds` | gauge | | The same lag in estimated seconds (`LEDGER_CLOSE_SECONDS` per ledger). |
| `accord_indexer_finality_depth_ledgers` | gauge | | Confirmations on the newest indexed ledger. Below `FINALITY_MIN_DEPTH` means non-final data was indexed. |
| `accord_indexer_checkpoint_age_seconds` | gauge | | Seconds since the checkpoint last advanced; keeps growing while batches fail. |
| `accord_indexer_lag_alert_level` | gauge | `check` = `tip_lag`, `finality_depth`, `checkpoint_age` | Monitor level: 0 ok, 1 warn, 2 critical. |
| `accord_indexer_lag_threshold` | gauge | `check`, `level` | The configured thresholds, so dashboards can draw them. |
| `accord_indexer_lag_alerts_total` | counter | `check`, `level` = `warn`, `critical` | Transitions into warn or critical. |
| `accord_indexer_last_successful_batch_timestamp_seconds` | gauge | | Unix time of the last clean batch. |
| `accord_indexer_http_requests_total` | counter | `method`, `route`, `status` | API requests (`route` is `unmatched` for unknown paths). |
| `accord_indexer_http_request_duration_seconds` | histogram | `method`, `route` | API latency. |
| `accord_indexer_webhook_deliveries_total` | counter | `subscription`, `result` = `delivered`, `retry`, `dead` | Delivery attempts. |
| `accord_indexer_webhook_delivery_duration_seconds` | histogram | `subscription` | Receiver latency. |
| `accord_indexer_webhook_deliveries` | gauge | `status` = `pending`, `delivered`, `dead` | Outbox size. |
| `accord_indexer_api_key_requests_total` | counter | `key`, `result` = `ok`, `unauthorized`, `forbidden`, `quota_exceeded` | Analytics requests checked against API keys (`key` is `unknown` when unauthenticated). |
| `accord_indexer_events_quarantined_total` | counter | `reason` = `unknown_topic`, `unknown_version`, `invalid_payload`, `undecodable` | Contract events that failed schema validation. |
| `accord_indexer_quarantined_events` | gauge | `reason` | Events currently held in quarantine. |
| `accord_indexer_event_validation_warnings_total` | counter | | Events indexed despite violations (`EVENT_VALIDATION_MODE=warn`). |
| `accord_indexer_webhook_replays_total` | counter | `scope` = `single`, `bulk` | Deliveries an operator replayed from the dashboard or API. |

### Chain-tip lag and finality-depth monitoring

The indexer's lag monitor turns three signals into `ok` / `warn` / `critical` levels and exposes them on `/metrics`, `GET /lag` and `GET /status` (a `critical` level makes `/status` report `degraded`).

| Check | Value | Warn | Critical | Settings |
| --- | --- | --- | --- | --- |
| `tip_lag` | ledgers behind the tip **above the finality floor** | 20 | 100 | `LAG_WARN_LEDGERS`, `LAG_CRITICAL_LEDGERS` |
| `checkpoint_age` | seconds since the checkpoint last advanced | 120 | 600 | `CHECKPOINT_AGE_WARN_SECONDS`, `CHECKPOINT_AGE_CRITICAL_SECONDS` |
| `finality_depth` | confirmations on the newest indexed ledger | | below `FINALITY_MIN_DEPTH` (default `LEDGER_FINALITY_LAG`) | `FINALITY_MIN_DEPTH` |

`LEDGER_CLOSE_SECONDS` (default 5) only converts ledgers to the estimated `chain_tip_lag_seconds`. Set `LAG_MONITOR_ENABLED=false` to turn the monitor off. The checkpoint time and alert levels persist in `lag_monitor_state` (Postgres migration `0010`), so a restart does not reset the age or re-fire an active alert; level changes are logged once as `[lag] <check> <from> -> <to>`.

## GraphQL live event subscriptions

The indexer serves real-time GraphQL event subscriptions over HTTP Server-Sent Events (SSE) at `GET /graphql/subscriptions` (or `GET /graphql` with `Accept: text/event-stream`), pushing proposal, approval, and treasury events to clients without polling.

### Subscribed channels

- `proposalEvents`: Push notifications for `created`, `proposal_ready`, `executed`, and `rejected` events.
- `approvalEvents`: Push notifications for `approved`, `revoked`, and `owner_weight_changed` events.
- `treasuryEvents`: Token transfer entries (`inflow`, `outflow`) and recurring payment disbursements (`rpay`).
- `liveEvents`: Unified event stream with optional `topics`, `proposalId`, `token`, or `direction` filters.

### Replay & idempotence

Clients reconnecting after network drops can pass a checkpoint via the `Last-Event-ID` header or `?fromEventId=<id>` query parameter. The indexer replays all events from the store starting after the checkpoint in strict order before seamlessly transitioning to live pushes. Subscriptions are idempotent and duplicates are filtered.

### Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `GRAPHQL_SUBSCRIPTIONS_ENABLED` | `true` | Toggle GraphQL subscription serving. |
| `GRAPHQL_SUBSCRIPTIONS_PATH` | `/graphql/subscriptions` | Endpoint path for SSE subscription connections. |
| `GRAPHQL_KEEPALIVE_MS` | `15000` | Keep-alive ping interval to prevent proxy disconnects. |
| `GRAPHQL_MAX_SUBS_PER_CLIENT` | `50` | Maximum subscriptions tracked per connection. |
| `GRAPHQL_REPLAY_MAX_EVENTS` | `1000` | Maximum historical events replayed on reconnect. |

## Event stream exporters (Kafka & NATS)

The indexer can export normalized contract and treasury events to durable message streaming platforms (Apache Kafka and NATS) for external consumption and asynchronous pipelines.

### Kafka configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `KAFKA_EXPORTER_ENABLED` | `false` | Enable Kafka event stream exporter. |
| `KAFKA_BROKERS` | `localhost:9092` | Comma-separated list of Kafka broker host:port addresses. |
| `KAFKA_TOPIC_PREFIX` | `accord.events` | Topic prefix; events are sent to `<prefix>.<topic>`. |
| `KAFKA_CLIENT_ID` | `accord-indexer` | Client ID sent with Kafka producer requests. |
| `KAFKA_BATCH_SIZE` | `100` | Maximum messages per batch. |
| `KAFKA_FLUSH_INTERVAL_MS` | `1000` | Maximum wait time before flushing queued messages. |

### NATS configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `NATS_EXPORTER_ENABLED` | `false` | Enable NATS event stream exporter. |
| `NATS_SERVERS` | `nats://localhost:4222` | Comma-separated list of NATS server URLs. |
| `NATS_SUBJECT_PREFIX` | `accord.events` | Subject prefix; messages are published to `<prefix>.<topic>`. |
| `NATS_CLIENT_ID` | `accord-indexer` | Client identification sent to NATS server. |

### Replay & checkpoint tracking

Stream exporters track durable published checkpoints in `stream_exporter_checkpoints`. Operators can replay historical ranges using `replayFrom(store, checkpointId)` without producing duplicate records.

## Data warehouse export connectors (BigQuery & Snowflake)

The indexer can export indexed tables (`ledger_entries`, `accord_events`, `reconciliation_results`) to cloud data warehouses on a schedule.

### BigQuery configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `BIGQUERY_EXPORT_ENABLED` | `false` | Enable BigQuery warehouse export connector. |
| `BIGQUERY_PROJECT_ID` | `""` | GCP Project ID hosting the target dataset. |
| `BIGQUERY_DATASET` | `accord_analytics` | BigQuery dataset name. |
| `BIGQUERY_SCHEDULE` | `0 * * * *` | Cron schedule for batch exports (default hourly). |
| `BIGQUERY_BATCH_SIZE` | `500` | Maximum rows per export chunk. |

### Snowflake configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `SNOWFLAKE_EXPORT_ENABLED` | `false` | Enable Snowflake warehouse export connector. |
| `SNOWFLAKE_ACCOUNT` | `""` | Snowflake account identifier. |
| `SNOWFLAKE_DATABASE` | `ACCORD_DB` | Target Snowflake database. |
| `SNOWFLAKE_SCHEMA` | `PUBLIC` | Target Snowflake schema. |
| `SNOWFLAKE_WAREHOUSE` | `COMPUTE_WH` | Snowflake virtual warehouse used for ingestion. |
| `SNOWFLAKE_SCHEDULE` | `0 * * * *` | Cron schedule for batch exports. |
| `SNOWFLAKE_BATCH_SIZE` | `500` | Maximum rows per batch. |

### Warehouse checkpoint tracking

Export progress is tracked in `warehouse_export_checkpoints` per warehouse and table name (`last_exported_id`, `last_ledger`, `rows_exported`, `schema_version`). Replaying from previous checkpoints is idempotent and prevents duplicate insertions.

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
      - alert: AccordChainTipLagWarn
        expr: accord_indexer_lag_alert_level{check="tip_lag"} >= 1
        for: 5m
        annotations: { summary: "Indexer is falling behind the chain tip", runbook_url: "https://github.com/Ac0rdP/AccordProtocol/blob/main/docs/RUNBOOK.md#chain-tip-lag" }
      - alert: AccordChainTipLagCritical
        expr: accord_indexer_lag_alert_level{check="tip_lag"} == 2
        for: 2m
        annotations: { summary: "Indexer is far behind the chain tip", runbook_url: "https://github.com/Ac0rdP/AccordProtocol/blob/main/docs/RUNBOOK.md#chain-tip-lag" }
      - alert: AccordFinalityDepthLow
        expr: accord_indexer_lag_alert_level{check="finality_depth"} == 2
        for: 1m
        annotations: { summary: "Indexed ledgers have fewer confirmations than the configured minimum", runbook_url: "https://github.com/Ac0rdP/AccordProtocol/blob/main/docs/RUNBOOK.md#finality-depth-low" }
      - alert: AccordCheckpointAgeHigh
        expr: accord_indexer_lag_alert_level{check="checkpoint_age"} >= 1
        for: 2m
        annotations: { summary: "The indexing checkpoint has not advanced recently", runbook_url: "https://github.com/Ac0rdP/AccordProtocol/blob/main/docs/RUNBOOK.md#checkpoint-age-high" }
      - alert: AccordIndexerErrors
        expr: sum by (stage) (increase(accord_indexer_errors_total[10m])) > 5
        annotations: { runbook_url: "https://github.com/Ac0rdP/AccordProtocol/blob/main/docs/RUNBOOK.md#indexer-errors" }
      - alert: AccordReorgDetected
        expr: increase(accord_indexer_reorgs_total[1h]) > 0
        annotations: { summary: "Chain view rolled back; check the RPC node", runbook_url: "https://github.com/Ac0rdP/AccordProtocol/blob/main/docs/RUNBOOK.md#reorg-detected" }
      - alert: AccordEventsQuarantined
        expr: sum(accord_indexer_quarantined_events) > 0
        for: 15m
        annotations: { summary: "Contract events failed schema validation; see GET /quarantine", runbook_url: "https://github.com/Ac0rdP/AccordProtocol/blob/main/docs/RUNBOOK.md#events-quarantined" }
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

## Contract reproducible build verification & rollback

Before initiating any contract upgrade on testnet or mainnet, operators must independently verify
the bytecode reproducibility of the release WASM artifact.

### Pre-deployment verification checklist

1. Clone or check out the target release tag:
   ```bash
   git checkout tags/vX.Y.Z
   ```
2. Run the reproducibility check script:
   ```bash
   bash scripts/verify-reproducible-build.sh
   ```
3. Read the verified SHA-256 digest from `target/reproducible-build/status.txt`:
   ```bash
   cat target/reproducible-build/status.txt
   ```
4. Confirm that the digest matches:
   - The `wasm_hash` in `wasm-manifest.json` from the release artifact.
   - The parameter in the `Upgrade` proposal submitted on-chain.

### Rollback and mitigation

If an upgrade proposal was created with a mismatched or unreproducible bytecode hash:
1. **Vote to Reject**: Multisig owners must immediately submit `revoke` or vote against
   the upgrade proposal.
2. **Revoke Proposal**: If executable threshold was met but time-lock is active, multisig
   participants must submit counter-governance or let the proposal expire past its deadline.
3. **Audit Discrepancies**: Compare local compiler versions against CI build environments
   (`rustc --version --verbose`, `stellar --version`) and verify lockfile integrity.
4. **Emergency Contact**: Follow [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md) and report
   unreproducible build incidents to the security team.

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
    "privacy-team": ["privacy_admin"],
    "sec-admin": ["apikey_admin", "policy_admin"],
    "auditor": ["security_auditor", "compliance_export"],
    "infra-lead": ["infra_operator"]
  },
  "permissions": {
    "treasury_transfer": ["treasury_operator"],
    "privacy_export": ["privacy_admin"],
    "privacy_delete": ["privacy_admin"],
    "policy_change": ["policy_admin"],
    "apikey_admin": ["apikey_admin"],
    "compliance_export": ["compliance_export"],
    "infra_operator": ["infra_operator"]
  },
  "allowRecipients": ["G..."],
  "contractAllowList": ["C..."],
  "screening": {
    "provider": "provider-name",
    "required": true,
    "results": { "g...": "clear" }
  },
  "allowedRegions": ["us-east-1", "eu-central-1"],
  "workspaces": {
    "ws-primary": { "pinnedRegion": "us-east-1", "dataClassification": "restricted" }
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

### API key operations

The Security Administrator issues, rotates, monitors, and revokes machine credentials.
Plaintext API keys are output only upon initial creation or rotation; the keystore
records only cryptographic hashes.

#### Issuing a scoped API key

```bash
node scripts/security-controls.mjs apikey issue \
  --keystore=./config/api-keys.json --policy=./config/security-policy.json \
  --actor=sec-admin --name=indexer-ingest \
  --scopes=audit:append,indexer:ingest --expires=90 \
  --audit=./data/security-audit.jsonl
```

#### Key rotation with overlap window

To replace an active key without downtime, operators trigger a rotation. The old key
enters a rotating status and remains valid during the overlap grace window (e.g., 7 days)
while the new key is deployed to client applications:

```bash
node scripts/security-controls.mjs apikey rotate \
  --keystore=./config/api-keys.json --policy=./config/security-policy.json \
  --actor=sec-admin --key=KEY_ID --overlap=7 --expires=90 \
  --audit=./data/security-audit.jsonl
```

#### Monitoring rotation reminders

Run scheduled checks for keys approaching expiration within the reminder window (e.g., 14 days):

```bash
node scripts/security-controls.mjs apikey reminders \
  --keystore=./config/api-keys.json --window=14
```

#### Emergency key revocation

If an API key is compromised or decommissioned, revoke it immediately. The revocation
fails closed and invalidates authentication without waiting for key expiration:

```bash
node scripts/security-controls.mjs apikey revoke \
  --keystore=./config/api-keys.json --policy=./config/security-policy.json \
  --actor=sec-admin --key=KEY_ID --reason="suspected key exposure" \
  --audit=./data/security-audit.jsonl
```

#### Authenticating and verifying API keys

```bash
node scripts/security-controls.mjs apikey verify \
  --keystore=./config/api-keys.json --token=accord_key_... --scope=indexer:ingest
```

### SIEM event streaming operations

Security, authorization, and governance audit records can be exported or streamed
directly to enterprise SIEM platforms.

#### Local export and dry-run verification

Test the SIEM transformation locally to inspect sanitization and categorization:

```bash
node scripts/security-controls.mjs siem export \
  --log=./data/security-audit.jsonl --target=splunk --out=./data/splunk-events.json

node scripts/security-controls.mjs siem export \
  --log=./data/security-audit.jsonl --target=datadog --out=./data/datadog-events.json
```

#### Live streaming to Splunk HEC or Datadog

Forward events over HTTPS. All secret fields and tokens are automatically redacted
prior to transmission:

```bash
# Streaming to Splunk HEC
node scripts/security-controls.mjs siem stream \
  --log=./data/security-audit.jsonl --target=splunk \
  --endpoint="https://splunk-hec.internal.net:8088/services/collector/event" \
  --token="${SPLUNK_HEC_TOKEN}"

# Streaming to Datadog Logs API
node scripts/security-controls.mjs siem stream \
  --log=./data/security-audit.jsonl --target=datadog \
  --endpoint="https://http-intake.logs.datadoghq.com/api/v2/logs" \
  --token="${DATADOG_API_KEY}"
```

### SOC 2 compliance and auditor evidence packages

Compliance officers and auditors use the `soc2` command to inspect control mappings
and export verified evidence bundles.

#### Inspecting control mappings

```bash
node scripts/security-controls.mjs soc2 map
```

#### Exporting auditor evidence package

Generates a complete SOC 2 evidence package with SHA-256 hashes for all input evidence:

```bash
node scripts/security-controls.mjs soc2 export \
  --policy=./config/security-policy.json \
  --audit=./data/security-audit.jsonl \
  --keystore=./config/api-keys.json \
  --residency=./config/data-residency-policy.json \
  --out=./data/soc2-evidence-package.json \
  --actor=auditor
```

Auditors verify the package by validating the `overallStatus: "COMPLIANT"`, the
underlying audit log hash chain, and the SHA-256 manifest of the evidence files.

### Data residency and workspace operations

Workspace data stores are pinned to approved geographical regions to enforce data
sovereignty and regulatory compliance.

#### Validating data residency

```bash
node scripts/security-controls.mjs residency verify \
  --policy=./config/security-policy.json --workspace=ws-primary --region=us-east-1
```

#### Integrity-verified workspace backup

Creates a region-pinned backup archive with an embedded SHA-256 checksum:

```bash
node scripts/security-controls.mjs workspace backup \
  --data=./data/workspace-data.json --policy=./config/security-policy.json \
  --workspace=ws-primary --region=us-east-1 \
  --out=./data/workspace-backup.json \
  --audit=./data/security-audit.jsonl --actor=infra-lead
```

#### Regional workspace export

Exports workspace records with geographic provenance headers:

```bash
node scripts/security-controls.mjs workspace export \
  --data=./data/workspace-data.json --policy=./config/security-policy.json \
  --workspace=ws-primary --region=us-east-1 \
  --out=./data/workspace-export.json \
  --audit=./data/security-audit.jsonl --actor=privacy-team
```

#### Regional workspace deletion with legal hold checks

Purges workspace data while checking active retention exceptions. If a retention
exception exists, the operation fails closed:

```bash
node scripts/security-controls.mjs workspace delete \
  --data=./data/workspace-data.json --policy=./config/security-policy.json \
  --exceptions=./config/retention.json \
  --workspace=ws-primary --region=us-east-1 \
  --out=./data/workspace-deleted-receipt.json \
  --audit=./data/security-audit.jsonl --actor=privacy-team
```

### SSO operations (SAML / OIDC)

`scripts/sso-controls.mjs` verifies IdP sign-ins, provisions team users just in
time, and enforces session policy (see
[docs/SECURITY.md](./SECURITY.md#enterprise-sso-saml--oidc-just-in-time-provisioning-and-session-policy)).
Keep the SSO config, user store, session store, and replay cache in restricted
(`0600`) files; the CLI writes them with that mode.

#### Configuring a provider

```json
{
  "clockSkewSeconds": 120,
  "providers": [
    {
      "id": "acme-saml",
      "team": "treasury-team",
      "protocol": "saml",
      "issuer": "http://www.okta.com/exk123",
      "audience": "https://accord.example/saml/metadata",
      "allowedDomains": ["acme.example"],
      "signingCertFingerprints": ["<sha256 of the IdP signing certificate>"]
    },
    {
      "id": "acme-oidc",
      "team": "treasury-team",
      "protocol": "oidc",
      "issuer": "https://idp.acme.example",
      "audience": "<client id>",
      "allowedDomains": ["acme.example"],
      "allowedAlgorithms": ["RS256"],
      "jwks": { "keys": [{ "kty": "RSA", "kid": "...", "alg": "RS256", "n": "...", "e": "AQAB" }] }
    }
  ],
  "jit": {
    "enabled": true,
    "allowedRoles": ["treasury_operator", "security_auditor"],
    "groupRoles": { "accord-treasury": ["treasury_operator"], "accord-audit": ["security_auditor"] }
  },
  "session": {
    "maxAgeMinutes": 480,
    "idleTimeoutMinutes": 30,
    "requireMfa": true,
    "reauthMinutesForActions": { "treasury_transfer": 15, "policy_change": 15 }
  }
}
```

Add `"sso_admin": ["sso_admin"]` to the security policy `permissions` and grant
`sso_admin` to the Security Administrator. Validate every config change before
deploying it:

```bash
node scripts/sso-controls.mjs validate --config=./config/sso.json
```

**Key rotation**: when the IdP rotates its signing certificate or JWKS, add the
new fingerprint/JWK alongside the old one, deploy, wait for the IdP cutover,
then remove the old entry. Never paste a private key or client secret into the
config; validation rejects JWKs with private (`d`) or symmetric (`k`) material.

#### Sign-in, session checks, and role projection

```bash
# SAML: --assertion is the gateway's verified-assertion JSON. OIDC: --id-token is the raw JWT.
node scripts/sso-controls.mjs login --config=./config/sso.json --provider=acme-oidc \
  --id-token=./tmp/id_token.jwt --nonce="$NONCE" \
  --users=./data/sso-users.json --sessions=./data/sso-sessions.json \
  --replay=./data/sso-replay.json --audit=./data/security-audit.jsonl

node scripts/sso-controls.mjs session-check --config=./config/sso.json \
  --sessions=./data/sso-sessions.json --token="$SESSION" --action=treasury_transfer

# Project active SSO users' roles into the security policy (policy_admin only).
node scripts/sso-controls.mjs sync-policy --policy=./config/security-policy.json \
  --actor=sec-admin --users=./data/sso-users.json --audit=./data/security-audit.jsonl
```

A `re-authentication required` result means the operator must sign in again
through the IdP before the privileged action; do not extend the window.

#### Deprovisioning (leaver or compromised account)

Remove the user from the IdP groups first, then suspend them in Accord so
active sessions end immediately rather than at next login:

```bash
node scripts/sso-controls.mjs deprovision --policy=./config/security-policy.json \
  --actor=sec-admin --user=sso:acme-oidc:00u-alice --reason="leaver ticket SEC-123" \
  --users=./data/sso-users.json --sessions=./data/sso-sessions.json \
  --audit=./data/security-audit.jsonl
```

Then run `sync-policy` so the suspended actor is removed from the policy.

#### Manual verification (quarterly and after IdP changes)

1. Run `validate` against the deployed config and record the output.
2. Compare `signingCertFingerprints` / JWKS `kid`s with the IdP's current metadata.
3. Review `sso_jit_provision`, `sso_role_sync`, `sso_login_denied`, and `sso_deprovision` audit records against IdP group changes and HR leaver lists.
4. Confirm no suspended user holds roles in the policy and no session for them is `active`.

### Frontend CSP and security headers

The frontend serves a strict Content-Security-Policy and companion HTTP security headers from a single canonical definition in [`frontend/security-headers.mjs`](../frontend/security-headers.mjs), applied to Vercel deployments via [`frontend/vercel.json`](../frontend/vercel.json) and to Vite `dev`/`preview` servers via [`frontend/vite.config.ts`](../frontend/vite.config.ts).

#### Changing allowed origins

1. Identify the exact origin (`https://host` or `wss://host`) required — never add paths, query strings, credentials, or wildcards (`*`).
2. For environment-specific endpoints (Soroban RPC, Analytics API, Indexer API, WebSocket/SSE push, or price feed), set the existing `VITE_*` environment variables (`VITE_SOROBAN_RPC_URL`, `VITE_API_BASE_URL`, `VITE_INDEXER_API_BASE_URL`, `VITE_EVENT_PUSH_URL`, `VITE_PRICE_FEED_URL`) or `VITE_CSP_EXTRA_CONNECT_SRC`.
3. If a new default production origin is needed for Vercel deployments, update `DEFAULT_CONNECT_ORIGINS` in `frontend/security-headers.mjs` and the matching `Content-Security-Policy` header in `frontend/vercel.json` in the same PR.
4. Run the header validation check before merging:
   ```bash
   node scripts/check-frontend-headers.mjs
   node --test scripts/check-frontend-headers.test.mjs
   ```
5. To verify a live preview or staging deployment, run:
   ```bash
   node scripts/check-frontend-headers.mjs --url=https://<preview-host>
   ```

#### Fast rollback (Report-Only mode)

If a production header change blocks a legitimate wallet or API flow:

1. **Immediate mitigation**: Set `VITE_CSP_REPORT_ONLY=true` (or `CSP_REPORT_ONLY=true`) for Vite preview/self-hosted deployments, or change `"key": "Content-Security-Policy"` to `"key": "Content-Security-Policy-Report-Only"` in `frontend/vercel.json` and redeploy.
2. Collect the blocked directive and origin from browser DevTools console logs.
3. Fix the policy narrowly (adding only the specific verified origin) and restore enforcing `Content-Security-Policy`.

#### Manual browser verification checklist (not automated in CI)

Automated tests cannot exercise real browser wallet extensions. Perform and record these checks manually in a real browser after any CSP or wallet change:

- [ ] **Freighter connect**: Connect Freighter on Testnet; confirm address and network passphrase populate with zero CSP errors in DevTools console.
- [ ] **Transaction signing**: Build, simulate, sign, and submit a proposal or approval via Freighter; confirm no `connect-src` or `script-src` violation blocks signing.
- [ ] **Wallet providers (Ledger / Passkey / WalletConnect)**: Confirm USB/HID/WebAuthn prompts and configured relay origins are not blocked by `Permissions-Policy` or `connect-src`.
- [ ] **Analytics & Indexer API**: Load the Dashboard and Analytics views; confirm `/proposals`, `/stats/summary`, and notification destination calls succeed with zero CSP violations.
- [ ] **Price feed & QR/PDF export**: Confirm CoinGecko fiat quotes load, QR codes render (`img-src data:`), and PDF export succeeds (`img-src blob:`).
- [ ] **Response headers in DevTools Network tab**: Confirm `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, and `Strict-Transport-Security: max-age=31536000` (without `includeSubDomains` or `preload`) are present and not duplicated.

### HSM and MPC signer integration runbook

This provider-neutral runbook defines how production Stellar owner keys for Accord (`contracts/accord/src/lib.rs`) are provisioned, used, rotated, and recovered with an HSM or MPC custody provider. **No real HSM or MPC provider has been tested in CI**; operators must complete and archive the manual drill below before mainnet launch.

#### 1. Provider selection requirements

Any HSM or MPC provider used for production owner keys must satisfy all of the following:

- **Native Ed25519 (RFC 8032)**: Must sign raw 32-byte Stellar transaction digests with Ed25519 (or threshold EdDSA / FROST MPC emitting standard 64-byte Ed25519 signatures). Verify native support explicitly — many traditional HSMs support only RSA/ECDSA and cannot sign Stellar `G...` accounts directly.
- **Non-exportable key material**: Private keys or MPC shards must be generated inside the HSM/MPC boundary and never exported to disk, CI secrets, environment variables, or shell history.
- **Policy engine & quorum approval**: Out-of-band human approval policy (M-of-N approvers inside the custody platform or distinct physical signers across independent HSMs/hardware wallets).
- **Tamper-evident audit log**: Immutable record of every signing request, approver identity, timestamp, and signed digest hash.

#### 2. Signing payload construction & network domain separation

Before submitting a transaction payload to an HSM or MPC signer:

1. Build the unsigned Stellar transaction XDR offline or via `stellar contract invoke --build-only` targeting the explicit network (`testnet` or `mainnet`).
2. Compute the Stellar signing digest with explicit network domain separation:
   - `networkId = SHA-256(networkPassphrase)`
     - Testnet: `Test SDF Network ; September 2015`
     - Mainnet: `Public Global Stellar Network ; September 2015`
   - `signingDigest = SHA-256(networkId || 0x00000002 || transactionBodyXdrBytes)`
3. Every approving owner independently verifies the target `contract_id`, entrypoint (`upgrade`, `execute`, `create_add_owner_proposal`, etc.), `new_wasm_hash` (for upgrades), and `networkPassphrase` before approving the HSM/MPC signing prompt.

#### 3. Separation of duties & key ceremony

- **Roles**:
  - **Build / Release Engineer**: Builds the reproducible WASM artifact (`scripts/verify-reproducible-build.sh`) and publishes the SHA-256 hash. Does **not** hold owner signing quorum.
  - **Multisig Owners (Signers)**: Distinct individuals/entities operating independent HSM/MPC signers or hardware wallets. No single owner may hold `> 50%` weight (`MAX_SINGLE_OWNER_WEIGHT_PCT`).
  - **Approver / Reviewer**: Independently verifies the WASM hash and transaction parameters before approving the custody policy request.
- **Key ceremony**: Generate each owner key inside its HSM/MPC enclave with at least two witnesses, record only the resulting Stellar `G...` public key and attestation certificate, and seal backup recovery shares (M-of-N offline splits stored in geographically separated vaults).

#### 4. Rotation, lockout prevention, and incident response

- **Testnet rehearsal mandatory**: Before rotating any production owner key, rehearse the full two-step rotation (`AddOwner` proposal -> `RemoveOwner` proposal; see [`docs/runbooks/KEY_ROTATION.md`](./runbooks/KEY_ROTATION.md)) and its rollback (re-adding the prior key) on **Stellar Testnet**. Never remove an owner until the replacement HSM/MPC key has successfully signed and been verified on-chain.
- **Lost or compromised key**:
  1. Guardian immediately invokes `freeze(guardian)` to halt proposal creation and execution ([`docs/runbooks/INCIDENT_RESPONSE.md`](./runbooks/INCIDENT_RESPONSE.md)).
  2. Remaining owners confirm remaining weight `>= threshold`.
  3. Owners execute `AddOwner` (if needed to preserve quorum headroom) followed by `RemoveOwner` for the compromised key, revoke the key in the HSM/MPC provider, and preserve custody audit logs.
  4. Owners co-sign `unfreeze(approvers)` only after confirming the compromised key is removed on-chain.

#### 5. Manual HSM/MPC signing drill & evidence verification (not verified in CI)

Before promoting a new HSM/MPC key to production (and quarterly thereafter):

1. Build a throwaway Testnet payload hex and obtain a detached Ed25519 signature from the HSM/MPC signer.
2. Record the drill evidence in a JSON file (containing **only** public metadata — never secret seeds or private keys):
   ```json
   {
     "schemaVersion": 1,
     "drillId": "drill-YYYY-MM-DD-testnet",
     "providerType": "<hsm-or-mpc-provider-name>",
     "keyLabel": "<hsm-key-id-or-vault-alias>",
     "signerPublicKey": "G...",
     "network": "testnet",
     "payloadHex": "<hex-encoded-transaction-body>",
     "signature": "<base64-or-hex-64-byte-ed25519-signature>",
     "approvedBy": ["<reviewer-1>", "<reviewer-2>"],
     "recordedAt": "YYYY-MM-DDTHH:MM:SSZ"
   }
   ```
3. Verify the evidence offline (no private key required):
   ```bash
   node scripts/verify-signer-evidence.mjs verify-evidence \
     --file=drill-evidence.json \
     --expected-public-key=G... \
     --expected-network=testnet
   ```
4. Archive the verified evidence JSON and HSM/MPC audit log export in the security evidence repository.

### Verification record

| Control | Owner | Scope | Failure Behavior | Automated Verification | Manual Evidence |
| --- | --- | --- | --- | --- | --- |
| **Audit Log Hash Chain** | Security Auditor | All privileged operational records | Fails closed on hash mismatch | `scripts/security-controls.mjs audit verify` | Audit log head hash and weekly backup snapshot |
| **Treasury Preflight** | Treasury Operator | On-chain fund disbursements | Fails closed on missing or non-clear screening | `node --test scripts/security-controls.test.mjs` | Provider query ID and sanctions screening response |
| **API Key Scopes & Rotation** | Security Administrator | Machine credentials and integration tokens | Fails closed on invalid token, expired overlap, or missing scope | `node --test scripts/security-controls.test.mjs` | Keystore hash manifest and rotation log receipts |
| **SIEM Event Streaming** | SOC Lead | Auth, authz, governance, and audit logs | Non-blocking fail-safe; redaction fails closed | `scripts/security-controls.mjs siem export --dry-run` | SIEM index ingestion confirmation and alerting rules |
| **SOC 2 Evidence Package** | Compliance Officer | All protocol and operational controls | Fails closed on broken evidence chain | `scripts/security-controls.mjs soc2 export` | Signed auditor package and SHA-256 manifest file |
| **Data Residency Pinning** | Infrastructure Operator | Workspace storage, backups, and exports | Fails closed on region mismatch or unapproved region | `scripts/security-controls.mjs residency verify` | Regional cloud tagging and backup checksum log |
| **Privacy Export & Deletion** | Privacy Administrator | User and tenant personal data | Fails closed on active retention exceptions | `node --test scripts/security-controls.test.mjs` | Retention exception filings and deletion receipts |
| **SSO (SAML/OIDC), JIT & Session Policy** | Security Administrator | Team sign-in, SSO-managed roles, and privileged-action sessions | Fails closed on unpinned key, claim mismatch, replay, off-domain or non-MFA login, suspended user, or expired/idle/step-up session | `node --test scripts/sso-controls.test.mjs`; `scripts/sso-controls.mjs validate` | Quarterly IdP metadata comparison and leaver review of SSO audit records |
| **Frontend CSP & Security Headers** | Frontend Maintainer | Accord web frontend (`frontend/`) responses on Vercel and Vite | Fails closed in browser (blocked script/frame/connect); CI fails on policy drift or `'unsafe-inline'`/`'unsafe-eval'` in production `script-src` | `node scripts/check-frontend-headers.mjs`; `node --test scripts/check-frontend-headers.test.mjs` | Manual browser DevTools checklist (Freighter connect/sign, Analytics API, zero CSP console violations) |
| **HSM / MPC Production Signer Custody** | Treasury Security Lead | Production Stellar owner and guardian keys | Fails closed on invalid `G...` StrKey, secret seed input, wrong network passphrase, tampered payload, or bad Ed25519 signature | `node --test scripts/verify-signer-evidence.test.mjs`; `node scripts/verify-signer-evidence.mjs verify-evidence` | Quarterly manual HSM/MPC Testnet signing drill evidence JSON + custody audit log export |

The control owner reviews this evidence monthly and after any incident or policy change. Automated verification runs in CI on every push and pull request.

---

## Blue/Green Indexer Deployment Runbook

The [`.github/workflows/blue-green-indexer.yml`](../.github/workflows/blue-green-indexer.yml) workflow and [`scripts/blue-green-indexer.sh`](../scripts/blue-green-indexer.sh) implement zero-downtime, data-safe blue/green rollouts for the Treasury Indexer (`indexer/`).

### Data Safety & Single-Writer Model

Running two indexers writing to the same database corrupts checkpoints and causes duplicate webhook/notification deliveries. This deployment enforces:

1. **Isolated Green Store & Shadow Catch-Up**: Green runs against its own isolated PostgreSQL database or schema (`INDEXER_GREEN_DATABASE_URL`) in shadow mode (outbound webhook/notification deliveries disabled) while Blue continues serving live traffic.
2. **Single Active Writer**: Only one indexer holds the active writer/outbox role at any time, enforced by `indexer_leases` (`indexer/src/leader-election.js` fencing tokens) and explicit role configuration.
3. **Pre-Switch Parity Gate (`scripts/blue-green-indexer.sh compare`)**:
   - Green `/readyz` returns HTTP `200`.
   - `accord_indexer_chain_tip_lag_ledgers` is within `max_tip_lag_ledgers` (default `10`).
   - Blue vs. Green latest indexed ledger delta is within `MAX_LEDGER_DELTA` (default `2`).
   - API parity passes on `/status`, `/ledger`, `/events`, and `/reconciliation`.
   - Recent-range `accord_events` row counts and MD5 checksums match when `BLUE_DATABASE_URL` and `GREEN_DATABASE_URL` are provided.
4. **Backward-Compatible Schema Migrations (Expand-then-Contract)**:
   - All migrations applied during blue/green overlap must be backward compatible with Blue (additive columns/tables first; drop old columns only in a later release after Blue is retired).
   - **If a migration is NOT backward compatible**: Do **not** use live blue/green overlap. Pause the active writer, take a verified `pg_dump`/snapshot, apply the migration in a maintenance window, and restore from snapshot if rollback is required.

### Operator Contract & Required Settings

> [!IMPORTANT]
> This repository does not contain cloud infrastructure or ingress definitions. Operators must provision the target environments and configure the following GitHub settings before running `dry_run: false`:

| Setting | Type | Purpose |
| --- | --- | --- |
| `production-indexer-traffic-shift` | GitHub Environment | **Must configure required reviewers** to gate the traffic-shift step. |
| `INDEXER_BLUE_URL` | Repo/Env Variable | Base URL of the live Blue indexer (private ops endpoint). |
| `INDEXER_GREEN_URL` | Repo/Env Variable | Base URL of the staging Green indexer. |
| `INDEXER_DEPLOY_GREEN_CMD` | Repo/Env Variable | Operator command/hook to deploy Green at `NEW_VERSION` in shadow mode. |
| `INDEXER_TRAFFIC_SHIFT_CMD` | Repo/Env Variable | Single, reversible command/hook receiving `TARGET_COLOR=green\|blue` to flip router/service/DNS weight. |
| `INDEXER_TEARDOWN_BLUE_CMD` | Repo/Env Variable | Operator command/hook to retire Blue after the soak period passes. |
| `INDEXER_BLUE_DATABASE_URL` | Repo/Env Secret | Read-only connection string for Blue parity checks (never echoed). |
| `INDEXER_GREEN_DATABASE_URL` | Repo/Env Secret | Read-only connection string for Green parity checks (never echoed). |

### Execution, Abort Criteria, and Rollback

1. **Dispatch**: Run **Actions → Blue/Green Indexer Deployment** with `new_version`, `dry_run: true` first, then `dry_run: false` with `soak_period_minutes` (default `15`).
2. **Abort Criteria**: Any `/readyz` failure, tip lag > `max_tip_lag_ledgers`, ledger delta > `MAX_LEDGER_DELTA`, or DB checksum mismatch aborts before traffic is shifted.
3. **Automatic Rollback**: If post-shift `/healthz`, `/readyz`, or `/status` (`operational`) fails, the workflow automatically executes `scripts/blue-green-indexer.sh shift --target blue`.
4. **Manual Rollback & Disable**:
   - Flip traffic back immediately: `TARGET_COLOR=blue bash -c "$INDEXER_TRAFFIC_SHIFT_CMD"`.
   - Disable the workflow if needed: `gh workflow disable "Blue/Green Indexer Deployment"`.
5. **Verify No Data Loss**: Confirm `accord_indexer_indexed_ledger` and `/reconciliation` drift (`0`) on the active instance and check `GET /webhooks/deliveries?status=dead`.

- **Owner**: Infrastructure / Platform Engineering.

---

## Multi-Region Backup & Restore Verification

The [`.github/workflows/backup-restore.yml`](../.github/workflows/backup-restore.yml) workflow and [`scripts/backup-restore.sh`](../scripts/backup-restore.sh) back up Accord's stores and configuration to a secondary region and verify restores into an isolated ephemeral PostgreSQL container on a daily schedule (`02:00 UTC`).

### Stores & Configuration Scope

- **In-Repo Stores**: PostgreSQL 16 (`accord_analytics` / `accord_indexer_test`, managed by `indexer/migrations/postgres/` and `analytics-api/migrations/`). SQLite (`STORE_BACKEND=sqlite`) is dev/replay-only.
- **Configuration**: `docker-compose.yml`, `.env.example`, and `launch/mainnet-checklist.json`.
- **Operator-Provisioned Targets**: Cloud object storage buckets, KMS/encryption keys, and OIDC IAM roles do **not** exist in this repository and must be provisioned by the operator.

### Encryption, Cross-Region & Retention Design

1. **Client-Side Encryption**: Backups are encrypted with `openssl enc -aes-256-cbc -pbkdf2 -salt` using `BACKUP_ENCRYPTION_KEY` before leaving the source. Keys are never echoed or written to artifacts.
2. **Secondary Region & Object Lock**: Encrypted archives and JSON manifests (`timestamp`, `source_version`, `size_bytes`, `sha256_encrypted`, `region`, `schema_version`) are uploaded to `BACKUP_SECONDARY_REGION` / `BACKUP_BUCKET_URI`. Configure the target bucket with **versioning** and **Object Lock / immutable retention** (`BACKUP_RETENTION_DAYS`, default `30`).
3. **OIDC Federation (No Long-Lived Cloud Keys)**: Jobs use `id-token: write`. Configure your cloud IAM trust policy to allow only `repo:Ac0rdP/AccordProtocol:ref:refs/heads/main` and `.github/workflows/backup-restore.yml` (use a read-only role for `verify-restore`).
4. **RPO & RTO Enforcement**: `verify-restore` restores into an ephemeral `postgres:16-alpine` service container (`SCRATCH_DATABASE_URL`, never production), verifies the SHA-256 manifest, and fails if `RPO > MAX_RPO_SECONDS` (default `86400`s) or `RTO > MAX_RTO_SECONDS` (default `900`s).

### Required Secrets & Variables

| Name | Kind | Purpose |
| --- | --- | --- |
| `BACKUP_ENCRYPTION_KEY` | Repo/Env Secret | Passphrase/key for `openssl` AES-256-PBKDF2 backup encryption (rotate quarterly; keep previous key in vault for historical restores). |
| `BACKUP_DATABASE_URL` | Repo/Env Secret | Read-only PostgreSQL connection string for `pg_dump`. |
| `BACKUP_SECONDARY_REGION` | Repo Variable | Secondary cloud region identifier (e.g. `us-west-2`). |
| `BACKUP_BUCKET_URI` | Repo Variable | Secondary-region bucket URI with versioning & Object Lock enabled. |
| `BACKUP_UPLOAD_CMD` | Repo Variable | Operator command to upload `$BACKUP_FILE` and `$MANIFEST_FILE` after OIDC auth. |
| `BACKUP_FETCH_CMD` | Repo Variable | Operator command to fetch latest `$BACKUP_FILE` and `$MANIFEST_FILE` (read-only role). |
| `BACKUP_PRUNE_CMD` | Repo Variable | Operator command to prune objects older than `$RETENTION_DAYS` (if not using bucket lifecycle rules). |

### Incident Restore Procedure & Disable Steps

1. **Incident Restore**: Fetch the target encrypted archive and manifest from `BACKUP_BUCKET_URI`, verify `sha256_encrypted`, decrypt with `BACKUP_ENCRYPTION_KEY`, pause the active indexer writer, restore with `psql -v ON_ERROR_STOP=1 -f db.sql`, and verify `/readyz` and `/reconciliation`.
2. **Disable / Rollback**: `gh workflow disable "Multi-Region Backup & Restore Verification"`.
- **Owner**: Infrastructure / SRE.
