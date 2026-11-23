# Analytics API Reference

This page is the reference for the analytics HTTP API — the endpoints, query parameters, response shapes, and error format — and for the payload schemas of every event the indexer stores. It complements two other documents:

- [ARCHITECTURE.md §13 — Indexer & Analytics Architecture](ARCHITECTURE.md#13-indexer--analytics-architecture) explains how events become the records this API serves (data flow, datastore schema, checkpointing).
- [CONTRACT_API.md](CONTRACT_API.md) is the reference for the contract functions and topics that produce these events in the first place; this page cross-references it wherever an event is also documented there.

**Status:** The Rust service in [`analytics-api/`](../analytics-api/README.md) implements `GET /proposals`, `GET /proposals/:id`, and `GET /spend/by-category` against its PostgreSQL datastore. The current reference indexer (`scripts/indexer.js`) writes a JSON file rather than these PostgreSQL tables, so a database ingestion adapter is still needed to connect those components. The remaining analytics endpoints below are specified by the frontend's client and types (`frontend/src/lib/analyticsClient.ts`, `frontend/src/types/accord.ts`) but do not yet have a backend implementation — see [frontend/docs/analytics-data-layer.md](../frontend/docs/analytics-data-layer.md) for the integration status. `POST /graphql` ([GraphQL](#graphql)) exposes proposals, owners, spends, and treasury flows with pagination, filtering, and query-cost limits. `GET /proposals/funnel` reports proposal conversion rates by category or owner. `GET /treasury/kpis` serves daily treasury KPI snapshots with period-over-period deltas for balance, spend and runway. `GET /freshness` reports ingestion lag, report freshness and API latency against their SLOs. `GET /reports`, `POST /reports/run` and `/report-templates` serve the scheduled treasury reports and their [branded templates](#branded-report-templates); `GET /alerts` and `GET /alerts/rules` serve the alerting engine. `/health` is a database-backed readiness check; the service root returns its name and status. `GET /livez`, `GET /readyz`, and `GET /metrics` provide liveness, readiness, and Prometheus metrics for operators. `GET /status` reports every dependency separately (`database`, `ingestion`) with an overall `operational`, `degraded` or `outage` verdict for the [public status page](STATUS.md).

---

## Conventions

- **Base URL** — set by `VITE_API_BASE_URL` on the frontend; requests are same-origin (relative paths) when unset.
- **Method** — every data endpoint is `GET`, except `POST /reports/run`, `POST /graphql` and the `PUT`/`DELETE` writes on `/report-templates` and the writes on `/alert-rules`. Any other method returns `405 METHOD_NOT_ALLOWED`.
- **OpenAPI** — the machine-readable contract is [analytics-api.openapi.json](analytics-api.openapi.json) (see [OpenAPI specification](#openapi-specification)).
- **Rate limits and caching** — every endpoint except the probes and `/metrics` is rate limited per client and the heavy reads are cached; see [Rate limiting and caching](#rate-limiting-and-caching).
- **Amounts** — token amounts are decimal token-unit strings (for example `"1500.0000000"`), never JSON numbers and never raw stroops. See [ARCHITECTURE.md §9 — Token Handling](ARCHITECTURE.md#9-token-handling).
- **Timestamps** — ISO 8601, UTC. Query date bounds (`startDate`, `endDate`) are inclusive and accept either a date (`2026-09-01`) or a date-time.
- **Category shares** — `share` fields are percentage points in the range 0–100, not fractions.
- **Undefined vs. empty** — omitted and empty-string query values are treated as "not set"; `0` and `false` are preserved.
- **Pagination** — `limit`/`offset` paginate list endpoints; see [Standardized Query Parameters](#standardized-query-parameters) for bounds and defaults.

## Standardized Query Parameters

All analytics endpoints share one parsing and validation pass (`parseAndValidateAnalyticsQuery` in `frontend/src/lib/analyticsApi.ts`). Not every parameter applies to every endpoint — see each endpoint section for which ones it reads.

| Parameter | Type | Default | Constraints / allowed values | Description |
| --- | --- | --- | --- | --- |
| `limit` | integer | `20` | `1`–`100` | Items per page. |
| `offset` | integer | `0` | `≥ 0` | Page offset index. |
| `sort` | string | `createdAt` | `deadline`, `amount`, `createdAt` | Sort field for proposal lists. |
| `order` | string | `desc` | `asc`, `desc` | Sort direction. |
| `category` | string | none | `all`, `Transfer`, `Payroll`, `Grant`, `Ops`, `Other` | Filter by proposal category. |
| `status` | string | none | `all`, `pending`, `ready`, `executed`, `expired`, `revoked` | Filter by proposal status. |
| `owner` | string | none | address or substring | Filter by proposer/owner address. |
| `token` | string | none | token symbol (`XLM`, `USDC`, …) | Filter by token. |
| `startDate` | string | none | ISO 8601 date/date-time | Inclusive lower bound. |
| `endDate` | string | none | ISO 8601 date/date-time, `≥ startDate` | Inclusive upper bound. |
| `granularity` | string | none | `day`, `week`, `month` | Bucket size for time-series endpoints. |
| `timeSeries` | boolean | none | `true`, `false` | Include historical time-series datapoints where supported. |
| `contractId` | string | every configured contract | a value from `CONTRACT_IDS` | Narrow the response to one indexed contract. |
| `network` | string | every configured network | a value from `NETWORKS` | Narrow the response to one network. |

## OpenAPI specification

[`docs/analytics-api.openapi.json`](analytics-api.openapi.json) is an OpenAPI 3.0.3 description of every endpoint the Rust service serves, including each list endpoint's pagination, filter and sort parameters, their bounds and enumerations, and the error format. Import it into Swagger UI, Postman or a client generator.

It is held in sync with the implementation by tests that run in CI (`cargo test -p accord-analytics-api openapi`, and the whole `analytics-api` suite):

- every route registered in `analytics-api/src/main.rs` is documented, and every documented route exists;
- the documented query parameters of each endpoint equal the parameters its validator accepts, and the documented enumerations (`sort`, `order`, `status`, `category`, `format`, `severity`) equal the values it accepts;
- each parameter lists an `x-invalid-example` and the `x-error-code` the API must answer it with; the contract tests send those requests and fail if the status, error code or field differs.

When you add or change an endpoint or parameter, update the spec in the same pull request or the suite fails. The contract tests in `analytics-api/src/contract_tests.rs` also pin pagination (defaults, bounds, stable paging, total), every filter, and sort order in both directions against seeded data.

## Rate limiting and caching

Every endpoint except `/`, `/health`, `/livez`, `/readyz`, `/status` and `/metrics` is limited **per client** with a fixed window. The client is the socket peer address, or the first `X-Forwarded-For` entry when `RATE_LIMIT_TRUST_PROXY=true` (set it only behind a proxy that overwrites that header). Allowed responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (seconds). A client over its quota gets `429` with a `Retry-After` header and the standard error body:

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Rate limit of 120 requests exceeded; retry in 42 seconds",
    "details": [{ "field": "retryAfterSeconds", "message": "42", "code": "RATE_LIMITED" }]
  }
}
```

Successful `GET /proposals`, `GET /proposals/:id`, `GET /proposals/funnel`, `GET /spend/by-category`, `GET /treasury/kpis` responses are cached in memory for a short window. Equal queries share an entry regardless of parameter order, only `200` responses are stored, and the response carries `X-Cache: HIT` or `MISS`. The cache is bounded and evicts the oldest entry when full. **It is cleared as soon as the indexer writes new events**: a watcher compares the newest indexed ledger every `ALERT_POLL_SECS` (default 15) seconds and drops the cache when it moves, so a cached answer is never older than the data or the TTL, whichever is shorter. The quota applies to cache hits too.

| Variable | Default | Meaning |
| --- | --- | --- |
| `RATE_LIMIT_REQUESTS` | `120` | Requests per client per window; `0` turns rate limiting off. |
| `RATE_LIMIT_WINDOW_SECS` | `60` | Window length. |
| `RATE_LIMIT_TRUST_PROXY` | `false` | Identify clients by `X-Forwarded-For`. |
| `CACHE_TTL_SECS` | `30` | Freshness of a cached read; `0` turns the cache off. |
| `CACHE_MAX_ENTRIES` | `500` | Cache size bound. |

Prometheus metrics at `/metrics`: `accord_api_rate_limit_requests_total{outcome="allowed|limited"}`, `accord_api_cache_requests_total{result="hit|miss"}`, `accord_api_cache_invalidations_total{cause="events"}` and the gauge `accord_api_cache_entries`.

## Error Response Format

Every endpoint uses one error shape for invalid input and request errors:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid query parameters",
    "details": [
      {
        "field": "limit",
        "message": "Limit must be an integer between 1 and 100",
        "code": "INVALID_LIMIT"
      }
    ]
  }
}
```

`details` is omitted when there's nothing more specific to report than `message`.

**Status codes and error codes:**

| HTTP status | `error.code` | Meaning |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | One or more query parameters failed validation (see `details`). |
| 400 | `INVALID_PARAMETER` | A parameter's format or value is malformed outside the standard validation pass (for example, a malformed proposal ID in a path segment). |
| 404 | `NOT_FOUND` | The endpoint or the requested resource (for example, a proposal ID) doesn't exist. |
| 405 | `METHOD_NOT_ALLOWED` | A non-`GET` method was used. |
| 500 | `INTERNAL_ERROR` | The server failed while fetching or processing data. |

**Validation detail codes:** `INVALID_LIMIT`, `INVALID_OFFSET`, `INVALID_SORT`, `INVALID_ORDER`, `INVALID_STATUS`, `INVALID_CATEGORY`, `INVALID_DATE`, `INVALID_DATE_RANGE`, `UNKNOWN_PARAMETER`, `INVALID_CONTRACT_ID` (a contract this deployment does not serve), `INVALID_NETWORK` (a network this deployment does not serve), `INVALID_FORMAT` (a report format other than `csv` or `pdf`), and `INVALID_PERIOD_DAYS`.

The frontend's `AnalyticsApiError` (`frontend/src/lib/analyticsClient.ts`) carries the HTTP status, the parsed body, and the server's `error.message` where available; network and abort errors propagate instead of being wrapped.

---

## Endpoints

### `GET /proposals`

Paginated proposal list, filterable the same way the dashboard filters proposals.

**Query parameters:** `limit`, `offset`, `sort`, `order`, `category`, `status`, `owner`, `token`, `startDate`, `endDate` (see [Standardized Query Parameters](#standardized-query-parameters)).

`owner` filters by proposer substring. `startDate` and `endDate` filter by proposal creation time; date-only values include the full end date. The service scopes every query to the configured `CONTRACT_ID`.

**Response (`AnalyticsProposalPage`):**

```json
{
  "proposals": [
    {
      "id": 42,
      "kind": "transfer",
      "to": "GABC...RECIPIENT",
      "amount": "500.0000000",
      "token": "USDC",
      "description": "Q3 contractor payment",
      "approvals": 3,
      "threshold": 3,
      "status": "executed",
      "deadline": "2026-09-30T00:00:00Z",
      "deadlineTs": 1790812800,
      "createdAt": "2026-09-01T12:00:00Z",
      "proposer": "GABC...PROPOSER",
      "userHasApproved": true,
      "approverAddresses": ["GABC...A", "GABC...B", "GABC...C"],
      "category": "Payroll",
      "executedAt": "2026-09-02T08:15:00Z"
    }
  ],
  "total": 128,
  "limit": 20,
  "offset": 0
}
```

Each proposal follows the full `Proposal` shape in `frontend/src/types/accord.ts`, including the weighted-governance fields (`quorumWeight`, `approvalWeight`, `totalWeight`, `approverWeights`) when the contract has migrated to weighted governance.

### `GET /proposals/:id`

A single proposal plus its full event timeline.

**Query parameters:** none.

**Response (`AnalyticsProposalDetail`):**

```json
{
  "proposal": { "id": 42, "kind": "transfer", "...": "as above" },
  "timeline": [
    { "type": "approved", "actor": "GABC...A", "timestamp": "2026-09-01T12:05:00Z", "ledger": 1000042 },
    { "type": "approved", "actor": "GABC...B", "timestamp": "2026-09-01T14:20:00Z", "ledger": 1000091 },
    { "type": "executed", "actor": "GABC...C", "timestamp": "2026-09-02T08:15:00Z", "ledger": 1000210 }
  ]
}
```

`timeline` entries follow `ProposalEvent` (`frontend/src/types/accord.ts`) — see [Event Payload Schemas](#event-payload-schemas) for how each `type` maps back to a contract-emitted event. Returns `404 NOT_FOUND` if no proposal with that ID has been indexed.
Timeline records are ordered by ledger sequence and event index, oldest first.

### `GET /proposals/funnel`

Proposal funnel and conversion analytics: how many proposals created in a period went on to be approved and executed, and how many left the funnel through cancellation or expiry, grouped by category or by proposing owner.

**Query parameters:** `groupBy` (`category` by default, or `owner`), `category`, `owner`, `token`, `startDate`, `endDate`, `limit`, `offset`, `contractId`, `network` (see [Standardized Query Parameters](#standardized-query-parameters)). `limit` and `offset` page through the *groups*; `startDate`/`endDate` bound the proposals' creation time, so every row is a cohort ("proposals created in this window"). Unknown parameters, an unsupported `groupBy`, an unknown `category` and the other usual validation failures are all reported together in one `400 VALIDATION_ERROR`; `groupBy` failures use the code `INVALID_GROUP_BY`.

**Response (`ProposalFunnelPage`):**

```json
{
  "groupBy": "category",
  "items": [
    {
      "key": "Payroll",
      "created": 10,
      "approved": 8,
      "executed": 6,
      "cancelled": 1,
      "expired": 1,
      "open": 2,
      "approvalRate": 80.0,
      "executionRate": 60.0,
      "cancellationRate": 10.0,
      "approvalToExecutionRate": 75.0,
      "avgSecondsToExecute": 43200
    }
  ],
  "totals": { "key": "all", "created": 10, "approved": 8, "executed": 6, "cancelled": 1, "expired": 1, "open": 2, "approvalRate": 80.0, "executionRate": 60.0, "cancellationRate": 10.0, "approvalToExecutionRate": 75.0, "avgSecondsToExecute": 43200 },
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

- `created` is every proposal in the cohort. `executed`, `cancelled` (revoked), `expired` and `open` (still pending or ready) partition it, so they always add up to `created`.
- `approved` counts proposals that reached their approval threshold (status `ready` or `executed`, or `approvals >= threshold`), even if they were later revoked or expired, so `approved` is not a subset of any one status.
- Rates are percentages in the range 0–100 rounded to two places. `approvalRate`, `executionRate` and `cancellationRate` are fractions of `created`; `approvalToExecutionRate` is `executed / approved`. A rate with an empty denominator is `0`, never `NaN`.
- `avgSecondsToExecute` is the mean time from creation to execution, or `null` when nothing in the group was executed.
- `totals` covers every matching proposal regardless of paging; `total` is the number of groups. Rows are ordered by `created` descending, then by `key`, so pages tile exactly.
- Like `GET /proposals`, successful responses are cached and carry `X-Cache`, and every response carries the `X-RateLimit-*` headers.

### `GET /spend/by-category`

Spend aggregated by proposal category, over executed transfers only.

**Query parameters:** `token`, `startDate`, `endDate`.

**Response (`CategorySpendBucket[]`):**

```json
[
  { "category": "Payroll", "token": "USDC", "total": "12500.0000000", "count": 6, "share": 62.5 },
  { "category": "Grant", "token": "USDC", "total": "7500.0000000", "count": 2, "share": 37.5 }
]
```

`share` is the category's percentage of total spend for the same token within the filtered range (0–100).
The response includes all five categories (`Transfer`, `Payroll`, `Grant`, `Ops`, `Other`) for every matching token, using a zero total/count/share when there is no spend. If no token has been indexed yet, it returns zero rows for `XLM`; a requested token with no activity also receives zero rows. `startDate` and `endDate` filter by execution time, with date-only bounds inclusive of the whole day.

### `GET /spend/by-owner`

Spend aggregated by proposer/owner address, over executed transfers only.

**Query parameters:** `token`, `startDate`, `endDate`.

**Response (`OwnerSpendBucket[]`):**

```json
[
  { "owner": "GABC...PROPOSER", "token": "USDC", "total": "9000.0000000", "count": 4 }
]
```

### `GET /owners/participation`

Report owner response times, approval rates, and inactive-owner trends across proposals.

**Query parameters:** `limit`, `offset`, `startDate`, `endDate`, `contractId`, `network` (see [Standardized Query Parameters](#standardized-query-parameters)).

**Response (`OwnerParticipationPage`):**

```json
{
  "items": [
    {
      "owner": "GABC...OWNER",
      "network": "testnet",
      "contractId": "CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS",
      "totalProposals": 12,
      "approvedProposals": 10,
      "participationRate": 83.33,
      "avgLatencySeconds": 3600.5,
      "isInactive": false,
      "lastApprovedAt": "2026-11-19T08:30:00Z"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

### `GET /treasury/kpis`

Daily treasury KPI snapshots and period-over-period trend deltas for balance, spend and runway.

**Query parameters:** `token`, `periodDays` (1–365, default `30`), `endDate` (last day of the current period; defaults to today in UTC and later dates are clamped to today), `limit`, `offset`, `contractId`, `network` (see [Standardized Query Parameters](#standardized-query-parameters)). `limit` and `offset` page through the *daily snapshots* of the current period. Validation failures are reported together in one `400 VALIDATION_ERROR`; `periodDays` failures use the code `INVALID_PERIOD_DAYS`.

Two consecutive periods of `periodDays` days are compared: the **current** period ends on `endDate`, the **previous** one ends where the current one starts.

**Response (`TreasuryKpiPage`):**

```json
{
  "periodDays": 30,
  "currentPeriod": { "start": "2026-09-02", "end": "2026-10-01" },
  "previousPeriod": { "start": "2026-08-03", "end": "2026-09-01" },
  "trends": [
    {
      "token": "USDC",
      "balance": { "current": "600", "previous": "900", "delta": "-300", "deltaPercent": -33.33 },
      "spend": { "current": "300", "previous": "100", "delta": "200", "deltaPercent": 200.0 },
      "runway": { "currentDays": 60.0, "previousDays": null, "deltaDays": null }
    }
  ],
  "items": [
    {
      "network": "testnet", "contractId": "C...", "token": "USDC", "date": "2026-10-01",
      "balance": "600", "inflow": "0", "spend": "0", "spendCount": 0,
      "netBurnRate": "10", "runwayDays": 60.0
    }
  ],
  "total": 30,
  "limit": 20,
  "offset": 0
}
```

- Snapshots are persisted in `treasury_kpi_snapshots`, one row per network, contract, token and day. Each request recomputes the snapshots for the window it needs with an upsert, so repeating a request, replaying the indexer or indexing a late event never duplicates or drifts a row.
- `balance` is the cumulative deposits (`deposit` events) minus transfers up to and including the day, so it is only an absolute balance once deposits are indexed. `spend` is what was transferred out on the day; `netBurnRate` is the trailing 30-day average of `spend - inflow` per day; `runwayDays` is `balance / netBurnRate`, or `null` when the treasury is not burning or has no positive balance.
- `trends` has one entry per token across the requested scope. `balance` and `runway` are read at the last day of each period; `spend` is summed over each period. `delta` is `current - previous`; `deltaPercent` is `null` when the previous value is zero.
- Items are ordered by date (newest first), then token, network and contract. Successful responses carry `Cache-Control: private, max-age=60`, `X-Cache` and the `X-RateLimit-*` headers.

### `GET /treasury/balance`

Current per-token treasury balance, with an optional historical time series.

**Query parameters:** `token`, `timeSeries`, `granularity` (bucket size when `timeSeries=true`).

**Response (`TreasuryBalance`):**

```json
{
  "balances": { "XLM": "84200.0000000", "USDC": "15300.0000000" },
  "timeSeries": [
    { "timestamp": "2026-09-01T00:00:00Z", "values": { "XLM": "90000.0000000", "USDC": "18000.0000000" } },
    { "timestamp": "2026-09-08T00:00:00Z", "values": { "XLM": "84200.0000000", "USDC": "15300.0000000" } }
  ]
}
```

`timeSeries` is omitted when `timeSeries=false` or unset.

### `GET /treasury/flow`

Inflow and outflow per token, bucketed by `granularity`.

**Query parameters:** `token`, `startDate`, `endDate`, `granularity` (default bucketing is implementation-defined when omitted).

**Response (`TreasuryFlowBucket[]`):**

```json
[
  { "timestamp": "2026-09-01T00:00:00Z", "token": "USDC", "inflow": "5000.0000000", "outflow": "2000.0000000" },
  { "timestamp": "2026-09-08T00:00:00Z", "token": "USDC", "inflow": "0.0000000", "outflow": "4500.0000000" }
]
```

`inflow` is deposits observed at the contract address (§10 — Token Deposit Flow); `outflow` is executed transfers and recurring disbursements out of the contract.

### `GET /stats/summary`

The dashboard stat-card rollup in a single response. This is the one endpoint with a reference implementation (`handleGetStatsSummary` in `frontend/src/lib/analyticsApi.ts`).

**Query parameters:**

- `startDate` (optional) — filter executed transfers starting from this ISO date.
- `endDate` (optional) — filter executed transfers up to this ISO date.
- `token` (optional) — filter disbursements and largest outflow to a specific token.

**Response (`TreasurySummary`):**

```json
{
  "totalDisbursed": {
    "XLM": "2000.0000000",
    "USDC": "500.0000000"
  },
  "activeProposals": 3,
  "ownerCount": 4,
  "largestOutflow": {
    "token": "XLM",
    "amount": "1500.0000000"
  }
}
```

- `totalDisbursed` — map of token to total disbursed by executed transfers within the date range.
- `activeProposals` — count of proposals in `pending` or `ready` status. Not affected by `startDate`/`endDate`/`token`.
- `ownerCount` — total count of multisig owners.
- `largestOutflow` — the single executed transfer with the highest amount within the range, or `null` if none.

## Data freshness and SLA

### `GET /freshness`

How fresh the analytics data is, judged against service level objectives. For every network and contract in scope it reports **ingestion lag** (the age of the indexer's checkpoint) and **report freshness** (the age of the last generated or delivered treasury report; a failed run does not count), and it reports the **API's own latency**.

**Query parameters:** `limit`, `offset` (they page through the network and contract pairs), `contractId`, `network`. Validation and errors are as for the other endpoints. The response is live health, so it is not cached; it is rate limited like the other endpoints.

```json
{
  "generatedAt": "2026-11-19T12:00:00Z",
  "slo": { "ingestionLagSeconds": 120, "apiP95Ms": 500, "reportMaxAgeSeconds": 2764800 },
  "status": "ok",
  "api": { "requests": 1840, "p50Ms": 10, "p95Ms": 100, "status": "ok" },
  "items": [
    {
      "network": "testnet",
      "contractId": "CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS",
      "lastLedger": 4242,
      "lastCheckpointAt": "2026-11-19T11:59:50Z",
      "ingestionLagSeconds": 10,
      "ingestionStatus": "ok",
      "lastReportAt": "2026-11-01T06:00:02Z",
      "reportAgeSeconds": 1555198,
      "reportStatus": "ok",
      "status": "ok"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

- A status is `ok` (within its objective), `breach` or `unknown` (nothing to judge yet: no checkpoint, no report, no requests). An item's `status` is the worse of its two; the top-level `status` is the worst across the API and **every** pair in scope, not just the page returned. A breach outranks unknown.
- `api` covers every route except the probes, `/metrics` and `/freshness`, since the process started. Percentiles are latency-histogram bucket upper bounds, so they never understate latency.
- Objectives come from the environment: `SLO_INGESTION_LAG_SECS` (default `120`), `SLO_API_P95_MS` (default `500`) and `SLO_REPORT_MAX_AGE_SECS` (default 32 days). A missing or invalid value uses the default.
- The dashboard's *Data freshness* page (`/app/freshness`) shows this endpoint.

## Branded report templates

Scheduled and manual treasury reports (`REPORT_SCHEDULE`, `POST /reports/run`) render the same default layout for everyone until a workspace customises it. A **workspace** is one network + contract pair and has at most one template; a pair without one keeps the default layout, so existing deployments are unaffected.

A template controls what a workspace's CSV, PDF and delivery email look like:

| Field | Type | Limits | Effect |
| --- | --- | --- | --- |
| `brandName` | string | ≤ 80 chars | Brand line above the title (PDF, CSV `brand` row, email). |
| `title` | string | ≤ 120 chars | Replaces the default title (also the email subject). May use `{network}`, `{contract}` and `{period}`; other `{…}` placeholders are rejected. |
| `headerText` | string | ≤ 500 chars | One line under the title. |
| `footerText` | string | ≤ 500 chars | Printed at the bottom of every PDF page and at the end of the CSV and email. |
| `logoUrl` | string | `https://` URL, ≤ 2048 chars | The workspace logo, **referenced** in the PDF header, the CSV `logo` row and the email. It is not embedded as an image and the service never fetches it. |
| `accentColor` | string | `#rrggbb` | Colour of the PDF brand and title. |
| `sections` | string[] | non-empty, unique | Which blocks to include, in order: `summary`, `token_totals`, `category_totals`, `transactions`. Defaults to all four. |

Text fields are trimmed, an empty string means "not set", and they must be a single line without control characters, so a template can never inject extra email headers or CSV rows. In the CSV, template text that begins with `=`, `+`, `-` or `@` is prefixed with `'` so a spreadsheet does not run it as a formula. With a template the CSV starts with `brand`/`title`/`header`/`logo` identity rows, then each chosen section as its own block in the template's order, then a `footer` row. In the PDF the summary blocks (`summary`, `token_totals`, `category_totals`) follow the template's order and the transaction rows always follow them.

### `GET /report-templates`

**Query parameters:** `limit`, `offset`, `contractId`, `network`.

**Response (`ReportTemplatePage`):**

```json
{
  "items": [
    {
      "id": 1,
      "network": "testnet",
      "contractId": "CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS",
      "brandName": "Acme Treasury",
      "title": "{network} statement, {period}",
      "headerText": "Confidential",
      "footerText": "Acme Inc.",
      "logoUrl": "https://cdn.example.com/logo.png",
      "accentColor": "#1a73e8",
      "sections": ["summary", "transactions"],
      "createdAt": "2026-11-19T08:30:00Z",
      "updatedAt": "2026-11-19T08:30:00Z"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

Templates are ordered by network and contract. This endpoint is rate limited like the others but **not cached**, so an edit shows on the next read.

### `PUT /report-templates`

Creates or replaces a workspace's template. **Query parameters:** `contractId` and `network` name the workspace; each is required when the deployment serves more than one (otherwise it defaults to the only one) and `400 MISSING_PARAMETER` says which is missing. The JSON body (≤ 16 KiB) holds the fields above. A `PUT` replaces the whole template, so a field you leave out returns to its default. Returns `200` with the stored template.

Validation reports every problem at once as `400 VALIDATION_ERROR`, with one detail per field: `INVALID_BODY` (malformed JSON, an unknown field or a wrong type), `INVALID_TEMPLATE_FIELD`, `INVALID_LOGO_URL`, `INVALID_COLOR` or `INVALID_SECTION`. A body over 16 KiB gets `413`.

### `DELETE /report-templates`

Removes the workspace's template so its reports return to the default layout. Same query parameters as `PUT`. Returns `204`, or `404 NOT_FOUND` when the workspace has no template.

### Securing the writes

Reads are open like every other endpoint. When `ADMIN_TOKEN` is set, `PUT` and `DELETE /report-templates` require `Authorization: Bearer <ADMIN_TOKEN>` and otherwise answer `401 UNAUTHORIZED`. With `ADMIN_TOKEN` unset the writes are as open as `POST /reports/run`, so set it on any deployment reachable beyond a trusted network.

## Alerting

The analytics API watches indexed data and raises alerts for **spend over a threshold** and **unusual approval patterns**. Rules come from two places: the deployment configuration, `ALERT_RULES` (inline JSON) or `ALERT_RULES_FILE` (a path to a JSON file), a JSON array of rules; and the rules created, edited, paused and tested through the [alert rule management](#alert-rule-management) API, which the dashboard's alert rules page uses. With neither, alerting is idle: no rule is evaluated and no alert is raised.

```json
[
  { "id": "large-usdc-spend", "type": "spend_threshold", "token": "USDC",
    "threshold": "50000000000", "windowSecs": 86400, "severity": "critical" },
  { "id": "approval-burst", "type": "approval_burst",
    "maxApprovals": 5, "windowSecs": 600, "cooldownSecs": 3600 },
  { "id": "night-approvals", "type": "off_hours_approval",
    "startHour": 22, "endHour": 5, "severity": "info" }
]
```

| Rule `type` | Fires when | Fields |
| --- | --- | --- |
| `spend_threshold` | transfers out of the treasury total at least `threshold` (smallest token unit, as an integer string) within a rolling `windowSecs`; each token is tracked separately, `token` limits the rule to one | `token?`, `threshold`, `windowSecs` |
| `approval_burst` | one owner approves more than `maxApprovals` proposals within `windowSecs` | `maxApprovals`, `windowSecs` |
| `off_hours_approval` | an approval lands in the UTC hours `[startHour, endHour)` (wraps past midnight when `startHour > endHour`) | `startHour`, `endHour` |

Every rule also takes `id` (unique), `severity` (`info`, `warning` — the default — or `critical`) and an optional `cooldownSecs`. Invalid or unknown fields in the configuration stop the service at startup with an error naming the rule. `spend_threshold` is a *threshold* rule; `approval_burst` and `off_hours_approval` are *anomaly* rules.

**Evaluation.** A watcher polls the `transfers` and `proposal_approvals` tables every `ALERT_POLL_SECS` (default 15) seconds for rows past its saved cursor (`alert_cursors`), evaluates each against the rules in ledger order, and stores every alert in the `alerts` table. Windows and cooldowns use the *event* time, so replaying history behaves exactly like live indexing. The first time alerting runs it starts at the newest indexed ledger and does not replay old history; set `ALERT_BACKFILL=true` to evaluate it.

**Channels.** `ALERT_CHANNELS` (default `log`) is a comma-separated list: `log` writes the alert to the service log; `email` sends it through the same transport as scheduled reports (`SMTP_URL`, or `REPORT_OUTPUT_DIR` for a directory drop) to `ALERT_RECIPIENTS`. A channel that fails is recorded on the alert (`failedChannels`) and counted in `accord_api_alerts_total{outcome="delivery_failed"}`; it never blocks the other channels.

**Storm protection.**

- *Cooldown* — after a rule alerts for a subject (a token, or an owner) it stays quiet for that subject for `ALERT_COOLDOWN_SECS` (default `900`, or the rule's own `cooldownSecs`).
- *Storm cap* — at most `ALERT_MAX_PER_WINDOW` (default `20`) alerts are raised across all rules within `ALERT_STORM_WINDOW_SECS` (default `600`); further matches are suppressed until the window passes.
- *Dedupe* — each alert is stored under a key made of the rule, subject and triggering event, so reprocessing an event (a restart, a reindex) never notifies twice.

Suppressed matches are counted in `accord_api_alerts_total{outcome="suppressed"}`; raised alerts in `outcome="fired"`.

### `GET /alerts`

Raised alerts, newest first. **Query parameters:** `limit`, `offset`, `ruleId`, `severity` (`info`, `warning`, `critical`), `contractId`, `network`. Response: `{ "alerts": [...], "total": 3, "limit": 20, "offset": 0 }` where each alert has `id`, `ruleId`, `kind`, `severity`, `network`, `contractId`, `subject`, `message`, `details`, `firedAt`, `deliveredChannels` and `failedChannels`.

### `GET /alerts/rules`

The configured rules and storm settings (`enabled: false` with no rules when alerting is off).

### Alert rule management

Rules from `ALERT_RULES` are read-only (`source: "config"`). Operators can add *managed* rules (`source: "managed"`), which are stored in the `alert_rules` table and evaluated alongside the configured ones. A change takes effect immediately on the instance that received it, and the watcher reloads the stored rules every `ALERT_POLL_SECS`, so other instances follow. Editing a rule discards the samples and cooldowns counted under its old definition, so a new threshold never inherits old totals. A paused rule is kept but not evaluated. Up to 200 managed rules may exist.

A rule is the same object `ALERT_RULES` takes (see the table above), plus an optional `enabled`. The id is 1–64 letters, digits, `.`, `_` or `-` (`test` is reserved). A managed rule's `windowSecs` and `cooldownSecs` may not exceed 30 days. Rules are global, like configured ones: they apply to every contract and network the deployment serves.

| Endpoint | Purpose |
| --- | --- |
| `GET /alert-rules` | Configured and managed rules by id. **Query parameters:** `limit`, `offset`, `status` (`active`, `paused`), `type`, `category` (`threshold`, `anomaly`), `source` (`config`, `managed`), `severity`. Not cached. |
| `POST /alert-rules` | Create a rule: `201` with the rule, active unless `enabled` is `false`. `409 CONFLICT` when the id is taken by a managed *or configured* rule. |
| `GET /alert-rules/{id}` | One rule. `404` when unknown. |
| `PUT /alert-rules/{id}` | Replace a managed rule. `id` may be left out of the body (it must match the path if present); `enabled` keeps its value when left out. `404` when unknown. |
| `DELETE /alert-rules/{id}` | Delete a managed rule: `204`. Alerts it already raised are kept. |
| `POST /alert-rules/{id}/pause`, `POST /alert-rules/{id}/resume` | Stop or restart evaluating a managed rule; returns the rule. |
| `POST /alert-rules/test` | Dry-run the draft rule in the body (not stored). |
| `POST /alert-rules/{id}/test` | Dry-run a saved or configured rule. |

Changing or deleting a configured rule answers `409 CONFLICT`. Validation reports one detail per problem as `400 VALIDATION_ERROR`: `INVALID_RULE_ID`, `INVALID_RULE` (the `field` names the setting, such as `threshold` or `windowSecs`), `INVALID_BODY` (malformed JSON, an unknown field or a wrong type) and, on the test endpoints, `INVALID_LOOKBACK`; a body over 8 KiB gets `413`. The writes (`POST`, `PUT`, `DELETE`, pause, resume) require `Authorization: Bearer <ADMIN_TOKEN>` when `ADMIN_TOKEN` is set, as for [report templates](#securing-the-writes), and otherwise `401 UNAUTHORIZED`. The test endpoints change nothing and need no token.

**Testing a rule.** The test replays the indexed transfers and approvals of the last `lookbackHours` (1–168, default 24) for the scoped contracts (`contractId`, `network`) through a fresh engine holding only that rule, with the deployment's cooldown and storm settings. Nothing is stored and no channel is notified.

```json
{
  "ruleId": "large-usdc-spend",
  "lookbackHours": 24,
  "eventsEvaluated": 128,
  "truncated": false,
  "wouldFire": 2,
  "suppressed": 5,
  "alerts": [
    { "ruleId": "large-usdc-spend", "kind": "spend_threshold", "severity": "critical",
      "network": "testnet", "contractId": "CD4Y…", "subject": "USDC",
      "message": "Spend of 52000000000 USDC in the last 86400s reached the 50000000000 threshold on CD4Y… (testnet)",
      "details": { "total": "52000000000" }, "firedAt": "2026-11-19T08:30:00Z" }
  ]
}
```

`wouldFire` counts every alert the rule would have raised, `alerts` lists the first `limit` (1–100, default 20) oldest first, and `suppressed` counts matches held back by the cooldown or storm cap. `truncated` is `true` when a source had more than 20 000 events in the window and the test read only the oldest ones.

## GraphQL

`POST /graphql` serves the same indexed data as the REST endpoints through a single, flexible query surface, so a dashboard can request exactly the fields it needs without a new endpoint per view. Resolvers read the PostgreSQL datastore directly and are scoped to the configured `CONTRACT_ID`.

Send a standard GraphQL-over-HTTP request body:

```json
{ "query": "{ proposals(first: 5) { nodes { id status amount } } }", "variables": {} }
```

### Schema overview

| Query field | Returns | Source |
| --- | --- | --- |
| `proposals(first, after, filter, sort, order)` | `ProposalConnection` | `proposals` |
| `proposal(id)` | `Proposal` or `null` | `proposals` |
| `owners(first, after, filter)` | `OwnerConnection` (heaviest first) | latest row per owner in `owner_weight_changes` |
| `owner(address)` | `Owner` or `null` | `owner_weight_changes` |
| `spends(first, after, filter)` | `SpendConnection` (most recently executed first) | executed `transfer` proposals |
| `spendTotals(filter)` | `[SpendTotal]` grouped by token and category | executed `transfer` proposals |
| `treasuryFlows(first, after, filter)` | `TreasuryFlowConnection` (newest first) | `transfers` |

Nested fields: `Proposal.timeline` (the proposal's events, oldest first), `Proposal.proposerOwner` (the proposer's current `Owner` record), and `Owner.proposals` (a paginated, filterable `ProposalConnection`). Both `timeline` and `proposerOwner` are batched, so listing many proposals does not issue a query per proposal. `status` and `category` are enums (`PENDING`, `READY`, `EXECUTED`, `EXPIRED`, `REVOKED`; `TRANSFER`, `PAYROLL`, `GRANT`, `OPS`, `OTHER`). Amounts are decimal strings and timestamps are ISO 8601 `DateTime` values, as in the REST API.

```graphql
query Dashboard($since: DateTime) {
  proposals(first: 10, filter: { status: EXECUTED, startDate: $since }, sort: AMOUNT, order: DESC) {
    nodes {
      id
      amount
      token
      category
      proposerOwner { address weight }
      timeline { type actor ledger }
    }
    pageInfo { hasNextPage endCursor }
    totalCount
  }
  spendTotals { token category total count }
  owners(first: 5) { nodes { address weight } }
  treasuryFlows(first: 5, filter: { token: "USDC" }) { nodes { amount ledger occurredAt } }
}
```

### Pagination

Every list field is a connection: `{ nodes, pageInfo { hasNextPage endCursor }, totalCount }`. `first` defaults to `20` and must be `1`–`100`. Pass the previous page's `pageInfo.endCursor` as `after` to fetch the next page. Cursors are opaque and only valid for the same filters and ordering. `totalCount` runs a separate count query, so it is only computed when selected.

### Filtering and ordering

| Field | Filter input | Keys |
| --- | --- | --- |
| `proposals`, `Owner.proposals` | `ProposalFilter` | `status`, `category`, `token`, `proposer` (substring), `startDate`/`endDate` (creation time) |
| `owners` | `OwnerFilter` | `address` (substring), `minWeight`, `includeRemoved` (default `false`) |
| `spends`, `spendTotals` | `SpendFilter` | `token`, `category`, `recipient` (substring), `startDate`/`endDate` (execution time) |
| `treasuryFlows` | `TreasuryFlowFilter` | `token`, `recipient` (substring), `proposalId`, `scheduleId`, `startDate`/`endDate` |

`proposals` also accepts `sort` (`CREATED_AT` default, `DEADLINE`, `AMOUNT`) and `order` (`DESC` default, `ASC`). Substring filters are case-insensitive and match `%`, `_`, and `\` literally.

### Query limits

Expensive queries are bounded before any resolver runs.

| Limit | Default | Environment variable | Behavior when exceeded |
| --- | --- | --- | --- |
| Query depth | `6` | `GRAPHQL_MAX_DEPTH` | `400`, error `Query is nested too deep.` |
| Query complexity | `500` | `GRAPHQL_MAX_COMPLEXITY` | `400`, error `Query is too complex.` |
| Page size (`first`) | `100` | — | `200`, error code `PAGE_SIZE_EXCEEDED` |
| Execution time | `10000` ms | `GRAPHQL_TIMEOUT_MS` | `504`, error code `TIMEOUT` |
| Request body | 64 KiB | — | `413` |
| Batched requests | unsupported | — | `400`, a JSON array body is refused |
| Introspection | enabled | `GRAPHQL_INTROSPECTION` (`false` disables) | introspection fields resolve to `null` |

Each field costs `1`; a connection or list field multiplies the cost of its selection by `first` (default `20`), and `timeline` and `spendTotals` assume `20` and `25` items. Nested connections therefore multiply, which is what stops a request such as "100 proposals, each with 100 owner proposals". Select fewer fields, lower `first`, or raise `GRAPHQL_MAX_COMPLEXITY` for trusted deployments.

### GraphQL errors

Resolver errors use the standard GraphQL `errors` array with a machine-readable `extensions.code`:

```json
{ "data": null, "errors": [{ "message": "`first` must be between 1 and 100", "path": ["proposals"], "extensions": { "code": "PAGE_SIZE_EXCEEDED" } }] }
```

| `extensions.code` | Meaning |
| --- | --- |
| `PAGE_SIZE_EXCEEDED` | `first` is outside `1`–`100`. |
| `INVALID_CURSOR` | `after` was not produced by this API. |
| `INTERNAL_ERROR` | A datastore query failed; details are logged server-side only. |
| `BAD_REQUEST` / `TIMEOUT` | Malformed or batched request body / execution time limit (HTTP-level error body with the same `errors` shape). |

Rejected requests are counted in `accord_api_graphql_rejections_total`.

---

## Webhooks

Consumers that would rather be pushed new events than poll can subscribe to signed webhooks. The webhook service runs in the **indexer** (`indexer/src/webhooks.js`), because that is where events enter the store; the analytics API itself serves pull queries. Subscription configuration, the delivery payload, retry/backoff settings and the dead-letter workflow are documented in the [indexer README](../indexer/README.md#webhooks).

Receivers verify each delivery with the `X-Accord-Signature` header, `t=<unix seconds>,v1=<hex>`, where `v1 = HMAC_SHA256(secret, "<t>." + rawBody)`:

1. Use the raw request body, not a re-serialized one.
2. Reject if `|now - t|` is over your tolerance (300 seconds recommended); retries are re-signed with a fresh `t`.
3. Compare in constant time against every `v1` in the header (more than one is sent only during secret rotation).
4. De-duplicate on `X-Accord-Event-Id`: delivery is at least once.

Failures retry with exponential backoff and jitter, then move to a dead-letter queue visible at the indexer's `GET /webhooks/deliveries?status=dead`.

## Event Payload Schemas

The indexer decodes and stores every event the Accord contract emits (`contracts/accord/src/lib.rs`); this table gives each event's fields and types. See [ARCHITECTURE.md §13.4](ARCHITECTURE.md#134-event-type-to-storage-mapping) for which datastore table(s) each event feeds, and [CONTRACT_API.md — Event Payloads](CONTRACT_API.md#event-payloads) for the subset (`ProposalCreatedEvent`, `ProposalApprovedEvent`, `ProposalRevokedEvent`, `ProposalExecutedEvent`, `OwnerWeightChangedEvent`, `RecurringPaymentCreatedEvent`, `RecurringPaymentDisbursedEvent`, `RecurringPaymentCancelledEvent`) that also has a full topics/XDR breakdown there.

### Proposal lifecycle

| Topic | Struct | Fields |
| --- | --- | --- |
| `created` | `ProposalCreatedEvent` | `id: u64`, `proposer: Address`, `threshold: u32`, `category: ProposalCategory`, `transfers: Vec<Transfer>` (`{ to, token, amount: i128 }` each), `quorum_weight: u32`, `total_weight_at_creation: u32` |
| `approved` | `ProposalApprovedEvent` | `id: u64`, `approver: Address`, `approvals: u32`, `threshold: u32`, `weight: u32`, `cumulative_weight: u32` |
| `revoked` | `ProposalRevokedEvent` | `id: u64`, `approver: Address`, `approvals: u32`, `weight: u32`, `cumulative_weight: u32` |
| `executed` | `ProposalExecutedEvent` | `id: u64`, `executor: Address` |
| `p_canc` | `ProposalCancelledEvent` | `id: u64`, `proposer: Address` |
| `exp_sw` | `ExpiredProposalsSweptEvent` | `swept: u32` |

### Governance and ownership

| Topic | Struct | Fields |
| --- | --- | --- |
| `a_own` | `AddOwnerExecutedEvent` | `new_owner: Address`, `owner_count: u32` |
| `r_own` | `RemoveOwnerExecutedEvent` | `removed_owner: Address`, `owner_count: u32` |
| `c_thr` | `ChangeThresholdExecutedEvent` | `previous_threshold: u32`, `new_threshold: u32` |
| `s_lim` | `SetSpendingLimitExecutedEvent` | `owner: Address`, `token: Address`, `previous_limit: Option<i128>`, `new_limit: i128` |
| `c_wgt` | `OwnerWeightChangedEvent` | `owner: Address`, `old_weight: u32`, `new_weight: u32`, `new_total_weight: u32` |
| `migrated` | `GovernanceMigratedEvent` | `owner_count: u32`, `total_weight: u32` |

### RBAC

| Topic | Struct | Fields |
| --- | --- | --- |
| `rbac_migrated` | `RbacMigratedEvent` | `owner_count: u32`, `role_version: u32` |
| `role_granted` | `RoleGrantedEvent` | `target: Address`, `role: Role`, `before: Vec<Role>`, `after: Vec<Role>` |
| `role_revoked` | `RoleRevokedEvent` | `target: Address`, `role: Role`, `before: Vec<Role>`, `after: Vec<Role>` |

### Recurring payments

| Topic | Struct | Fields |
| --- | --- | --- |
| `r_crt` | `RecurringPaymentCreatedEvent` | `id: u64`, `proposer: Address`, `recipient: Address`, `token: Address`, `amount: i128`, `interval_secs: u64`, `start_time: u64`, `end_time: u64`, `cliff_time: u64`, `total_cap: i128`, `kind: RecurringKind` |
| `rpay` | `RecurringPaymentDisbursedEvent` | `schedule_id: u64`, `recipient: Address`, `token: Address`, `amount: i128`, `total_disbursed: i128`, `periods_disbursed: u32` |
| `str_clm` | `RecurringStreamClaimedEvent` | `schedule_id: u64`, `recipient: Address`, `token: Address`, `amount: i128`, `total_disbursed: i128` |
| `r_pause` | `RecurringPaymentPausedEvent` | `id: u64`, `caller: Address` |
| `r_resum` | `RecurringPaymentResumedEvent` | `id: u64`, `caller: Address` |
| `r_mod` | `RecurringPaymentModifiedEvent` | `schedule_id: u64`, `previous_amount: i128`, `new_amount: i128`, `previous_interval: u64`, `new_interval: u64`, `previous_end_time: u64`, `new_end_time: u64` |
| `r_cncl` | `RecurringPaymentCancelledEvent` | `id: u64`, `caller: Address` |

### Guardian and emergency pause

| Topic | Struct | Fields |
| --- | --- | --- |
| `guard_set` | `GuardianSetEvent` | `guardian: Address` |
| `frozen` | `FrozenEvent` | `guardian: Address` |
| `unfrozen` | `UnfrozenEvent` | `approvers: Vec<Address>` |
| `upgraded` | `UpgradeExecutedEvent` | `caller: Address`, `new_wasm_hash: BytesN<32>` |

Every topic is preceded by the contract address, which Soroban attaches implicitly as the first topic-array element (see [ARCHITECTURE.md §7 — Event Schema](ARCHITECTURE.md#7-event-schema)).

---

## Related documents

| Document | Description |
| --- | --- |
| [ARCHITECTURE.md §13](ARCHITECTURE.md#13-indexer--analytics-architecture) | Indexer data flow, datastore schema, checkpointing |
| [CONTRACT_API.md](CONTRACT_API.md) | Contract function and event reference |
| [guides/treasury-analytics.md](guides/treasury-analytics.md) | End-user guide to the analytics page |
| [RECONCILIATION_RUNBOOK.md](RECONCILIATION_RUNBOOK.md) | Responding to drift between the chain and the indexed view |
| [GLOSSARY.md](GLOSSARY.md) | Definitions for indexer and analytics terms |
| [analytics-api.openapi.json](analytics-api.openapi.json) | OpenAPI 3.0.3 specification of the analytics HTTP API |
| [frontend/docs/analytics-data-layer.md](../frontend/docs/analytics-data-layer.md) | Frontend client integration notes and current implementation status |
