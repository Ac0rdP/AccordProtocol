# Status page

The status page tells users, operators and support whether the Accord services
are working. It is a static page that is refreshed automatically from the
health endpoints of the services.

| Artefact | Path | Purpose |
|---|---|---|
| Published page | `docs/status/index.html` | The page itself; also served as `status.html` by the documentation build |
| Status data | `docs/status/status.json` | Current status of every service plus the daily availability history |
| Incident notes | `docs/status/incidents.json` | The notes a maintainer files when something breaks |
| Probe script | `scripts/status-page.mjs` | Maps the health answers to a status and renders the page |
| Probe workflow | `.github/workflows/status-page.yml` | Runs the probe every 15 minutes and publishes the result |

## What is monitored

| Service | Health endpoint | What it covers |
|---|---|---|
| Indexer | `GET /status` on the indexer API | The ledger store and whether indexing still makes progress |
| Analytics API | `GET /status` on the analytics API | The database and whether the indexer checkpoint still advances |

Both services answer with the same document, so one page can show both:

```json
{
  "service": "indexer",
  "status": "operational",
  "checks": {
    "store": { "ok": true },
    "indexing": { "ok": true, "lastSuccessAgeSeconds": 3 }
  },
  "updatedAt": "2026-10-22T09:00:00.000Z",
  "nextLedger": "42",
  "latestLedger": 41,
  "finalityLag": 2
}
```

`/healthz` and `/livez` only say that the process answers, and `/readyz` says
whether it is ready. The `/status` endpoint reports every dependency on its own
so the page can name the failing part instead of only saying "not ready".

## How a health answer becomes a status

| Health answer | Status on the page |
|---|---|
| Every check passes | `operational` |
| A check fails but the service still works, for example the indexer has not completed a batch recently | `degraded` |
| The store or the database fails, or the service does not answer at all | `outage` |
| The status endpoint does not exist or does not answer with a status document | `unknown` |

A service that reports a status itself wins over the derived one: it knows its
own internals, the probe only sees the outside. The mapping lives in
`mapProbeResult` in `scripts/status-page.mjs` and is covered by
`scripts/status-page.test.mjs`.

## How the page is kept up to date

1. `.github/workflows/status-page.yml` runs every 15 minutes.
2. The workflow probes the `/status` endpoint of both services.
3. The result is folded into `docs/status/status.json`: the current status of
   every service and the worst status seen on each day.
4. The page is re-rendered into `docs/status/index.html`.
5. The workflow commits the change to the default branch, which publishes the
   page together with the rest of the documentation.

The page is only rewritten when the status changed, when a new day started or
at least every six hours, so the repository does not collect a commit every
few minutes while everything is fine. A change to the incident notes is
published right away, even when the health of the services did not change.

The workflow needs the two health endpoints as repository variables:

| Variable | Example |
|---|---|
| `INDEXER_STATUS_URL` | `https://indexer.example.com` |
| `ANALYTICS_API_STATUS_URL` | `https://api.example.com` |

Without them the probe is skipped and the page keeps its last state.

## Running the probe locally

```bash
# Probe the services and write the status data and the page
INDEXER_STATUS_URL=http://127.0.0.1:8787 \
ANALYTICS_API_STATUS_URL=http://127.0.0.1:8080 \
node scripts/status-page.mjs probe

# Re-render the page from the committed status data
node scripts/status-page.mjs render

# Run the tests of the mapping and the rendering
node --test scripts/status-page.test.mjs
```

`probe` writes `docs/status/status.json` and `docs/status/index.html`.
`--dry-run` shows what would change without writing anything.

## Filing an incident note

The page shows the notes in `docs/status/incidents.json`. Add an entry as soon
as users are affected, following [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md);
the communications lead owns the status page during an incident.

```json
{
  "version": 1,
  "incidents": [
    {
      "id": "2026-10-22-indexer-outage",
      "service": "indexer",
      "title": "Indexer stopped indexing new ledgers",
      "status": "investigating",
      "startedAt": "2026-10-22T08:55:00.000Z",
      "resolvedAt": null,
      "impact": "Analytics data was up to five minutes stale.",
      "updates": [
        {
          "at": "2026-10-22T08:55:00.000Z",
          "status": "investigating",
          "note": "The indexer stopped answering health checks. The on-call engineer is looking at the RPC connection."
        }
      ]
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `id` | Stable identifier, usually the date and the service |
| `service` | `indexer`, `analytics-api` or `all` |
| `status` | `investigating`, `identified`, `monitoring` or `resolved` |
| `startedAt` | When the incident started (UTC, ISO 8601) |
| `resolvedAt` | When it was resolved; `null` while it is open |
| `impact` | What users experienced; shown when there is no note yet |
| `updates` | The notes, oldest first; the newest note is shown on the page |

After changing the notes, re-render the page and commit both files:

```bash
node scripts/status-page.mjs render
git add docs/status/incidents.json docs/status/index.html
```

The test `the committed status page matches the committed status data` fails
when the page and the notes drift apart, so the documentation build and the CI
catch a forgotten render.

An incident is open while its `status` is not `resolved`. The page shows every
open incident, the newest five resolved ones, and the note of the open
incident that belongs to a service that is currently degraded or in an
outage. While an incident is open the page keeps showing it even if the
service recovered, so users can read what happened.

## Availability history

The page shows one bar per day for the last 30 days. A day keeps the worst
status seen on it, so a short outage stays visible after the service recovers.
A day without a health check is grey: no data is better than no data at all.

## Related documents

- [OPERATIONS.md](OPERATIONS.md) — health endpoints, metrics and alerting
- [RUNBOOK.md](RUNBOOK.md) — what to do when a check fails
- [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md) — severity levels and communication
