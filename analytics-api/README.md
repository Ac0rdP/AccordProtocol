# Analytics API

The analytics API is a Rust HTTP service backed by PostgreSQL. It applies its
schema migrations on startup. The `proposals` and `events` tables follow the
datastore model in [the analytics architecture](../docs/ARCHITECTURE.md#132-datastore-schema).
The current `scripts/indexer.js` reference implementation persists to a JSON file;
it does not yet populate this PostgreSQL schema, so the API needs a PostgreSQL
indexer adapter or an equivalent ingestion process before it can serve indexed
records.

Every table is tagged by contract **and** network, and both are part of each
primary key, so one deployment can serve several multisigs and several networks.
Checkpoints are tracked per `(network, contract_id)` pair.

## Run locally

Start PostgreSQL from the repository root:

```sh
docker compose up -d postgres
```

Then, from the repository root, start the API:

```sh
DATABASE_URL=postgres://accord:accord@localhost:5432/accord_analytics \
  CONTRACT_IDS=CA...TREASURY_A,CA...TREASURY_B \
  NETWORKS=testnet,pubnet \
  cargo run -p accord-analytics-api
```

```sh
curl http://127.0.0.1:8080/
curl http://127.0.0.1:8080/health
curl "http://127.0.0.1:8080/proposals?contractId=CA...TREASURY_A&network=testnet"
```

`/health` runs a database query and responds with `503 Service Unavailable` if
the datastore cannot be reached. The server exits at startup if it cannot
connect or apply its migrations.

## GraphQL

`POST /graphql` exposes proposals, owners, spends, and treasury flows with
pagination and filtering; see [the API reference](../docs/ANALYTICS_API.md#graphql).
Queries are bounded by these optional environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `GRAPHQL_MAX_DEPTH` | `6` | Maximum selection nesting depth. |
| `GRAPHQL_MAX_COMPLEXITY` | `500` | Maximum query cost (lists multiply by `first`). |
| `GRAPHQL_TIMEOUT_MS` | `10000` | Execution time limit per request. |
| `GRAPHQL_INTROSPECTION` | `true` | Set `false` to disable schema introspection. |

```sh
curl -s http://127.0.0.1:8080/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"{ proposals(first: 3) { nodes { id status } totalCount } }"}'
```

## Metrics and health

| Endpoint | Purpose |
| --- | --- |
| `GET /livez` | Liveness: `200` whenever the process is serving; never touches the database. |
| `GET /readyz` | Readiness: `200` when the database answers within 2 seconds, otherwise `503`. |
| `GET /metrics` | Prometheus text format: request counts and latency per route, error and GraphQL rejection counters, database pool gauges, and the indexer checkpoint (`accord_api_indexed_ledger`, `accord_api_checkpoint_age_seconds`). |

`/health` is unchanged. Point Kubernetes liveness probes at `/livez` and
readiness probes at `/readyz`.

## Tests

`cargo test -p accord-analytics-api` runs the unit and HTTP-level tests. The
database-backed GraphQL tests run when `TEST_DATABASE_URL` points at a
PostgreSQL database (each test creates and drops its own schema) and are
skipped otherwise:

```sh
TEST_DATABASE_URL=postgres://accord:accord@localhost:5432/accord_analytics \
  cargo test -p accord-analytics-api
```
