import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * SQLite implementation of the indexer store (the default backend).
 *
 * `node:sqlite` is synchronous, but every method is `async` so callers treat
 * it exactly like the Postgres store; see `./index.js` for the shared contract.
 */
export function openLedgerStore(databasePath) {
  const resolvedPath = resolve(databasePath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  const database = new DatabaseSync(resolvedPath);

  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      token TEXT NOT NULL,
      token_address TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('inflow', 'outflow')),
      amount TEXT NOT NULL,
      balance TEXT NOT NULL,
      ledger INTEGER NOT NULL,
      transaction_hash TEXT,
      occurred_at TEXT NOT NULL,
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ledger_entries_time_idx
      ON ledger_entries (occurred_at, id);
    CREATE INDEX IF NOT EXISTS ledger_entries_token_time_idx
      ON ledger_entries (token, occurred_at, id);
    CREATE TABLE IF NOT EXISTS token_balances (
      token TEXT PRIMARY KEY,
      balance TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accord_events (
      id INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      topic TEXT NOT NULL,
      payload TEXT NOT NULL,
      ledger INTEGER NOT NULL,
      transaction_hash TEXT,
      occurred_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS accord_events_time_idx
      ON accord_events (occurred_at, id);
    CREATE INDEX IF NOT EXISTS accord_events_topic_time_idx
      ON accord_events (topic, occurred_at, id);
    CREATE TABLE IF NOT EXISTS indexer_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reconciliation_results (
      id INTEGER PRIMARY KEY,
      token TEXT NOT NULL,
      token_address TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      implied_balance TEXT NOT NULL,
      actual_balance TEXT NOT NULL,
      drift TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reconciliation_token_time_idx
      ON reconciliation_results (token, checked_at DESC);
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id INTEGER PRIMARY KEY,
      subscription_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      last_error TEXT,
      last_status_code INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delivered_at TEXT,
      UNIQUE (subscription_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx
      ON webhook_deliveries (status, next_attempt_at, id);
  `);

  const insertEntry = database.prepare(`
    INSERT INTO ledger_entries (
      event_id, token, token_address, direction, amount, balance, ledger,
      transaction_hash, occurred_at, from_address, to_address
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteEntriesAbove = database.prepare("DELETE FROM ledger_entries WHERE ledger > ?");
  const deleteEventsAbove = database.prepare("DELETE FROM accord_events WHERE ledger > ?");
  const selectEntriesForReplay = database.prepare(
    "SELECT id, token, direction, amount FROM ledger_entries ORDER BY ledger ASC, id ASC"
  );
  const updateEntryBalance = database.prepare(
    "UPDATE ledger_entries SET balance = ? WHERE id = ?"
  );
  const clearTokenBalances = database.prepare("DELETE FROM token_balances");
  const upsertTokenBalance = database.prepare(`
    INSERT INTO token_balances (token, balance) VALUES (?, ?)
    ON CONFLICT(token) DO UPDATE SET balance = excluded.balance
  `);

  // Running balances are a fold over the chain, so inserting an event that
  // belongs to an *older* ledger than what is already stored (a backfill) would
  // fold against the wrong predecessor. Replaying in canonical chain order
  // (ledger ASC, id ASC) rebuilds both the per-row running balance and the
  // cached `token_balances` snapshot. Callers run it inside their own
  // transaction via the store methods below.
  function replayBalances() {
    clearTokenBalances.run();
    const running = new Map();
    for (const row of selectEntriesForReplay.all()) {
      const delta = BigInt(row.amount) * (row.direction === "inflow" ? 1n : -1n);
      const balanceAfter = (running.get(row.token) ?? 0n) + delta;
      running.set(row.token, balanceAfter);
      updateEntryBalance.run(balanceAfter.toString(), row.id);
    }
    for (const [token, balance] of running) {
      upsertTokenBalance.run(token, balance.toString());
    }
    return running.size;
  }
  const insertAccordEvent = database.prepare(`
    INSERT INTO accord_events (
      event_id, topic, payload, ledger, transaction_hash, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const selectBalance = database.prepare(
    "SELECT balance FROM token_balances WHERE token = ?"
  );
  const updateBalance = database.prepare(`
    INSERT INTO token_balances (token, balance) VALUES (?, ?)
    ON CONFLICT(token) DO UPDATE SET balance = excluded.balance
  `);
  const upsertState = database.prepare(`
    INSERT INTO indexer_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const insertDelivery = database.prepare(`
    INSERT INTO webhook_deliveries (
      subscription_id, event_id, body, status, attempts, next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
    ON CONFLICT(subscription_id, event_id) DO NOTHING
  `);

  function inTransaction(work) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  function toDelivery(row) {
    return {
      id: row.id,
      subscriptionId: row.subscriptionId,
      eventId: row.eventId,
      body: row.body,
      status: row.status,
      attempts: row.attempts,
      nextAttemptAt: row.nextAttemptAt,
      lastError: row.lastError,
      lastStatusCode: row.lastStatusCode,
      createdAt: row.createdAt,
      deliveredAt: row.deliveredAt,
    };
  }

  const deliveryColumns = `
    id, subscription_id AS subscriptionId, event_id AS eventId, body, status, attempts,
    next_attempt_at AS nextAttemptAt, last_error AS lastError,
    last_status_code AS lastStatusCode, created_at AS createdAt, delivered_at AS deliveredAt
  `;

  return {
    backend: "sqlite",

    async ping() {
      database.prepare("SELECT 1").get();
    },

    async recordTransfer(entry) {
      const amount = BigInt(entry.amount);
      if (amount <= 0n) throw new Error("Transfer amount must be positive");
      const balanceBefore = BigInt(selectBalance.get(entry.token)?.balance ?? "0");
      const balanceAfter = balanceBefore + (entry.direction === "inflow" ? amount : -amount);

      database.exec("BEGIN IMMEDIATE");
      try {
        insertEntry.run(
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
          entry.to
        );
        updateBalance.run(entry.token, balanceAfter.toString());
        database.exec("COMMIT");
        return true;
      } catch (error) {
        database.exec("ROLLBACK");
        if (String(error.message).includes("UNIQUE constraint failed: ledger_entries.event_id")) {
          return false;
        }
        throw error;
      }
    },

    async getBalance(token) {
      return selectBalance.get(token)?.balance ?? "0";
    },

    async getEntries({ token, from, to, limit, offset }) {
      const clauses = [];
      const values = [];
      if (token) {
        clauses.push("token = ?");
        values.push(token);
      }
      if (from) {
        clauses.push("occurred_at >= ?");
        values.push(from);
      }
      if (to) {
        clauses.push("occurred_at <= ?");
        values.push(to);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      return database.prepare(`
        SELECT event_id AS eventId, token, token_address AS tokenAddress,
          direction, amount, balance, ledger, transaction_hash AS transactionHash,
          occurred_at AS occurredAt, from_address AS "from", to_address AS "to"
        FROM ledger_entries ${where}
        ORDER BY ledger ASC, id ASC LIMIT ? OFFSET ?
      `).all(...values, limit, offset).map((row) => ({ ...row })); // node:sqlite rows have a null prototype
    },

    async recordAccordEvent(entry) {
      try {
        insertAccordEvent.run(
          entry.eventId,
          entry.topic,
          JSON.stringify(entry.payload),
          entry.ledger,
          entry.transactionHash ?? null,
          entry.occurredAt
        );
        return true;
      } catch (error) {
        if (String(error.message).includes("UNIQUE constraint failed: accord_events.event_id")) {
          return false;
        }
        throw error;
      }
    },

    async getAccordEvents({ topic, from, to, limit, offset }) {
      const clauses = [];
      const values = [];
      if (topic) {
        clauses.push("topic = ?");
        values.push(topic);
      }
      if (from) {
        clauses.push("occurred_at >= ?");
        values.push(from);
      }
      if (to) {
        clauses.push("occurred_at <= ?");
        values.push(to);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      return database.prepare(`
        SELECT event_id AS eventId, topic, payload, ledger,
          transaction_hash AS transactionHash, occurred_at AS occurredAt
        FROM accord_events ${where}
        ORDER BY ledger ASC, id ASC LIMIT ? OFFSET ?
      `).all(...values, limit, offset).map((row) => ({
        ...row,
        payload: JSON.parse(row.payload),
      }));
    },

    async setState(key, value) {
      upsertState.run(key, String(value));
    },

    async getState(key) {
      return database.prepare("SELECT value FROM indexer_state WHERE key = ?").get(key)?.value ?? null;
    },

    async recordReconciliation(result) {
      database.prepare(`
        INSERT INTO reconciliation_results (
          token, token_address, checked_at, implied_balance, actual_balance, drift
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        result.token,
        result.tokenAddress,
        result.checkedAt,
        result.impliedBalance,
        result.actualBalance,
        result.drift
      );
    },

    async getLatestReconciliations() {
      return database.prepare(`
        SELECT token, token_address AS tokenAddress, checked_at AS checkedAt,
          implied_balance AS impliedBalance, actual_balance AS actualBalance, drift
        FROM reconciliation_results AS current
        WHERE id = (
          SELECT MAX(id) FROM reconciliation_results
          WHERE token = current.token
        )
        ORDER BY token
      `).all();
    },

    /**
     * Rebuilds the running balances by folding every stored entry in canonical
     * chain order. Returns the number of tokens whose snapshot was rewritten.
     */
    async recomputeBalances() {
      return inTransaction(replayBalances);
    },

    /**
     * Rewinds indexed data to a consistent point after a rollback: drops every
     * entry and event emitted above `ledger`, then re-folds balances over what
     * remains. Callers reset their checkpoints to `ledger + 1` afterwards so
     * the range is re-ingested from the chain.
     *
     * @returns {{removedEntries: number, removedEvents: number}}
     */
    async rewindToLedger(ledger) {
      const target = Number(ledger);
      if (!Number.isSafeInteger(target) || target < 0) {
        throw new Error("rewind target must be a non-negative integer");
      }
      return inTransaction(() => {
        const removedEntries = deleteEntriesAbove.run(target).changes;
        const removedEvents = deleteEventsAbove.run(target).changes;
        replayBalances();
        return { removedEntries, removedEvents };
      });
    },

    /**
     * Wipes all indexed history (entries, protocol events, balances and
     * reconciliation results) so the store can be rebuilt from chain events.
     * `indexer_state` checkpoints are left to the caller to reset, except the
     * webhook cursors, which index into `accord_events` and would otherwise
     * point past the rebuilt rows. Webhook deliveries are kept so a rebuild
     * never re-sends an event that was already delivered.
     *
     * @returns {{removedEntries: number, removedEvents: number, removedReconciliations: number}}
     */
    async clearHistory() {
      return inTransaction(() => {
        const removedEntries = database.prepare("DELETE FROM ledger_entries").run().changes;
        const removedEvents = database.prepare("DELETE FROM accord_events").run().changes;
        const removedReconciliations = database.prepare("DELETE FROM reconciliation_results").run().changes;
        clearTokenBalances.run();
        database.prepare("DELETE FROM indexer_state WHERE key LIKE 'webhook_cursor:%'").run();
        return { removedEntries, removedEvents, removedReconciliations };
      });
    },

    async getLatestAccordEventId() {
      return Number(database.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM accord_events").get().id);
    },

    async getAccordEventsAfter(afterId, limit) {
      return database.prepare(`
        SELECT id, event_id AS eventId, topic, payload, ledger,
          transaction_hash AS transactionHash, occurred_at AS occurredAt
        FROM accord_events WHERE id > ? ORDER BY id ASC LIMIT ?
      `).all(afterId, limit).map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
    },

    async enqueueWebhookDeliveries({ subscriptionId, deliveries, cursor, now }) {
      return inTransaction(() => {
        let inserted = 0;
        for (const { eventId, body } of deliveries) {
          inserted += Number(insertDelivery.run(subscriptionId, eventId, body, now, now, now).changes);
        }
        upsertState.run(`webhook_cursor:${subscriptionId}`, String(cursor));
        return inserted;
      });
    },

    async claimDueWebhookDeliveries({ now, limit }) {
      return database.prepare(`
        SELECT ${deliveryColumns} FROM webhook_deliveries
        WHERE status = 'pending' AND next_attempt_at <= ?
        ORDER BY id ASC LIMIT ?
      `).all(now, limit).map(toDelivery);
    },

    async completeWebhookDelivery({ id, outcome, attempts, nextAttemptAt, statusCode, error, now }) {
      const status = outcome === "delivered" ? "delivered" : outcome === "dead" ? "dead" : "pending";
      database.prepare(`
        UPDATE webhook_deliveries SET status = ?, attempts = ?, next_attempt_at = ?,
          last_error = ?, last_status_code = ?, updated_at = ?,
          delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END
        WHERE id = ?
      `).run(status, attempts, nextAttemptAt ?? now, error ?? null, statusCode ?? null, now, status, now, id);
    },

    async countWebhookDeliveries() {
      const counts = { pending: 0, delivered: 0, dead: 0 };
      for (const row of database.prepare("SELECT status, COUNT(*) AS count FROM webhook_deliveries GROUP BY status").all()) {
        counts[row.status] = Number(row.count);
      }
      return counts;
    },

    async listWebhookDeliveries({ status, subscriptionId, limit, offset }) {
      const clauses = [];
      const values = [];
      if (status) {
        clauses.push("status = ?");
        values.push(status);
      }
      if (subscriptionId) {
        clauses.push("subscription_id = ?");
        values.push(subscriptionId);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      return database.prepare(`
        SELECT ${deliveryColumns} FROM webhook_deliveries ${where}
        ORDER BY id ASC LIMIT ? OFFSET ?
      `).all(...values, limit, offset).map(toDelivery);
    },

    async requeueDeadWebhookDeliveries({ subscriptionId, now }) {
      const result = subscriptionId
        ? database.prepare(`
            UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, updated_at = ?
            WHERE status = 'dead' AND subscription_id = ?
          `).run(now, now, subscriptionId)
        : database.prepare(`
            UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, updated_at = ?
            WHERE status = 'dead'
          `).run(now, now);
      return Number(result.changes);
    },

    async close() {
      database.close();
    },
  };
}
