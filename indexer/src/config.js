/**
 * Centralized indexer configuration parser and validator.
 *
 * Exposes typed, structured configuration with safe defaults for:
 *   - Core indexer (RPC, chain, store, finality)
 *   - GraphQL live event subscriptions (push updates without polling)
 *   - Event stream exporters (Kafka, NATS)
 *   - Data warehouse connectors (BigQuery, Snowflake)
 *   - Multi-region failover (leader election)
 *   - Webhook delivery dashboard and retry controls
 *   - Contract event schema validation and quarantine
 *   - API keys with per-key quotas
 *   - Parallel backfill (workers, shard size, retries)
 *   - Chain-tip lag / finality-depth monitoring and alert thresholds
 */

import { DEFAULT_FINALITY_LAG } from "./finality.js";
import { DEFAULT_READY_MAX_STALENESS_MS } from "./health.js";

/** Parses a boolean environment variable with fallback. */
function parseBool(val, defaultValue = false) {
  if (val === undefined || val === null || val === "") return defaultValue;
  const s = String(val).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

/** Parses an integer environment variable with fallback. */
function parseIntSafe(val, defaultValue, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
  if (val === undefined || val === null || val === "") return defaultValue;
  const n = Number(val);
  if (!Number.isSafeInteger(n) || n < min || n > max) return defaultValue;
  return n;
}

/**
 * Resolves the GraphQL subscriptions configuration.
 *
 * Safe defaults:
 *   - enabled: true (can be toggled with GRAPHQL_SUBSCRIPTIONS_ENABLED=false)
 *   - path: /graphql/subscriptions
 *   - keepAliveMs: 15000 (sends SSE/WS ping comment to prevent idle disconnects)
 *   - maxSubscriptionsPerClient: 50
 */
export function resolveGraphQLConfig(env = process.env) {
  const enabled = parseBool(env.GRAPHQL_SUBSCRIPTIONS_ENABLED, true);
  const path = env.GRAPHQL_SUBSCRIPTIONS_PATH?.trim() || "/graphql/subscriptions";
  const keepAliveMs = parseIntSafe(env.GRAPHQL_KEEPALIVE_MS, 15000, 1000, 120000);
  const maxSubscriptionsPerClient = parseIntSafe(env.GRAPHQL_MAX_SUBS_PER_CLIENT, 50, 1, 1000);
  const replayMaxEvents = parseIntSafe(env.GRAPHQL_REPLAY_MAX_EVENTS, 1000, 1, 10000);

  return {
    enabled,
    path,
    keepAliveMs,
    maxSubscriptionsPerClient,
    replayMaxEvents,
  };
}

/**
 * Resolves the Event Stream Exporters configuration (Kafka & NATS).
 *
 * Safe defaults:
 *   - kafka.enabled: false
 *   - nats.enabled: false
 */
export function resolveStreamExportersConfig(env = process.env) {
  const kafka = {
    enabled: parseBool(env.KAFKA_EXPORTER_ENABLED, false),
    brokers: (env.KAFKA_BROKERS?.trim() || "localhost:9092").split(",").map((b) => b.trim()),
    topicPrefix: env.KAFKA_TOPIC_PREFIX?.trim() || "accord.events",
    clientId: env.KAFKA_CLIENT_ID?.trim() || "accord-indexer",
    batchSize: parseIntSafe(env.KAFKA_BATCH_SIZE, 100, 1, 10000),
    flushIntervalMs: parseIntSafe(env.KAFKA_FLUSH_INTERVAL_MS, 1000, 50, 60000),
  };

  const nats = {
    enabled: parseBool(env.NATS_EXPORTER_ENABLED, false),
    servers: (env.NATS_SERVERS?.trim() || "nats://localhost:4222").split(",").map((s) => s.trim()),
    subjectPrefix: env.NATS_SUBJECT_PREFIX?.trim() || "accord.events",
    clusterId: env.NATS_CLUSTER_ID?.trim() || "accord-cluster",
    clientId: env.NATS_CLIENT_ID?.trim() || "accord-indexer",
  };

  return { kafka, nats };
}

/**
 * Resolves Data Warehouse export connectors configuration (BigQuery & Snowflake).
 *
 * Safe defaults:
 *   - bigquery.enabled: false
 *   - snowflake.enabled: false
 */
export function resolveWarehouseConfig(env = process.env) {
  const bigquery = {
    enabled: parseBool(env.BIGQUERY_EXPORT_ENABLED, false),
    projectId: env.BIGQUERY_PROJECT_ID?.trim() || "",
    dataset: env.BIGQUERY_DATASET?.trim() || "accord_analytics",
    exportScheduleCron: env.BIGQUERY_SCHEDULE?.trim() || "0 * * * *",
    batchSize: parseIntSafe(env.BIGQUERY_BATCH_SIZE, 500, 1, 50000),
  };

  const snowflake = {
    enabled: parseBool(env.SNOWFLAKE_EXPORT_ENABLED, false),
    account: env.SNOWFLAKE_ACCOUNT?.trim() || "",
    database: env.SNOWFLAKE_DATABASE?.trim() || "ACCORD_DB",
    schema: env.SNOWFLAKE_SCHEMA?.trim() || "PUBLIC",
    warehouse: env.SNOWFLAKE_WAREHOUSE?.trim() || "COMPUTE_WH",
    exportScheduleCron: env.SNOWFLAKE_SCHEDULE?.trim() || "0 * * * *",
    batchSize: parseIntSafe(env.SNOWFLAKE_BATCH_SIZE, 500, 1, 50000),
  };

  return { bigquery, snowflake };
}

/**
 * Resolves multi-region failover (leader election) configuration.
 *
 * Safe defaults:
 *   - enabled: false (a single instance is always the leader)
 *   - region: "" (label only)
 *   - leaseName: indexer-leader
 *   - leaseTtlMs: 15000 (a dead leader is replaced after at most this long)
 *   - renewIntervalMs: 5000 (never more than half the TTL)
 *
 * Failover needs every instance to share one store, i.e. STORE_BACKEND=postgres.
 */
export function resolveLeaderElectionConfig(env = process.env) {
  const enabled = parseBool(env.INDEXER_LEADER_ELECTION_ENABLED, false);
  const leaseTtlMs = parseIntSafe(env.INDEXER_LEASE_TTL_MS, 15000, 3000, 300000);
  let renewIntervalMs = parseIntSafe(env.INDEXER_LEASE_RENEW_MS, 5000, 500, 150000);
  // A renewal slower than half the TTL would let a healthy leader lapse.
  if (renewIntervalMs * 2 > leaseTtlMs) renewIntervalMs = Math.floor(leaseTtlMs / 3);

  return {
    enabled,
    region: env.INDEXER_REGION?.trim() || "",
    instanceId: env.INDEXER_INSTANCE_ID?.trim() || "",
    leaseName: env.INDEXER_LEASE_NAME?.trim() || "indexer-leader",
    leaseTtlMs,
    renewIntervalMs,
  };
}

/**
 * Resolves the parallel backfill configuration.
 *
 * Safe defaults:
 *   - workers: 1 (sequential; the original single-cursor backfill is used)
 *   - shardSize: 50000 ledgers per shard
 *   - maxShardRetries: 3 in-run retries per shard before it is left `failed`
 *   - retryBaseDelayMs: 1000 (doubles each retry, capped at 60000)
 *
 * Set BACKFILL_WORKERS above 1 to split the range into shards that are walked
 * concurrently, each with its own checkpoint.
 */
export function resolveBackfillConfig(env = process.env) {
  return {
    workers: parseIntSafe(env.BACKFILL_WORKERS, 1, 1, 32),
    shardSize: parseIntSafe(env.BACKFILL_SHARD_SIZE, 50000, 1, 10_000_000),
    maxShardRetries: parseIntSafe(env.BACKFILL_SHARD_MAX_RETRIES, 3, 0, 20),
    retryBaseDelayMs: parseIntSafe(env.BACKFILL_SHARD_RETRY_DELAY_MS, 1000, 0, 60000),
  };
}

/**
 * Resolves the webhook delivery dashboard configuration.
 *
 * Safe defaults:
 *   - enabled: true (read-only: the page and the inspection endpoints)
 *   - adminToken: "" - retry controls are OFF until OPS_ADMIN_TOKEN is set; a
 *     token shorter than 16 characters is rejected rather than accepted weak
 *   - pageSize: 50 deliveries per page
 */
export const MIN_ADMIN_TOKEN_LENGTH = 16;

export function resolveWebhookDashboardConfig(env = process.env) {
  const rawToken = env.OPS_ADMIN_TOKEN?.trim() || "";
  const adminTokenRejected = rawToken !== "" && rawToken.length < MIN_ADMIN_TOKEN_LENGTH;
  return {
    enabled: parseBool(env.WEBHOOK_DASHBOARD_ENABLED, true),
    adminToken: adminTokenRejected ? "" : rawToken,
    adminTokenRejected,
    pageSize: parseIntSafe(env.WEBHOOK_DASHBOARD_PAGE_SIZE, 50, 1, 200),
  };
}

/**
 * Resolves the chain-tip lag / finality-depth monitor configuration.
 *
 * Safe defaults (every threshold is on lag *above* the finality floor, so a
 * larger LEDGER_FINALITY_LAG never raises an alert by itself):
 *   - enabled: true
 *   - ledgerCloseSeconds: 5 (converts ledgers to an estimated lag in seconds)
 *   - tipLagWarnLedgers / tipLagCriticalLedgers: 20 / 100 (~100s / ~8min)
 *   - checkpointAgeWarnSeconds / checkpointAgeCriticalSeconds: 120 / 600
 *   - minFinalityDepth: the finality lag; the newest indexed ledger must be at
 *     least this many ledgers below the chain tip
 *
 * A critical threshold below its warn threshold is raised to match it.
 */
export function resolveLagMonitorConfig(env = process.env, finalityLag = DEFAULT_FINALITY_LAG) {
  const tipLagWarnLedgers = parseIntSafe(env.LAG_WARN_LEDGERS, 20, 1, 1_000_000);
  const checkpointAgeWarnSeconds = parseIntSafe(env.CHECKPOINT_AGE_WARN_SECONDS, 120, 1, 604_800);
  return {
    enabled: parseBool(env.LAG_MONITOR_ENABLED, true),
    ledgerCloseSeconds: parseIntSafe(env.LEDGER_CLOSE_SECONDS, 5, 1, 60),
    tipLagWarnLedgers,
    tipLagCriticalLedgers: Math.max(tipLagWarnLedgers, parseIntSafe(env.LAG_CRITICAL_LEDGERS, 100, 1, 1_000_000)),
    checkpointAgeWarnSeconds,
    checkpointAgeCriticalSeconds: Math.max(checkpointAgeWarnSeconds, parseIntSafe(env.CHECKPOINT_AGE_CRITICAL_SECONDS, 600, 1, 604_800)),
    minFinalityDepth: parseIntSafe(env.FINALITY_MIN_DEPTH, finalityLag, 0, 1000),
  };
}

/**
 * Resolves contract event schema validation.
 *
 * Safe defaults:
 *   - mode: enforce. Events that do not match a registered schema are
 *     quarantined (kept, with the reason, and re-checkable), never dropped.
 *     `warn` indexes invalid payloads anyway and reports them; `off` restores
 *     the previous behaviour (no validation, unknown topics ignored).
 *   - strict: true (fields outside the schema are violations)
 *   - allowUnversioned: true (deployments that predate the `version` field)
 */
export const EVENT_VALIDATION_MODES = ["off", "warn", "enforce"];

export function resolveEventValidationConfig(env = process.env) {
  const requested = env.EVENT_VALIDATION_MODE?.trim().toLowerCase();
  return {
    mode: EVENT_VALIDATION_MODES.includes(requested) ? requested : "enforce",
    modeRejected: Boolean(requested) && !EVENT_VALIDATION_MODES.includes(requested),
    strict: parseBool(env.EVENT_SCHEMA_STRICT, true),
    allowUnversioned: parseBool(env.EVENT_ALLOW_UNVERSIONED, true),
  };
}

/**
 * Resolves the cash-runway forecast assumptions.
 *
 * Safe defaults: a 90-day lookback, no recurring flows (the forecast then rests
 * on history alone) and a 3650-day horizon. Recurring amounts are base units
 * per day and must be non-negative integers; invalid values fall back to 0.
 */
export function resolveRunwayConfig(env = process.env) {
  const amount = (value) => (/^\d{1,30}$/.test(String(value ?? "").trim()) ? String(value).trim() : "0");
  return {
    lookbackDays: parseIntSafe(env.RUNWAY_LOOKBACK_DAYS, 90, 1, 3650),
    recurringOutflowPerDay: amount(env.RUNWAY_RECURRING_OUTFLOW_PER_DAY),
    recurringInflowPerDay: amount(env.RUNWAY_RECURRING_INFLOW_PER_DAY),
    horizonDays: parseIntSafe(env.RUNWAY_HORIZON_DAYS, 3650, 1, 36500),
  };
}

/**
 * Resolves API key configuration for analytics consumers.
 *
 * Safe defaults:
 *   - enabled: false. Analytics reads stay open as before until you turn keys on.
 *   - defaultQuota / defaultWindowSeconds: 1000 requests per hour for a new key
 *   - rotationGraceSeconds: 86400 (the old secret keeps working for a day after a rotation)
 *   - usageRetentionDays: 30 (how long per-window counters are kept)
 *
 * Managing keys over HTTP needs OPS_ADMIN_TOKEN.
 */
export function resolveApiKeysConfig(env = process.env) {
  return {
    enabled: parseBool(env.API_KEYS_ENABLED, false),
    defaultQuota: parseIntSafe(env.API_KEYS_DEFAULT_QUOTA, 1000, 1, 10_000_000),
    defaultWindowSeconds: parseIntSafe(env.API_KEYS_DEFAULT_WINDOW_SECONDS, 3600, 1, 2_592_000),
    rotationGraceSeconds: parseIntSafe(env.API_KEYS_ROTATION_GRACE_SECONDS, 86400, 0, 2_592_000),
    usageRetentionDays: parseIntSafe(env.API_KEYS_USAGE_RETENTION_DAYS, 30, 1, 365),
  };
}

/**
 * Resolves the outflow anomaly detection settings.
 *
 * Safe defaults: a 30-day baseline, scoring the last 7 days, no flag until 10
 * earlier outflows exist, and a robust z-score threshold of 6 (conservative).
 */
export function resolveAnomalyConfig(env = process.env) {
  const threshold = Number(env.ANOMALY_THRESHOLD);
  return {
    lookbackDays: parseIntSafe(env.ANOMALY_LOOKBACK_DAYS, 30, 1, 3650),
    reportDays: parseIntSafe(env.ANOMALY_REPORT_DAYS, 7, 1, 365),
    minSamples: parseIntSafe(env.ANOMALY_MIN_SAMPLES, 10, 1, 100000),
    threshold: Number.isFinite(threshold) && threshold > 0 && env.ANOMALY_THRESHOLD !== "" ? threshold : 6,
  };
}

/**
 * Full consolidated indexer configuration.
 */
export function loadIndexerConfig(env = process.env) {
  return {
    graphql: resolveGraphQLConfig(env),
    streams: resolveStreamExportersConfig(env),
    warehouse: resolveWarehouseConfig(env),
    leader: resolveLeaderElectionConfig(env),
    webhookDashboard: resolveWebhookDashboardConfig(env),
    eventValidation: resolveEventValidationConfig(env),
    apiKeys: resolveApiKeysConfig(env),
    backfill: resolveBackfillConfig(env),
    runway: resolveRunwayConfig(env),
    anomalies: resolveAnomalyConfig(env),
    lagMonitor: resolveLagMonitorConfig(env, parseIntSafe(env.LEDGER_FINALITY_LAG, DEFAULT_FINALITY_LAG, 0, 1000)),
    finalityLag: parseIntSafe(env.LEDGER_FINALITY_LAG, DEFAULT_FINALITY_LAG, 0, 1000),
    readyMaxStalenessMs: parseIntSafe(
      env.READY_MAX_STALENESS_MS,
      DEFAULT_READY_MAX_STALENESS_MS,
      5000,
      3600000,
    ),
  };
}
