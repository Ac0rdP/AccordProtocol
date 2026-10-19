# Operations assets

| Path | What it is |
| --- | --- |
| `grafana/accord-indexer-api.json` | Grafana dashboard for indexer ingestion lag, throughput, errors and API health. Import it and pick your Prometheus data source. |
| `prometheus/prometheus.yml` | Scrape jobs (`accord-indexer`, `accord-analytics-api`) the dashboard expects. |

Alert rules live in [docs/OPERATIONS.md](../docs/OPERATIONS.md); each links to its section in [docs/RUNBOOK.md](../docs/RUNBOOK.md). `indexer/test/ops-assets.test.js` checks that the dashboard's data sources are reachable and that alerts and the runbook stay in sync.
