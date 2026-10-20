import pg from "pg";
import { migratePostgres } from "./migrations.js";

// Serializes writers that fold running balances, mirroring SQLite's BEGIN IMMEDIATE.
const LEDGER_LOCK_ID = 7_243_002;

const iso = (value) => (value === null || value === undefined ? null : new Date(value).toISOString());

/**
 * Postgres implementation of the indexer store. Same contract as the SQLite
 * store (see `./index.js`); the schema is owned by `migrations/postgres/`.
 *
 * @param {object} options
 * @param {string} options.connectionString  libpq-style URL
 * @param {string} [options.schema]  confine the store to one schema (created if missing)
 * @param {number} [options.poolMax]  maximum pooled connections (default 10)
 * @param {boolean} [options.migrate]  apply pending migrations on open (default true)
 */
export async function openPostgresStore({ connectionString, schema, poolMax = 10, migrate = true }) {
  if (!connectionString) throw new Error("DATABASE_URL must be set for the postgres store");
  if (schema !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error("postgres schema must be a plain identifier");
  }

  if (schema) {
    const bootstrap = new pg.Client({ connectionString });
    await bootstrap.connect();
    try {
      await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    } finally {
      await bootstrap.end();
    }
  }

  const pool = new pg.Pool({
    connectionString,
    max: poolMax,
    ...(schema ? { options: `-c search_path="${schema}"` } : {}),
  });
  // An idle client dropping (server restart) must not crash the process; the
  // next query checks out a fresh connection.
  pool.on("error", (error) => console.error("postgres pool error:", error.message));

  try {
    if (migrate) await migratePostgres(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }

  async function withTransaction(work, { lockLedger = false } = {}) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (lockLedger) await client.query("SELECT pg_advisory_xact_lock($1)", [LEDGER_LOCK_ID]);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // Set-based equivalent of the SQLite replay: one window-function pass folds
  // the running balance per token in canonical chain order (ledger, id).
  async function replayBalances(client) {
    await client.query("DELETE FROM token_balances");
    await client.query(`
      UPDATE ledger_entries AS entry SET balance = folded.balance
      FROM (
        SELECT id, (SUM(CASE WHEN direction = 'inflow' THEN amount::numeric ELSE -amount::numeric END)
          OVER (PARTITION BY token ORDER BY ledger ASC, id ASC))::text AS balance
        FROM ledger_entries
      ) AS folded
      WHERE entry.id = folded.id
    `);
    const { rowCount } = await client.query(`
      INSERT INTO token_balances (token, balance)
      SELECT token, SUM(CASE WHEN direction = 'inflow' THEN amount::numeric ELSE -amount::numeric END)::text
      FROM ledger_entries GROUP BY token
    `);
    return rowCount;
  }

  function filterClause(columns, values) {
    const clauses = [];
    const params = [];
    for (const [column, operator, value] of columns) {
      if (!value) continue;
      params.push(value);
      clauses.push(`${column} ${operator} $${params.length}`);
    }
    values.push(...params);
    return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  }

  function toDelivery(row) {
    return {
      id: Number(row.id),
      subscriptionId: row.subscription_id,
      eventId: row.event_id,
      body: row.body,
      status: row.status,
      attempts: row.attempts,
      nextAttemptAt: iso(row.next_attempt_at),
      lastError: row.last_error,
      lastStatusCode: row.last_status_code,
      createdAt: iso(row.created_at),
      deliveredAt: iso(row.delivered_at),
    };
  }

  const deliveryColumns = `id, subscription_id, event_id, body, status, attempts, next_attempt_at,
    last_error, last_status_code, created_at, delivered_at`;

  function toNotificationDelivery(row) {
    return {
      id: Number(row.id),
      destinationId: row.destination_id,
      eventId: row.event_id,
      body: row.body,
      status: row.status,
      attempts: row.attempts,
      nextAttemptAt: iso(row.next_attempt_at),
      lastError: row.last_error,
      lastStatusCode: row.last_status_code,
      createdAt: iso(row.created_at),
      deliveredAt: iso(row.delivered_at),
    };
  }

  const notificationDeliveryColumns = `id, destination_id, event_id, body, status, attempts, next_attempt_at,
    last_error, last_status_code, created_at, delivered_at`;

  function toDestination(row) {
    return {
      id: row.id,
      kind: row.kind,
      config: typeof row.config === "string" ? JSON.parse(row.config) : row.config,
      topics: row.topics ? (typeof row.topics === "string" ? JSON.parse(row.topics) : row.topics) : null,
      enabled: Boolean(row.enabled),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  return {
    backend: "postgres",

    async ping() {
      await pool.query("SELECT 1");
    },

    async recordTransfer(entry) {
      const amount = BigInt(entry.amount);
      if (amount <= 0n) throw new Error("Transfer amount must be positive");

      return withTransaction(async (client) => {
        const duplicate = await client.query(
          "SELECT 1 FROM ledger_entries WHERE event_id = $1 OR dedupe_key = $2",
          [entry.eventId, entry.dedupeKey ?? null]
        );
        if (duplicate.rowCount > 0) return false;

        const current = await client.query("SELECT balance FROM token_balances WHERE token = $1", [entry.token]);
        const balanceBefore = BigInt(current.rows[0]?.balance ?? "0");
        const balanceAfter = balanceBefore + (entry.direction === "inflow" ? amount : -amount);

        await client.query(
          `INSERT INTO ledger_entries (
             event_id, token, token_address, direction, amount, balance, ledger,
             transaction_hash, occurred_at, from_address, to_address, dedupe_key
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            entry.eventId,
            entry.token,
            entry.tokenAddress,
            entry.direction,
            amount.toString(),
            balanceAfter.toString(),
            entry.ledger,
            entry.transactionHash ?? null,
            entry.occurredAt,
            entry.from,
            entry.to,
            entry.dedupeKey ?? null,
          ]
        );
        await client.query(
          `INSERT INTO token_balances (token, balance) VALUES ($1, $2)
           ON CONFLICT (token) DO UPDATE SET balance = EXCLUDED.balance`,
          [entry.token, balanceAfter.toString()]
        );
        return true;
      }, { lockLedger: true });
    },

    async getBalance(token) {
      const { rows } = await pool.query("SELECT balance FROM token_balances WHERE token = $1", [token]);
      return rows[0]?.balance ?? "0";
    },

    async getEntries({ token, from, to, limit, offset }) {
      const values = [];
      const where = filterClause(
        [["token", "=", token], ["occurred_at", ">=", from], ["occurred_at", "<=", to]],
        values
      );
      const { rows } = await pool.query(
        `SELECT event_id, token, token_address, direction, amount, balance, ledger,
           transaction_hash, occurred_at, from_address, to_address
         FROM ledger_entries ${where}
         ORDER BY ledger ASC, id ASC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset]
      );
      return rows.map((row) => ({
        eventId: row.event_id,
        token: row.token,
        tokenAddress: row.token_address,
        direction: row.direction,
        amount: row.amount,
        balance: row.balance,
        ledger: row.ledger,
        transactionHash: row.transaction_hash,
        occurredAt: iso(row.occurred_at),
        from: row.from_address,
        to: row.to_address,
      }));
    },

    async recordAccordEvent(entry) {
      const { rowCount } = await pool.query(
        `INSERT INTO accord_events (event_id, topic, payload, ledger, transaction_hash, occurred_at, schema_version, dedupe_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
        [
          entry.eventId,
          entry.topic,
          JSON.stringify(entry.payload),
          entry.ledger,
          entry.transactionHash ?? null,
          entry.occurredAt,
          entry.schemaVersion ?? null,
          entry.dedupeKey ?? null,
        ]
      );
      return rowCount > 0;
    },

    async getAccordEvents({ topic, from, to, limit, offset }) {
      const values = [];
      const where = filterClause(
        [["topic", "=", topic], ["occurred_at", ">=", from], ["occurred_at", "<=", to]],
        values
      );
      const { rows } = await pool.query(
        `SELECT event_id, topic, payload, ledger, transaction_hash, occurred_at, schema_version
         FROM accord_events ${where}
         ORDER BY ledger ASC, id ASC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset]
      );
      return rows.map((row) => ({
        eventId: row.event_id,
        topic: row.topic,
        payload: row.payload,
        ledger: row.ledger,
        transactionHash: row.transaction_hash,
        occurredAt: iso(row.occurred_at),
        schemaVersion: row.schema_version,
      }));
    },

    async setState(key, value) {
      await pool.query(
        `INSERT INTO indexer_state (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, String(value)]
      );
    },

    async getState(key) {
      const { rows } = await pool.query("SELECT value FROM indexer_state WHERE key = $1", [key]);
      return rows[0]?.value ?? null;
    },

    async recordReconciliation(result) {
      await pool.query(
        `INSERT INTO reconciliation_results (
           token, token_address, checked_at, implied_balance, actual_balance, drift
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [result.token, result.tokenAddress, result.checkedAt, result.impliedBalance, result.actualBalance, result.drift]
      );
    },

    async getLatestReconciliations() {
      const { rows } = await pool.query(`
        SELECT DISTINCT ON (token) token, token_address, checked_at, implied_balance, actual_balance, drift
        FROM reconciliation_results ORDER BY token, id DESC
      `);
      return rows.map((row) => ({
        token: row.token,
        tokenAddress: row.token_address,
        checkedAt: iso(row.checked_at),
        impliedBalance: row.implied_balance,
        actualBalance: row.actual_balance,
        drift: row.drift,
      }));
    },

    async recomputeBalances() {
      return withTransaction(replayBalances, { lockLedger: true });
    },

    async rewindToLedger(ledger) {
      const target = Number(ledger);
      if (!Number.isSafeInteger(target) || target < 0) {
        throw new Error("rewind target must be a non-negative integer");
      }
      return withTransaction(async (client) => {
        const entries = await client.query("DELETE FROM ledger_entries WHERE ledger > $1", [target]);
        const events = await client.query("DELETE FROM accord_events WHERE ledger > $1", [target]);
        await replayBalances(client);
        return { removedEntries: entries.rowCount, removedEvents: events.rowCount };
      }, { lockLedger: true });
    },

    async clearHistory() {
      return withTransaction(async (client) => {
        const entries = await client.query("DELETE FROM ledger_entries");
        const events = await client.query("DELETE FROM accord_events");
        const reconciliations = await client.query("DELETE FROM reconciliation_results");
        await client.query("DELETE FROM token_balances");
        await client.query("DELETE FROM indexer_state WHERE key LIKE 'webhook\\_cursor:%'");
        await client.query("DELETE FROM indexer_state WHERE key LIKE 'notification\\_cursor:%'");
        return {
          removedEntries: entries.rowCount,
          removedEvents: events.rowCount,
          removedReconciliations: reconciliations.rowCount,
        };
      }, { lockLedger: true });
    },

    async getLatestAccordEventId() {
      const { rows } = await pool.query("SELECT COALESCE(MAX(id), 0) AS id FROM accord_events");
      return Number(rows[0].id);
    },

    async getAccordEventsAfter(afterId, limit) {
      const { rows } = await pool.query(
        `SELECT id, event_id, topic, payload, ledger, transaction_hash, occurred_at, schema_version
         FROM accord_events WHERE id > $1 ORDER BY id ASC LIMIT $2`,
        [afterId, limit]
      );
      return rows.map((row) => ({
        id: Number(row.id),
        eventId: row.event_id,
        topic: row.topic,
        payload: row.payload,
        ledger: row.ledger,
        transactionHash: row.transaction_hash,
        occurredAt: iso(row.occurred_at),
        schemaVersion: row.schema_version,
      }));
    },

    async enqueueWebhookDeliveries({ subscriptionId, deliveries, cursor, now }) {
      return withTransaction(async (client) => {
        let inserted = 0;
        for (const { eventId, body } of deliveries) {
          const result = await client.query(
            `INSERT INTO webhook_deliveries (
               subscription_id, event_id, body, status, attempts, next_attempt_at, created_at, updated_at
             ) VALUES ($1, $2, $3, 'pending', 0, $4, $4, $4)
             ON CONFLICT (subscription_id, event_id) DO NOTHING`,
            [subscriptionId, eventId, body, now]
          );
          inserted += result.rowCount;
        }
        await client.query(
          `INSERT INTO indexer_state (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [`webhook_cursor:${subscriptionId}`, String(cursor)]
        );
        return inserted;
      });
    },

    async claimDueWebhookDeliveries({ now, limit }) {
      const { rows } = await pool.query(
        `SELECT ${deliveryColumns} FROM webhook_deliveries
         WHERE status = 'pending' AND next_attempt_at <= $1 ORDER BY id ASC LIMIT $2`,
        [now, limit]
      );
      return rows.map(toDelivery);
    },

    async completeWebhookDelivery({ id, outcome, attempts, nextAttemptAt, statusCode, error, now }) {
      const status = outcome === "delivered" ? "delivered" : outcome === "dead" ? "dead" : "pending";
      await pool.query(
        `UPDATE webhook_deliveries SET status = $1, attempts = $2, next_attempt_at = $3,
           last_error = $4, last_status_code = $5, updated_at = $6,
           delivered_at = CASE WHEN $1 = 'delivered' THEN $6::timestamptz ELSE delivered_at END
         WHERE id = $7`,
        [status, attempts, nextAttemptAt ?? now, error ?? null, statusCode ?? null, now, id]
      );
    },

    async countWebhookDeliveries() {
      const counts = { pending: 0, delivered: 0, dead: 0 };
      const { rows } = await pool.query("SELECT status, COUNT(*) AS count FROM webhook_deliveries GROUP BY status");
      for (const row of rows) counts[row.status] = Number(row.count);
      return counts;
    },

    async listWebhookDeliveries({ status, subscriptionId, limit, offset }) {
      const values = [];
      const where = filterClause([["status", "=", status], ["subscription_id", "=", subscriptionId]], values);
      const { rows } = await pool.query(
        `SELECT ${deliveryColumns} FROM webhook_deliveries ${where}
         ORDER BY id ASC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset]
      );
      return rows.map(toDelivery);
    },

    async requeueDeadWebhookDeliveries({ subscriptionId, now }) {
      const { rowCount } = await pool.query(
        `UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = $1, updated_at = $1
         WHERE status = 'dead' AND ($2::text IS NULL OR subscription_id = $2)`,
        [now, subscriptionId ?? null]
      );
      return rowCount;
    },

    async upsertNotificationDestination({ id, kind, config, topics, enabled, now }) {
      await pool.query(
        `INSERT INTO notification_destinations (id, kind, config, topics, enabled, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (id) DO UPDATE SET
           kind = $2, config = $3, topics = $4, enabled = $5, updated_at = $6`,
        [id, kind, JSON.stringify(config), topics ? JSON.stringify(topics) : null, Boolean(enabled), now]
      );
    },

    async listNotificationDestinations() {
      const { rows } = await pool.query(
        `SELECT id, kind, config, topics, enabled, created_at, updated_at
         FROM notification_destinations ORDER BY id ASC`
      );
      return rows.map(toDestination);
    },

    async getNotificationDestination(id) {
      const { rows } = await pool.query(
        `SELECT id, kind, config, topics, enabled, created_at, updated_at
         FROM notification_destinations WHERE id = $1`,
        [id]
      );
      return rows[0] ? toDestination(rows[0]) : null;
    },

    async deleteNotificationDestination(id) {
      const { rowCount } = await pool.query("DELETE FROM notification_destinations WHERE id = $1", [id]);
      return rowCount > 0;
    },

    async enqueueNotificationDeliveries({ destinationId, deliveries, cursor, now }) {
      return withTransaction(async (client) => {
        let inserted = 0;
        for (const { eventId, body } of deliveries) {
          const result = await client.query(
            `INSERT INTO notification_deliveries (
               destination_id, event_id, body, status, attempts, next_attempt_at, created_at, updated_at
             ) VALUES ($1, $2, $3, 'pending', 0, $4, $4, $4)
             ON CONFLICT (destination_id, event_id) DO NOTHING`,
            [destinationId, eventId, body, now]
          );
          inserted += result.rowCount;
        }
        await client.query(
          `INSERT INTO indexer_state (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [`notification_cursor:${destinationId}`, String(cursor)]
        );
        return inserted;
      });
    },

    async claimDueNotificationDeliveries({ now, limit }) {
      const { rows } = await pool.query(
        `SELECT ${notificationDeliveryColumns} FROM notification_deliveries
         WHERE status = 'pending' AND next_attempt_at <= $1 ORDER BY id ASC LIMIT $2`,
        [now, limit]
      );
      return rows.map(toNotificationDelivery);
    },

    async completeNotificationDelivery({ id, outcome, attempts, nextAttemptAt, statusCode, error, now }) {
      const status = outcome === "delivered" ? "delivered" : outcome === "dead" ? "dead" : "pending";
      await pool.query(
        `UPDATE notification_deliveries SET status = $1, attempts = $2, next_attempt_at = $3,
           last_error = $4, last_status_code = $5, updated_at = $6,
           delivered_at = CASE WHEN $1 = 'delivered' THEN $6::timestamptz ELSE delivered_at END
         WHERE id = $7`,
        [status, attempts, nextAttemptAt ?? now, error ?? null, statusCode ?? null, now, id]
      );
    },

    async countNotificationDeliveries() {
      const counts = { pending: 0, delivered: 0, dead: 0 };
      const { rows } = await pool.query("SELECT status, COUNT(*) AS count FROM notification_deliveries GROUP BY status");
      for (const row of rows) counts[row.status] = Number(row.count);
      return counts;
    },

    async listNotificationDeliveries({ status, destinationId, limit, offset }) {
      const values = [];
      const where = filterClause([["status", "=", status], ["destination_id", "=", destinationId]], values);
      const { rows } = await pool.query(
        `SELECT ${notificationDeliveryColumns} FROM notification_deliveries ${where}
         ORDER BY id ASC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset]
      );
      return rows.map(toNotificationDelivery);
    },

    async requeueDeadNotificationDeliveries({ destinationId, now }) {
      const { rowCount } = await pool.query(
        `UPDATE notification_deliveries SET status = 'pending', attempts = 0, next_attempt_at = $1, updated_at = $1
         WHERE status = 'dead' AND ($2::text IS NULL OR destination_id = $2)`,
        [now, destinationId ?? null]
      );
      return rowCount;
    },

    async close() {
      await pool.end();
    },
  };
}
