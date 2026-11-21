import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createApi } from "../src/api.js";
import { loadIndexerConfig, resolveRunwayConfig } from "../src/config.js";
import { createReadiness } from "../src/health.js";
import { createIndexerMetrics } from "../src/metrics.js";
import { computeRunway, forecastRunway } from "../src/runway.js";
import { cleanupTempStores, createStore, describeEachBackend, makeEvent, sender, tokenAddresses, treasury } from "./helpers.js";
import { parseTokenTransferEvent } from "../src/events.js";

afterEach(cleanupTempStores);

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-30T00:00:00Z");
const config = resolveRunwayConfig({});
const entry = (daysAgo, direction, amount) => ({
  occurredAt: new Date(NOW - daysAgo * DAY).toISOString(), direction, amount: String(amount),
});

describe("runway configuration", () => {
  it("defaults to history only and falls back on invalid values", () => {
    assert.deepEqual(config, { lookbackDays: 90, recurringOutflowPerDay: "0", recurringInflowPerDay: "0", horizonDays: 3650 });
    assert.deepEqual(loadIndexerConfig({}).runway, config);
    const odd = resolveRunwayConfig({ RUNWAY_LOOKBACK_DAYS: "0", RUNWAY_RECURRING_OUTFLOW_PER_DAY: "-5", RUNWAY_RECURRING_INFLOW_PER_DAY: "12" });
    assert.equal(odd.lookbackDays, 90);
    assert.equal(odd.recurringOutflowPerDay, "0");
    assert.equal(odd.recurringInflowPerDay, "12");
  });
});

describe("forecastRunway", () => {
  const run = (entries, balance, extra = {}) =>
    forecastRunway({ entries, balance, now: NOW, config: { ...config, ...extra } });

  it("projects runway from the historical net burn", () => {
    // 10-day window: 1000 out, 200 in -> 80/day burn; 800 balance -> 10 days.
    const result = run([entry(10, "outflow", 1000), entry(5, "inflow", 200)], 800);
    assert.equal(result.status, "burning");
    assert.equal(result.windowDays, 10);
    assert.equal(result.netBurnPerDay, "80");
    assert.equal(result.runwayDays, 10);
    assert.equal(result.depletionDate, new Date(NOW + 10 * DAY).toISOString());
  });

  it("adds recurring assumptions to the historical rate", () => {
    const result = run([entry(10, "outflow", 1000)], 1100, { recurringOutflowPerDay: "10" });
    assert.equal(result.netBurnPerDay, "110");
    assert.equal(result.runwayDays, 10);
  });

  it("is sustainable when inflows cover outflows", () => {
    const result = run([entry(4, "outflow", 100), entry(2, "inflow", 500)], 1000);
    assert.equal(result.status, "sustainable");
    assert.equal(result.runwayDays, null);
  });

  it("reports an empty treasury, no data and a capped horizon", () => {
    assert.equal(run([entry(2, "outflow", 100)], 0).status, "depleted");
    assert.equal(run([], 500).status, "no_data");
    assert.equal(run([], 500, { recurringOutflowPerDay: "5" }).runwayDays, 100);
    const far = run([entry(10, "outflow", 10)], 1_000_000, { horizonDays: 365 });
    assert.deepEqual([far.status, far.runwayDays, far.depletionDate], ["beyond_horizon", 365, null]);
  });

  it("ignores entries outside the lookback window", () => {
    const result = run([entry(200, "outflow", 99999), entry(10, "outflow", 100)], 100);
    assert.equal(result.entriesUsed, 1);
    assert.equal(result.netBurnPerDay, "10");
  });

  it("is idempotent: the same flows always give the same forecast", () => {
    const entries = [entry(10, "outflow", 1000), entry(5, "inflow", 200)];
    assert.deepEqual(run(entries, 800), run([...entries], 800));
  });
});

describeEachBackend("runway from the store", () => {
  async function seed(store) {
    const now = Date.now();
    const tokenNames = new Map([[tokenAddresses.USDC.toLowerCase(), "USDC"]]);
    const out = makeEvent({ id: "o1", from: treasury, to: sender, amount: 1000n, ledger: 5, closedAt: new Date(now - 10 * DAY).toISOString() });
    const inn = makeEvent({ id: "i1", amount: 200n, ledger: 6, closedAt: new Date(now - 5 * DAY).toISOString() });
    for (const event of [out, inn, out]) await store.recordTransfer(parseTokenTransferEvent(event, tokenNames, treasury));
    await store.recomputeBalances();
    return now;
  }

  it("computes from deduplicated entries, so a replayed event does not change it", async () => {
    const store = await createStore();
    const now = await seed(store);
    const result = await computeRunway({ store, token: "USDC", config, now });
    assert.equal(result.entriesUsed, 2);
    assert.equal(result.balance, "-800");
    assert.equal(result.status, "depleted");
  });

  it("surfaces store failures to the caller", async () => {
    const failing = { getEntries: async () => { throw new Error("db down"); }, getBalance: async () => "0" };
    await assert.rejects(computeRunway({ store: failing, token: "USDC", config }), /db down/);
  });

  it("serves /runway and rejects an unknown token", async () => {
    const store = await createStore();
    await seed(store);
    const readiness = createReadiness({ store });
    const api = createApi({ store, readiness, metrics: createIndexerMetrics(), startLedger: 1, finalityLag: 2, tokenAddresses: new Map([["USDC", "C"]]) });
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${api.address().port}`;
    try {
      const ok = await fetch(`${base}/runway?token=usdc`);
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).token, "USDC");
      assert.equal((await fetch(`${base}/runway?token=DOGE`)).status, 400);
    } finally {
      await new Promise((resolve) => api.close(resolve));
    }
  });
});
