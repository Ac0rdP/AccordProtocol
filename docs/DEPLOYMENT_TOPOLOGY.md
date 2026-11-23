# Production Deployment Topology Guide

This guide documents the production topology, environment variables, health checks, upgrade workflows, and rollback procedures for the three runtime services in Accord Protocol:

1. **Frontend (Vercel)** — React + Vite single-page application in [`frontend/`](../frontend/package.json)
2. **Treasury Indexer** — Node.js event ingestion, reconciliation, webhook, and notification service in [`indexer/`](../indexer/README.md)
3. **Analytics API** — Rust + Axum HTTP and GraphQL query service in [`analytics-api/`](../analytics-api/README.md)

For Stellar smart contract deployment and on-chain WASM upgrades, see [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) and [`docs/UPGRADE_SAFETY.md`](./UPGRADE_SAFETY.md). For secrets storage and rotation policy, see [`docs/SECRETS_MANAGEMENT.md`](./SECRETS_MANAGEMENT.md).

---

## 1. Production Topology Overview

```text
                        ┌────────────────────────────────────┐
                        │  Browser + Freighter Wallet        │
                        └─────────┬───────────────┬──────────┘
                                  │ HTTPS         │ simulateTransaction /
                                  ▼               │ signed tx submission
                  ┌───────────────────────────┐   │
                  │  Vercel Edge CDN          │   ▼
                  │  Frontend SPA (frontend/) │  ┌──────────────────────────┐
                  │  Rewrites: vercel.json    │  │  Stellar Soroban RPC     │
                  └────────────┬──────────────┘  │  (Archival endpoint)     │
                               │ HTTPS           └────────────┬─────────────┘
                               ▼                              │ getEvents /
               ┌────────────────────────────────┐             │ simulateTransaction
               │  Reverse Proxy / Ingress (TLS) │             │
               └──────────┬─────────────┬───────┘             │
                          │             │                     │
              /proposals  │             │ /notifications/*    │
              /spend/*    │             │ /graphql/sub...     │
              /graphql    │             │                     │
                          ▼             ▼                     │
          ┌────────────────────┐  ┌───────────────────────────┴──┐
          │  Analytics API     │  │  Treasury Indexer            │
          │  Rust/Axum :8080   │  │  Node.js >= 22.13  :8787     │
          │  Stateless (N >=2) │  │  STRICTLY 1 active writer    │
          └─────────┬──────────┘  └──────────────┬───────────────┘
                    │ SQLx PgPool                │ pg Pool (STORE_BACKEND=postgres)
                    ▼                            ▼
          ┌──────────────────────────────────────────────────────┐
          │  PostgreSQL 16 (Private VPC / Managed Primary + PITR)│
          │  • analytics-api/migrations/ (proposals, events,     │
          │    checkpoints, scheduled_reports, alerts)           │
          │  • indexer/migrations/ (ledger_entries,              │
          │    accord_events, reconciliation_results, outboxes)  │
          └──────────────────────────────────────────────────────┘
                                     ▲
          ┌──────────────────────────┴───────────────────────────┐
          │  Observability (Private Network)                     │
          │  Prometheus (ops/prometheus/prometheus.yml)          │
          │  Grafana    (ops/grafana/accord-indexer-api.json)    │
          │  Status     (.github/workflows/status-page.yml)      │
          └──────────────────────────────────────────────────────┘
```

### Network Boundaries and Scaling Cardinality

| Service | Runtime | Default Bind | Scaling Rule | Public Endpoints | Private / Ops Endpoints |
| --- | --- | --- | --- | --- | --- |
| **Frontend** | Vercel static SPA (`Vite`) | Edge HTTPS | Global CDN; immutable per-commit deploys | `/`, `/app/*`, `/proposals/:id`, `/docs` | None |
| **Treasury Indexer** | Node.js `>=22.13.0` | `127.0.0.1:8787` | **Exactly 1 active instance per database.** Running two outbox processors causes duplicate webhook and notification deliveries. | `/notifications/destinations*` (authenticated behind ingress), `/graphql/subscriptions` | `/healthz`, `/readyz`, `/status`, `/health`, `/metrics`, `/ledger`, `/events`, `/reconciliation`, `/webhooks/deliveries`, `/notifications/deliveries` |
| **Analytics API** | Rust binary (`accord-analytics-api`) | `127.0.0.1:8080` | **Horizontally scalable (`N >= 2`).** Keep `REPORT_SCHEDULE` and `ALERT_RULES` enabled on at most one designated worker replica so scheduled reports and alerts do not duplicate. | `/`, `/proposals`, `/proposals/{id}`, `/spend/by-category`, `/owners/participation`, `/graphql`, `/alerts`, `/alerts/rules`, `/reports` | `/livez`, `/readyz`, `/status`, `/health`, `/metrics`, `POST /reports/run` |
| **PostgreSQL** | `postgres:16-alpine` (or managed PG 16) | Private `:5432` | Managed primary with automated backups + PITR | Never public | Database access restricted to indexer & analytics API security groups |

> **Important datastore note:** As documented in [`analytics-api/README.md`](../analytics-api/README.md), the analytics API manages its schema via SQLx migrations (`analytics-api/migrations/`) while the treasury indexer manages its tables via `indexer/migrations/` (`npm --prefix indexer run migrate`). Ensure your ingestion pipeline populates the analytics tables (`proposals`, `events`, `checkpoints`) and that `CONTRACT_ID`/`CONTRACT_IDS` in the Analytics API matches `ACCORD_CONTRACT_ID` in the indexer.

---

## 2. Frontend on Vercel (`frontend/`)

### Project Configuration

Configure the Vercel project with these exact settings:

| Setting | Value | Source in Repository |
| --- | --- | --- |
| **Root Directory** | `frontend` | [`frontend/package.json`](../frontend/package.json) |
| **Framework Preset** | `Vite` | [`frontend/vite.config.ts`](../frontend/vite.config.ts) |
| **Install Command** | `npm ci` | Lockfile-enforced install |
| **Build Command** | `npm run build` (`tsc -b && vite build`) | [`frontend/package.json`](../frontend/package.json) |
| **Output Directory** | `dist` | Vite default |
| **Node.js Version** | `22.x` (supports `^20.19.0 \|\| >=22.12.0`) | [`frontend/package.json`](../frontend/package.json) |
| **SPA Rewrites** | `/(.*) -> /index.html` | [`frontend/vercel.json`](../frontend/vercel.json) |

### Environment Variables

All `VITE_*` variables are compiled into the static browser bundle at build time. **Never** put private keys, database URLs, or bearer tokens in `VITE_*` variables (see [`docs/SECRETS_MANAGEMENT.md`](./SECRETS_MANAGEMENT.md)).

| Variable | Required | Production Example | Purpose |
| --- | --- | --- | --- |
| `VITE_SOROBAN_RPC_URL` | Yes | `https://soroban-testnet.stellar.org` (or mainnet archival RPC) | Soroban RPC endpoint for read-only simulations and transaction submission |
| `VITE_NETWORK_PASSPHRASE` | Yes | `Test SDF Network ; September 2015` or `Public Global Stellar Network ; September 2015` | Stellar network passphrase verified against Freighter |
| `VITE_CONTRACT_ADDRESS` | Yes | Deployed Accord contract `C...` address | Target Accord multisig contract ID |
| `VITE_SIM_SOURCE` | Yes | Funded Stellar `G...` public key | Read-only simulation source account (never signs transactions) |
| `VITE_USDC_TOKEN_ADDRESS` | Recommended | Network USDC SAC contract ID | USDC balance tracking in the dashboard |
| `VITE_API_BASE_URL` | Recommended | `https://api.example.com` (empty = same origin) | Base URL for the Analytics API |
| `VITE_INDEXER_API_BASE_URL` | Recommended | `https://indexer.example.com` (empty = same origin) | Base URL for the Indexer API (used by notification destination management) |
| `VITE_PREVIEW_SEED` | **Must be unset in production** | _(empty)_ | PR preview-only flag that injects `preview-seed.json`; never enable in production |

Reference template: [`frontend/.env.example`](../frontend/.env.example).

### Build Verification, Deploy, and Health Checks

Run a local production build and bundle-budget check before deploying:

```bash
cd frontend
npm ci
npm run build
npm run check:bundle
```

Expected output (summary):

```text
✓ built in ...s
Bundle budget check passed.
```

Deploy to Vercel via CLI (or merge to the Git branch connected to Vercel):

```bash
cd frontend
vercel deploy --prod
```

Verify both the root document and deep-link SPA rewrite (`frontend/vercel.json`):

```bash
curl -sSI https://app.example.com/ | head -n 5
curl -sSI https://app.example.com/proposals/1 | head -n 5
```

Expected output:

```text
HTTP/2 200
content-type: text/html; charset=utf-8
...
HTTP/2 200
content-type: text/html; charset=utf-8
```

Verify the deployed bundle does not have preview seeding enabled:

```bash
curl -sS https://app.example.com/ | grep -i "Accord"
```

### Upgrades and Rollback (Vercel)

- **Upgrade:** Every deployment is immutable. Changing any `VITE_*` environment variable in Vercel **requires a new build/redeploy** because Vite inlines `import.meta.env.VITE_*` during `npm run build`.
- **Rollback (instant, zero rebuild):**
  1. Via CLI:
     ```bash
     vercel list --prod
     vercel rollback <previous-deployment-url>
     ```
  2. Or in the Vercel Dashboard: **Deployments → select previous healthy production deployment → Promote to Production**.
  3. Re-run the `curl -sSI` checks on `/` and `/proposals/1` to confirm HTTP `200` and verify the UI loads contract state and analytics charts without console errors.

---

## 3. Treasury Indexer (`indexer/`)

### Runtime & Infrastructure Requirements

- **Node.js:** `>=22.13.0` (enforced by [`indexer/package.json`](../indexer/package.json)).
- **Database:** PostgreSQL 16 (`STORE_BACKEND=postgres`) in production. SQLite (`STORE_BACKEND=sqlite`) is only for single-host development or isolated replay runs.
- **RPC:** Archival Soroban RPC endpoint with sufficient retention for `INDEXER_START_LEDGER` and backfills.
- **Concurrency:** Run **one** active indexer process per database. Configure your orchestrator with `replicas: 1` and `strategy: Recreate` (never `RollingUpdate` with two simultaneous writers).

### Environment Variables

The full operational reference is enforced by `indexer/test/ops-assets.test.js` against [`docs/RUNBOOK.md`](./RUNBOOK.md#configuration-reference). Inject secrets from your platform secret manager rather than committing `.env` files.

| Category | Variable | Default | Purpose |
| --- | --- | --- | --- |
| **Chain & Contract** | `ACCORD_CONTRACT_ID` | **required** | Accord contract ID to index (must match API `CONTRACT_ID`) |
| | `XLM_TOKEN_ADDRESS` | **required** | XLM Stellar Asset Contract ID |
| | `USDC_TOKEN_ADDRESS` | **required** | USDC Stellar Asset Contract ID |
| | `SIM_SOURCE` | **required (`serve`)** | Funded account for reconciliation balance simulations |
| | `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | Archival Soroban RPC URL |
| | `NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | Stellar network passphrase |
| | `INDEXER_START_LEDGER` | **required (`serve`)** | First ledger for initial live indexing |
| **Polling & Finality** | `LEDGER_FINALITY_LAG` | `2` | Ledgers held back before indexing to absorb reorgs |
| | `INDEX_INTERVAL_MS` | `5000` | Live polling cadence (ms) |
| | `RECONCILE_INTERVAL_MS` | `60000` | On-chain vs folded-balance drift check cadence (ms) |
| | `READY_MAX_STALENESS_MS` | `max(60000, 6 * INDEX_INTERVAL_MS)` | Max age of last successful batch before `/readyz` returns `503` |
| **HTTP Server** | `HOST` / `PORT` | `127.0.0.1` / `8787` | Bind address and port (`0.0.0.0` inside containers) |
| **Storage** | `STORE_BACKEND` | `sqlite` | Set to `postgres` in production |
| | `DATABASE_URL` | none | PostgreSQL connection string (`postgres://accord:changeme@db.example.internal:5432/accord_analytics`) |
| | `DATABASE_POOL_MAX` | `10` | Maximum PostgreSQL pool connections |
| | `DATABASE_AUTO_MIGRATE` | `true` | Apply `indexer/migrations/` on boot; set `false` if running migrations as a dedicated pre-deploy job |
| **Webhooks & Notifications** | `WEBHOOK_SUBSCRIPTIONS_FILE` / `WEBHOOK_SUBSCRIPTIONS` | none | Webhook subscription definitions |
| | `WEBHOOK_MAX_ATTEMPTS`, `WEBHOOK_BACKOFF_BASE_MS`, `WEBHOOK_BACKOFF_MAX_MS`, `WEBHOOK_TIMEOUT_MS`, `WEBHOOK_POLL_INTERVAL_MS` | `8`, `5000`, `3600000`, `10000`, `2000` | Webhook outbox retry & polling controls |
| | `EMAIL_API_URL`, `EMAIL_API_KEY`, `EMAIL_FROM` | none | Shared transactional email transport for notification destinations |
| | `NOTIFICATION_MAX_ATTEMPTS`, `NOTIFICATION_BACKOFF_BASE_MS`, `NOTIFICATION_BACKOFF_MAX_MS`, `NOTIFICATION_TIMEOUT_MS`, `NOTIFICATION_POLL_INTERVAL_MS` | `8`, `5000`, `3600000`, `10000`, `2000` | Notification outbox retry & polling controls |
| **Optional Streaming / Exports** | `GRAPHQL_SUBSCRIPTIONS_ENABLED`, `GRAPHQL_SUBSCRIPTIONS_PATH`, `GRAPHQL_KEEPALIVE_MS` | `true`, `/graphql/subscriptions`, `15000` | Real-time SSE GraphQL subscriptions (see [`docs/OPERATIONS.md`](./OPERATIONS.md#graphql-live-event-subscriptions)) |
| | `KAFKA_EXPORTER_ENABLED`, `NATS_EXPORTER_ENABLED`, `BIGQUERY_EXPORT_ENABLED`, `SNOWFLAKE_EXPORT_ENABLED` | `false` | Optional stream and data warehouse exporters (see [`docs/OPERATIONS.md`](./OPERATIONS.md)) |

### Startup & Migration Commands

Run PostgreSQL migrations explicitly before starting a new release:

```bash
cd indexer
npm ci --omit=dev
STORE_BACKEND=postgres \
DATABASE_URL=postgres://accord:changeme@db.example.internal:5432/accord_analytics \
npm run migrate
```

Start the indexer service:

```bash
cd indexer
HOST=0.0.0.0 PORT=8787 STORE_BACKEND=postgres npm start
```

### Health Checks and Expected Output

Point container liveness probes at `GET /healthz` and readiness probes at `GET /readyz`. Scrape `GET /metrics` from Prometheus (`ops/prometheus/prometheus.yml`).

```bash
# Liveness (always 200 while HTTP loop is responsive; never touches DB or RPC)
curl -fsS http://127.0.0.1:8787/healthz

# Readiness (200 only when store answers AND a batch succeeded within READY_MAX_STALENESS_MS)
curl -fsS http://127.0.0.1:8787/readyz

# Structured status (consumed by scripts/status-page.mjs)
curl -fsS http://127.0.0.1:8787/status

# Balance reconciliation status
curl -fsS http://127.0.0.1:8787/reconciliation
```

Expected output:

```json
// GET /healthz (HTTP 200)
{"status":"ok"}

// GET /readyz (HTTP 200; returns HTTP 503 with "status":"not_ready" before first batch or when stalled)
{
  "ready": true,
  "status": "ready",
  "checks": {
    "store": { "ok": true },
    "indexing": { "ok": true, "lastSuccessAgeSeconds": 3 }
  }
}

// GET /status (HTTP 200 when operational/degraded; HTTP 503 on store outage)
{
  "service": "indexer",
  "status": "operational",
  "checks": {
    "store": { "ok": true },
    "indexing": { "ok": true, "lastSuccessAgeSeconds": 3 }
  },
  "updatedAt": "2026-11-19T12:00:00.000Z",
  "nextLedger": "1200450",
  "latestLedger": 1200451,
  "finalityLag": 2
}
```

### Upgrades and Rollback (Indexer)

**Upgrade procedure (single-writer safe):**

1. Take a PostgreSQL snapshot / `pg_dump` before applying schema migrations.
2. Apply migrations ahead of cutover:
   ```bash
   npm --prefix indexer run migrate
   ```
3. Send `SIGTERM` to the running indexer and wait for graceful shutdown (closes HTTP server and DB pool cleanly; checkpoint persists in `next_ledger` and `event_cursor`).
4. Start the new release (`npm --prefix indexer start` or deploy the new container image with `replicas: 1`).
5. Wait for `GET /readyz` to transition from `503` to `200`, confirm `accord_indexer_ingestion_lag_ledgers` converges toward `LEDGER_FINALITY_LAG`, and confirm `GET /reconciliation` reports `"drift": "0"` per token.

**Rollback procedure:**

1. Stop the faulty indexer cleanly (`SIGTERM`).
2. Deploy the previous image/tag (compatible with expand-only migrations). If the failed release included a breaking schema migration, restore the pre-upgrade PostgreSQL snapshot first.
3. Start the previous release and verify `GET /readyz` returns `200`.
4. To inspect events around the incident window without modifying live state, run a non-destructive replay:
   ```bash
   cd indexer
   node src/index.js replay --before-checkpoint 50 --json
   ```
5. If ledgers were missed or drifted during the failed release, run a resumable `backfill` (or `reindex` after stopping the live indexer) following [`docs/RUNBOOK.md`](./RUNBOOK.md#recover-from-balance-drift).

---

## 4. Analytics API (`analytics-api/`)

### Runtime & Infrastructure Requirements

- **Binary:** Compiled Rust service (`cargo build --locked --release -p accord-analytics-api` produces `target/release/accord-analytics-api`).
- **Database:** PostgreSQL 16. On startup, the API connects with a 10-connection pool and automatically applies `analytics-api/migrations/` via `sqlx::migrate!("./migrations")`. The process exits non-zero if PostgreSQL is unreachable or migrations fail.
- **Scaling:** Stateless read tier; run at least two replicas behind a TLS reverse proxy. Set `RATE_LIMIT_TRUST_PROXY=true` only when the proxy overwrites/strips client-supplied `X-Forwarded-For`.

### Environment Variables

| Category | Variable | Default | Purpose |
| --- | --- | --- | --- |
| **Core** | `LISTEN_HOST` | `127.0.0.1` | Bind IP (`0.0.0.0` in containers) |
| | `LISTEN_PORT` | `8080` | HTTP listen port |
| | `DATABASE_URL` | **required** | PostgreSQL connection string (`postgres://accord:changeme@db.example.internal:5432/accord_analytics`) |
| | `CONTRACT_ID` / `CONTRACT_IDS` | **required (one)** | Single contract ID or comma-separated list served by this deployment |
| | `NETWORK` / `NETWORKS` | `testnet` | Single network or comma-separated list (`testnet,pubnet`) |
| | `RUST_LOG` | `info` | `tracing-subscriber` filter (e.g. `info,sqlx=warn`) |
| **Rate Limiting & Caching** | `RATE_LIMIT_REQUESTS` | `120` | Requests per client per window (`0` disables limiting; probes & `/metrics` are always exempt) |
| | `RATE_LIMIT_WINDOW_SECS` | `60` | Fixed window duration in seconds (must be `>= 1`) |
| | `RATE_LIMIT_TRUST_PROXY` | `false` | Identify clients from `X-Forwarded-For` behind a trusted proxy |
| | `CACHE_TTL_SECS` | `30` | In-memory TTL cache for heavy reads (`/proposals`, `/proposals/{id}`, `/spend/by-category`); `0` disables caching |
| | `CACHE_MAX_ENTRIES` | `500` | Maximum cached responses per replica |
| **GraphQL Guardrails** | `GRAPHQL_MAX_DEPTH` | `6` | Maximum selection nesting depth |
| | `GRAPHQL_MAX_COMPLEXITY` | `500` | Maximum query complexity cost |
| | `GRAPHQL_TIMEOUT_MS` | `10000` | Per-query execution timeout (ms) |
| | `GRAPHQL_INTROSPECTION` | `true` | Set `false` in hardened public deployments to disable `__schema` introspection |
| **Scheduled Reports** | `REPORT_SCHEDULE` | unset (off) | 6-field cron expression (`sec min hour dom month dow`); enable on one replica only |
| | `REPORT_FORMATS`, `REPORT_RECIPIENTS`, `REPORT_PERIOD_DAYS`, `REPORT_OUTPUT_DIR`, `REPORT_FROM`, `SMTP_URL`, `REPORT_MAX_ATTEMPTS`, `REPORT_RETRY_BACKOFF_MS` | `csv,pdf`, none, `30`, none, `accord-analytics@localhost`, none, `3`, `2000` | Scheduled CSV/PDF report generation and SMTP/directory delivery |
| **Alerting** | `ALERT_RULES` / `ALERT_RULES_FILE` | unset (off) | Inline JSON or file path of spend/approval alert rules |
| | `ALERT_CHANNELS`, `ALERT_RECIPIENTS`, `ALERT_COOLDOWN_SECS`, `ALERT_MAX_PER_WINDOW`, `ALERT_STORM_WINDOW_SECS`, `ALERT_POLL_SECS`, `ALERT_BACKFILL` | `log`, none, `300`, `20`, `300`, `15`, `false` | Alert delivery, storm protection, and watcher cadence |

Full API reference and OpenAPI schema: [`docs/ANALYTICS_API.md`](./ANALYTICS_API.md) and [`docs/analytics-api.openapi.json`](./analytics-api.openapi.json).

### Build, Startup, and Health Checks

Build the release binary from the repository root:

```bash
cargo build --locked --release -p accord-analytics-api
```

Run health, readiness, status, metrics, and functional smoke checks:

```bash
# Liveness (200 whenever process answers; never touches PostgreSQL)
curl -fsS http://127.0.0.1:8080/livez

# Readiness (200 when SELECT 1 completes within 2s; otherwise 503)
curl -fsS http://127.0.0.1:8080/readyz

# Structured status (database + ingestion checkpoint freshness <= 120s)
curl -fsS http://127.0.0.1:8080/status

# Prometheus metrics
curl -fsS http://127.0.0.1:8080/metrics | head -n 20

# Functional REST & GraphQL smoke checks
curl -fsS "http://127.0.0.1:8080/proposals?limit=1"
curl -fsS http://127.0.0.1:8080/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"{ proposals(first: 1) { totalCount } }"}'
```

Expected output:

```json
// GET /livez (HTTP 200)
{"status":"ok"}

// GET /readyz (HTTP 200; returns HTTP 503 with "status":"unavailable" if DB ping fails)
{"checks":{"database":"ok"},"status":"ok"}

// GET /status (HTTP 200 when operational/degraded; HTTP 503 on database outage)
{
  "service": "analytics-api",
  "status": "operational",
  "checks": {
    "database": { "ok": true },
    "ingestion": { "ok": true, "ageSeconds": 5 }
  },
  "updatedAt": "2026-11-19T12:00:00.000000+00:00",
  "latestLedger": 1200450
}
```

### Upgrades and Rollback (Analytics API)

**Upgrade procedure (rolling zero-downtime):**

1. Verify database migrations in `analytics-api/migrations/` are backward-compatible with the currently running release (expand-and-contract pattern). Never edit an already-applied migration file; SQLx validates migration checksums in `_sqlx_migrations`.
2. Take a pre-upgrade PostgreSQL snapshot if new SQLx migrations are included.
3. Roll out one canary replica running the new binary/image. Startup automatically applies pending SQLx migrations.
4. Confirm `GET /readyz` returns `200`, `GET /status` returns `"operational"`, and `accord_api_errors_total` stays at `0`.
5. Complete the rolling update across remaining replicas, draining connections on each old instance before termination.

**Rollback procedure:**

1. Shift ingress traffic back to the previous release image/binary.
2. Confirm `GET /readyz` returns `200` and smoke-test `/proposals?limit=1` and `/graphql`.
3. Note on SQLx migrations: if the rolled-back release applied a new migration, an older binary that does not have that migration file in its embedded `sqlx::migrate!("./migrations")` list will still start if `ignore_missing` were set, **but by default SQLx rejects unknown applied migrations**. Therefore, if a release introduced new SQLx migrations and must be rolled back, either:
   - Restore the pre-upgrade PostgreSQL snapshot (coordinated with an indexer pause and backfill), **or**
   - Ship a forward-fix release that preserves the migration history in `_sqlx_migrations`.

---

## 5. Coordinated Multi-Service Upgrade & Rollback Order

When a release spans multiple components (for example, a new contract event or database column):

### Forward Upgrade Order

1. **Snapshot PostgreSQL** (`pg_dump` / managed snapshot) and verify restore readability.
2. **Smart contract** (only if contract WASM changed): follow [`docs/UPGRADE_SAFETY.md`](./UPGRADE_SAFETY.md) and [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md#upgrading-the-contract).
3. **Treasury Indexer**: run `npm --prefix indexer run migrate`, stop the old writer cleanly, deploy the new indexer, wait for `GET /readyz` -> `200` and zero drift.
4. **Analytics API**: roll out canary replica, confirm SQLx migrations and `GET /readyz` -> `200`, then roll out remaining replicas.
5. **Frontend (Vercel)**: deploy production build and verify `/` and `/proposals/1` return `200`.
6. **Status page & monitoring**: verify Prometheus scrape targets (`up{job=~"accord-.*"} == 1`) and run a dry-run status probe:
   ```bash
   INDEXER_STATUS_URL=http://127.0.0.1:8787 \
   ANALYTICS_API_STATUS_URL=http://127.0.0.1:8080 \
   node scripts/status-page.mjs probe --dry-run
   ```

### Reverse Rollback Order

1. **Frontend (Vercel):** instant rollback via `vercel rollback` or Dashboard Promote.
2. **Analytics API:** revert to the previous container/binary (or restore DB snapshot if new SQLx migrations were applied).
3. **Treasury Indexer:** stop faulty writer, revert to previous release, verify `/readyz` and `/reconciliation`.
4. **Smart contract** (only if on-chain WASM regressed): follow [`docs/runbooks/UPGRADE_ROLLBACK.md`](./runbooks/UPGRADE_ROLLBACK.md).

---

## 6. Local Full-Stack Topology Validation

You can validate the multi-service wiring locally using [`docker-compose.yml`](../docker-compose.yml):

```bash
# 1. Start PostgreSQL 16 (and optional standalone Stellar node)
docker compose up -d postgres

# 2. Apply indexer schema migrations and start the indexer
npm --prefix indexer run migrate
STORE_BACKEND=postgres npm --prefix indexer start

# 3. Start the analytics API in a second terminal
DATABASE_URL=postgres://accord:changeme@127.0.0.1:5432/accord_analytics \
CONTRACT_ID=YOUR_CONTRACT_ID \
NETWORK=testnet \
cargo run --locked -p accord-analytics-api

# 4. Verify both services respond to health probes
curl -fsS http://127.0.0.1:8787/healthz
curl -fsS http://127.0.0.1:8080/livez
curl -fsS http://127.0.0.1:8080/readyz
```

---

## 7. Troubleshooting

| Service | Symptom | Likely Cause | Diagnostic Command & Fix |
| --- | --- | --- | --- |
| **Vercel Frontend** | Direct links (`/proposals/1`, `/app/analytics`) return HTTP `404` | Vercel Root Directory is not set to `frontend`, so `frontend/vercel.json` rewrites are ignored | Set Vercel **Root Directory** to `frontend` and redeploy; verify `curl -sSI https://app.example.com/proposals/1` returns `200`. |
| **Vercel Frontend** | Analytics charts show fixture/mock data in production | `VITE_PREVIEW_SEED=true` leaked into production env vars | Remove `VITE_PREVIEW_SEED` from Vercel Production environment and trigger a fresh build. |
| **Vercel Frontend** | Browser console reports CORS errors against Analytics or Indexer API | Missing `Access-Control-Allow-Origin` at ingress or mismatched `VITE_API_BASE_URL` | Confirm `VITE_API_BASE_URL` matches the TLS origin configured on your reverse proxy and allow the Vercel origin. |
| **Treasury Indexer** | `GET /readyz` stays `503` with `checks.indexing.ok: false` | Soroban RPC unreachable, rate-limited, or pruned past `next_ledger` | Run `curl -sS http://127.0.0.1:8787/readyz` and `curl -sS -X POST "$SOROBAN_RPC_URL" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'`. Switch to an archival RPC or follow [`docs/RUNBOOK.md#indexing-stalled`](./RUNBOOK.md#indexing-stalled). |
| **Treasury Indexer** | Duplicate webhooks or notifications delivered | More than one indexer instance is polling the same database outbox | Scale indexer replicas strictly to `1` (`strategy: Recreate`); see [`docs/RUNBOOK.md#webhook-backlog`](./RUNBOOK.md#webhook-backlog). |
| **Analytics API** | Process exits immediately on startup | Missing `DATABASE_URL` / `CONTRACT_ID`, PostgreSQL unreachable, or SQLx migration mismatch | Inspect startup stderr (`RUST_LOG=info`); verify `DATABASE_URL` connectivity and `_sqlx_migrations` table state. |
| **Analytics API** | All users receive `429 RATE_LIMITED` behind a load balancer | `RATE_LIMIT_TRUST_PROXY` is `false`, so every request shares the ingress peer IP | Set `RATE_LIMIT_TRUST_PROXY=true` (only behind a trusted proxy that strips spoofed `X-Forwarded-For`) and tune `RATE_LIMIT_REQUESTS`. |
| **Analytics API** | `GET /status` reports `"degraded"` (`ingestion.ok: false`) | `checkpoints` row is missing or older than 120s | Confirm `CONTRACT_ID`/`CONTRACT_IDS` matches indexer `ACCORD_CONTRACT_ID` and both target the same PostgreSQL database; see [`docs/RUNBOOK.md#api-checkpoint-stale`](./RUNBOOK.md#api-checkpoint-stale). |
| **Analytics API** | Elevated latency and `accord_api_db_pool_connections{state="idle"} == 0` | Slow queries or connection pool saturation | Check `pg_stat_activity` in PostgreSQL, verify `CACHE_TTL_SECS > 0`, and follow [`docs/RUNBOOK.md#api-db-pool-saturated`](./RUNBOOK.md#api-db-pool-saturated). |

---

## Related Documentation

- [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) — Soroban smart contract deployment and testnet upgrade simulation
- [`docs/OPERATIONS.md`](./OPERATIONS.md) — Prometheus metrics, alerting rules, and streaming/warehouse exporters
- [`docs/RUNBOOK.md`](./RUNBOOK.md) — Incident triage, backfill/reindex/replay, and indexer configuration reference
- [`docs/STATUS.md`](./STATUS.md) — Automated public status page probes and incident notes
- [`docs/SECRETS_MANAGEMENT.md`](./SECRETS_MANAGEMENT.md) — Secret classification, injection, and rotation rules
- [`docs/INCIDENT_RESPONSE.md`](./INCIDENT_RESPONSE.md) — Severity classification and escalation procedures
