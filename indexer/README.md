# Accord Protocol Indexer

The indexer is a standalone Node.js service that polls the Soroban RPC for events emitted by Accord Protocol contracts and their configured tokens. One process can track several contracts across several networks.

## Features

- **Token Transfers**: Indexes `transfer` events from configured tokens to/from the treasury address, tracking balances natively.
- **Accord Protocol Events**: Indexes core protocol events (proposals, roles, thresholds) using the typed catalog and exposes them decoded.
- **Finality**: Only indexes events from ledgers that are final, so the index never runs ahead of the chain.
- **Reorg handling**: Detects a rollback and rewinds indexed data to a consistent point.
- **Backfill & Reindex**: Rebuilds a fresh or damaged deployment from chain history.
- **Reconciliation**: Periodically reads on-chain token balances to detect drift between the indexed state and the live ledger state.
- **Pluggable storage**: SQLite by default, Postgres for deployments that outgrow it (see [Storage](#storage)).
- **Signed webhooks**: Pushes new protocol events to subscribers with retries and a dead-letter queue (see [Webhooks](#webhooks)).
- **Operations**: Prometheus metrics plus liveness and readiness endpoints (see [Monitoring](#monitoring)).

## Architecture

The indexer persists events through a storage interface with two implementations: a local SQLite database (`data/treasury.sqlite` by default) and Postgres. It maintains state (like `next_ledger` and `event_cursor`) across restarts to ensure no events are missed.

## Storage

All storage goes through one async interface (documented on `openStore` in `src/store/index.js`); the indexing, backfill, reindex, API and webhook code never touch a database driver directly.

| Backend | Select with | Schema |
| --- | --- | --- |
| SQLite (default) | nothing, or `STORE_BACKEND=sqlite` | Created on open (`src/store/sqlite.js`). Existing databases upgrade in place. |
| Postgres | `STORE_BACKEND=postgres` + `DATABASE_URL` | Versioned SQL files in `migrations/postgres/`. |

Setting only `DATABASE_URL` does **not** switch backends, so an existing deployment can never change its store by accident.

### Using Postgres

```bash
export STORE_BACKEND=postgres
export DATABASE_URL=postgres://accord:accord@localhost:5432/accord_indexer

npm run migrate   # optional: apply migrations as a separate release step
npm start         # also migrates on start unless DATABASE_AUTO_MIGRATE=false
```

The indexer's tables (`ledger_entries`, `token_balances`, `accord_events`, `indexer_state`, `reconciliation_results`, `webhook_deliveries`) are distinct from the analytics API's, so both can share a database; give the indexer its own database or schema if you would rather keep them apart.

### Migrations

- Files are `migrations/postgres/NNNN_name.sql`, applied in order, each in its own transaction, and recorded in `schema_migrations` with a SHA-256 checksum.
- Concurrent starters are serialized with an advisory lock, so two replicas booting together migrate once.
- Applied migrations are immutable: editing one makes the next start fail with `was modified after it was applied`. Ship schema changes as a new numbered file.
- A failing migration rolls back completely and names the file that failed.
- To keep schema changes out of the application's start-up path, set `DATABASE_AUTO_MIGRATE=false` and run `npm run migrate` from an init container or release job first.

### Moving from SQLite to Postgres

There is no data copy. History is rebuilt from the chain, which is the source of truth:

1. Point the environment at Postgres and run `npm run migrate`.
2. Run `npm run backfill` (the RPC only serves the ledgers it retains; data older than that cannot be rebuilt, so keep the SQLite file if you need it).
3. Start the indexer and switch consumers over once `/readyz` reports ready.

### Testing against both backends

`test/store.test.js` is one contract suite that runs against every backend, and the ledger, finality and backfill/reindex suites use the same mechanism (`describeEachBackend` in `test/helpers.js`). SQLite always runs; Postgres runs when `TEST_POSTGRES_URL` points at a disposable database (each test gets its own schema and drops it afterwards), and is reported as skipped otherwise.

```bash
docker compose up -d postgres
TEST_POSTGRES_URL=postgres://accord:accord@localhost:5432/accord_analytics npm test
```

## Running

```bash
npm start                 # serve: run the API and poll for new events
npm run backfill          # index history from the first relevant ledger to now
npm run reindex           # clear the store and rebuild it from chain events
```

Each history command accepts:

- `--from <ledger>` — first ledger to cover. Defaults to the oldest ledger the RPC still retains (its retention window is the practical genesis; history before it is no longer servable).
- `--to <ledger>` — last ledger to cover. Defaults to the final ledger, and is **always clamped to it**: non-final ledgers are never indexed.
- `--json` — emit machine-readable progress lines.

```bash
# Backfill from the RPC's oldest retained ledger, with progress.
npm run backfill

# Backfill a specific range.
node src/index.js backfill --from 1000 --to 2000

# Rebuild everything the RPC can still serve.
npm run reindex
```

### Backfill

Walks a ledger range and ingests its events. It is safe on a fresh deployment
and on an existing one: inserts are keyed by event id, so re-ingesting an overlap
is a no-op, and the running balances are re-folded in chain order
(`ledger ASC, id ASC`) once the walk completes — which is what keeps a backfill
of *older* events into a store that already holds *newer* ones correct.

After a completed backfill the live indexer's checkpoint is advanced to the
first ledger after the covered range, never backwards.

#### Parallel backfill

Set `BACKFILL_WORKERS` above `1` to split the range into shards of
`BACKFILL_SHARD_SIZE` ledgers that are walked concurrently. The default is `1`,
which keeps the single-cursor walk above and changes nothing for existing
deployments.

```bash
BACKFILL_WORKERS=4 BACKFILL_SHARD_SIZE=50000 npm run backfill
```

- Every shard has its own checkpoint in `backfill_shards` (Postgres migration
  `0009_backfill_shards.sql`): status, RPC cursor, last ledger, pages, events and
  attempts. The checkpoint is written *after* the page's events, so replaying a
  shard from any checkpoint is safe — inserts are keyed by event id.
- A shard that fails is retried from its own cursor up to
  `BACKFILL_SHARD_MAX_RETRIES` times (exponential backoff from
  `BACKFILL_SHARD_RETRY_DELAY_MS`). If it still fails it stays `failed` with its
  checkpoint while the other shards finish; re-running `backfill` resumes only
  the unfinished shards.
- The live indexer's checkpoint and the running balances are only updated once
  **every** shard is done, so a partially covered range never hands over to the
  live indexer.
- Shard boundaries are anchored at the range start, so a later run whose chain
  tip moved forward keeps finished shards and only extends the last one. A
  different start ledger or shard size begins a new job.
- `reindex` (and any rewind past a shard) discards shard checkpoints.

### Reindex

Clears the store (entries, protocol events, balances, reconciliation results)
and re-walks history. An interrupted rebuild leaves `store_rebuilding` set and
its walk checkpoint on disk; the next `reindex` for the **same range** resumes it
instead of wiping the partial progress again. Requesting a *different* range
mid-rebuild starts over cleanly, so a stale partial range is never merged in.

### Resumability and progress

Both commands persist a checkpoint (`<command>_cursor`, `<command>_from`,
`<command>_to`, `<command>_done`) after every page, so a long run can be stopped
and re-run without repeating work. Progress is reported per page and throttled
to at most one line every two seconds; `--json` emits the same data as JSON.

### Replay

Re-runs a ledger range **in isolation** to debug a bad ingest. Events are
decoded and applied to a private SQLite store (in memory by default) and every
one is printed; the live store is never written.

```bash
# An explicit range.
node src/index.js replay --from 1000 --to 1100

# The 50 ledgers already indexed (before the live checkpoint)…
node src/index.js replay --before-checkpoint 50
# …or the 50 ledgers the indexer has yet to cover (from the checkpoint on).
node src/index.js replay --after-checkpoint 50

# Keep the isolated store to inspect it afterwards; machine-readable output.
node src/index.js replay --from 1000 --to 1100 --replay-store ./data/replay.sqlite --json
```

- `--before-checkpoint` / `--after-checkpoint` are relative to the live
  `next_ledger` checkpoint, which is read without writing (SQLite is opened
  read-only; Postgres runs no migrations). `--checkpoint <ledger>` supplies one
  explicitly. They cannot be combined with `--from`/`--to`.
- The end is clamped to the final ledger, exactly like `backfill`.
- `--replay-store` may never be the live `DATABASE_PATH`; replay always uses
  SQLite, even when the live store is Postgres.
- Output is one line per event (`ledger`, event id, transaction, decoded transfer
  or Accord event, `(duplicate)` / `ignored` markers) followed by a summary with
  the balances the range produces. See the runbook in
  [docs/RUNBOOK.md](../docs/RUNBOOK.md).

## Idempotent ingestion (event dedupe)

Every event is identified by its position on chain: the **dedupe key**
`ledger:transaction:eventIndex` (for example `42:ab12…:3`). The key is built in
`src/events.js` (`eventDedupeKey`) from the event's ledger, its transaction
hash, and its event index — the RPC's `eventIndex`/`index` when present,
otherwise the numeric suffix of the Soroban event id (`<toid>-<eventIndex>`).
It does not depend on paging tokens or cursors, so re-fetching the same event
always produces the same key.

Both stores keep the key in a `dedupe_key` column with a unique index, on
`ledger_entries` and `accord_events`. A record whose key (or legacy `event_id`)
is already present is skipped and reported as not recorded, so a retry, a
re-read of a ledger, a `backfill` overlap or a `reindex` never inflates counts
or balances. The live indexer, `backfill`, `reindex` and `replay` all parse events
through the same functions, so they share the one key.

Rows indexed before the column existed keep a `NULL` key and stay protected by
the `event_id` constraint; run `reindex` once to give them keys. Postgres gets
the column from migration `0004_event_dedupe_key`; SQLite adds it on open.
`test/dedupe.test.js` re-runs ingestion, backfill and reindex on both backends
and asserts no duplicates.

## Event schema registry, validation and quarantine

Every event the treasury contract emits is checked against a **versioned schema registry** ([schema-registry.js](src/schema-registry.js)) before it reaches `accord_events`. Events that do not fit are **quarantined**, not dropped, and never stall ingestion.

- **Schemas** are `(topic, version)` pairs built from `src/catalog.json` (the current version) plus the recorded version history, so version `1` (`executed` still carried `transfers`) and pre-versioning events (no `version` field) stay valid. See [docs/EVENTS.md](../docs/EVENTS.md#event-versioning-policy). `GET /schemas` lists every topic, version and field.
- **Checks:** known topic, known version, every field present with the right type and range (`u32`, `u64`, `i128`, addresses, `Vec`, `Option`, `BytesN`, the `Transfer` struct), and no fields outside the schema.
- **Quarantine reasons:** `unknown_topic`, `unknown_version` (e.g. a newer contract), `invalid_payload`, `undecodable`. Each row keeps the reasons, the ledger and transaction, and the raw event (topic and value as base64 XDR) in `quarantined_events` (migration `0011_quarantined_events.sql`).
- **Inspect:** `GET /quarantine` (`status`, `reason`, `topic`, `raw=true`, `limit`, `offset`; the response includes counts). Metrics: `accord_indexer_events_quarantined_total{reason}` and `accord_indexer_quarantined_events{reason}`.
- **Recover:** after fixing the cause (register the new schema, ship a catalog update), run `npm run start -- quarantine-reprocess [--topic <name>] [--reason <code>]`. Every quarantined event that is valid now is indexed and marked `released`; the rest stay. `quarantine-discard --id <n>` retires one for good. Re-ingesting a range (backfill, replay) releases fixed events too.

Safe to replay from any checkpoint:

- Quarantine is keyed by the event's chain position (`ledger:transaction:eventIndex`), the same key that dedupes accepted events, so replaying a range quarantines each event once and the first verdict stands.
- A store failure mid-batch leaves the checkpoint where it was; the retry finds the already-stored events deduped and finishes the rest.
- A reorg rewind (and `reindex`) also removes quarantined events above the rewind point, so they are re-judged with the rest of the range.
- Previously, an undecodable treasury event failed the whole batch on every retry; it is now quarantined and ingestion moves on.

| Variable | Default | Purpose |
| --- | --- | --- |
| `EVENT_VALIDATION_MODE` | `enforce` | `enforce`: quarantine events that fail validation. `warn`: index invalid payloads anyway and count them in `accord_indexer_event_validation_warnings_total` (unknown topics and versions are still quarantined). `off`: previous behaviour, no validation and unknown topics ignored. An unrecognised value falls back to `enforce` with a warning. |
| `EVENT_SCHEMA_STRICT` | `true` | Treat fields outside the schema as violations. Set `false` to tolerate additive fields |
| `EVENT_ALLOW_UNVERSIONED` | `true` | Accept events from deployments that predate the `version` field |

## API keys and quotas for analytics consumers

Turn on `API_KEYS_ENABLED=true` and the analytics reads (`/ledger`, `/events`, `/reconciliation`, and the GraphQL subscriptions stream) require a scoped API key with a request quota. Health, readiness, metrics and the ops endpoints are not affected. It is **off by default**, so existing consumers keep working until you enable it.

- **Keys** look like `acck_<16 hex id>_<64 hex secret>`, are shown **once** when issued, and only a SHA-256 hash of the secret is stored. Send them as `Authorization: Bearer <key>` or `X-API-Key: <key>` (never in the query string).
- **Scopes:** `ledger`, `events`, `reconciliation`, `subscriptions` (or `"*"`). A key outside its scope gets `403`.
- **Quota:** `limit` requests per fixed `windowSeconds` window (default 1000 per 3600 s), counted atomically in the store, so concurrent requests, and instances sharing the database, cannot overshoot it. Over the limit is `429` with `Retry-After`. Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (epoch seconds). Refused requests (bad key, wrong scope, over quota) are never counted.
- **Rotation:** `POST /admin/api-keys/:id/rotate` issues a new secret for the same key id (so its quota carries over). The old secret keeps working for `graceSeconds` (default `API_KEYS_ROTATION_GRACE_SECONDS`, 24 h; `0` cuts it off at once) so consumers can switch without downtime. Only one previous secret is honoured: rotating twice inside the grace period drops the oldest.
- **Revocation** is immediate and idempotent (revoking twice is a no-op); a revoked key cannot be rotated back.
- **Expiry:** an optional `expiresAt` when issuing.

Managing keys needs `Authorization: Bearer <OPS_ADMIN_TOKEN>` (the same token as the [webhook retry controls](#delivery-dashboard-and-retry-controls)); without a configured token these endpoints answer `403`.

```bash
curl -X POST localhost:8787/admin/api-keys -H "authorization: Bearer $OPS_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"partner-dashboard","scopes":["ledger","events"],"limit":5000,"windowSeconds":3600}'
# {"key":"acck_...","apiKey":{"id":"...","scopes":["events","ledger"],"quotaLimit":5000,...}}
```

| Endpoint | Purpose |
| --- | --- |
| `POST /admin/api-keys` | Issue a key: `name`, `scopes`, optional `limit`, `windowSeconds`, `expiresAt` (`201`, secret in the response only) |
| `GET /admin/api-keys[?status=active\|revoked]` | List keys (never secrets) |
| `GET /admin/api-keys/:id` | One key |
| `POST /admin/api-keys/:id/rotate` | New secret; optional `graceSeconds` |
| `POST /admin/api-keys/:id/revoke` | Revoke |

Keys live in `api_keys` and quota counters in `api_key_usage` (migration `0012_api_keys.sql`, one counter row per key per window, pruned after `API_KEYS_USAGE_RETENTION_DAYS`). Counters are only shared between instances that share the store, so use Postgres when running several indexers. Metric: `accord_indexer_api_key_requests_total{key,result}`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_KEYS_ENABLED` | `false` | Require an API key for the analytics reads |
| `API_KEYS_DEFAULT_QUOTA` | `1000` | Requests per window for a new key |
| `API_KEYS_DEFAULT_WINDOW_SECONDS` | `3600` | Quota window for a new key |
| `API_KEYS_ROTATION_GRACE_SECONDS` | `86400` | How long a rotated-out secret keeps working |
| `API_KEYS_USAGE_RETENTION_DAYS` | `30` | How long quota counters are kept |

## Usage metering and billing hooks

Set `USAGE_METERING_ENABLED=true` to record usage for future paid plans. It is **off by default**: nothing is recorded or emitted until you turn it on.

| Kind | Recorded when |
| --- | --- |
| `api_call` | A successful `GET` of `/ledger`, `/events`, `/reconciliation` or the subscriptions stream. The subject is the API key id, or `anonymous` when keys are not enforced. |
| `report` | A successful `GET /runway` or `/anomalies`. |
| `webhook` | A webhook delivery succeeded. The subject is the subscription id. |

Records live in `usage_events` (migration `0013_usage_events.sql`). Every record has an idempotency key (`event_id`): a webhook is keyed by subscription and event, so a retry, a rebuild or a replay from any checkpoint meters a delivery exactly once; each API call and report gets its own id. `GET /usage?from=&to=&kind=&subject=` (needs `OPS_ADMIN_TOKEN`) returns the usage per kind and subject for `[from, to)` plus the billing hand-off counts.

With `USAGE_BILLING_HOOK_URL` set, every new record is also POSTed to that URL as signed JSON (`X-Accord-Signature`, the same scheme as webhooks; `X-Accord-Usage-Id` is the idempotency key a billing system should dedupe on). Delivery is at-least-once and survives restarts: a failing hook leaves the record pending and retries with exponential backoff, and after `USAGE_BILLING_MAX_ATTEMPTS` it is dead-lettered and can be requeued. A hook URL that is not https (http is allowed for localhost) or that has a secret shorter than 16 characters is ignored with a warning.

| Variable | Default | Purpose |
| --- | --- | --- |
| `USAGE_METERING_ENABLED` | `false` | Record usage |
| `USAGE_BILLING_HOOK_URL` | unset | Push each new record to this URL |
| `USAGE_BILLING_HOOK_SECRET` | unset | Signing secret for the hook (16+ characters) |
| `USAGE_BILLING_MAX_ATTEMPTS` | `5` | Attempts before a record is dead-lettered |
| `USAGE_BILLING_BACKOFF_BASE_MS` | `5000` | First retry delay; doubles per attempt |
| `USAGE_BILLING_BATCH_SIZE` | `100` | Records handed to the hook per tick |

Prometheus: `accord_indexer_usage_events_total{kind,result}`.

## Ledger finality and reorg policy

Stellar reaches BFT finality on every close: once a ledger closes, any two
validators sharing a quorum intersection agree on it. There is no probabilistic
confirmation depth. The residual risk for an indexer is a *view* problem — the
RPC node being polled can answer from a lagging replica or from a view built on
a ledger a later close supersedes.

The policy, implemented in `src/finality.js`:

- A ledger is final once it is closed **and** at least `LEDGER_FINALITY_LAG`
  further ledgers have closed on top of it:
  `finalLedger(latest) = max(0, latest - LEDGER_FINALITY_LAG)`.
- The default lag is **2** (~two ledger closes, roughly 5s). Set
  `LEDGER_FINALITY_LAG=0` to treat every closed ledger as final.
- Events above the final ledger are **held back**, not dropped: the checkpoint
  parks at the first non-final ledger observed, and those ledgers are re-fetched
  by the next pass once they are final.
- If the observed chain head moves *backwards* (`last_seen_ledger`), that is a
  rollback — the RPC replica restarted on a different ledger or is serving a
  stale view. The store is rewound to `finalLedger(newHead)`, which removes
  exactly the tail corresponding to the regression depth, balances are re-folded
  over what remains, and the walk restarts from the rewound point.

After either event, the indexed state equals the chain state up to the final
ledger — never ahead of it. `indexer/test/finality.test.js` asserts that
invariant after both a not-yet-final ledger and a rollback.

## Multi-region failover (leader election)

Run the same indexer in several regions against one shared Postgres and let them elect a leader. The leader ingests events, reconciles balances and runs the outbound workers (webhooks, notifications, stream and warehouse exporters). Standbys keep serving the read API from the shared store and take over automatically when the leader stops.

```bash
STORE_BACKEND=postgres
DATABASE_URL=postgres://...                  # the same database in every region
INDEXER_LEADER_ELECTION_ENABLED=true
INDEXER_REGION=us-east-1                     # label only
```

How it works:

- Instances contend for one row in `indexer_leases` (migration `0009_indexer_leases.sql`) with a single atomic upsert. The holder renews every `INDEXER_LEASE_RENEW_MS`; if it stops, the lease lapses after `INDEXER_LEASE_TTL_MS` and the next instance to try wins. Worst-case takeover is the TTL plus one renewal interval.
- Every change of ownership bumps a **fencing token**, reported by `GET /status` under `leader`.
- A leader that cannot reach the store keeps leading only until its last successful renewal would have expired by its own clock, then steps down, so it never outlives the lease it holds.
- Shutting down (`SIGTERM`/`SIGINT`) releases the lease first, so a standby takes over immediately instead of waiting out the TTL.
- Failover is safe to replay from any checkpoint: events are deduplicated by chain position and the checkpoint only resumes from a ledger that was already covered. If two instances briefly overlap (clock skew, a slow leader), the extra writes are no-ops. Keep instance clocks NTP-synced and the TTL well above expected skew.
- `/readyz` stays `200` on a healthy standby (it deliberately does not ingest); `/status` reports `checks.indexing.role = "standby"` and who the leader is.
- Metrics: `accord_indexer_is_leader` (gauge) and `accord_indexer_leader_transitions_total{to}`.

Failover is **off by default**: a single instance is always the leader and behaves exactly as before. It only coordinates instances that share the store, so use Postgres (a per-instance SQLite file elects a leader per file, not per fleet; the indexer logs a warning if you enable it on SQLite).

| Variable | Default | Purpose |
| --- | --- | --- |
| `INDEXER_LEADER_ELECTION_ENABLED` | `false` | Turn leader election on |
| `INDEXER_REGION` | empty | Region label shown in status output |
| `INDEXER_INSTANCE_ID` | `region:host-pid-random` | Unique id of this instance |
| `INDEXER_LEASE_NAME` | `indexer-leader` | Lease contended for; use distinct names for independent deployments sharing a database |
| `INDEXER_LEASE_TTL_MS` | `15000` | Lease lifetime without renewal (3000-300000) |
| `INDEXER_LEASE_RENEW_MS` | `5000` | Renewal cadence; clamped to at most half the TTL |

## Chain-tip lag and finality-depth monitoring

The indexer tracks how far it trails the chain and alerts on it. Three checks each report `ok`, `warn` or `critical`:

- **`tip_lag`** — ledgers behind the tip *above* the `LEDGER_FINALITY_LAG` floor (warn 20, critical 100), so a larger finality lag never alerts by itself.
- **`checkpoint_age`** — seconds since the checkpoint last advanced (warn 120, critical 600). It keeps growing while batches fail.
- **`finality_depth`** — confirmations on the newest indexed ledger; critical when below `FINALITY_MIN_DEPTH` (default `LEDGER_FINALITY_LAG`), i.e. non-final data was indexed.

Metrics: `accord_indexer_chain_tip_lag_ledgers`, `..._chain_tip_lag_seconds`, `..._finality_depth_ledgers`, `..._checkpoint_age_seconds`, `..._lag_alert_level{check}`, `..._lag_threshold{check,level}` and `..._lag_alerts_total{check,level}`. `GET /lag` returns the current evaluation and `/status` embeds it (a `critical` level reports `degraded`). Settings and suggested Prometheus alerts are in [docs/OPERATIONS.md](../docs/OPERATIONS.md); response steps are in the [runbook](../docs/RUNBOOK.md#chain-tip-lag).

The monitor is idempotent: it only records *when the indexed ledger changed*, so replaying an observation changes nothing. Its state persists in `lag_monitor_state` (Postgres migration `0010_lag_monitor_state.sql`), so a restart keeps the checkpoint age and does not re-fire an active alert. It is on by default (`LAG_MONITOR_ENABLED=false` disables it).

## Cash-runway forecast

`GET /runway?token=USDC` (default `USDC`; `XLM` also works) forecasts how long the treasury balance lasts from its indexed flows:

```
net burn/day = (outflow - inflow) over the window / window days
               + RUNWAY_RECURRING_OUTFLOW_PER_DAY - RUNWAY_RECURRING_INFLOW_PER_DAY
runway days  = balance / net burn/day
```

The window is `RUNWAY_LOOKBACK_DAYS` (default 90), shortened to the age of the first entry when history is younger. The response gives `status` (`burning`, `sustainable`, `beyond_horizon`, `depleted` or `no_data`), `runwayDays` and `depletionDate` (both `null` when not burning), plus the inputs used. Recurring amounts are base units per day and default to `0`, so by default the forecast rests on history alone; `RUNWAY_HORIZON_DAYS` (default 3650) caps the answer.

The forecast is computed on demand from the already-deduplicated ledger entries and persists nothing, so it is idempotent and identical after any replay, backfill or reindex.

## Outflow anomaly detection

`GET /anomalies?token=USDC` scores the treasury's recent outflows against their own history and flags unusual ones. Transfers and recurring disbursements both settle as token outflows, so both are covered.

Each outflow in the last `ANOMALY_REPORT_DAYS` is scored against the outflows that came *before it* in the preceding `ANOMALY_LOOKBACK_DAYS`, with a robust z-score: `(amount - median) / max(1.4826 * MAD, median / 10, 1)`. It is flagged when the score reaches `ANOMALY_THRESHOLD`, and never before `ANOMALY_MIN_SAMPLES` earlier outflows exist (the score is then `null`). The median/MAD baseline is not skewed by the outliers it hunts, and the floor stops a perfectly regular history from flagging tiny deviations.

Safe defaults: 30-day baseline, 7-day report window, 10 minimum samples, threshold 6. Each score depends only on earlier ledger entries, so the result is deterministic and identical after any replay, backfill or reindex; nothing is persisted.

## Endpoints

- `GET /health` - Service health, current ledger state and the finality lag in effect.
- `GET /healthz` - Liveness: `200` whenever the process can answer.
- `GET /readyz` - Readiness: `200` when the store answers and indexing made progress recently, otherwise `503` with per-check detail.
- `GET /status` - Structured status for the [public status page](../docs/STATUS.md): `operational`, `degraded` or `outage` plus one entry per check (`store`, `indexing`). It is `503` only while the store is down.
- `GET /lag` - Chain-tip lag, finality depth and checkpoint age with their alert levels (`503` until the first batch is observed).
- `GET /runway?token=USDC` - Treasury cash-runway forecast from indexed flows.
- `GET /anomalies?token=USDC` - Recent treasury outflows scored against their historical baseline; `anomalies` lists the flagged ones.
- `GET /metrics` - Prometheus metrics.
- `GET /webhooks/deliveries?status=dead` - Inspect the webhook outbox (`status` is `pending`, `delivered` or `dead`; optional `subscription`, `event`, `order`, `limit`, `offset`).
- `GET /ops/webhooks` - Webhook delivery dashboard with replay controls; see [Delivery dashboard](#delivery-dashboard-and-retry-controls).
- `GET /ledger?token=XLM&limit=100` - Query historical treasury token transfer events.
- `GET /events?topic=created&limit=100` - Query decoded Accord Protocol events.
- `GET /reconciliation` - View latest token balance reconciliation checks.
- `GET /schemas` - The event schema registry (topics, versions, fields) and the validation mode in effect.
- `GET /quarantine` - Events that failed schema validation, with counts; see [Event schema registry](#event-schema-registry-validation-and-quarantine).

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `ACCORD_CONTRACT_ID` | yes | Accord contract address |
| `XLM_TOKEN_ADDRESS` | yes | XLM token contract address |
| `USDC_TOKEN_ADDRESS` | yes | USDC token contract address |
| `SIM_SOURCE` | serve only | Funded account used to build simulations |
| `INDEXER_START_LEDGER` | serve only | First ledger for live indexing |
| `SOROBAN_RPC_URL` | no | Soroban RPC endpoint |
| `NETWORK_PASSPHRASE` | no | Stellar network passphrase |
| `LEDGER_FINALITY_LAG` | no | Ledgers to hold back before treating one as final (default 2) |
| `BACKFILL_WORKERS` | no | Shards walked concurrently by `backfill` (default 1 = sequential, max 32) |
| `BACKFILL_SHARD_SIZE` | no | Ledgers per backfill shard (default 50000) |
| `BACKFILL_SHARD_MAX_RETRIES` | no | In-run retries per failed shard before it is left `failed` (default 3) |
| `BACKFILL_SHARD_RETRY_DELAY_MS` | no | Base retry delay, doubled each retry, capped at 60000 (default 1000) |
| `LAG_MONITOR_ENABLED` | no | Chain-tip lag monitor (default `true`) |
| `LAG_WARN_LEDGERS` / `LAG_CRITICAL_LEDGERS` | no | Lag above the finality floor that warns / is critical (defaults 20 / 100) |
| `CHECKPOINT_AGE_WARN_SECONDS` / `CHECKPOINT_AGE_CRITICAL_SECONDS` | no | Checkpoint age that warns / is critical (defaults 120 / 600) |
| `FINALITY_MIN_DEPTH` | no | Minimum confirmations on the newest indexed ledger (default `LEDGER_FINALITY_LAG`) |
| `LEDGER_CLOSE_SECONDS` | no | Seconds per ledger for the lag-in-seconds estimate (default 5) |
| `RUNWAY_LOOKBACK_DAYS` | no | History window for the runway forecast (default 90) |
| `RUNWAY_RECURRING_OUTFLOW_PER_DAY` / `RUNWAY_RECURRING_INFLOW_PER_DAY` | no | Assumed recurring flows in base units per day (default 0) |
| `RUNWAY_HORIZON_DAYS` | no | Longest runway reported (default 3650) |
| `ANOMALY_LOOKBACK_DAYS` / `ANOMALY_REPORT_DAYS` | no | Baseline window / scored window for outflow anomalies (defaults 30 / 7) |
| `ANOMALY_MIN_SAMPLES` / `ANOMALY_THRESHOLD` | no | Earlier outflows needed before flagging / robust z-score that flags (defaults 10 / 6) |
| `STORE_BACKEND` | no | `sqlite` (default) or `postgres` |
| `DATABASE_PATH` | no | SQLite file (default `./data/treasury.sqlite`) |
| `DATABASE_URL` | postgres | Postgres connection URL |
| `DATABASE_POOL_MAX` | no | Postgres pool size (default 10) |
| `DATABASE_AUTO_MIGRATE` | no | Apply Postgres migrations on start (default `true`) |
| `INDEX_INTERVAL_MS` | no | Poll interval for new events (default 5000) |
| `READY_MAX_STALENESS_MS` | no | Longest gap since a good batch before `/readyz` fails (default: the larger of 60000 and six poll intervals) |
| `WEBHOOK_SUBSCRIPTIONS_FILE` / `WEBHOOK_SUBSCRIPTIONS` | no | Webhook subscriptions as a JSON file path / inline JSON |
| `WEBHOOK_MAX_ATTEMPTS` | no | Attempts before dead-lettering (default 8) |
| `WEBHOOK_BACKOFF_BASE_MS` / `WEBHOOK_BACKOFF_MAX_MS` | no | Retry delay is `base * 2^(attempt-1)` capped at max, ±20% jitter (defaults 5000 / 3600000) |
| `WEBHOOK_TIMEOUT_MS` | no | Per-request timeout (default 10000) |
| `WEBHOOK_POLL_INTERVAL_MS` | no | How often the outbox is processed (default 2000) |

## Webhooks

The indexer can push each newly indexed protocol event (the `/events` data) to HTTPS endpoints, signed so the receiver can prove the delivery came from the indexer.

### Subscribing

Subscriptions are configuration, not API state. Point `WEBHOOK_SUBSCRIPTIONS_FILE` at a JSON file (or set `WEBHOOK_SUBSCRIPTIONS` inline):

```json
[
  {
    "id": "ops-alerts",
    "url": "https://hooks.example.com/accord",
    "secretEnv": "OPS_ALERTS_WEBHOOK_SECRET",
    "topics": ["created", "executed"]
  }
]
```

| Field | Notes |
| --- | --- |
| `id` | 1–64 characters of letters, digits, `-`, `_`. Names the subscription in metrics and the outbox. |
| `url` | Must be `https`; plain `http` is accepted only for `localhost`/`127.0.0.1`. Redirects are never followed. |
| `secret` or `secretEnv` | HMAC key, at least 16 characters. Prefer `secretEnv` so the key stays out of the file. |
| `topics` | Optional list of event topics (see [EVENTS.md](../docs/EVENTS.md)); omit for every event. |
| `enabled` | Set `false` to switch a subscription off without deleting it. |

A subscription starts at the moment the indexer first sees it: it receives events indexed from then on, not the history. Config is validated at start-up, so a typo fails fast instead of silently dropping deliveries.

### Delivery

Each event becomes a `POST` with `Content-Type: application/json`:

```json
{
  "id": "0001234567-0000000001",
  "type": "executed",
  "subscription": "ops-alerts",
  "ledger": 1234567,
  "transactionHash": "9f2c…",
  "occurredAt": "2026-09-27T12:00:00.000Z",
  "data": { "...": "decoded event payload" }
}
```

| Header | Meaning |
| --- | --- |
| `X-Accord-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256>` — see below. |
| `X-Accord-Event-Id` | Same as `id`. Stable across retries: use it to de-duplicate. |
| `X-Accord-Delivery-Id` | Outbox row id. |
| `X-Accord-Delivery-Attempt` | `1` for the first try, incrementing on retries. |

Delivery is **at least once**. A `2xx` response is success; anything else (other status, redirect, timeout, connection error) is a failure. Only events from final ledgers are ever stored, so nothing pushed can later be reorged away.

### Verifying a delivery

The signature covers the timestamp and the exact request bytes: `HMAC_SHA256(secret, "<t>." + rawBody)`.

1. Read the **raw** body before any JSON parsing; re-serializing changes the bytes.
2. Parse `t` and every `v1` from `X-Accord-Signature`.
3. Reject if `|now - t|` exceeds your tolerance (300 seconds is a good default). Each retry is re-signed with a fresh `t`, so legitimate retries stay inside the window while old captured requests are rejected.
4. Compute the HMAC and compare with `v1` using a constant-time comparison. Accepting a match against any listed `v1` lets you rotate secrets: sign with both during the changeover.

Node:

```js
import { verifySignature } from "./webhooks.js"; // or copy the ~15 lines from it

app.post("/accord", express.raw({ type: "application/json" }), (req, res) => {
  const check = verifySignature({
    secret: process.env.ACCORD_WEBHOOK_SECRET,
    header: req.get("x-accord-signature"),
    body: req.body.toString("utf8"),
  });
  if (!check.valid) return res.status(401).end();
  // ...handle JSON.parse(req.body), de-duplicating on the event id...
  res.status(204).end();
});
```

Any language works the same way, for example Python:

```python
import hmac, hashlib, time

def verify(secret: bytes, header: str, body: bytes, tolerance=300) -> bool:
    parts = [p.split("=", 1) for p in header.split(",")]
    t = next(v for k, v in parts if k == "t")
    if abs(time.time() - int(t)) > tolerance:
        return False
    expected = hmac.new(secret, t.encode() + b"." + body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(v, expected) for k, v in parts if k == "v1")
```

### Retries and the dead-letter queue

Deliveries are kept in a durable outbox (`webhook_deliveries`), so a restart loses nothing:

- A failure is retried after `base * 2^(attempt-1)` (default 5s, 10s, 20s, … capped at an hour), spread ±20% so many failing endpoints do not retry in lockstep.
- After `WEBHOOK_MAX_ATTEMPTS` (default 8) failed attempts the delivery is **dead-lettered**: it stops retrying, keeps its last error and status code, and is logged. Inspect with `GET /webhooks/deliveries?status=dead`.
- Once the receiver is fixed, `node src/index.js webhooks-requeue [--subscription <id>]` returns dead letters to the queue with a fresh attempt budget.
- A delivery whose subscription was removed from the config is dead-lettered with `subscription is no longer configured`.
- Within one subscription events are sent in order, but a retried event can arrive after later ones: receivers must not assume strict ordering and should use `ledger` when it matters.
- Subscriptions are independent: a slow or failing endpoint never delays another.
- A `reindex` never resends: deliveries are unique per (subscription, event id).

Run a single outbox processor per database: it does not lock rows between processes. With [leader election](#multi-region-failover-leader-election) enabled only the leader runs it.

### Delivery dashboard and retry controls

`GET /ops/webhooks` serves a self-contained operations page (no external requests, strict CSP) for the webhook outbox:

- **Inspect:** outbox size per subscription, a filterable and paged delivery list (status, subscription, event id; newest first), and for each delivery the exact payload, the receiver's origin, and **every attempt** (round, outcome, HTTP status, latency, time, error). Attempt history is stored in `webhook_delivery_attempts` (migration `0010_webhook_delivery_attempts.sql`).
- **Replay:** send one delivery through the dispatcher again (`POST /webhooks/deliveries/:id/replay`), or requeue every dead letter (`POST /webhooks/deliveries/retry-dead[?subscription=<id>]`).

Replay is idempotent and safe to repeat:

- It only flips the outbox row back to `pending`; the dispatcher then re-sends the **stored body byte for byte** with a fresh signature timestamp and the same `x-accord-event-id`, so receivers can deduplicate. Delivery stays at-least-once.
- A dead or delivered delivery starts a new *replay round* (attempt count resets, history is kept). Replaying one that is already queued just makes it due now and is not counted again, so a double click or a retried request never queues a second copy.
- Replays only take effect on the leader, because only the leader runs the dispatcher.

Reading is open like the rest of the API. **Replay needs `Authorization: Bearer <OPS_ADMIN_TOKEN>`** and is disabled (`403`) until a token of at least 16 characters is configured; the dashboard hides the controls in that case. Put the indexer behind your usual network controls, since the read endpoints expose payloads.

| Variable | Default | Purpose |
| --- | --- | --- |
| `WEBHOOK_DASHBOARD_ENABLED` | `true` | Serve the dashboard and its inspection endpoints (`false` returns `404`) |
| `OPS_ADMIN_TOKEN` | unset | Bearer token that enables replay/retry. Unset or shorter than 16 characters keeps the dashboard read-only |
| `WEBHOOK_DASHBOARD_PAGE_SIZE` | `50` | Deliveries per page (1-200) |

Inspection endpoints: `GET /webhooks/deliveries` (adds `event` and `order=desc`), `GET /webhooks/deliveries/summary`, `GET /webhooks/deliveries/:id`. Replays are counted in `accord_indexer_webhook_replays_total{scope}`.

## Monitoring

`GET /metrics` exposes Prometheus metrics and `/healthz` and `/readyz` back liveness and readiness probes. The metric catalogue and suggested alerts live in [docs/OPERATIONS.md](../docs/OPERATIONS.md).

```yaml
livenessProbe:  { httpGet: { path: /healthz, port: 8787 } }
readinessProbe: { httpGet: { path: /readyz,  port: 8787 } }
```

`/readyz` returns `503` until the first indexing batch succeeds and again whenever the store stops answering or no batch has succeeded within `READY_MAX_STALENESS_MS`, which is what makes it useful for catching an indexer that is running but wedged.

## Tests

```bash
npm test                                   # SQLite
TEST_POSTGRES_URL=postgres://… npm test    # SQLite and Postgres
```

The suite covers the store contract on every backend, Postgres migrations, the finality and rollback policy, backfill/reindex/replay on a small ledger range, webhook signing/retries/dead-lettering, and the metrics and health endpoints.
