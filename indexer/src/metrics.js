/**
 * Minimal Prometheus registry (text exposition format 0.0.4): counters,
 * gauges and histograms with labels. Hand-rolled to keep the indexer's only
 * runtime dependencies the Stellar SDK and the Postgres driver.
 */

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function escapeLabelValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function labelKey(labelNames, labels) {
  return labelNames.map((name) => `${name}="${escapeLabelValue(labels[name] ?? "")}"`).join(",");
}

function formatNumber(value) {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(value);
}

function metric(registry, { name, help, type, labelNames = [] }) {
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) throw new Error(`invalid metric name ${name}`);
  if (registry.metrics.has(name)) throw new Error(`metric ${name} is already registered`);
  const definition = { name, help, type, labelNames, series: new Map() };
  registry.metrics.set(name, definition);
  return definition;
}

export function createRegistry() {
  const registry = { metrics: new Map() };

  return {
    counter(options) {
      const definition = metric(registry, { ...options, type: "counter" });
      return {
        inc(labels = {}, amount = 1) {
          if (amount < 0) throw new Error("counters can only increase");
          const key = labelKey(definition.labelNames, labels);
          definition.series.set(key, (definition.series.get(key) ?? 0) + amount);
        },
      };
    },

    gauge(options) {
      const definition = metric(registry, { ...options, type: "gauge" });
      return {
        set(labels, value) {
          // set(value) is shorthand for an unlabelled gauge.
          if (typeof labels === "number") [labels, value] = [{}, labels];
          definition.series.set(labelKey(definition.labelNames, labels), value);
        },
      };
    },

    histogram({ buckets = DEFAULT_BUCKETS, ...options }) {
      const definition = metric(registry, { ...options, type: "histogram" });
      definition.buckets = [...buckets].sort((a, b) => a - b);
      return {
        observe(labels, value) {
          if (typeof labels === "number") [labels, value] = [{}, labels];
          const key = labelKey(definition.labelNames, labels);
          let series = definition.series.get(key);
          if (!series) {
            series = { counts: definition.buckets.map(() => 0), sum: 0, count: 0 };
            definition.series.set(key, series);
          }
          definition.buckets.forEach((bound, index) => {
            if (value <= bound) series.counts[index] += 1;
          });
          series.sum += value;
          series.count += 1;
        },
      };
    },

    render() {
      const lines = [];
      for (const { name, help, type, series, buckets } of registry.metrics.values()) {
        lines.push(`# HELP ${name} ${help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")}`);
        lines.push(`# TYPE ${name} ${type}`);
        for (const [key, value] of series) {
          const braces = (extra) => {
            const parts = [key, extra].filter(Boolean).join(",");
            return parts ? `{${parts}}` : "";
          };
          if (type === "histogram") {
            buckets.forEach((bound, index) => {
              lines.push(`${name}_bucket${braces(`le="${formatNumber(bound)}"`)} ${value.counts[index]}`);
            });
            lines.push(`${name}_bucket${braces('le="+Inf"')} ${value.count}`);
            lines.push(`${name}_sum${braces()} ${formatNumber(value.sum)}`);
            lines.push(`${name}_count${braces()} ${value.count}`);
          } else {
            lines.push(`${name}${braces()} ${formatNumber(value)}`);
          }
        }
      }
      return `${lines.join("\n")}\n`;
    },
  };
}

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** The indexer's operational metrics; see docs/OPERATIONS.md for what each one means. */
export function createIndexerMetrics() {
  const registry = createRegistry();
  return {
    registry,
    render: () => registry.render(),

    eventsProcessed: registry.counter({
      name: "accord_indexer_events_processed_total",
      help: "Chain events newly written to the store (duplicates excluded).",
    }),
    eventsHeldBack: registry.counter({
      name: "accord_indexer_events_held_back_total",
      help: "Events seen on a non-final ledger and deferred to a later batch.",
    }),
    reorgs: registry.counter({
      name: "accord_indexer_reorgs_total",
      help: "Chain rollbacks detected, each of which rewound the store.",
    }),
    errors: registry.counter({
      name: "accord_indexer_errors_total",
      help: "Failures by pipeline stage.",
      labelNames: ["stage"],
    }),
    batches: registry.counter({
      name: "accord_indexer_batches_total",
      help: "Indexing batches by outcome.",
      labelNames: ["outcome"],
    }),
    batchDuration: registry.histogram({
      name: "accord_indexer_batch_duration_seconds",
      help: "Wall time of one indexing batch.",
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    }),
    latestLedger: registry.gauge({
      name: "accord_indexer_chain_latest_ledger",
      help: "Latest ledger reported by the RPC.",
    }),
    finalLedger: registry.gauge({
      name: "accord_indexer_chain_final_ledger",
      help: "Latest ledger old enough to be indexed (latest minus the finality lag).",
    }),
    indexedLedger: registry.gauge({
      name: "accord_indexer_indexed_ledger",
      help: "Last ledger fully covered by the indexing checkpoint.",
    }),
    ingestionLagLedgers: registry.gauge({
      name: "accord_indexer_ingestion_lag_ledgers",
      help: "Final ledgers not yet indexed (final ledger minus indexed ledger).",
    }),
    lastSuccess: registry.gauge({
      name: "accord_indexer_last_successful_batch_timestamp_seconds",
      help: "Unix time of the last indexing batch that completed without error.",
    }),
    httpRequests: registry.counter({
      name: "accord_indexer_http_requests_total",
      help: "HTTP requests served by the indexer API.",
      labelNames: ["method", "route", "status"],
    }),
    httpDuration: registry.histogram({
      name: "accord_indexer_http_request_duration_seconds",
      help: "Indexer API request latency.",
      labelNames: ["method", "route"],
    }),
    webhookDeliveries: registry.counter({
      name: "accord_indexer_webhook_deliveries_total",
      help: "Webhook delivery attempts by result (delivered, retry, dead).",
      labelNames: ["subscription", "result"],
    }),
    webhookDeliveryDuration: registry.histogram({
      name: "accord_indexer_webhook_delivery_duration_seconds",
      help: "Latency of webhook delivery attempts.",
      labelNames: ["subscription"],
    }),
    webhookBacklog: registry.gauge({
      name: "accord_indexer_webhook_deliveries",
      help: "Webhook deliveries in the outbox by status (pending, delivered, dead).",
      labelNames: ["status"],
    }),
  };
}

/** Folds one finished `indexEventBatch` result into the ingestion metrics. */
export function recordBatchSuccess(metrics, result, indexedLedger, nowSeconds = Date.now() / 1000) {
  metrics.eventsProcessed.inc({}, result.indexed);
  metrics.eventsHeldBack.inc({}, result.heldBack);
  if (result.reorg) metrics.reorgs.inc();
  metrics.latestLedger.set(result.latestLedger);
  metrics.finalLedger.set(result.finalLedger);
  metrics.indexedLedger.set(indexedLedger);
  metrics.ingestionLagLedgers.set(Math.max(0, result.finalLedger - indexedLedger));
  metrics.lastSuccess.set(nowSeconds);
  metrics.batches.inc({ outcome: "success" });
}
