import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createApi } from "../src/api.js";
import { createReadiness } from "../src/health.js";
import { createIndexerMetrics, recordBatchSuccess } from "../src/metrics.js";
import { cleanupTempStores, createStore } from "./helpers.js";

afterEach(cleanupTempStores);

const repo = (path) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const read = (path) => readFileSync(repo(path), "utf8");

const dashboard = JSON.parse(read("ops/grafana/accord-indexer-api.json"));
const operations = read("docs/OPERATIONS.md");
const runbook = read("docs/RUNBOOK.md");

const METRIC = /\baccord_(?:indexer|api)_[a-z0-9_]+/g;
const stripSuffix = (name) => name.replace(/_(bucket|sum|count)$/, "");

const dashboardTargets = () => dashboard.panels.flatMap((panel) => panel.targets ?? []);
const dashboardMetrics = () =>
  new Set(dashboardTargets().flatMap(({ expr }) => (expr.match(METRIC) ?? []).map(stripSuffix)));

/** GitHub's heading → anchor rule, enough for the headings used in the runbook. */
const slug = (heading) => heading.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/ /g, "-");
const runbookAnchors = new Set([...runbook.matchAll(/^#{1,6} (.+)$/gm)].map(([, heading]) => slug(heading)));

async function listen(api) {
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${api.address().port}`;
}

describe("dashboard data sources", () => {
  it("queries only metrics the indexer and analytics API actually expose", async () => {
    const store = await createStore("sqlite");
    const metrics = createIndexerMetrics();
    recordBatchSuccess(metrics, { indexed: 1, heldBack: 0, reorg: null, latestLedger: 10, finalLedger: 9 }, 9);
    const readiness = createReadiness({ store });
    readiness.markSuccess();
    const api = createApi({ store, readiness, metrics, startLedger: 1, finalityLag: 1, tokenAddresses: new Map() });
    const base = await listen(api);

    try {
      // The indexer's data source: /metrics must answer and expose every indexer metric used.
      const response = await fetch(`${base}/metrics`);
      assert.equal(response.status, 200);
      const exposed = await response.text();

      // The analytics API's metrics are rendered by Rust; check they are declared there.
      const apiSource = [read("analytics-api/src/metrics.rs"), read("analytics-api/src/main.rs")].join("\n");

      const used = dashboardMetrics();
      assert.ok(used.size > 10, "dashboard should query a meaningful set of metrics");
      for (const name of used) {
        if (name.startsWith("accord_indexer_")) {
          assert.ok(exposed.includes(`# TYPE ${name} `), `indexer does not expose ${name}`);
        } else {
          assert.ok(apiSource.includes(name), `analytics API does not expose ${name}`);
        }
      }

      // Health sources behind the "up" tiles and runbook triage.
      for (const path of ["/healthz", "/readyz", "/health"]) {
        assert.equal((await fetch(`${base}${path}`)).status, 200, `${path} should be reachable`);
      }
    } finally {
      await new Promise((resolve) => api.close(resolve));
    }
  });

  it("exposes the analytics API health endpoints the runbook relies on", () => {
    const source = read("analytics-api/src/main.rs");
    for (const route of ["/health", "/livez", "/readyz", "/metrics"]) {
      assert.ok(source.includes(`.route("${route}"`), `analytics API should route ${route}`);
    }
  });

  it("uses scrape jobs that the bundled Prometheus config defines", () => {
    const prometheus = read("ops/prometheus/prometheus.yml");
    const jobs = [...prometheus.matchAll(/job_name: (\S+)/g)].map(([, name]) => name);
    for (const variable of dashboard.templating.list) {
      assert.ok(jobs.includes(variable.query), `no scrape job named ${variable.query}`);
    }
    for (const { expr } of dashboardTargets()) {
      for (const [, job] of expr.matchAll(/job="\$(\w+)"/g)) {
        assert.ok(dashboard.templating.list.some(({ name }) => name === job), `unknown variable $${job}`);
      }
    }
  });

  it("covers ingestion lag, throughput, errors and API health", () => {
    const used = dashboardMetrics();
    for (const name of [
      "accord_indexer_ingestion_lag_ledgers",
      "accord_indexer_events_processed_total",
      "accord_indexer_errors_total",
      "accord_api_http_request_duration_seconds",
      "accord_api_checkpoint_age_seconds",
    ]) {
      assert.ok(used.has(name), `dashboard should chart ${name}`);
    }
    assert.ok(dashboardTargets().some(({ expr }) => expr.startsWith("up{")), "dashboard should show scrape health");
  });
});

describe("alerts and runbook", () => {
  const alerts = [...operations.matchAll(/^ {6}- alert: (\w+)\n([\s\S]*?)(?=^ {6}- alert: |\n```)/gm)]
    .map(([, name, body]) => ({ name, body }));

  it("finds every suggested alert", () => {
    assert.ok(alerts.length >= 10);
  });

  it("links every alert to an existing runbook section", () => {
    for (const { name, body } of alerts) {
      const match = body.match(/runbook_url: "[^"#]*docs\/RUNBOOK\.md#([a-z0-9-]+)"/);
      assert.ok(match, `${name} has no runbook_url`);
      assert.ok(runbookAnchors.has(match[1]), `${name} links to #${match[1]}, which is not a runbook heading`);
    }
  });

  it("only alerts on metrics that exist", () => {
    const known = new Set([...createIndexerMetrics().render().matchAll(/# TYPE (\S+)/g)].map(([, name]) => name));
    const apiSource = [read("analytics-api/src/metrics.rs"), read("analytics-api/src/main.rs")].join("\n");
    for (const { name, body } of alerts) {
      for (const metric of (body.match(METRIC) ?? []).map(stripSuffix)) {
        const exists = metric.startsWith("accord_api_") ? apiSource.includes(metric) : known.has(metric);
        assert.ok(exists, `${name} uses unknown metric ${metric}`);
      }
    }
  });

  it("covers restart, backfill, reindex, replay and drift recovery", () => {
    for (const anchor of ["restart-the-indexer", "backfill-a-ledger-range", "reindex-rebuild-from-chain", "replay-a-range-to-debug-non-destructive", "recover-from-balance-drift"]) {
      assert.ok(runbookAnchors.has(anchor), `runbook is missing #${anchor}`);
    }
  });

  it("documents every environment variable the indexer reads", () => {
    const sources = [
      ...readdirSync(repo("indexer/src")).filter((file) => file.endsWith(".js")).map((file) => `indexer/src/${file}`),
      ...readdirSync(repo("indexer/src/store")).filter((file) => file.endsWith(".js")).map((file) => `indexer/src/store/${file}`),
    ];
    const variables = new Set();
    for (const file of sources) {
      const text = read(file);
      for (const [, name] of text.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})/g)) variables.add(name);
      for (const [, name] of text.matchAll(/required\("([A-Z][A-Z0-9_]+)"\)/g)) variables.add(name);
    }
    assert.ok(variables.size >= 20, "expected to find the indexer's settings");
    const undocumented = [...variables].filter((name) => !runbook.includes(`\`${name}\``));
    assert.deepEqual(undocumented, [], "add these to the runbook's configuration reference");
  });
});
