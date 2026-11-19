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

The control owner reviews this evidence monthly and after any incident or policy change. Automated verification runs in CI on every push and pull request.
