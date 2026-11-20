/**
 * Centralized indexer configuration parser and validator.
 *
 * Exposes typed, structured configuration with safe defaults for:
 *   - Core indexer (RPC, chain, store, finality)
 *   - GraphQL live event subscriptions (push updates without polling)
 *   - Event stream exporters (Kafka, NATS)
 *   - Data warehouse connectors (BigQuery, Snowflake)
 *   - Parallel backfill (workers, shard size, retries)
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
 * Full consolidated indexer configuration.
 */
export function loadIndexerConfig(env = process.env) {
  return {
    graphql: resolveGraphQLConfig(env),
    streams: resolveStreamExportersConfig(env),
    warehouse: resolveWarehouseConfig(env),
    backfill: resolveBackfillConfig(env),
    finalityLag: parseIntSafe(env.LEDGER_FINALITY_LAG, DEFAULT_FINALITY_LAG, 0, 1000),
    readyMaxStalenessMs: parseIntSafe(
      env.READY_MAX_STALENESS_MS,
      DEFAULT_READY_MAX_STALENESS_MS,
      5000,
      3600000,
    ),
  };
}
