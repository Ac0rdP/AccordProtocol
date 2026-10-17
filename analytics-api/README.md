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

## Configuration

The API also reads these values from a repository-root `.env` file.

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | — | Required. Connection string for the indexer database. |
| `CONTRACT_ID` | — | A single indexed contract. Still supported. |
| `CONTRACT_IDS` | — | Comma-separated contract IDs. Takes precedence over `CONTRACT_ID`. One of the two is required. |
| `NETWORK` | `testnet` | A single network name. |
| `NETWORKS` | value of `NETWORK` | Comma-separated network names. |
| `LISTEN_HOST`, `LISTEN_PORT` | `127.0.0.1`, `8080` | Bind address. |

Reads are scoped to the configured contracts and networks. The `contractId` and
`network` query parameters narrow one request to a single value; anything outside
the configured set is a `400`, not an empty result. See
[docs/ANALYTICS_API.md](../docs/ANALYTICS_API.md#multi-contract-and-multi-network-scope).

## Scheduled reports

`GET /reports` returns the schedule and the history of generated reports;
`POST /reports/run` generates and delivers one immediately. Reports cover the
executed transfers in a period, with per-token and per-category totals, as CSV
(detail rows plus a totals section) or PDF (a paginated A4 landscape statement).

| Variable | Default | Description |
| --- | --- | --- |
| `REPORT_SCHEDULE` | — | Cron expression: `seconds minutes hours day-of-month month day-of-week`. Unset disables scheduled reports. `0 0 6 1 * *` is 06:00 UTC on the first of each month. |
| `REPORT_FORMATS` | `csv,pdf` | Comma-separated formats to produce each run. |
| `REPORT_RECIPIENTS` | — | Comma-separated email addresses. Delivery is skipped when empty. |
| `REPORT_PERIOD_DAYS` | `30` | Length of the period each run reports on, ending at the run time. |
| `REPORT_OUTPUT_DIR` | — | Write each generated report here as well. |
| `REPORT_FROM` | `accord-analytics@localhost` | `From` mailbox. |
| `SMTP_URL` | — | lettre SMTP URL, for example `smtps://user:password@smtp.example.com:465`. |
| `REPORT_MAX_ATTEMPTS` | `3` | Delivery attempts before a run is recorded as failed. |
| `REPORT_RETRY_BACKOFF_MS` | `2000` | Base backoff between attempts; grows linearly. |

Delivery goes over SMTP when `SMTP_URL` is set. With no `SMTP_URL` but a
`REPORT_OUTPUT_DIR`, each report and a delivery manifest are written to
`<REPORT_OUTPUT_DIR>/delivered` instead, so the pipeline can be exercised end to
end without mail credentials. With neither, reports are generated and recorded
but not delivered, and `GET /reports` says so.

A delivery that exhausts its attempts is recorded as `failed` with the last
error and the attempt count, and logged at error level so log-based alerting
picks it up. A scheduled run skips a period and format it has already delivered,
so a restart never re-sends a statement; a manual run always generates.

## Tests

```sh
cargo test -p accord-analytics-api
```

The suite covers query validation and scoping, CSV and PDF report content,
schedule arithmetic, and delivery retry behaviour. It does not need a running
database.
