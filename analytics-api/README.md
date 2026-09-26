# Analytics API

The analytics API is a Rust HTTP service backed by PostgreSQL. It applies the
schema migration on startup. The `proposals` and `events` tables follow the
datastore model in [the analytics architecture](../docs/ARCHITECTURE.md#132-datastore-schema).
The current `scripts/indexer.js` reference implementation persists to a JSON file;
it does not yet populate this PostgreSQL schema, so the API needs a PostgreSQL
indexer adapter or an equivalent ingestion process before it can serve indexed
records.

## Run locally

Start PostgreSQL from the repository root:

```sh
docker compose up -d postgres
```

Then, from the repository root, start the API:

```sh
DATABASE_URL=postgres://accord:accord@localhost:5432/accord_analytics \
  cargo run -p accord-analytics-api
```

The default address is `127.0.0.1:8080`. Configure it with `LISTEN_HOST` and
`LISTEN_PORT`. `DATABASE_URL` and `CONTRACT_ID` are required. The API also reads
these values from a repository-root `.env` file. The `CONTRACT_ID` value scopes
proposal reads to one indexed Accord contract.

```sh
curl http://127.0.0.1:8080/
curl http://127.0.0.1:8080/health
```

`/health` runs a database query and responds with `503 Service Unavailable` if
the datastore cannot be reached. The server exits at startup if it cannot
connect or apply its migrations.