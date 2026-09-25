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
