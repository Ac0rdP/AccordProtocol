import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createApi } from "../src/api.js";
import { createReadiness } from "../src/health.js";
import { createIndexerMetrics, createRegistry, METRICS_CONTENT_TYPE, recordBatchSuccess } from "../src/metrics.js";
import { cleanupTempStores, createStore, describeEachBackend } from "./helpers.js";

afterEach(cleanupTempStores);

describe("prometheus registry", () => {
  it("renders counters, gauges and histograms in the text exposition format", () => {
    const registry = createRegistry();
    const requests = registry.counter({ name: "demo_requests_total", help: "Requests.", labelNames: ["route"] });
    const depth = registry.gauge({ name: "demo_queue_depth", help: "Queue depth." });
    const latency = registry.histogram({ name: "demo_latency_seconds", help: "Latency.", buckets: [0.1, 1], labelNames: ["route"] });

    requests.inc({ route: "/a" });
    requests.inc({ route: "/a" }, 2);
    requests.inc({ route: '/we"ird\\path' });
    depth.set(7);
    latency.observe({ route: "/a" }, 0.05);
    latency.observe({ route: "/a" }, 0.5);
    latency.observe({ route: "/a" }, 5);

    assert.equal(registry.render(), [
      "# HELP demo_requests_total Requests.",
      "# TYPE demo_requests_total counter",
      'demo_requests_total{route="/a"} 3',
      'demo_requests_total{route="/we\\"ird\\\\path"} 1',
      "# HELP demo_queue_depth Queue depth.",
      "# TYPE demo_queue_depth gauge",
      "demo_queue_depth 7",
      "# HELP demo_latency_seconds Latency.",
      "# TYPE demo_latency_seconds histogram",
      'demo_latency_seconds_bucket{route="/a",le="0.1"} 1',
      'demo_latency_seconds_bucket{route="/a",le="1"} 2',
      'demo_latency_seconds_bucket{route="/a",le="+Inf"} 3',
      'demo_latency_seconds_sum{route="/a"} 5.55',
      'demo_latency_seconds_count{route="/a"} 3',
      "",
    ].join("\n"));
  });

  it("rejects invalid or duplicate metric names and decreasing counters", () => {
    const registry = createRegistry();
    registry.counter({ name: "ok_total", help: "x" });
    assert.throws(() => registry.counter({ name: "ok_total", help: "x" }), /already registered/);
    assert.throws(() => registry.gauge({ name: "bad-name", help: "x" }), /invalid metric name/);
    assert.throws(() => registry.counter({ name: "c_total", help: "x" }).inc({}, -1), /only increase/);
  });
});

describe("batch metrics", () => {
  it("tracks events processed, ledger positions and ingestion lag", () => {
    const metrics = createIndexerMetrics();
    recordBatchSuccess(metrics, { indexed: 5, heldBack: 2, reorg: null, latestLedger: 120, finalLedger: 118 }, 110, 1_800_000_000);
    recordBatchSuccess(metrics, { indexed: 3, heldBack: 0, reorg: { rewindTo: 100 }, latestLedger: 125, finalLedger: 123 }, 123, 1_800_000_005);

    const text = metrics.render();
    assert.match(text, /^accord_indexer_events_processed_total 8$/m);
    assert.match(text, /^accord_indexer_events_held_back_total 2$/m);
    assert.match(text, /^accord_indexer_reorgs_total 1$/m);
    assert.match(text, /^accord_indexer_chain_latest_ledger 125$/m);
    assert.match(text, /^accord_indexer_indexed_ledger 123$/m);
    assert.match(text, /^accord_indexer_ingestion_lag_ledgers 0$/m);
    assert.match(text, /^accord_indexer_last_successful_batch_timestamp_seconds 1800000005$/m);
    assert.match(text, /^accord_indexer_batches_total\{outcome="success"\} 2$/m);
  });

  it("reports a positive lag while the checkpoint trails the final ledger", () => {
    const metrics = createIndexerMetrics();
    recordBatchSuccess(metrics, { indexed: 0, heldBack: 0, reorg: null, latestLedger: 120, finalLedger: 118 }, 100);
    assert.match(metrics.render(), /^accord_indexer_ingestion_lag_ledgers 18$/m);
  });
});

describe("readiness", () => {
  const healthyStore = { ping: async () => {} };

  it("is not ready until the first batch completes", async () => {
    const readiness = createReadiness({ store: healthyStore });
    const result = await readiness.check();
    assert.equal(result.ready, false);
    assert.equal(result.checks.store.ok, true);
    assert.match(result.checks.indexing.detail, /waiting for the first indexing batch/);
  });

  it("becomes ready after a batch and goes stale if batches stop", async () => {
    let now = 1_000_000;
    const readiness = createReadiness({ store: healthyStore, maxStalenessMs: 30_000, now: () => now });
    readiness.markSuccess();
    assert.equal((await readiness.check()).ready, true);

    now += 30_000;
    assert.equal((await readiness.check()).ready, true, "exactly at the limit is still fresh");
    now += 1;
    const stale = await readiness.check();
    assert.equal(stale.ready, false);
    assert.equal(stale.checks.indexing.ok, false);
    assert.equal(stale.checks.indexing.lastSuccessAgeSeconds, 30);

    readiness.markFailure(new Error("RPC unavailable"));
    assert.match((await readiness.check()).checks.indexing.detail, /RPC unavailable/);
    readiness.markSuccess();
    assert.equal((await readiness.check()).ready, true, "recovers once a batch succeeds");
  });

  it("is not ready when the store does not answer", async () => {
    const readiness = createReadiness({ store: { ping: async () => { throw new Error("connection refused"); } } });
    readiness.markSuccess();
    const result = await readiness.check();
    assert.equal(result.ready, false);
    assert.deepEqual(result.checks.store, { ok: false, detail: "connection refused" });
  });
});

async function withApi(store, fn, { readiness } = {}) {
  const metrics = createIndexerMetrics();
  const ready = readiness ?? createReadiness({ store });
  const api = createApi({
    store, readiness: ready, metrics, startLedger: 5, finalityLag: 2, tokenAddresses: new Map([["USDC", "CUSDC"]]),
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${api.address().port}`;
  try {
    return await fn({ base, metrics, readiness: ready });
  } finally {
    await new Promise((resolve) => api.close(resolve));
  }
}

describeEachBackend("indexer api operations", () => {
  it("serves liveness regardless of indexing state", async () => {
    const store = await createStore();
    await withApi(store, async ({ base }) => {
      const response = await fetch(`${base}/healthz`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: "ok" });
    });
  });

  it("serves readiness: 503 before the first batch, 200 after", async () => {
    const store = await createStore();
    await withApi(store, async ({ base, readiness }) => {
      const before = await fetch(`${base}/readyz`);
      assert.equal(before.status, 503);
      assert.equal((await before.json()).status, "not_ready");

      readiness.markSuccess();
      const after = await fetch(`${base}/readyz`);
      assert.equal(after.status, 200);
      const body = await after.json();
      assert.equal(body.status, "ready");
      assert.equal(body.checks.store.ok, true);
    });
  });

  it("serves structured status for the public status page", async () => {
    const store = await createStore();
    await withApi(store, async ({ base, readiness }) => {
      const before = await fetch(`${base}/status`);
      assert.equal(before.status, 200);
      const body = await before.json();
      assert.equal(body.service, "indexer");
      assert.equal(body.status, "degraded", "no indexing batch yet is degraded, not an outage");
      assert.equal(body.checks.store.ok, true);
      assert.equal(body.checks.indexing.ok, false);
      assert.equal(body.nextLedger, "5");
      assert.equal(body.latestLedger, null);
      assert.match(body.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

      readiness.markSuccess();
      const after = await fetch(`${base}/status`);
      assert.equal(after.status, 200);
      assert.equal((await after.json()).status, "operational");
    });
  });

  it("reports an outage when the store does not answer", async () => {
    const store = await createStore();
    const readiness = createReadiness({
      store: { ping: async () => { throw new Error("connection refused"); } },
    });
    readiness.markSuccess();
    await withApi(store, async ({ base }) => {
      const response = await fetch(`${base}/status`);
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.status, "outage");
      assert.equal(body.checks.store.ok, false);
      assert.equal(body.checks.store.detail, "connection refused");
    }, { readiness });
  });

  it("keeps serving status when the store state cannot be read", async () => {
    const store = await createStore();
    const unreadable = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "getState") return async () => { throw new Error("database is locked"); };
        return Reflect.get(target, property, receiver);
      },
    });
    await withApi(unreadable, async ({ base, readiness }) => {
      readiness.markSuccess();
      const response = await fetch(`${base}/status`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.status, "operational");
      assert.equal(body.nextLedger, "5");
      assert.equal(body.latestLedger, null);
    });
  });

  it("serves Prometheus metrics including its own request latency", async () => {
    const store = await createStore();
    await withApi(store, async ({ base }) => {
      await fetch(`${base}/health`);
      await fetch(`${base}/events?limit=5`);
      await fetch(`${base}/no-such-route-${Math.random()}`);
      await fetch(`${base}/events?from=not-a-date`);

      const response = await fetch(`${base}/metrics`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), METRICS_CONTENT_TYPE);
      const text = await response.text();
      assert.match(text, /^# TYPE accord_indexer_http_request_duration_seconds histogram$/m);
      assert.match(text, /^accord_indexer_http_requests_total\{method="GET",route="\/health",status="200"\} 1$/m);
      assert.match(text, /^accord_indexer_http_requests_total\{method="GET",route="\/events",status="200"\} 1$/m);
      assert.match(text, /^accord_indexer_http_requests_total\{method="GET",route="\/events",status="400"\} 1$/m);
      assert.match(text, /^accord_indexer_http_requests_total\{method="GET",route="unmatched",status="404"\} 1$/m);
      assert.match(text, /^accord_indexer_http_request_duration_seconds_count\{method="GET",route="\/health"\} 1$/m);
      assert.doesNotMatch(text, /no-such-route/, "unknown paths never become label values");
    });
  });

  it("keeps serving the existing data endpoints", async () => {
    const store = await createStore();
    await store.setState("next_ledger", "9");
    await store.recordAccordEvent({
      eventId: "a1", topic: "created", payload: { id: "1" }, ledger: 8, transactionHash: "h", occurredAt: "2026-09-27T12:00:00.000Z",
    });
    await withApi(store, async ({ base }) => {
      assert.deepEqual(await (await fetch(`${base}/health`)).json(), {
        status: "ok", nextLedger: "9", latestLedger: null, finalityLag: 2,
      });
      const { events } = await (await fetch(`${base}/events?topic=created`)).json();
      assert.deepEqual(events.map(({ eventId, payload }) => [eventId, payload]), [["a1", { id: "1" }]]);
      assert.equal((await fetch(`${base}/ledger?token=DOGE`)).status, 400);
      assert.deepEqual(await (await fetch(`${base}/reconciliation`)).json(), { results: [] });
    });
  });

  it("lists the webhook outbox and dead letters", async () => {
    const store = await createStore();
    const now = "2026-09-27T12:00:00.000Z";
    await store.enqueueWebhookDeliveries({
      subscriptionId: "ops", deliveries: [{ eventId: "e1", body: "{}" }, { eventId: "e2", body: "{}" }], cursor: 2, now,
    });
    const [first] = await store.claimDueWebhookDeliveries({ now, limit: 1 });
    await store.completeWebhookDelivery({ id: first.id, outcome: "dead", attempts: 8, error: "HTTP 500", statusCode: 500, now });

    await withApi(store, async ({ base }) => {
      const dead = await (await fetch(`${base}/webhooks/deliveries?status=dead`)).json();
      assert.deepEqual(dead.deliveries.map(({ eventId, status, lastError }) => [eventId, status, lastError]), [["e1", "dead", "HTTP 500"]]);
      assert.equal((await (await fetch(`${base}/webhooks/deliveries`)).json()).deliveries.length, 2);
      assert.equal((await fetch(`${base}/webhooks/deliveries?status=bogus`)).status, 400);
    });
  });

  it("reports a failing store as a 500 without leaking details", async () => {
    const store = await createStore();
    const broken = { ...store, getAccordEvents: async () => { throw new Error("relation \"secret_table\" does not exist"); } };
    await withApi(broken, async ({ base, metrics }) => {
      const originalError = console.error;
      console.error = () => {};
      try {
        const response = await fetch(`${base}/events`);
        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), { error: "internal error" });
      } finally {
        console.error = originalError;
      }
      assert.match(metrics.render(), /^accord_indexer_errors_total\{stage="api"\} 1$/m);
    });
  });
});
