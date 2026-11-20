import pg from "pg";
import { migratePostgres } from "./migrations.js";
import { foldDeliverySummary } from "./sqlite.js";

// Serializes writers that fold running balances, mirroring SQLite's BEGIN IMMEDIATE.
const LEDGER_LOCK_ID = 7_243_002;

const toLease = (row) => ({
  name: row.name,
  holderId: row.holder_id,
  region: row.region,
  fencingToken: Number(row.fencing_token),
  acquiredAt: iso(row.acquired_at),
  renewedAt: iso(row.renewed_at),
  expiresAt: iso(row.expires_at),
});

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

  const apiKeyColumns = `id, name, scopes, quota_limit, quota_window_seconds, status, created_at, updated_at,
    expires_at, rotated_at, revoked_at, previous_expires_at, previous_secret_hash IS NOT NULL AS has_previous_secret`;

  function toApiKey(row, withSecrets) {
    return {
      id: row.id,
      name: row.name,
      scopes: JSON.parse(row.scopes),
      quotaLimit: row.quota_limit,
      quotaWindowSeconds: row.quota_window_seconds,
      status: row.status,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      expiresAt: iso(row.expires_at),
      rotatedAt: iso(row.rotated_at),
      revokedAt: iso(row.revoked_at),
      previousExpiresAt: iso(row.previous_expires_at),
      hasPreviousSecret: Boolean(row.has_previous_secret),
      ...(withSecrets ? { secretHash: row.secret_hash, previousSecretHash: row.previous_secret_hash } : {}),
    };
  }

  async function selectApiKey(id) {
    const { rows } = await pool.query(
      `SELECT ${apiKeyColumns}, secret_hash, previous_secret_hash FROM api_keys WHERE id = $1`,
      [id]
    );
    return rows[0] ? toApiKey(rows[0], true) : null;
  }

  async function selectLease(name) {
    const { rows } = await pool.query(
      `SELECT name, holder_id, region, fencing_token, acquired_at, renewed_at, expires_at
       FROM indexer_leases WHERE name = $1`,
      [name]
    );
    return rows[0] ? toLease(rows[0]) : null;
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
      replayCount: row.replay_count,
      lastReplayedAt: iso(row.last_replayed_at),
    };
  }

  const deliveryColumns = `id, subscription_id, event_id, body, status, attempts, next_attempt_at,
    last_error, last_status_code, created_at, delivered_at, replay_count, last_replayed_at`;

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
        // Re-ingested (and re-quarantined if still invalid) together with the rewound range.
        await client.query("DELETE FROM quarantined_events WHERE ledger > $1", [target]);
        await replayBalances(client);
        return { removedEntries: entries.rowCount, removedEvents: events.rowCount };
      }, { lockLedger: true });
    },

    async clearHistory() {
      return withTransaction(async (client) => {
        const entries = await client.query("DELETE FROM ledger_entries");
        const events = await client.query("DELETE FROM accord_events");
        await client.query("DELETE FROM quarantined_events");
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

    async completeWebhookDelivery({ id, outcome, attempts, nextAttemptAt, statusCode, error, durationMs, now }) {
      const status = outcome === "delivered" ? "delivered" : outcome === "dead" ? "dead" : "pending";
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE webhook_deliveries SET status = $1, attempts = $2, next_attempt_at = $3,
             last_error = $4, last_status_code = $5, updated_at = $6,
             delivered_at = CASE WHEN $1 = 'delivered' THEN $6::timestamptz ELSE delivered_at END
           WHERE id = $7`,
          [status, attempts, nextAttemptAt ?? now, error ?? null, statusCode ?? null, now, id]
        );
        // One history row per attempt, written with the outcome so the two never disagree.
        await client.query(
          `INSERT INTO webhook_delivery_attempts (
             delivery_id, attempt, replay_round, outcome, status_code, error, duration_ms, attempted_at
           ) SELECT id, $2, replay_count, $3, $4, $5, $6, $7 FROM webhook_deliveries WHERE id = $1`,
          [id, attempts, outcome === "delivered" || outcome === "dead" ? outcome : "retry",
            statusCode ?? null, error ?? null, durationMs ?? null, now]
        );
      });
    },

    async countWebhookDeliveries() {
      const counts = { pending: 0, delivered: 0, dead: 0 };
      const { rows } = await pool.query("SELECT status, COUNT(*) AS count FROM webhook_deliveries GROUP BY status");
      for (const row of rows) counts[row.status] = Number(row.count);
      return counts;
    },

    async listWebhookDeliveries({ status, subscriptionId, eventId, order = "asc", limit, offset }) {
      const values = [];
      const where = filterClause(
        [["status", "=", status], ["subscription_id", "=", subscriptionId], ["event_id", "=", eventId]],
        values
      );
      const direction = order === "desc" ? "DESC" : "ASC";
      const { rows } = await pool.query(
        `SELECT ${deliveryColumns} FROM webhook_deliveries ${where}
         ORDER BY id ${direction} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset]
      );
      return rows.map(toDelivery);
    },

    async getWebhookDelivery(id) {
      const { rows } = await pool.query(`SELECT ${deliveryColumns} FROM webhook_deliveries WHERE id = $1`, [id]);
      return rows[0] ? toDelivery(rows[0]) : null;
    },

    async listWebhookDeliveryAttempts(deliveryId) {
      const { rows } = await pool.query(
        `SELECT id, delivery_id, attempt, replay_round, outcome, status_code, error, duration_ms, attempted_at
         FROM webhook_delivery_attempts WHERE delivery_id = $1 ORDER BY id ASC`,
        [deliveryId]
      );
      return rows.map((row) => ({
        id: Number(row.id),
        deliveryId: Number(row.delivery_id),
        attempt: row.attempt,
        replayRound: row.replay_round,
        outcome: row.outcome,
        statusCode: row.status_code,
        error: row.error,
        durationMs: row.duration_ms,
        attemptedAt: iso(row.attempted_at),
      }));
    },

    async summarizeWebhookDeliveries() {
      const { rows } = await pool.query(
        `SELECT subscription_id, status, COUNT(*) AS count, MIN(created_at) AS oldest_at,
           COALESCE(SUM(replay_count), 0) AS replays
         FROM webhook_deliveries GROUP BY subscription_id, status`
      );
      return foldDeliverySummary(rows.map((row) => ({
        subscriptionId: row.subscription_id,
        status: row.status,
        count: Number(row.count),
        oldestAt: iso(row.oldest_at),
        replays: Number(row.replays),
      })));
    },

    /** Same contract as the SQLite store; the row lock keeps concurrent replays from double-counting. */
    async replayWebhookDelivery({ id, now }) {
      return withTransaction(async (client) => {
        const current = await client.query("SELECT status FROM webhook_deliveries WHERE id = $1 FOR UPDATE", [id]);
        if (!current.rows[0]) return { found: false };
        const previousStatus = current.rows[0].status;
        if (previousStatus === "pending") {
          await client.query("UPDATE webhook_deliveries SET next_attempt_at = $2, updated_at = $2 WHERE id = $1", [id, now]);
        } else {
          await client.query(
            `UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = $2, updated_at = $2,
               replay_count = replay_count + 1, last_replayed_at = $2
             WHERE id = $1`,
            [id, now]
          );
        }
        const { rows } = await client.query(`SELECT ${deliveryColumns} FROM webhook_deliveries WHERE id = $1`, [id]);
        return { found: true, previousStatus, delivery: toDelivery(rows[0]) };
      });
    },

    async requeueDeadWebhookDeliveries({ subscriptionId, now }) {
      const { rowCount } = await pool.query(
        `UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = $1, updated_at = $1,
           replay_count = replay_count + 1, last_replayed_at = $1
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

    async setClientCheckpoint({ clientId, query, lastEventId = null, lastLedger = null, now = new Date().toISOString() }) {
      await pool.query(
        `INSERT INTO graphql_client_checkpoints (client_id, query, last_event_id, last_ledger, connected_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (client_id) DO UPDATE SET
           query = EXCLUDED.query,
           last_event_id = EXCLUDED.last_event_id,
           last_ledger = EXCLUDED.last_ledger,
           updated_at = EXCLUDED.updated_at`,
        [clientId, query, lastEventId, lastLedger, now]
      );
      return true;
    },

    async getClientCheckpoint(clientId) {
      const { rows } = await pool.query(
        `SELECT client_id, query, last_event_id, last_ledger, connected_at, updated_at
         FROM graphql_client_checkpoints WHERE client_id = $1`,
        [clientId]
      );
      if (!rows[0]) return null;
      return {
        clientId: rows[0].client_id,
        query: rows[0].query,
        lastEventId: rows[0].last_event_id,
        lastLedger: rows[0].last_ledger,
        connectedAt: rows[0].connected_at,
        updatedAt: rows[0].updated_at,
      };
    },

    async setStreamCheckpoint({ exporter, lastEventId = null, lastLedger = null, eventsPublished = 0, now = new Date().toISOString() }) {
      await pool.query(
        `INSERT INTO stream_exporter_checkpoints (exporter, last_event_id, last_ledger, events_published, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (exporter) DO UPDATE SET
           last_event_id = EXCLUDED.last_event_id,
           last_ledger = EXCLUDED.last_ledger,
           events_published = EXCLUDED.events_published,
           updated_at = EXCLUDED.updated_at`,
        [exporter, lastEventId, lastLedger, eventsPublished, now]
      );
      return true;
    },

    async getStreamCheckpoint(exporter) {
      const { rows } = await pool.query(
        `SELECT exporter, last_event_id, last_ledger, events_published, updated_at
         FROM stream_exporter_checkpoints WHERE exporter = $1`,
        [exporter]
      );
      if (!rows[0]) return null;
      return {
        exporter: rows[0].exporter,
        lastEventId: rows[0].last_event_id,
        lastLedger: rows[0].last_ledger,
        eventsPublished: Number(rows[0].events_published),
        updatedAt: rows[0].updated_at,
      };
    },

    async setWarehouseCheckpoint({ warehouse, tableName, lastExportedId = 0, lastLedger = null, rowsExported = 0, schemaVersion = 1, now = new Date().toISOString() }) {
      await pool.query(
        `INSERT INTO warehouse_export_checkpoints (warehouse, table_name, last_exported_id, last_ledger, rows_exported, schema_version, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (warehouse, table_name) DO UPDATE SET
           last_exported_id = EXCLUDED.last_exported_id,
           last_ledger = EXCLUDED.last_ledger,
           rows_exported = warehouse_export_checkpoints.rows_exported + EXCLUDED.rows_exported,
           schema_version = EXCLUDED.schema_version,
           updated_at = EXCLUDED.updated_at`,
        [warehouse, tableName, lastExportedId, lastLedger, rowsExported, schemaVersion, now]
      );
      return true;
    },

    async getWarehouseCheckpoint(warehouse, tableName) {
      const { rows } = await pool.query(
        `SELECT warehouse, table_name, last_exported_id, last_ledger, rows_exported, schema_version, updated_at
         FROM warehouse_export_checkpoints WHERE warehouse = $1 AND table_name = $2`,
        [warehouse, tableName]
      );
      if (!rows[0]) return null;
      return {
        warehouse: rows[0].warehouse,
        tableName: rows[0].table_name,
        lastExportedId: Number(rows[0].last_exported_id),
        lastLedger: rows[0].last_ledger,
        rowsExported: Number(rows[0].rows_exported),
        schemaVersion: rows[0].schema_version,
        updatedAt: rows[0].updated_at,
      };
    },

    /** Same contract as the SQLite store. */
    async quarantineEvent(record) {
      const now = record.now ?? new Date().toISOString();
      const { rowCount } = await pool.query(
        `INSERT INTO quarantined_events (
           dedupe_key, event_id, contract_id, topic, schema_version, reason, errors, raw,
           ledger, transaction_hash, occurred_at, status, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'quarantined', $12, $12)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [
          record.dedupeKey, record.eventId, record.contractId ?? null, record.topic ?? null,
          record.schemaVersion ?? null, record.reason, JSON.stringify(record.errors ?? []),
          JSON.stringify(record.raw ?? {}), record.ledger, record.transactionHash ?? null,
          record.occurredAt, now,
        ]
      );
      return rowCount > 0;
    },

    async listQuarantinedEvents({ status, reason, topic, afterId, order = "desc", limit, offset = 0, includeRaw = false }) {
      const values = [];
      const where = filterClause([["status", "=", status], ["reason", "=", reason], ["topic", "=", topic]], values);
      let condition = where;
      if (afterId) {
        values.push(afterId);
        condition = `${where ? `${where} AND` : "WHERE"} id > $${values.length}`;
      }
      const { rows } = await pool.query(
        `SELECT id, dedupe_key, event_id, contract_id, topic, schema_version, reason, errors, raw, ledger,
           transaction_hash, occurred_at, status, created_at, resolved_at
         FROM quarantined_events ${condition} ORDER BY id ${order === "asc" ? "ASC" : "DESC"}
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset]
      );
      return rows.map((row) => ({
        id: Number(row.id),
        dedupeKey: row.dedupe_key,
        eventId: row.event_id,
        contractId: row.contract_id,
        topic: row.topic,
        schemaVersion: row.schema_version === null ? null : Number(row.schema_version),
        reason: row.reason,
        errors: JSON.parse(row.errors),
        ...(includeRaw ? { raw: JSON.parse(row.raw) } : {}),
        ledger: row.ledger,
        transactionHash: row.transaction_hash,
        occurredAt: iso(row.occurred_at),
        status: row.status,
        createdAt: iso(row.created_at),
        resolvedAt: iso(row.resolved_at),
      }));
    },

    async countQuarantinedEvents() {
      const counts = { quarantined: 0, released: 0, discarded: 0, byReason: {} };
      const byStatus = await pool.query("SELECT status, COUNT(*) AS count FROM quarantined_events GROUP BY status");
      for (const row of byStatus.rows) counts[row.status] = Number(row.count);
      const byReason = await pool.query(
        "SELECT reason, COUNT(*) AS count FROM quarantined_events WHERE status = 'quarantined' GROUP BY reason"
      );
      for (const row of byReason.rows) counts.byReason[row.reason] = Number(row.count);
      return counts;
    },

    async resolveQuarantinedEvent({ id, dedupeKey, status, now = new Date().toISOString() }) {
      if (!["released", "discarded"].includes(status)) throw new Error("status must be released or discarded");
      const { rowCount } = id !== undefined
        ? await pool.query(
            "UPDATE quarantined_events SET status = $1, updated_at = $2, resolved_at = $2 WHERE id = $3 AND status = 'quarantined'",
            [status, now, id]
          )
        : await pool.query(
            "UPDATE quarantined_events SET status = $1, updated_at = $2, resolved_at = $2 WHERE dedupe_key = $3 AND status = 'quarantined'",
            [status, now, dedupeKey]
          );
      return rowCount > 0;
    },

    /** The API-key methods below follow the SQLite store's contract. */
    async createApiKey({ id, name, secretHash, scopes, quotaLimit, quotaWindowSeconds, expiresAt = null, now }) {
      const { rowCount } = await pool.query(
        `INSERT INTO api_keys (id, name, secret_hash, scopes, quota_limit, quota_window_seconds, status,
           created_at, updated_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [id, name, secretHash, JSON.stringify(scopes), quotaLimit, quotaWindowSeconds, now, expiresAt]
      );
      return rowCount > 0;
    },

    async getApiKey(id) {
      return selectApiKey(id);
    },

    async listApiKeys({ status, limit, offset }) {
      const values = [];
      const where = filterClause([["status", "=", status]], values);
      const { rows } = await pool.query(
        `SELECT ${apiKeyColumns} FROM api_keys ${where}
         ORDER BY created_at ASC, id ASC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset]
      );
      return rows.map((row) => toApiKey(row, false));
    },

    async rotateApiKey({ id, secretHash, graceUntil = null, now }) {
      const { rowCount } = await pool.query(
        `UPDATE api_keys SET
           previous_secret_hash = CASE WHEN $2::timestamptz IS NULL THEN NULL ELSE secret_hash END,
           previous_expires_at = $2, secret_hash = $3, rotated_at = $4, updated_at = $4
         WHERE id = $1 AND status = 'active'`,
        [id, graceUntil, secretHash, now]
      );
      return rowCount > 0 ? selectApiKey(id) : null;
    },

    async revokeApiKey({ id, now }) {
      const { rowCount } = await pool.query(
        `UPDATE api_keys SET status = 'revoked', revoked_at = $2, updated_at = $2,
           previous_secret_hash = NULL, previous_expires_at = NULL
         WHERE id = $1 AND status = 'active'`,
        [id, now]
      );
      const found = rowCount > 0 || (await pool.query("SELECT 1 FROM api_keys WHERE id = $1", [id])).rowCount > 0;
      return { found, changed: rowCount > 0 };
    },

    async consumeApiKeyQuota({ keyId, windowStart, limit, now }) {
      const { rows } = await pool.query(
        `INSERT INTO api_key_usage AS usage (key_id, window_start, request_count, updated_at) VALUES ($1, $2, 1, $3)
         ON CONFLICT (key_id, window_start) DO UPDATE SET
           request_count = usage.request_count + 1, updated_at = EXCLUDED.updated_at
         WHERE usage.request_count < $4
         RETURNING request_count`,
        [keyId, windowStart, now, limit]
      );
      if (rows[0]) return { allowed: true, used: Number(rows[0].request_count) };
      const current = await pool.query(
        "SELECT request_count FROM api_key_usage WHERE key_id = $1 AND window_start = $2",
        [keyId, windowStart]
      );
      return { allowed: false, used: Number(current.rows[0]?.request_count ?? limit) };
    },

    async pruneApiKeyUsage({ before }) {
      const { rowCount } = await pool.query("DELETE FROM api_key_usage WHERE window_start < $1", [before]);
      return rowCount;
    },

    /** Same contract as the SQLite store; the upsert is a single atomic statement. */
    async acquireLease({ name, holderId, region = "", ttlMs, now = new Date().toISOString() }) {
      const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
      const { rows } = await pool.query(
        `INSERT INTO indexer_leases AS lease (name, holder_id, region, fencing_token, acquired_at, renewed_at, expires_at)
         VALUES ($1, $2, $3, 1, $4, $4, $5)
         ON CONFLICT (name) DO UPDATE SET
           fencing_token = CASE
             WHEN lease.holder_id = EXCLUDED.holder_id AND lease.expires_at > EXCLUDED.renewed_at
             THEN lease.fencing_token ELSE lease.fencing_token + 1 END,
           acquired_at = CASE
             WHEN lease.holder_id = EXCLUDED.holder_id AND lease.expires_at > EXCLUDED.renewed_at
             THEN lease.acquired_at ELSE EXCLUDED.acquired_at END,
           holder_id = EXCLUDED.holder_id,
           region = EXCLUDED.region,
           renewed_at = EXCLUDED.renewed_at,
           expires_at = EXCLUDED.expires_at
         WHERE lease.holder_id = EXCLUDED.holder_id OR lease.expires_at <= EXCLUDED.renewed_at
         RETURNING name, holder_id, region, fencing_token, acquired_at, renewed_at, expires_at`,
        [name, holderId, region, now, expiresAt]
      );
      if (rows[0]) return { acquired: true, lease: toLease(rows[0]) };
      return { acquired: false, lease: await selectLease(name) };
    },

    async getLease(name) {
      return selectLease(name);
    },

    async releaseLease({ name, holderId, now = new Date().toISOString() }) {
      const { rowCount } = await pool.query(
        "UPDATE indexer_leases SET expires_at = $3 WHERE name = $1 AND holder_id = $2 AND expires_at > $3",
        [name, holderId, now]
      );
      return rowCount > 0;
    },

    async close() {
      await pool.end();
    },
  };
}
