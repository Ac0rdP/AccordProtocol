/**
 * Chain-tip lag and finality-depth monitoring.
 *
 * Three signals, each with warn/critical levels:
 *
 *   tip_lag          ledgers the indexer trails the tip by, *above* the finality
 *                    floor (so `LEDGER_FINALITY_LAG` alone never alerts)
 *   finality_depth   confirmations on the newest indexed ledger; below
 *                    `minFinalityDepth` means non-final data was indexed
 *   checkpoint_age   seconds since the checkpoint last advanced
 *
 * The monitor is derived state: `evaluateLag` is a pure function of
 * (latest ledger, indexed ledger, when the checkpoint last moved, now), and
 * `observe` only records *when the indexed ledger changed*. Replaying the same
 * observation changes nothing, and a replay of older ledgers (a rewind) simply
 * counts as the checkpoint moving. The checkpoint time and alert levels are
 * persisted (`lag_monitor_state`) so a restart neither zeroes the age nor
 * re-fires an alert that is already active.
 */

export const LEVELS = ["ok", "warn", "critical"];
export const LAG_CHECKS = ["tip_lag", "finality_depth", "checkpoint_age"];
export const LAG_MONITOR_ID = "indexer";

const rank = (level) => LEVELS.indexOf(level);
const worst = (levels) => levels.reduce((top, level) => (rank(level) > rank(top) ? level : top), "ok");

function threshold(value, warn, critical) {
  if (value >= critical) return "critical";
  if (value >= warn) return "warn";
  return "ok";
}

/**
 * @param {object} input
 * @param {number|null} input.latestLedger chain tip reported by the RPC (0/null when unknown)
 * @param {number|null} input.indexedLedger newest ledger covered by the checkpoint
 * @param {number|null} input.checkpointAdvancedAtMs when the indexed ledger last changed
 * @param {number} input.nowMs
 * @param {number} input.finalityLag
 * @param {object} input.config see `resolveLagMonitorConfig`
 */
export function evaluateLag({ latestLedger, indexedLedger, checkpointAdvancedAtMs, nowMs, finalityLag, config }) {
  const tipKnown = Number.isSafeInteger(latestLedger) && latestLedger > 0 && Number.isSafeInteger(indexedLedger);
  const tipLagLedgers = tipKnown ? latestLedger - indexedLedger : null;
  const excessLagLedgers = tipKnown ? Math.max(0, tipLagLedgers - finalityLag) : null;
  const checkpointAgeSeconds = checkpointAdvancedAtMs === null || checkpointAdvancedAtMs === undefined
    ? null
    : Math.max(0, Math.floor((nowMs - checkpointAdvancedAtMs) / 1000));

  const checks = {
    tip_lag: {
      level: tipKnown ? threshold(excessLagLedgers, config.tipLagWarnLedgers, config.tipLagCriticalLedgers) : "ok",
      value: excessLagLedgers,
      warn: config.tipLagWarnLedgers,
      critical: config.tipLagCriticalLedgers,
    },
    finality_depth: {
      // The newest indexed ledger must sit at least `minFinalityDepth` below the tip.
      level: tipKnown && tipLagLedgers < config.minFinalityDepth ? "critical" : "ok",
      value: tipLagLedgers,
      min: config.minFinalityDepth,
    },
    checkpoint_age: {
      level: checkpointAgeSeconds === null
        ? "ok"
        : threshold(checkpointAgeSeconds, config.checkpointAgeWarnSeconds, config.checkpointAgeCriticalSeconds),
      value: checkpointAgeSeconds,
      warn: config.checkpointAgeWarnSeconds,
      critical: config.checkpointAgeCriticalSeconds,
    },
  };

  return {
    latestLedger: tipKnown ? latestLedger : null,
    indexedLedger: Number.isSafeInteger(indexedLedger) ? indexedLedger : null,
    tipLagLedgers,
    excessLagLedgers,
    tipLagSeconds: tipKnown ? tipLagLedgers * config.ledgerCloseSeconds : null,
    finalityDepth: tipLagLedgers,
    finalityLag,
    checkpointAgeSeconds,
    checks,
    level: worst(Object.values(checks).map((check) => check.level)),
  };
}

function publishThresholds(metrics, config) {
  const set = (check, level, value) => metrics.lagThreshold.set({ check, level }, value);
  set("tip_lag", "warn", config.tipLagWarnLedgers);
  set("tip_lag", "critical", config.tipLagCriticalLedgers);
  set("checkpoint_age", "warn", config.checkpointAgeWarnSeconds);
  set("checkpoint_age", "critical", config.checkpointAgeCriticalSeconds);
  set("finality_depth", "critical", config.minFinalityDepth);
}

/**
 * @param {object} options
 * @param {object} options.store needs `getLagMonitorState` / `setLagMonitorState`
 * @param {object} options.metrics from `createIndexerMetrics`
 * @param {object} options.config from `resolveLagMonitorConfig`
 * @param {number} options.finalityLag
 * @param {() => number} [options.now] epoch milliseconds
 * @param {(alert: object) => void} [options.onAlert] called once per level change
 */
export function createLagMonitor({ store, metrics, config, finalityLag, now = () => Date.now(), onAlert = () => {} }) {
  let loading = null;
  let latestLedger = null;
  let indexedLedger = null;
  let advancedAtMs = null;
  let levels = {};
  let current = null;

  if (config.enabled) publishThresholds(metrics, config);

  function load() {
    // One shared load, so overlapping observe/refresh calls never race it.
    loading ??= (async () => {
      try {
        const saved = await store.getLagMonitorState(LAG_MONITOR_ID);
        if (!saved) return;
        latestLedger = saved.latestLedger;
        indexedLedger = saved.indexedLedger;
        advancedAtMs = saved.checkpointAdvancedAt ? Date.parse(saved.checkpointAdvancedAt) : null;
        levels = saved.levels ?? {};
      } catch {
        // Starting from nothing only loses continuity; it never blocks indexing.
        metrics.errors.inc({ stage: "lag" });
      }
    })();
    return loading;
  }

  /** Evaluates, exports metrics and reports level changes. Returns whether any level changed. */
  function evaluate() {
    const evaluation = evaluateLag({
      latestLedger, indexedLedger, checkpointAdvancedAtMs: advancedAtMs, nowMs: now(), finalityLag, config,
    });
    if (evaluation.tipLagLedgers !== null) {
      metrics.chainTipLagLedgers.set(evaluation.tipLagLedgers);
      metrics.chainTipLagSeconds.set(evaluation.tipLagSeconds);
      metrics.finalityDepthLedgers.set(evaluation.finalityDepth);
    }
    if (evaluation.checkpointAgeSeconds !== null) metrics.checkpointAgeSeconds.set(evaluation.checkpointAgeSeconds);

    let changed = false;
    const next = {};
    for (const name of LAG_CHECKS) {
      const check = evaluation.checks[name];
      const previous = levels[name] ?? "ok";
      next[name] = check.level;
      metrics.lagAlertLevel.set({ check: name }, rank(check.level));
      if (check.level !== previous) {
        changed = true;
        if (check.level !== "ok") metrics.lagAlerts.inc({ check: name, level: check.level });
        try {
          onAlert({ check: name, level: check.level, previous, value: check.value, threshold: check.critical ?? check.min ?? null });
        } catch {
          // A failing alert sink must not stop monitoring.
        }
      }
    }
    levels = next;
    current = { ...evaluation, observedAt: new Date(now()).toISOString() };
    return changed;
  }

  async function persist() {
    try {
      await store.setLagMonitorState({
        monitor: LAG_MONITOR_ID,
        latestLedger,
        indexedLedger,
        checkpointAdvancedAt: advancedAtMs === null ? null : new Date(advancedAtMs).toISOString(),
        levels,
        now: new Date(now()).toISOString(),
      });
    } catch {
      metrics.errors.inc({ stage: "lag" });
    }
  }

  return {
    /** Records a finished batch's view of the chain and re-evaluates. Never throws. */
    async observe({ latestLedger: latest, indexedLedger: indexed }) {
      if (!config.enabled) return null;
      await load();
      const latestNumber = Number(latest);
      const indexedNumber = Number(indexed);
      if (Number.isSafeInteger(latestNumber) && latestNumber > 0) latestLedger = latestNumber;
      if (Number.isSafeInteger(indexedNumber)) {
        // Only a *change* counts as the checkpoint moving; a repeat is a no-op.
        if (indexedNumber !== indexedLedger || advancedAtMs === null) advancedAtMs = now();
        indexedLedger = indexedNumber;
      }
      evaluate();
      await persist();
      return current;
    },

    /**
     * Re-evaluates with the current time and no new observation, so the
     * checkpoint age keeps growing while batches fail or hang.
     */
    async refresh() {
      if (!config.enabled) return null;
      await load();
      if (indexedLedger === null && advancedAtMs === null) return null;
      if (evaluate()) await persist();
      return current;
    },

    current: () => current,
    enabled: Boolean(config.enabled),
  };
}
