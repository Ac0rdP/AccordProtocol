# Accord Protocol Indexer

The indexer is a standalone Node.js service that polls the Soroban RPC for events emitted by the Accord Protocol contract and its configured tokens.

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

## Endpoints

- `GET /health` - Service health, current ledger state and the finality lag in effect.
- `GET /healthz` - Liveness: `200` whenever the process can answer.
- `GET /readyz` - Readiness: `200` when the store answers and indexing made progress recently, otherwise `503` with per-check detail.
- `GET /metrics` - Prometheus metrics.
- `GET /webhooks/deliveries?status=dead` - Inspect the webhook outbox (`status` is `pending`, `delivered` or `dead`; optional `subscription`, `limit`, `offset`).
- `GET /ledger?token=XLM&limit=100` - Query historical treasury token transfer events.
- `GET /events?topic=created&limit=100` - Query decoded Accord Protocol events.
- `GET /reconciliation` - View latest token balance reconciliation checks.

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

Run a single indexer instance per database: the outbox processor does not lock rows between processes.

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

The suite covers the store contract on every backend, Postgres migrations, the finality and rollback policy, backfill/reindex on a small ledger range, webhook signing/retries/dead-lettering, and the metrics and health endpoints.
