# Analytics API Reference

This page is the reference for the analytics HTTP API — the endpoints, query parameters, response shapes, and error format — and for the payload schemas of every event the indexer stores. It complements two other documents:

- [ARCHITECTURE.md §13 — Indexer & Analytics Architecture](ARCHITECTURE.md#13-indexer--analytics-architecture) explains how events become the records this API serves (data flow, datastore schema, checkpointing).
- [CONTRACT_API.md](CONTRACT_API.md) is the reference for the contract functions and topics that produce these events in the first place; this page cross-references it wherever an event is also documented there.

**Status:** The Rust service in [`analytics-api/`](../analytics-api/README.md) implements `GET /proposals`, `GET /proposals/:id`, `GET /spend/by-category`, `GET /reports`, and `POST /reports/run` against its PostgreSQL datastore. Every record is tagged by contract **and** network, so one deployment can serve several multisigs and several networks — see [Multi-Contract and Multi-Network Scope](#multi-contract-and-multi-network-scope). The current reference indexer (`scripts/indexer.js`) writes a JSON file rather than these PostgreSQL tables, so a database ingestion adapter is still needed to connect those components. The remaining analytics endpoints below are specified by the frontend's client and types (`frontend/src/lib/analyticsClient.ts`, `frontend/src/types/accord.ts`) but do not yet have a backend implementation — see [frontend/docs/analytics-data-layer.md](../frontend/docs/analytics-data-layer.md) for the integration status. `/health` is a database-backed readiness check; the service root returns its name and status.

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
| `contractId` | string | every configured contract | a value from `CONTRACT_IDS` | Narrow the response to one indexed contract. |
| `network` | string | every configured network | a value from `NETWORKS` | Narrow the response to one network. |

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

### `GET /reports`

The scheduled-report configuration and the history of generated reports, newest first.

**Query parameters:** `limit`, `offset`, `contractId`, `network`, plus `status` (`generated`, `delivered`, `failed`) and `format` (`csv`, `pdf`).

**Response:**

```json
{
  "config": {
    "schedule": "0 0 6 1 * *",
    "formats": ["csv", "pdf"],
    "recipients": ["treasury@example.com"],
    "periodDays": 30,
    "maxAttempts": 3,
    "retryBackoffMs": 2000,
    "outputDir": "./reports",
    "delivery": "smtp(mail.example.com:587)"
  },
  "nextRun": "2026-11-01T06:00:00Z",
  "runs": [
    {
      "id": 41,
      "network": "testnet",
      "contractId": "CA...TREASURY",
      "periodStart": "2026-09-01T06:00:00Z",
      "periodEnd": "2026-10-01T06:00:00Z",
      "format": "pdf",
      "triggerSource": "scheduled",
      "status": "delivered",
      "attempts": 1,
      "recipients": ["treasury@example.com"],
      "byteSize": 18422,
      "filePath": "./reports/accord-testnet-catreasury-20260901-20261001.pdf",
      "error": null,
      "createdAt": "2026-10-01T06:00:04Z",
      "deliveredAt": "2026-10-01T06:00:06Z"
    }
  ],
  "total": 12,
  "limit": 20,
  "offset": 0
}
```

`status` is `delivered` when the report reached its recipients, `generated` when it was produced but no delivery is configured, and `failed` when every delivery attempt was exhausted — `error` then carries the last failure and `attempts` how many were made. `delivery` states which transport is in use, or why delivery is off.

### `POST /reports/run`

Generates and delivers a report immediately, without waiting for the schedule. Useful for verifying delivery after a configuration change and for re-sending a statement.

**Query parameters:** `contractId`, `network`, `format` (defaults to every configured format), `periodDays` (`1`–`3650`, defaults to `REPORT_PERIOD_DAYS`).

**Response:**

```json
{
  "period": { "start": "2026-09-17T09:00:00Z", "end": "2026-10-17T09:00:00Z" },
  "runs": [{ "id": 42, "format": "csv", "status": "delivered", "attempts": 1 }]
}
```

A manual run always generates, even if the same period was already delivered; a scheduled run skips a period and format it has already delivered, so a restart does not re-send a statement.

---

## Multi-Contract and Multi-Network Scope

One deployment serves a set of contracts across a set of networks instead of a single contract.

| Variable | Default | Description |
| --- | --- | --- |
| `CONTRACT_ID` | — | A single contract. Still supported; equivalent to a one-entry `CONTRACT_IDS`. |
| `CONTRACT_IDS` | — | Comma-separated contract IDs. Takes precedence over `CONTRACT_ID`. |
| `NETWORK` | `testnet` | A single network name. |
| `NETWORKS` | value of `NETWORK` | Comma-separated network names. |

At least one contract is required. Every endpoint is scoped to the configured set, and `contractId`/`network` narrow a single request to one of them. A value outside the configured set is a `400` with `INVALID_CONTRACT_ID` or `INVALID_NETWORK`, rather than an empty result that looks like missing data.

Every row carries its `network` and `contract_id`, and both are part of each table's primary key, so the same proposal id on two contracts — or the same contract on testnet and mainnet — never collide. `GET /proposals` and `GET /proposals/:id` return `network` and `contractId` on each proposal. With several contracts in scope, a proposal id that exists on more than one resolves to the first pair in `(network, contract_id)` order; pass `contractId` and `network` to pick one deliberately.

**Checkpoints** are per contract and per network: the `checkpoints` table is keyed on `(network, contract_id)`, and the indexer keeps its `next_ledger` and `event_cursor` under the same pair, so each target resumes from its own position.

---

## Data Retention and Archival

Indexed history grows without bound, so the indexer applies three retention windows, each a number of days where `0` keeps data forever. All three default to `0`, so retention is off until it is configured.

| Variable | Default | Description |
| --- | --- | --- |
| `RETENTION_RAW_EVENT_DAYS` | `0` | How long raw ledger entries and decoded events are kept. |
| `RETENTION_AGGREGATE_DAYS` | `0` | How long the daily aggregates are kept. Must be ≥ `RETENTION_RAW_EVENT_DAYS`. |
| `RETENTION_RECONCILIATION_DAYS` | `0` | How long reconciliation results are kept. |
| `RETENTION_ARCHIVE_DIR` | unset | Archive rows as JSON Lines under this directory before removing them. Unset prunes without archiving. |
| `RETENTION_INTERVAL_MS` | `86400000` | How often retention runs. |

**What a run does, in order.** For each (network, contract) target it rolls every raw row older than the raw window into `ledger_daily_aggregates` (per token per day: inflow, outflow, entry count, closing balance, last ledger) and `event_daily_aggregates` (per topic per day: event count); archives those rows as JSON Lines when an archive directory is set; removes them; then drops aggregates past the aggregate window and reconciliation rows past the reconciliation window — always keeping the latest result for each check and subject.

**Why reports keep working after a prune.** Running balances live in `token_balances`, which retention never touches, so balances and reconciliation stay exact. Event counts are read as live rows plus archived aggregates, so a count over pruned history is still correct. Historical per-day totals come from the aggregate tables rather than the raw rows. The guard that `RETENTION_AGGREGATE_DAYS` must be at least `RETENTION_RAW_EVENT_DAYS` is what stops a configuration from dropping a summary while the rows behind it are still being kept.

`GET /retention` on the indexer returns the active policy and the recent runs; `POST /retention/run` applies it immediately.

---

## Reconciliation and Drift Detection

The indexer compares the chain to its own view on a schedule and records every check, matching or not. See [RECONCILIATION_RUNBOOK.md](RECONCILIATION_RUNBOOK.md) for how to respond to drift.

| Check | On-chain value | Indexed value |
| --- | --- | --- |
| `token_balance` | `balance(treasury)` on each configured token | the running balance in `token_balances` |
| `total_proposals` | `get_total_proposals()` on the Accord contract | the number of `created` events, live plus archived |

`drift` is `actual - implied`. A check is `ok` when it is zero, `drift` when it is not, and `error` when the chain could not be read — an unreadable value is never recorded as agreement. Drift and errors are logged, posted to `ALERT_WEBHOOK_URL` when one is set (retried with linear backoff), and exposed as Prometheus gauges on `GET /metrics`: `accord_reconciliation_drift`, `accord_reconciliation_status`, `accord_reconciliation_last_run_seconds` and `accord_indexer_next_ledger`, each labelled by `network`, `contract_id`, `check` and `subject`.

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
| [RECONCILIATION_RUNBOOK.md](RECONCILIATION_RUNBOOK.md) | Responding to drift between the chain and the indexed view |
| [GLOSSARY.md](GLOSSARY.md) | Definitions for indexer and analytics terms |
| [frontend/docs/analytics-data-layer.md](../frontend/docs/analytics-data-layer.md) | Frontend client integration notes and current implementation status |
