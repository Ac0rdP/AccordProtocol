import { openPostgresStore } from "./postgres.js";
import { openLedgerStore } from "./sqlite.js";

export const STORE_BACKENDS = ["sqlite", "postgres"];

/**
 * Picks the storage backend from the environment. SQLite stays the default so
 * existing deployments are untouched; Postgres is opt-in via `STORE_BACKEND`.
 */
export function resolveStoreConfig(env = process.env) {
  const backend = (env.STORE_BACKEND?.trim() || "sqlite").toLowerCase();
  if (!STORE_BACKENDS.includes(backend)) {
    throw new Error(`STORE_BACKEND must be one of: ${STORE_BACKENDS.join(", ")}`);
  }
  if (backend === "sqlite") {
    return { backend, databasePath: env.DATABASE_PATH ?? "./data/treasury.sqlite" };
  }

  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL must be set when STORE_BACKEND=postgres");
  const poolMax = Number(env.DATABASE_POOL_MAX ?? 10);
  if (!Number.isSafeInteger(poolMax) || poolMax < 1) {
    throw new Error("DATABASE_POOL_MAX must be a positive integer");
  }
  return {
    backend,
    connectionString,
    poolMax,
    migrate: (env.DATABASE_AUTO_MIGRATE ?? "true").toLowerCase() !== "false",
  };
}

/**
 * Opens the configured store.
 *
 * Every store exposes the same async interface:
 *
 *   ping()
 *   recordTransfer(entry) -> boolean            false when `eventId` was already recorded
 *   getBalance(token) -> string
 *   getEntries({token, from, to, limit, offset})
 *   recordAccordEvent(entry) -> boolean         false when `eventId` was already recorded
 *   getAccordEvents({topic, from, to, limit, offset})
 *   setState(key, value) / getState(key)        string checkpoints, null when unset
 *   recordReconciliation(result) / getLatestReconciliations()
 *   recomputeBalances() / rewindToLedger(ledger) / clearHistory()
 *   getLatestAccordEventId() / getAccordEventsAfter(id, limit)
 *   enqueueWebhookDeliveries / claimDueWebhookDeliveries / completeWebhookDelivery
 *   countWebhookDeliveries / listWebhookDeliveries / requeueDeadWebhookDeliveries
 *   upsertNotificationDestination / listNotificationDestinations
 *   getNotificationDestination / deleteNotificationDestination
 *   enqueueNotificationDeliveries / claimDueNotificationDeliveries / completeNotificationDelivery
 *   countNotificationDeliveries / listNotificationDeliveries / requeueDeadNotificationDeliveries
 *   close()
 *
 * plus a `backend` string. Timestamps are ISO 8601 strings on both backends.
 */
export async function openStore(config = resolveStoreConfig()) {
  if (config.backend === "postgres") return openPostgresStore(config);
  return openLedgerStore(config.databasePath);
}

export { openLedgerStore, openPostgresStore };
