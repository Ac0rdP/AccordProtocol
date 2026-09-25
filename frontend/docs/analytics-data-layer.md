# Analytics data layer

Import `analyticsClient` from `src/lib/analyticsClient.ts` or use
`useTreasuryAnalytics(query, intervalMs)` from `src/hooks/useTreasuryAnalytics.ts`.
Set `VITE_API_BASE_URL` to the analytics service URL; the default is same-origin.

The backend routes in upstream issues #648–#655 are not implemented on main yet.
The types in `src/types/accord.ts` define the frontend integration contract below,
based on those endpoint requirements. Verify the wire shapes with the backend
when it lands; live integration has not been tested. The existing proposal-based
analytics page stays usable independently of the API.

| Client method | GET path | Response type |
| --- | --- | --- |
| `getProposals` | `/proposals` | `AnalyticsProposalPage` |
| `getProposal(id)` | `/proposals/:id` | `AnalyticsProposalDetail` |
| `getSpendByCategory` | `/spend/by-category` | `CategorySpendBucket[]` |
| `getSpendByOwner` | `/spend/by-owner` | `OwnerSpendBucket[]` |
| `getBalance` | `/treasury/balance` | `TreasuryBalance` |
| `getFlow` | `/treasury/flow` | `TreasuryFlowBucket[]` |
| `getSummary` | `/stats/summary` | `TreasurySummary` |

Query keys use camelCase: `startDate`, `endDate`, `token`, `category`, `owner`,
`status`, `limit`, `offset`, `sort`, `order`, `granularity`, and `timeSeries`.
Date bounds are inclusive ISO dates/date-times. Granularity is `day`, `week`, or
`month`; sort is `deadline`, `amount`, or `createdAt`; order is `asc` or `desc`.
Undefined and empty values are omitted; zero and false are preserved. Each method
accepts an optional `AbortSignal`. HTTP errors throw `AnalyticsApiError` with
status, parsed body and the server message where available. Network and abort
errors propagate. JSON is parsed into the declared response type; this client
does not perform runtime schema validation.

Amounts are decimal token-unit strings, not JSON numbers or raw stroops.
Balance points have an ISO UTC timestamp and token-to-amount `values` map.
Spend rows keep token identifiers so consumers don't add unrelated currencies.
Category shares are percentage points (0–100). Summary totals are per token;
`largestOutflow` is null when no transfer exists. Flow rows carry an ISO UTC
bucket start, token, inflow and outflow. Empty arrays and zero amounts are valid.

```tsx
const { data, loading, error, refresh } = useTreasuryAnalytics(
  { startDate: "2026-09-01", token: "XLM", granularity: "day" },
  30_000,
);
```

The hook loads summary, balance history, both spend breakdowns and flow together.
It returns null data initially, a loading flag for each fetch, an error message,
and an awaitable manual refresh. Successful data is retained during a refresh
failure. Filter changes clear previous data and abort old requests. Equivalent
filter objects do not restart polling. Unmount aborts requests and clears timers.

Both this hook and `useEventPolling` use `startPolling`: fetch immediately, wait
for completion before scheduling another poll, double the delay after failure,
cap at 30 seconds (or the configured interval if longer), and reset after success
or manual refresh. Refresh shares an in-flight request. Event polling retries
ledger initialization and advances its checkpoint only after refresh succeeds.
Analytics polls the API directly so indexer lag doesn't require another RPC event.

Formatting helpers in `soroban.ts` are pure: `formatCurrency` preserves decimal
strings and accepts bigint base units (7 decimals by default for Stellar tokens),
`formatPercent` consumes percentage points, and `formatTimeSeriesLabel` /
`formatAnalyticsDate` render UTC dates. Numeric timestamps are Unix seconds.
Invalid values render an em dash. Currency output uses en-US grouping, at least
two fractional digits (limited by token precision), and rounds excess precision.

## Standardized query parameters (#655)

All analytics endpoints adhere to shared query parameter parsing and validation rules implemented in `src/lib/analyticsApi.ts`:

| Parameter | Type | Default | Constraints / Allowed values | Description |
| --- | --- | --- | --- | --- |
| `limit` | integer | `20` | `1` to `100` | Number of items per page. |
| `offset` | integer | `0` | `≥ 0` | Page offset index. |
| `sort` | string | `createdAt` | `deadline`, `amount`, `createdAt` | Sort criterion. |
| `order` | string | `desc` | `asc`, `desc` | Sort direction. |
| `category` | string | none | `all`, `Transfer`, `Payroll`, `Grant`, `Ops`, `Other` | Filter proposals by category. |
| `status` | string | none | `all`, `pending`, `ready`, `executed`, `expired`, `revoked` | Filter proposals by status. |
| `owner` | string | none | string (address or substring) | Filter by proposer/owner address. |
| `token` | string | none | string (e.g. `XLM`, `USDC`) | Filter by token symbol. |
| `startDate` | string | none | ISO 8601 date / date-time | Lower bound (inclusive). |
| `endDate` | string | none | ISO 8601 date / date-time | Upper bound (inclusive). Must be `≥ startDate`. |
| `granularity`| string | none | `day`, `week`, `month` | Bucket grouping interval. |
| `timeSeries` | boolean | none | `true`, `false` | Include historical time-series datapoints. |

## Error response format (#655)

Every analytics endpoint uses a uniform error response shape when handling invalid input or request errors:

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

Standard error codes:
- `VALIDATION_ERROR` (HTTP 400): One or more query parameters failed validation.
- `INVALID_PARAMETER` (HTTP 400): Parameter format or value is malformed.
- `NOT_FOUND` (HTTP 404): Endpoint or resource not found.
- `METHOD_NOT_ALLOWED` (HTTP 405): Method is not supported (endpoints are GET only).
- `INTERNAL_ERROR` (HTTP 500): Server error occurred while fetching or processing data.

## GET /stats/summary endpoint (#654)

Exposes treasury summary statistics matching the dashboard stat card requirements in a single response:

- **Path**: `GET /stats/summary`
- **Query parameters**:
  - `startDate` (optional): Filter executed transfers starting from this ISO date.
  - `endDate` (optional): Filter executed transfers up to this ISO date.
  - `token` (optional): Filter disbursements and largest outflow to a specific token.

### Response fields (`TreasurySummary`)

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

- `totalDisbursed`: Map of token identifiers to total amounts disbursed by executed transfers within the date range. Serialized as decimal token unit strings.
- `activeProposals`: Number of currently active proposals (`pending` or `ready`).
- `ownerCount`: Total count of multisig owners.
- `largestOutflow`: The single executed transfer proposal with the highest disbursed amount within the date range, or `null` if no transfers exist.


## Spend, balance and flow endpoints

Handlers live in `src/lib/analyticsApi.ts` and are routed by `handleAnalyticsRoute`.
They read from `AnalyticsContext`: `proposals`, plus optional `owners`, `deposits`
and `balanceSnapshots`. All accept the shared query parameters above.

- `GET /spend/by-owner` — executed transfer spend per owner and token, largest
  first. Owners in `context.owners` with no spend in range are returned with
  `total: "0"`, `count: 0`. Supports `startDate`, `endDate`, `token`, `category`, `owner`.
- `GET /treasury/balance` — latest per-token balances. `timeSeries=true` adds the
  snapshots in range (ascending). With `endDate`, the current balance is the latest
  snapshot on or before that day. Supports `token`.
- `GET /treasury/flow` — `inflow` (deposits) and `outflow` (executed transfers)
  per token per bucket. `granularity` is `day` (default), `week` (Monday start) or
  `month`. Empty buckets are zero-filled across the requested range, or across the
  first-to-last activity when no range is given.

## Range and granularity helpers

`src/lib/analyticsRange.ts` builds inputs for filter controls: `getPresetRange`
(`7d`, `30d`, `90d`, `ytd`, `all`), `validateDateRange` (rejects malformed or
inverted ranges), `clampDateRange` (drops bad bounds, swaps inverted ones, applies
`min`/`max`/`maxDays`), `toApiGranularity` ("Weekly" → `week`), `suggestGranularity`
and `buildRangeQuery`.
