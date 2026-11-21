import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createApi } from "../src/api.js";
import { loadIndexerConfig, resolveLagMonitorConfig } from "../src/config.js";
import { createReadiness } from "../src/health.js";
import { createLagMonitor, evaluateLag } from "../src/lag-monitor.js";
import { createIndexerMetrics } from "../src/metrics.js";
import { cleanupTempStores, createStore, describeEachBackend } from "./helpers.js";

afterEach(cleanupTempStores);

const config = resolveLagMonitorConfig({}, 2);

describe("lag monitor configuration", () => {
  it("has safe defaults and tolerates bad values", () => {
    assert.deepEqual(config, {
      enabled: true, ledgerCloseSeconds: 5, tipLagWarnLedgers: 20, tipLagCriticalLedgers: 100,
      checkpointAgeWarnSeconds: 120, checkpointAgeCriticalSeconds: 600, minFinalityDepth: 2,
    });
    assert.equal(loadIndexerConfig({}).lagMonitor.minFinalityDepth, 2);
    const odd = resolveLagMonitorConfig({ LAG_WARN_LEDGERS: "50", LAG_CRITICAL_LEDGERS: "10", LAG_MONITOR_ENABLED: "false", LEDGER_CLOSE_SECONDS: "x" }, 2);
    assert.equal(odd.tipLagCriticalLedgers, 50);
    assert.equal(odd.enabled, false);
    assert.equal(odd.ledgerCloseSeconds, 5);
  });
});

describe("evaluateLag", () => {
  const base = { nowMs: 100_000, finalityLag: 2, config };

  it("does not alert on the finality floor alone", () => {
    const result = evaluateLag({ ...base, latestLedger: 102, indexedLedger: 100, checkpointAdvancedAtMs: 100_000 });
    assert.equal(result.level, "ok");
    assert.equal(result.finalityDepth, 2);
    assert.equal(result.excessLagLedgers, 0);
    assert.equal(result.tipLagSeconds, 10);
  });

  it("warns and goes critical on tip lag above the floor", () => {
    const at = (indexed) => evaluateLag({ ...base, latestLedger: 200, indexedLedger: indexed, checkpointAdvancedAtMs: 100_000 }).checks.tip_lag.level;
    assert.equal(at(179), "ok");
    assert.equal(at(178), "warn");
    assert.equal(at(98), "critical");
  });

  it("flags too-shallow finality depth, including a checkpoint ahead of the tip", () => {
    assert.equal(evaluateLag({ ...base, latestLedger: 101, indexedLedger: 100, checkpointAdvancedAtMs: 100_000 }).checks.finality_depth.level, "critical");
    assert.equal(evaluateLag({ ...base, latestLedger: 100, indexedLedger: 105, checkpointAdvancedAtMs: 100_000 }).checks.finality_depth.level, "critical");
  });

  it("levels checkpoint age and treats an unknown tip as ok", () => {
    const age = (seconds) => evaluateLag({ ...base, nowMs: 1_000_000, latestLedger: 100, indexedLedger: 98, checkpointAdvancedAtMs: 1_000_000 - seconds * 1000 }).checks.checkpoint_age.level;
    assert.deepEqual([age(119), age(120), age(600)], ["ok", "warn", "critical"]);
    assert.equal(evaluateLag({ ...base, latestLedger: 0, indexedLedger: 5, checkpointAdvancedAtMs: null }).level, "ok");
  });
});

describeEachBackend("lag monitor", () => {
  function setup(store, { disabled = false } = {}) {
    const clock = { now: 1_000_000 };
    const metrics = createIndexerMetrics();
    const alerts = [];
    const monitor = createLagMonitor({
      store, metrics, finalityLag: 2, now: () => clock.now,
      config: { ...config, enabled: !disabled }, onAlert: (alert) => alerts.push(alert),
    });
    return { clock, metrics, alerts, monitor };
  }

  it("exports lag metrics and alerts once per level change", async () => {
    const store = await createStore();
    const { metrics, alerts, monitor } = setup(store);

    await monitor.observe({ latestLedger: 300, indexedLedger: 150 });
    await monitor.observe({ latestLedger: 300, indexedLedger: 150 });

    const text = metrics.render();
    assert.match(text, /^accord_indexer_chain_tip_lag_ledgers 150$/m);
    assert.match(text, /^accord_indexer_chain_tip_lag_seconds 750$/m);
    assert.match(text, /^accord_indexer_lag_alert_level\{check="tip_lag"\} 2$/m);
    assert.match(text, /^accord_indexer_lag_alerts_total\{check="tip_lag",level="critical"\} 1$/m);
    assert.deepEqual(alerts.map(({ check, level }) => `${check}:${level}`), ["tip_lag:critical"]);

    await monitor.observe({ latestLedger: 302, indexedLedger: 300 });
    assert.equal(alerts.at(-1).level, "ok");
  });

  it("ages the checkpoint only while the indexed ledger stands still", async () => {
    const store = await createStore();
    const { clock, monitor } = setup(store);
    await monitor.observe({ latestLedger: 102, indexedLedger: 100 });
    clock.now += 130_000;
    await monitor.observe({ latestLedger: 110, indexedLedger: 100 });
    assert.equal(monitor.current().checkpointAgeSeconds, 130);
    assert.equal(monitor.current().checks.checkpoint_age.level, "warn");

    clock.now += 1000;
    await monitor.observe({ latestLedger: 112, indexedLedger: 110 });
    assert.equal(monitor.current().checkpointAgeSeconds, 0);
  });

  it("keeps aging through failed batches via refresh", async () => {
    const store = await createStore();
    const { clock, monitor } = setup(store);
    await monitor.observe({ latestLedger: 102, indexedLedger: 100 });
    clock.now += 700_000;
    await monitor.refresh();
    assert.equal(monitor.current().checks.checkpoint_age.level, "critical");
  });

  it("survives a restart without resetting age or re-firing an active alert", async () => {
    const store = await createStore();
    const first = setup(store);
    await first.monitor.observe({ latestLedger: 300, indexedLedger: 150 });

    const second = setup(store);
    second.clock.now += 60_000;
    await second.monitor.observe({ latestLedger: 301, indexedLedger: 150 });

    assert.equal(second.monitor.current().checkpointAgeSeconds, 60);
    assert.deepEqual(second.alerts, []);
  });

  it("does nothing when disabled", async () => {
    const store = await createStore();
    const { monitor } = setup(store, { disabled: true });
    assert.equal(await monitor.observe({ latestLedger: 10, indexedLedger: 1 }), null);
    assert.equal(await store.getLagMonitorState("indexer"), null);
  });

  it("never lets a failing store break indexing", async () => {
    const store = await createStore();
    const failing = { getLagMonitorState: async () => { throw new Error("down"); }, setLagMonitorState: async () => { throw new Error("down"); } };
    const { monitor, metrics } = setup(failing);
    assert.ok(await monitor.observe({ latestLedger: 102, indexedLedger: 100 }));
    assert.match(metrics.render(), /accord_indexer_errors_total\{stage="lag"\} 2/);
    await store.close();
  });

  it("serves /lag and degrades /status when critical", async () => {
    const store = await createStore();
    const { metrics, monitor } = setup(store);
    const readiness = createReadiness({ store });
    readiness.markSuccess();
    const api = createApi({ store, readiness, metrics, startLedger: 1, finalityLag: 2, tokenAddresses: new Map(), lagMonitor: monitor });
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${api.address().port}`;
    try {
      assert.equal((await fetch(`${base}/lag`)).status, 503);
      await monitor.observe({ latestLedger: 300, indexedLedger: 150 });
      const lag = await (await fetch(`${base}/lag`)).json();
      assert.equal(lag.status, "critical");
      assert.equal(lag.tipLagLedgers, 150);
      const status = await (await fetch(`${base}/status`)).json();
      assert.equal(status.status, "degraded");
      assert.equal(status.checks.lag.ok, false);
    } finally {
      await new Promise((resolve) => api.close(resolve));
    }
  });
});

describeEachBackend("lag monitor state store", () => {
  it("upserts one row per monitor", async () => {
    const store = await createStore();
    await store.setLagMonitorState({ monitor: "indexer", latestLedger: 5, indexedLedger: 3, checkpointAdvancedAt: "2026-01-01T00:00:00.000Z", levels: { tip_lag: "warn" } });
    await store.setLagMonitorState({ monitor: "indexer", latestLedger: 9, indexedLedger: 7, checkpointAdvancedAt: "2026-01-01T00:00:05.000Z", levels: {} });
    const state = await store.getLagMonitorState("indexer");
    assert.equal(state.indexedLedger, 7);
    assert.equal(state.checkpointAdvancedAt, "2026-01-01T00:00:05.000Z");
    assert.deepEqual(state.levels, {});
  });
});
