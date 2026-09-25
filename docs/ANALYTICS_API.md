# Analytics API Reference

This page is the reference for the analytics HTTP API — the endpoints, query parameters, response shapes, and error format — and for the payload schemas of every event the indexer stores. It complements two other documents:

- [ARCHITECTURE.md §13 — Indexer & Analytics Architecture](ARCHITECTURE.md#13-indexer--analytics-architecture) explains how events become the records this API serves (data flow, datastore schema, checkpointing).
- [CONTRACT_API.md](CONTRACT_API.md) is the reference for the contract functions and topics that produce these events in the first place; this page cross-references it wherever an event is also documented there.

**Status:** `GET /stats/summary` is specified and has a reference implementation of its query validation and response shape (`frontend/src/lib/analyticsApi.ts`). The remaining endpoints below are specified by the frontend's analytics client and types (`frontend/src/lib/analyticsClient.ts`, `frontend/src/types/accord.ts`) but do not yet have a merged backend implementation — see [frontend/docs/analytics-data-layer.md](../frontend/docs/analytics-data-layer.md) for the up-to-date integration status. The shapes on this page are the contract the frontend already codes against, so a backend can implement them without a frontend change.

---

## Conventions

- **Base URL** — set by `VITE_API_BASE_URL` on the frontend; requests are same-origin (relative paths) when unset.
- **Method** — every endpoint is `GET`. Any other method returns `405 METHOD_NOT_ALLOWED`.
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

The frontend's `AnalyticsApiError` (`frontend/src/lib/analyticsClient.ts`) carries the HTTP status, the parsed body, and the server's `error.message` where available; network and abort errors propagate instead of being wrapped.

---

## Endpoints

### `GET /proposals`

Paginated proposal list, filterable the same way the dashboard filters proposals.

**Query parameters:** `limit`, `offset`, `sort`, `order`, `category`, `status`, `owner`, `token`, `startDate`, `endDate` (see [Standardized Query Parameters](#standardized-query-parameters)).

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

### `GET /spend/by-owner`

Spend aggregated by proposer/owner address, over executed transfers only.

**Query parameters:** `token`, `startDate`, `endDate`.

**Response (`OwnerSpendBucket[]`):**

```json
[
  { "owner": "GABC...PROPOSER", "token": "USDC", "total": "9000.0000000", "count": 4 }
]
```

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

---

## Event Payload Schemas

The indexer decodes and stores every event the Accord contract emits (`contracts/accord/src/lib.rs`); this table gives each event's fields and types. See [ARCHITECTURE.md §13.4](ARCHITECTURE.md#134-event-type-to-storage-mapping) for which datastore table(s) each event feeds, and [CONTRACT_API.md — Event Payloads](CONTRACT_API.md#event-payloads) for the subset (`ProposalCreatedEvent`, `ProposalApprovedEvent`, `ProposalRevokedEvent`, `ProposalExecutedEvent`, `OwnerWeightChangedEvent`, `RecurringPaymentCreatedEvent`, `RecurringPaymentDisbursedEvent`, `RecurringPaymentCancelledEvent`) that also has a full topics/XDR breakdown there.

### Proposal lifecycle

| Topic | Struct | Fields |
| --- | --- | --- |
| `created` | `ProposalCreatedEvent` | `id: u64`, `proposer: Address`, `threshold: u32`, `category: ProposalCategory`, `transfers: Vec<Transfer>` (`{ to, token, amount: i128 }` each), `quorum_weight: u32`, `total_weight_at_creation: u32` |
| `approved` | `ProposalApprovedEvent` | `id: u64`, `approver: Address`, `approvals: u32`, `threshold: u32`, `weight: u32`, `cumulative_weight: u32` |
| `revoked` | `ProposalRevokedEvent` | `id: u64`, `approver: Address`, `approvals: u32`, `weight: u32`, `cumulative_weight: u32` |
| `executed` | `ProposalExecutedEvent` | `id: u64`, `executor: Address`, `transfers: Vec<Transfer>` |

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
| [GLOSSARY.md](GLOSSARY.md) | Definitions for indexer and analytics terms |
| [frontend/docs/analytics-data-layer.md](../frontend/docs/analytics-data-layer.md) | Frontend client integration notes and current implementation status |
