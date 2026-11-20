import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createApi } from "../src/api.js";
import { computeAnomalies, detectAnomalies, scoreOutflow } from "../src/anomalies.js";
import { loadIndexerConfig, resolveAnomalyConfig } from "../src/config.js";
import { parseTokenTransferEvent } from "../src/events.js";
import { createReadiness } from "../src/health.js";
import { createIndexerMetrics } from "../src/metrics.js";
import { cleanupTempStores, createStore, describeEachBackend, makeEvent, sender, tokenAddresses, treasury } from "./helpers.js";

afterEach(cleanupTempStores);

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-30T00:00:00Z");
const config = resolveAnomalyConfig({});
const outflow = (n, daysAgo, amount) => ({
  eventId: `e${n}`, token: "USDC", ledger: n, direction: "outflow", amount: String(amount), to: "G",
  occurredAt: new Date(NOW - daysAgo * DAY).toISOString(),
});
// Twelve regular 100-unit outflows over the previous 20 days.
const history = () => Array.from({ length: 12 }, (_, i) => outflow(i + 1, 20 - i, 100 + (i % 3)));

describe("anomaly configuration", () => {
  it("has safe defaults and rejects invalid values", () => {
    assert.deepEqual(config, { lookbackDays: 30, reportDays: 7, minSamples: 10, threshold: 6 });
    assert.deepEqual(loadIndexerConfig({}).anomalies, config);
    assert.equal(resolveAnomalyConfig({ ANOMALY_THRESHOLD: "-1" }).threshold, 6);
    assert.equal(resolveAnomalyConfig({ ANOMALY_THRESHOLD: "abc" }).threshold, 6);
    assert.equal(resolveAnomalyConfig({ ANOMALY_THRESHOLD: "3.5" }).threshold, 3.5);
    assert.equal(resolveAnomalyConfig({ ANOMALY_MIN_SAMPLES: "0" }).minSamples, 10);
  });
});

describe("scoreOutflow", () => {
  it("scores outliers high and typical amounts near zero", () => {
    const baseline = [100, 101, 102, 100, 101, 102, 100, 101, 102, 100];
    assert.ok(scoreOutflow(5000, baseline).score > 100);
    assert.ok(Math.abs(scoreOutflow(101, baseline).score) < 1);
  });

  it("does not explode on a perfectly regular history", () => {
    const flat = Array(10).fill(100);
    assert.ok(scoreOutflow(105, flat).score < 1);
    assert.ok(scoreOutflow(1000, flat).score >= 6);
  });
});

describe("detectAnomalies", () => {
  it("flags a spike and leaves regular outflows alone", () => {
    const entries = [...history(), outflow(13, 1, 9000), outflow(14, 0.5, 101)];
    const result = detectAnomalies({ entries, now: NOW, config });
    assert.deepEqual(result.filter((row) => row.anomalous).map((row) => row.eventId), ["e13"]);
    assert.equal(result.find((row) => row.eventId === "e14").anomalous, false);
  });

  it("flags nothing until enough history exists", () => {
    const result = detectAnomalies({ entries: [outflow(1, 2, 100), outflow(2, 1, 99999)], now: NOW, config });
    assert.deepEqual(result.map((row) => [row.score, row.anomalous]), [[null, false], [null, false]]);
  });

  it("scores each outflow only against earlier ones and ignores inflows", () => {
    const base = [...history(), outflow(13, 1, 9000)];
    const withInflow = [...base, { ...outflow(99, 0.2, 1e9), direction: "inflow" }];
    assert.deepEqual(detectAnomalies({ entries: withInflow, now: NOW, config }), detectAnomalies({ entries: base, now: NOW, config }));
    // A later outflow never changes an earlier score.
    const extended = detectAnomalies({ entries: [...base, outflow(14, 0.1, 100)], now: NOW, config });
    assert.deepEqual(extended.find((row) => row.eventId === "e13"), detectAnomalies({ entries: base, now: NOW, config }).find((row) => row.eventId === "e13"));
  });

  it("is idempotent", () => {
    const entries = [...history(), outflow(13, 1, 9000)];
    assert.deepEqual(detectAnomalies({ entries, now: NOW, config }), detectAnomalies({ entries: [...entries], now: NOW, config }));
  });
});

describeEachBackend("anomalies from the store", () => {
  async function seed(store, now) {
    const names = new Map([[tokenAddresses.USDC.toLowerCase(), "USDC"]]);
    const events = [];
    for (let i = 0; i < 12; i += 1) {
      events.push(makeEvent({ id: `r${i}`, from: treasury, to: sender, amount: BigInt(100 + (i % 3)), ledger: i + 1, closedAt: new Date(now - (20 - i) * DAY).toISOString() }));
    }
    events.push(makeEvent({ id: "spike", from: treasury, to: sender, amount: 9000n, ledger: 50, closedAt: new Date(now - DAY).toISOString() }));
    // The spike is delivered twice, as after a replay.
    for (const event of [...events, events.at(-1)]) await store.recordTransfer(parseTokenTransferEvent(event, names, treasury));
  }

  it("flags the spike once, even when the event was replayed", async () => {
    const store = await createStore();
    const now = Date.now();
    await seed(store, now);
    const result = await computeAnomalies({ store, token: "USDC", config, now });
    assert.deepEqual(result.anomalies.map((row) => row.eventId), ["spike"]);
  });

  it("surfaces store failures to the caller", async () => {
    const failing = { getEntries: async () => { throw new Error("db down"); } };
    await assert.rejects(computeAnomalies({ store: failing, token: "USDC", config }), /db down/);
  });

  it("serves /anomalies and rejects an unknown token", async () => {
    const store = await createStore();
    await seed(store, Date.now());
    const api = createApi({
      store, readiness: createReadiness({ store }), metrics: createIndexerMetrics(),
      startLedger: 1, finalityLag: 2, tokenAddresses: new Map([["USDC", "C"]]),
    });
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${api.address().port}`;
    try {
      const ok = await fetch(`${base}/anomalies`);
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).anomalies.length, 1);
      assert.equal((await fetch(`${base}/anomalies?token=DOGE`)).status, 400);
    } finally {
      await new Promise((resolve) => api.close(resolve));
    }
  });
});
