# Analytics API Load Testing & 10k RPS Performance Budgets

This document defines the 10,000 requests/second (10k RPS) query-mix methodology, latency and error budgets, caching and rate-limiting interplay, and regression quality gate for the Accord Analytics API (`analytics-api/`).

---

## 1. Objectives & Budget Summary

The Analytics API serves read-heavy dashboard, reporting, and GraphQL traffic backed by PostgreSQL and an in-memory response cache (`ResponseCache`, default `CACHE_TTL_SECS=30`).

Committed budgets live in [`analytics-api/load-budgets.json`](../analytics-api/load-budgets.json) and are enforced in CI by [`scripts/analytics-load-test.mjs`](../scripts/analytics-load-test.mjs):

| Metric | Production Budget (`production-10k-rps`) | Alert Ceiling ([`docs/OPERATIONS.md`](./OPERATIONS.md)) |
| --- | --- | --- |
| **Sustained Throughput** | `>= 10,000 RPS` | N/A |
| **Overall p50 Latency** | `<= 12 ms` | N/A |
| **Overall p95 Latency** | `<= 45 ms` | `1,000 ms` (`AccordApiLatencyHigh`) |
| **Overall p99 Latency** | `<= 120 ms` | N/A |
| **Overall 5xx Error Rate** | `<= 0.10%` (`0.001`) | `5.00%` (`AccordApiErrors`) |
| **Overall Unexpected Error Rate** | `<= 0.50%` (`0.005`) | N/A |

---

## 2. Realistic Query Mix

The 10k RPS workload distributes traffic across the API endpoints defined in [`docs/analytics-api.openapi.json`](./analytics-api.openapi.json) plus the readiness probe:

| Route ID | Endpoint | Weight | Caching | p50 Budget | p95 Budget | p99 Budget | Max Error Rate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `proposals_list` | `GET /proposals?limit=20&offset=0&status=executed` | 35% | Cached (`30s` TTL) | `<= 8 ms` | `<= 30 ms` | `<= 80 ms` | `<= 0.10%` |
| `spend_by_category` | `GET /spend/by-category?token=USDC` | 25% | Cached (`30s` TTL) | `<= 10 ms` | `<= 35 ms` | `<= 90 ms` | `<= 0.10%` |
| `proposal_detail` | `GET /proposals/1` | 15% | Cached (`30s` TTL) | `<= 8 ms` | `<= 30 ms` | `<= 85 ms` | `<= 0.10%` |
| `owner_participation` | `GET /owners/participation?limit=20&offset=0` | 10% | Uncached SQL query | `<= 18 ms` | `<= 60 ms` | `<= 140 ms` | `<= 0.20%` |
| `graphql_proposals` | `POST /graphql` (`proposals(first: 10)`) | 10% | Uncached GraphQL | `<= 20 ms` | `<= 65 ms` | `<= 150 ms` | `<= 0.20%` |
| `health_readyz` | `GET /readyz` | 5% | Exempt probe | `<= 4 ms` | `<= 15 ms` | `<= 40 ms` | `0.00%` |

---

## 3. Running the Load Suite & Quality Gate

Run the unit and regression test suite:

```bash
node --test scripts/analytics-load-test.test.mjs
```

Run the deterministic CI budget gate and emit `report.json` and `report.md`:

```bash
node scripts/analytics-load-test.mjs --ci-gate --report-dir target/analytics-load-test
```

When benchmarking a live `accord-analytics-api` process directly from a single load-generator IP, disable per-client fixed-window throttling (`RATE_LIMIT_REQUESTS=0`) or distribute synthetic client IPs behind `RATE_LIMIT_TRUST_PROXY=true` so the per-client default (`120` requests / `60s`) does not mask backend throughput.

---

## 4. Regression Fixture Tracking

[`analytics-api/load-regression-fixture.json`](../analytics-api/load-regression-fixture.json) (`regression-2026-10-spend-by-category-cache-stampede`) captures a cache-invalidation stampede where concurrent misses on `GET /spend/by-category` saturated the PostgreSQL connection pool, dropping throughput to `8,420 RPS` and spiking `spend_by_category` `p99` to `340 ms`. The CI gate evaluates this fixture on every run to ensure budget enforcement catches throughput drops, per-route tail latency spikes, and error-rate breaches while redacting any sensitive URL or header material.
