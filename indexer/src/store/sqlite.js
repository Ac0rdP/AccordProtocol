import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * SQLite implementation of the indexer store (the default backend).
 *
 * `node:sqlite` is synchronous, but every method is `async` so callers treat
 * it exactly like the Postgres store; see `./index.js` for the shared contract.
 */
/** Folds per-(subscription, status) rows into one object per subscription. */
export function foldDeliverySummary(rows) {
  const bySubscription = new Map();
  for (const row of rows) {
    if (!bySubscription.has(row.subscriptionId)) {
      bySubscription.set(row.subscriptionId, {
        subscriptionId: row.subscriptionId, pending: 0, delivered: 0, dead: 0, replays: 0, oldestPendingAt: null,
      });
    }
    const entry = bySubscription.get(row.subscriptionId);
    entry[row.status] = row.count;
    entry.replays += row.replays;
    if (row.status === "pending") entry.oldestPendingAt = row.oldestAt;
  }
  return [...bySubscription.values()].sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId));
}

export function openLedgerStore(databasePath) {
  // ":memory:" is SQLite's private in-memory database (used by replay); it
  // must not be resolved into a file path.
  const inMemory = databasePath === ":memory:";
  const resolvedPath = inMemory ? databasePath : resolve(databasePath);
  if (!inMemory) mkdirSync(dirname(resolvedPath), { recursive: true });
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
      occurred_at TEXT NOT NULL,
      schema_version INTEGER
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
    CREATE TABLE IF NOT EXISTS webhook_delivery_attempts (
      id INTEGER PRIMARY KEY,
      delivery_id INTEGER NOT NULL,
      attempt INTEGER NOT NULL,
      replay_round INTEGER NOT NULL DEFAULT 0,
      outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'retry', 'dead')),
      status_code INTEGER,
      error TEXT,
      duration_ms INTEGER,
      attempted_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS webhook_delivery_attempts_delivery_idx
      ON webhook_delivery_attempts (delivery_id, id);
    CREATE TABLE IF NOT EXISTS notification_destinations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('webhook', 'slack', 'discord', 'email')),
      config TEXT NOT NULL,
      topics TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id INTEGER PRIMARY KEY,
      destination_id TEXT NOT NULL,
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
      UNIQUE (destination_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS notification_deliveries_due_idx
      ON notification_deliveries (status, next_attempt_at, id);
    CREATE TABLE IF NOT EXISTS graphql_client_checkpoints (
      client_id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      last_event_id TEXT,
      last_ledger INTEGER,
      connected_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS graphql_client_checkpoints_updated_idx
      ON graphql_client_checkpoints (updated_at);
    CREATE TABLE IF NOT EXISTS stream_exporter_checkpoints (
      exporter TEXT PRIMARY KEY,
      last_event_id TEXT,
      last_ledger INTEGER,
      events_published INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS warehouse_export_checkpoints (
      warehouse TEXT NOT NULL,
      table_name TEXT NOT NULL,
      last_exported_id INTEGER NOT NULL DEFAULT 0,
      last_ledger INTEGER,
      rows_exported INTEGER NOT NULL DEFAULT 0,
      schema_version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (warehouse, table_name)
    );
    CREATE TABLE IF NOT EXISTS quarantined_events (
      id INTEGER PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      event_id TEXT NOT NULL,
      contract_id TEXT,
      topic TEXT,
      schema_version INTEGER,
      reason TEXT NOT NULL CHECK (reason IN ('unknown_topic', 'unknown_version', 'invalid_payload', 'undecodable')),
      errors TEXT NOT NULL,
      raw TEXT NOT NULL,
      ledger INTEGER NOT NULL,
      transaction_hash TEXT,
      occurred_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'quarantined' CHECK (status IN ('quarantined', 'released', 'discarded')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS quarantined_events_status_idx ON quarantined_events (status, id);
    CREATE INDEX IF NOT EXISTS quarantined_events_ledger_idx ON quarantined_events (ledger);
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      previous_secret_hash TEXT,
      previous_expires_at TEXT,
      scopes TEXT NOT NULL,
      quota_limit INTEGER NOT NULL CHECK (quota_limit >= 1),
      quota_window_seconds INTEGER NOT NULL CHECK (quota_window_seconds >= 1),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      rotated_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS api_keys_status_idx ON api_keys (status, created_at);
    CREATE TABLE IF NOT EXISTS api_key_usage (
      key_id TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (key_id, window_start)
    );
    CREATE INDEX IF NOT EXISTS api_key_usage_window_idx ON api_key_usage (window_start);
    CREATE TABLE IF NOT EXISTS indexer_leases (
      name TEXT PRIMARY KEY,
      holder_id TEXT NOT NULL,
      region TEXT NOT NULL DEFAULT '',
      fencing_token INTEGER NOT NULL DEFAULT 1,
      acquired_at TEXT NOT NULL,
      renewed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS backfill_shards (
      job_id TEXT NOT NULL,
      shard_index INTEGER NOT NULL,
      start_ledger INTEGER NOT NULL,
      end_ledger INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
      cursor TEXT NOT NULL DEFAULT '',
      last_ledger INTEGER,
      pages INTEGER NOT NULL DEFAULT 0,
      events_indexed INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (job_id, shard_index)
    );
    CREATE INDEX IF NOT EXISTS backfill_shards_status_idx ON backfill_shards (job_id, status);
    CREATE TABLE IF NOT EXISTS lag_monitor_state (
      monitor TEXT PRIMARY KEY,
      latest_ledger INTEGER,
      indexed_ledger INTEGER,
      checkpoint_advanced_at TEXT,
      levels TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );
  `);

  // Databases created before the event-schema version existed lack the column.
  const eventColumns = database.prepare("PRAGMA table_info(accord_events)").all();
  if (!eventColumns.some((column) => column.name === "schema_version")) {
    database.exec("ALTER TABLE accord_events ADD COLUMN schema_version INTEGER");
  }

  // Replay bookkeeping arrived after the first release of the outbox.
  const deliveryTableColumns = database.prepare("PRAGMA table_info(webhook_deliveries)").all();
  if (!deliveryTableColumns.some((column) => column.name === "replay_count")) {
    database.exec("ALTER TABLE webhook_deliveries ADD COLUMN replay_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!deliveryTableColumns.some((column) => column.name === "last_replayed_at")) {
    database.exec("ALTER TABLE webhook_deliveries ADD COLUMN last_replayed_at TEXT");
  }

  // The chain-position dedupe key (`ledger:transaction:eventIndex`, see
  // events.js). Rows from before it existed keep a NULL key and stay covered
  // by the `event_id` constraint; NULLs never collide in a unique index.
  for (const table of ["ledger_entries", "accord_events"]) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((column) => column.name === "dedupe_key")) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN dedupe_key TEXT`);
    }
    database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${table}_dedupe_key_idx ON ${table} (dedupe_key)`);
  }

  function selectLease(name) {
    const row = database.prepare(`
      SELECT name, holder_id, region, fencing_token, acquired_at, renewed_at, expires_at
      FROM indexer_leases WHERE name = ?
    `).get(name);
    if (!row) return null;
    return {
      name: row.name,
      holderId: row.holder_id,
      region: row.region,
      fencingToken: Number(row.fencing_token),
      acquiredAt: row.acquired_at,
      renewedAt: row.renewed_at,
      expiresAt: row.expires_at,
    };
  }

  const apiKeyColumns = `
    id, name, scopes, quota_limit AS quotaLimit, quota_window_seconds AS quotaWindowSeconds, status,
    created_at AS createdAt, updated_at AS updatedAt, expires_at AS expiresAt, rotated_at AS rotatedAt,
    revoked_at AS revokedAt, previous_expires_at AS previousExpiresAt,
    previous_secret_hash IS NOT NULL AS hasPreviousSecret
  `;

  function toApiKey(row) {
    return { ...row, scopes: JSON.parse(row.scopes), hasPreviousSecret: Boolean(row.hasPreviousSecret) };
  }

  function selectApiKey(id) {
    const row = database.prepare(`
      SELECT ${apiKeyColumns}, secret_hash AS secretHash, previous_secret_hash AS previousSecretHash
      FROM api_keys WHERE id = ?
    `).get(id);
    return row ? toApiKey(row) : null;
  }

  const insertEntry = database.prepare(`
    INSERT INTO ledger_entries (
      event_id, token, token_address, direction, amount, balance, ledger,
      transaction_hash, occurred_at, from_address, to_address, dedupe_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteEntriesAbove = database.prepare("DELETE FROM ledger_entries WHERE ledger > ?");
  const deleteEventsAbove = database.prepare("DELETE FROM accord_events WHERE ledger > ?");
  // Quarantined events above a rewind are re-ingested (and re-quarantined if still bad) with the range.
  const deleteQuarantinedAbove = database.prepare("DELETE FROM quarantined_events WHERE ledger > ?");
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
      event_id, topic, payload, ledger, transaction_hash, occurred_at, schema_version, dedupe_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
  const upsertDestination = database.prepare(`
    INSERT INTO notification_destinations (id, kind, config, topics, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind, config = excluded.config, topics = excluded.topics,
      enabled = excluded.enabled, updated_at = excluded.updated_at
  `);
  const insertNotificationDelivery = database.prepare(`
    INSERT INTO notification_deliveries (
      destination_id, event_id, body, status, attempts, next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
    ON CONFLICT(destination_id, event_id) DO NOTHING
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
      replayCount: row.replayCount,
      lastReplayedAt: row.lastReplayedAt,
    };
  }

  const deliveryColumns = `
    id, subscription_id AS subscriptionId, event_id AS eventId, body, status, attempts,
    next_attempt_at AS nextAttemptAt, last_error AS lastError,
    last_status_code AS lastStatusCode, created_at AS createdAt, delivered_at AS deliveredAt,
    replay_count AS replayCount, last_replayed_at AS lastReplayedAt
  `;

  function toNotificationDelivery(row) {
    return {
      id: row.id,
      destinationId: row.destinationId,
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

  const notificationDeliveryColumns = `
    id, destination_id AS destinationId, event_id AS eventId, body, status, attempts,
    next_attempt_at AS nextAttemptAt, last_error AS lastError,
    last_status_code AS lastStatusCode, created_at AS createdAt, delivered_at AS deliveredAt
  `;

  function toDestination(row) {
    return {
      id: row.id,
      kind: row.kind,
      config: JSON.parse(row.config),
      topics: row.topics ? JSON.parse(row.topics) : null,
      enabled: Boolean(row.enabled),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

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
          entry.to,
          entry.dedupeKey ?? null
        );
        updateBalance.run(entry.token, balanceAfter.toString());
        database.exec("COMMIT");
        return true;
      } catch (error) {
        database.exec("ROLLBACK");
        if (/UNIQUE constraint failed: ledger_entries\.(event_id|dedupe_key)/.test(String(error.message))) {
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
          entry.occurredAt,
          entry.schemaVersion ?? null,
          entry.dedupeKey ?? null
        );
        return true;
      } catch (error) {
        if (/UNIQUE constraint failed: accord_events\.(event_id|dedupe_key)/.test(String(error.message))) {
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
          transaction_hash AS transactionHash, occurred_at AS occurredAt,
          schema_version AS schemaVersion
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
        deleteQuarantinedAbove.run(target);
        // Shards that reached past the rewind point no longer describe indexed data.
        database.prepare("DELETE FROM backfill_shards WHERE end_ledger > ?").run(target);
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
        database.prepare("DELETE FROM quarantined_events").run();
        const removedReconciliations = database.prepare("DELETE FROM reconciliation_results").run().changes;
        clearTokenBalances.run();
        database.prepare("DELETE FROM indexer_state WHERE key LIKE 'webhook_cursor:%'").run();
        database.prepare("DELETE FROM indexer_state WHERE key LIKE 'notification_cursor:%'").run();
        // Shards marked done describe data that no longer exists.
        database.prepare("DELETE FROM backfill_shards").run();
        return { removedEntries, removedEvents, removedReconciliations };
      });
    },

    async getLatestAccordEventId() {
      return Number(database.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM accord_events").get().id);
    },

    async getAccordEventsAfter(afterId, limit) {
      return database.prepare(`
        SELECT id, event_id AS eventId, topic, payload, ledger,
          transaction_hash AS transactionHash, occurred_at AS occurredAt,
          schema_version AS schemaVersion
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

    async completeWebhookDelivery({ id, outcome, attempts, nextAttemptAt, statusCode, error, durationMs, now }) {
      const status = outcome === "delivered" ? "delivered" : outcome === "dead" ? "dead" : "pending";
      inTransaction(() => {
        database.prepare(`
          UPDATE webhook_deliveries SET status = ?, attempts = ?, next_attempt_at = ?,
            last_error = ?, last_status_code = ?, updated_at = ?,
            delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END
          WHERE id = ?
        `).run(status, attempts, nextAttemptAt ?? now, error ?? null, statusCode ?? null, now, status, now, id);
        // One history row per attempt, written with the outcome so the two never disagree.
        database.prepare(`
          INSERT INTO webhook_delivery_attempts (
            delivery_id, attempt, replay_round, outcome, status_code, error, duration_ms, attempted_at
          ) SELECT id, ?, replay_count, ?, ?, ?, ?, ? FROM webhook_deliveries WHERE id = ?
        `).run(attempts, outcome === "delivered" || outcome === "dead" ? outcome : "retry",
          statusCode ?? null, error ?? null, durationMs ?? null, now, id);
      });
    },

    async countWebhookDeliveries() {
      const counts = { pending: 0, delivered: 0, dead: 0 };
      for (const row of database.prepare("SELECT status, COUNT(*) AS count FROM webhook_deliveries GROUP BY status").all()) {
        counts[row.status] = Number(row.count);
      }
      return counts;
    },

    async listWebhookDeliveries({ status, subscriptionId, eventId, order = "asc", limit, offset }) {
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
      if (eventId) {
        clauses.push("event_id = ?");
        values.push(eventId);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const direction = order === "desc" ? "DESC" : "ASC";
      return database.prepare(`
        SELECT ${deliveryColumns} FROM webhook_deliveries ${where}
        ORDER BY id ${direction} LIMIT ? OFFSET ?
      `).all(...values, limit, offset).map(toDelivery);
    },

    async getWebhookDelivery(id) {
      const row = database.prepare(`SELECT ${deliveryColumns} FROM webhook_deliveries WHERE id = ?`).get(id);
      return row ? toDelivery(row) : null;
    },

    async listWebhookDeliveryAttempts(deliveryId) {
      return database.prepare(`
        SELECT id, delivery_id AS deliveryId, attempt, replay_round AS replayRound, outcome,
          status_code AS statusCode, error, duration_ms AS durationMs, attempted_at AS attemptedAt
        FROM webhook_delivery_attempts WHERE delivery_id = ? ORDER BY id ASC
      `).all(deliveryId).map((row) => ({ ...row }));
    },

    /** Outbox size per subscription and status, with the age of the oldest pending delivery. */
    async summarizeWebhookDeliveries() {
      const rows = database.prepare(`
        SELECT subscription_id AS subscriptionId, status, COUNT(*) AS count,
          MIN(created_at) AS oldestAt, SUM(replay_count) AS replays
        FROM webhook_deliveries GROUP BY subscription_id, status
      `).all();
      return foldDeliverySummary(rows.map((row) => ({ ...row, count: Number(row.count), replays: Number(row.replays ?? 0) })));
    },

    /**
     * Sends one delivery back through the dispatcher. A dead or delivered row
     * starts a new replay round (attempts reset); a pending one is just made due
     * now, so repeating the call never queues a second copy. Delivery is
     * at-least-once: receivers dedupe on the stable `x-accord-event-id`.
     *
     * @returns {{found: boolean, previousStatus?: string, delivery?: object}}
     */
    async replayWebhookDelivery({ id, now }) {
      return inTransaction(() => {
        const current = database.prepare("SELECT status FROM webhook_deliveries WHERE id = ?").get(id);
        if (!current) return { found: false };
        if (current.status === "pending") {
          database.prepare("UPDATE webhook_deliveries SET next_attempt_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
        } else {
          database.prepare(`
            UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, updated_at = ?,
              replay_count = replay_count + 1, last_replayed_at = ?
            WHERE id = ?
          `).run(now, now, now, id);
        }
        const row = database.prepare(`SELECT ${deliveryColumns} FROM webhook_deliveries WHERE id = ?`).get(id);
        return { found: true, previousStatus: current.status, delivery: toDelivery(row) };
      });
    },

    async requeueDeadWebhookDeliveries({ subscriptionId, now }) {
      const result = subscriptionId
        ? database.prepare(`
            UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, updated_at = ?,
              replay_count = replay_count + 1, last_replayed_at = ?
            WHERE status = 'dead' AND subscription_id = ?
          `).run(now, now, now, subscriptionId)
        : database.prepare(`
            UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, updated_at = ?,
              replay_count = replay_count + 1, last_replayed_at = ?
            WHERE status = 'dead'
          `).run(now, now, now);
      return Number(result.changes);
    },

    async upsertNotificationDestination({ id, kind, config, topics, enabled, now }) {
      upsertDestination.run(
        id, kind, JSON.stringify(config), topics ? JSON.stringify(topics) : null, enabled ? 1 : 0, now, now
      );
    },

    async listNotificationDestinations() {
      return database.prepare(`
        SELECT id, kind, config, topics, enabled, created_at AS createdAt, updated_at AS updatedAt
        FROM notification_destinations ORDER BY id ASC
      `).all().map(toDestination);
    },

    async getNotificationDestination(id) {
      const row = database.prepare(`
        SELECT id, kind, config, topics, enabled, created_at AS createdAt, updated_at AS updatedAt
        FROM notification_destinations WHERE id = ?
      `).get(id);
      return row ? toDestination(row) : null;
    },

    async deleteNotificationDestination(id) {
      const result = database.prepare("DELETE FROM notification_destinations WHERE id = ?").run(id);
      return result.changes > 0;
    },

    async enqueueNotificationDeliveries({ destinationId, deliveries, cursor, now }) {
      return inTransaction(() => {
        let inserted = 0;
        for (const { eventId, body } of deliveries) {
          inserted += Number(insertNotificationDelivery.run(destinationId, eventId, body, now, now, now).changes);
        }
        upsertState.run(`notification_cursor:${destinationId}`, String(cursor));
        return inserted;
      });
    },

    async claimDueNotificationDeliveries({ now, limit }) {
      return database.prepare(`
        SELECT ${notificationDeliveryColumns} FROM notification_deliveries
        WHERE status = 'pending' AND next_attempt_at <= ?
        ORDER BY id ASC LIMIT ?
      `).all(now, limit).map(toNotificationDelivery);
    },

    async completeNotificationDelivery({ id, outcome, attempts, nextAttemptAt, statusCode, error, now }) {
      const status = outcome === "delivered" ? "delivered" : outcome === "dead" ? "dead" : "pending";
      database.prepare(`
        UPDATE notification_deliveries SET status = ?, attempts = ?, next_attempt_at = ?,
          last_error = ?, last_status_code = ?, updated_at = ?,
          delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END
        WHERE id = ?
      `).run(status, attempts, nextAttemptAt ?? now, error ?? null, statusCode ?? null, now, status, now, id);
    },

    async countNotificationDeliveries() {
      const counts = { pending: 0, delivered: 0, dead: 0 };
      for (const row of database.prepare("SELECT status, COUNT(*) AS count FROM notification_deliveries GROUP BY status").all()) {
        counts[row.status] = Number(row.count);
      }
      return counts;
    },

    async listNotificationDeliveries({ status, destinationId, limit, offset }) {
      const clauses = [];
      const values = [];
      if (status) {
        clauses.push("status = ?");
        values.push(status);
      }
      if (destinationId) {
        clauses.push("destination_id = ?");
        values.push(destinationId);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      return database.prepare(`
        SELECT ${notificationDeliveryColumns} FROM notification_deliveries ${where}
        ORDER BY id ASC LIMIT ? OFFSET ?
      `).all(...values, limit, offset).map(toNotificationDelivery);
    },

    async requeueDeadNotificationDeliveries({ destinationId, now }) {
      const result = destinationId
        ? database.prepare(`
            UPDATE notification_deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, updated_at = ?
            WHERE status = 'dead' AND destination_id = ?
          `).run(now, now, destinationId)
        : database.prepare(`
            UPDATE notification_deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, updated_at = ?
            WHERE status = 'dead'
          `).run(now, now);
      return Number(result.changes);
    },

    async setClientCheckpoint({ clientId, query, lastEventId = null, lastLedger = null, now = new Date().toISOString() }) {
      database.prepare(`
        INSERT INTO graphql_client_checkpoints (client_id, query, last_event_id, last_ledger, connected_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (client_id) DO UPDATE SET
          query = excluded.query,
          last_event_id = excluded.last_event_id,
          last_ledger = excluded.last_ledger,
          updated_at = excluded.updated_at
      `).run(clientId, query, lastEventId, lastLedger, now, now);
      return true;
    },

    async getClientCheckpoint(clientId) {
      const row = database.prepare(`
        SELECT client_id, query, last_event_id, last_ledger, connected_at, updated_at
        FROM graphql_client_checkpoints WHERE client_id = ?
      `).get(clientId);
      if (!row) return null;
      return {
        clientId: row.client_id,
        query: row.query,
        lastEventId: row.last_event_id,
        lastLedger: row.last_ledger,
        connectedAt: row.connected_at,
        updatedAt: row.updated_at,
      };
    },

    async setStreamCheckpoint({ exporter, lastEventId = null, lastLedger = null, eventsPublished = 0, now = new Date().toISOString() }) {
      database.prepare(`
        INSERT INTO stream_exporter_checkpoints (exporter, last_event_id, last_ledger, events_published, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (exporter) DO UPDATE SET
          last_event_id = excluded.last_event_id,
          last_ledger = excluded.last_ledger,
          events_published = excluded.events_published,
          updated_at = excluded.updated_at
      `).run(exporter, lastEventId, lastLedger, eventsPublished, now);
      return true;
    },

    async getStreamCheckpoint(exporter) {
      const row = database.prepare(`
        SELECT exporter, last_event_id, last_ledger, events_published, updated_at
        FROM stream_exporter_checkpoints WHERE exporter = ?
      `).get(exporter);
      if (!row) return null;
      return {
        exporter: row.exporter,
        lastEventId: row.last_event_id,
        lastLedger: row.last_ledger,
        eventsPublished: row.events_published,
        updatedAt: row.updated_at,
      };
    },

    async setWarehouseCheckpoint({ warehouse, tableName, lastExportedId = 0, lastLedger = null, rowsExported = 0, schemaVersion = 1, now = new Date().toISOString() }) {
      database.prepare(`
        INSERT INTO warehouse_export_checkpoints (warehouse, table_name, last_exported_id, last_ledger, rows_exported, schema_version, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (warehouse, table_name) DO UPDATE SET
          last_exported_id = excluded.last_exported_id,
          last_ledger = excluded.last_ledger,
          rows_exported = warehouse_export_checkpoints.rows_exported + excluded.rows_exported,
          schema_version = excluded.schema_version,
          updated_at = excluded.updated_at
      `).run(warehouse, tableName, lastExportedId, lastLedger, rowsExported, schemaVersion, now);
      return true;
    },

    async getWarehouseCheckpoint(warehouse, tableName) {
      const row = database.prepare(`
        SELECT warehouse, table_name, last_exported_id, last_ledger, rows_exported, schema_version, updated_at
        FROM warehouse_export_checkpoints WHERE warehouse = ? AND table_name = ?
      `).get(warehouse, tableName);
      if (!row) return null;
      return {
        warehouse: row.warehouse,
        tableName: row.table_name,
        lastExportedId: row.last_exported_id,
        lastLedger: row.last_ledger,
        rowsExported: row.rows_exported,
        schemaVersion: row.schema_version,
        updatedAt: row.updated_at,
      };
    },

    /**
     * Parks an event that failed validation. Keyed by the chain-position dedupe
     * key, so quarantining the same event twice is a no-op.
     *
     * @returns {boolean} false when it was already quarantined
     */
    async quarantineEvent(record) {
      const now = record.now ?? new Date().toISOString();
      return database.prepare(`
        INSERT INTO quarantined_events (
          dedupe_key, event_id, contract_id, topic, schema_version, reason, errors, raw,
          ledger, transaction_hash, occurred_at, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'quarantined', ?, ?)
        ON CONFLICT (dedupe_key) DO NOTHING
      `).run(
        record.dedupeKey, record.eventId, record.contractId ?? null, record.topic ?? null,
        record.schemaVersion ?? null, record.reason, JSON.stringify(record.errors ?? []),
        JSON.stringify(record.raw ?? {}), record.ledger, record.transactionHash ?? null,
        record.occurredAt, now, now
      ).changes > 0;
    },

    async listQuarantinedEvents({ status, reason, topic, afterId, order = "desc", limit, offset = 0, includeRaw = false }) {
      const clauses = [];
      const values = [];
      for (const [column, value] of [["status", status], ["reason", reason], ["topic", topic]]) {
        if (value) {
          clauses.push(`${column} = ?`);
          values.push(value);
        }
      }
      if (afterId) {
        clauses.push("id > ?");
        values.push(afterId);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      return database.prepare(`
        SELECT id, dedupe_key AS dedupeKey, event_id AS eventId, contract_id AS contractId, topic,
          schema_version AS schemaVersion, reason, errors, raw, ledger, transaction_hash AS transactionHash,
          occurred_at AS occurredAt, status, created_at AS createdAt, resolved_at AS resolvedAt
        FROM quarantined_events ${where} ORDER BY id ${order === "asc" ? "ASC" : "DESC"} LIMIT ? OFFSET ?
      `).all(...values, limit, offset).map(({ errors, raw, ...row }) => ({
        ...row,
        errors: JSON.parse(errors),
        ...(includeRaw ? { raw: JSON.parse(raw) } : {}),
      }));
    },

    async countQuarantinedEvents() {
      const counts = { quarantined: 0, released: 0, discarded: 0, byReason: {} };
      for (const row of database.prepare("SELECT status, COUNT(*) AS count FROM quarantined_events GROUP BY status").all()) {
        counts[row.status] = Number(row.count);
      }
      for (const row of database.prepare(
        "SELECT reason, COUNT(*) AS count FROM quarantined_events WHERE status = 'quarantined' GROUP BY reason"
      ).all()) {
        counts.byReason[row.reason] = Number(row.count);
      }
      return counts;
    },

    /** Moves a still-quarantined event to `released` or `discarded`; anything else is left alone. */
    async resolveQuarantinedEvent({ id, dedupeKey, status, now = new Date().toISOString() }) {
      if (!["released", "discarded"].includes(status)) throw new Error("status must be released or discarded");
      const result = id !== undefined
        ? database.prepare(
            "UPDATE quarantined_events SET status = ?, updated_at = ?, resolved_at = ? WHERE id = ? AND status = 'quarantined'"
          ).run(status, now, now, id)
        : database.prepare(
            "UPDATE quarantined_events SET status = ?, updated_at = ?, resolved_at = ? WHERE dedupe_key = ? AND status = 'quarantined'"
          ).run(status, now, now, dedupeKey);
      return Number(result.changes) > 0;
    },

    /**
     * Stores a new key. Only the secret's hash is ever persisted.
     *
     * @returns {boolean} false when a key with that id already exists
     */
    async createApiKey({ id, name, secretHash, scopes, quotaLimit, quotaWindowSeconds, expiresAt = null, now }) {
      return database.prepare(`
        INSERT INTO api_keys (id, name, secret_hash, scopes, quota_limit, quota_window_seconds, status,
          created_at, updated_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
        ON CONFLICT (id) DO NOTHING
      `).run(id, name, secretHash, JSON.stringify(scopes), quotaLimit, quotaWindowSeconds, now, now, expiresAt).changes > 0;
    },

    /** One key, including the secret hashes the service needs to authenticate with. Never sent to clients. */
    async getApiKey(id) {
      return selectApiKey(id);
    },

    async listApiKeys({ status, limit, offset }) {
      return database.prepare(`
        SELECT ${apiKeyColumns} FROM api_keys ${status ? "WHERE status = ?" : ""}
        ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?
      `).all(...(status ? [status] : []), limit, offset).map(toApiKey);
    },

    /**
     * Replaces the secret. The old one stays valid until `graceUntil` (null drops it at once).
     * @returns {object|null} the updated key, or null when it does not exist or is revoked
     */
    async rotateApiKey({ id, secretHash, graceUntil = null, now }) {
      const changed = database.prepare(`
        UPDATE api_keys SET
          previous_secret_hash = CASE WHEN ? IS NULL THEN NULL ELSE secret_hash END,
          previous_expires_at = ?,
          secret_hash = ?, rotated_at = ?, updated_at = ?
        WHERE id = ? AND status = 'active'
      `).run(graceUntil, graceUntil, secretHash, now, now, id).changes > 0;
      return changed ? selectApiKey(id) : null;
    },

    /** @returns {{found: boolean, changed: boolean}} revoking twice is a harmless no-op */
    async revokeApiKey({ id, now }) {
      const changed = database.prepare(`
        UPDATE api_keys SET status = 'revoked', revoked_at = ?, updated_at = ?,
          previous_secret_hash = NULL, previous_expires_at = NULL
        WHERE id = ? AND status = 'active'
      `).run(now, now, id).changes > 0;
      const found = changed || Boolean(database.prepare("SELECT 1 FROM api_keys WHERE id = ?").get(id));
      return { found, changed };
    },

    /**
     * Counts one request against a key's window in a single atomic statement.
     * The counter never passes `limit`, so a burst of concurrent requests (even
     * across instances sharing the store) cannot overshoot the quota.
     *
     * @returns {{allowed: boolean, used: number}}
     */
    async consumeApiKeyQuota({ keyId, windowStart, limit, now }) {
      const row = database.prepare(`
        INSERT INTO api_key_usage (key_id, window_start, request_count, updated_at) VALUES (?, ?, 1, ?)
        ON CONFLICT (key_id, window_start) DO UPDATE SET
          request_count = api_key_usage.request_count + 1, updated_at = excluded.updated_at
        WHERE api_key_usage.request_count < ?
        RETURNING request_count
      `).get(keyId, windowStart, now, limit);
      if (row) return { allowed: true, used: Number(row.request_count) };
      const current = database.prepare("SELECT request_count FROM api_key_usage WHERE key_id = ? AND window_start = ?").get(keyId, windowStart);
      return { allowed: false, used: Number(current?.request_count ?? limit) };
    },

    /** Drops usage counters for windows that started before `before` (epoch seconds). */
    async pruneApiKeyUsage({ before }) {
      return Number(database.prepare("DELETE FROM api_key_usage WHERE window_start < ?").run(before).changes);
    },

    /**
     * Takes or renews a named lease in one atomic statement. The row is won when
     * it is free, expired, or already ours; otherwise the current holder keeps it.
     * `fencingToken` only increases when ownership changes (or a lapsed lease is
     * re-taken), so a renewal never moves it.
     *
     * @returns {{acquired: boolean, lease: object|null}}
     */
    async acquireLease({ name, holderId, region = "", ttlMs, now = new Date().toISOString() }) {
      const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
      const row = database.prepare(`
        INSERT INTO indexer_leases (name, holder_id, region, fencing_token, acquired_at, renewed_at, expires_at)
        VALUES (?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT (name) DO UPDATE SET
          fencing_token = CASE
            WHEN indexer_leases.holder_id = excluded.holder_id AND indexer_leases.expires_at > excluded.renewed_at
            THEN indexer_leases.fencing_token ELSE indexer_leases.fencing_token + 1 END,
          acquired_at = CASE
            WHEN indexer_leases.holder_id = excluded.holder_id AND indexer_leases.expires_at > excluded.renewed_at
            THEN indexer_leases.acquired_at ELSE excluded.acquired_at END,
          holder_id = excluded.holder_id,
          region = excluded.region,
          renewed_at = excluded.renewed_at,
          expires_at = excluded.expires_at
        WHERE indexer_leases.holder_id = excluded.holder_id OR indexer_leases.expires_at <= excluded.renewed_at
        RETURNING holder_id
      `).get(name, holderId, region, now, now, expiresAt);
      const lease = selectLease(name);
      return { acquired: Boolean(row) && lease?.holderId === holderId, lease };
    },

    async getLease(name) {
      return selectLease(name);
    },

    /** Gives a lease up early (graceful shutdown) so a standby takes over without waiting for the TTL. */
    async releaseLease({ name, holderId, now = new Date().toISOString() }) {
      return database.prepare(
        "UPDATE indexer_leases SET expires_at = ? WHERE name = ? AND holder_id = ? AND expires_at > ?"
      ).run(now, name, holderId, now).changes > 0;
    },

    async registerBackfillJob({ jobId, shards, now = new Date().toISOString() }) {
      return inTransaction(() => {
        // A different job's shards describe a different range; keep only this job's.
        database.prepare("DELETE FROM backfill_shards WHERE job_id != ?").run(jobId);
        const insert = database.prepare(`
          INSERT INTO backfill_shards (job_id, shard_index, start_ledger, end_ledger, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (job_id, shard_index) DO UPDATE SET
            status = CASE WHEN excluded.end_ledger > backfill_shards.end_ledger THEN 'pending' ELSE backfill_shards.status END,
            end_ledger = MAX(backfill_shards.end_ledger, excluded.end_ledger)
        `);
        for (const shard of shards) insert.run(jobId, shard.index, shard.start, shard.end, now);
        // A crashed worker leaves its shard 'running'; nobody owns it now.
        database.prepare(
          "UPDATE backfill_shards SET status = 'pending', updated_at = ? WHERE job_id = ? AND status = 'running'"
        ).run(now, jobId);
        return true;
      });
    },

    async listBackfillShards(jobId) {
      return database.prepare(`
        SELECT job_id, shard_index, start_ledger, end_ledger, status, cursor, last_ledger,
          pages, events_indexed, attempts, last_error, updated_at
        FROM backfill_shards WHERE job_id = ? ORDER BY shard_index ASC
      `).all(jobId).map(mapShardRow);
    },

    async updateBackfillShard({ jobId, shardIndex, status, cursor, lastLedger, pages, eventsIndexed, attempts, lastError, now = new Date().toISOString() }) {
      database.prepare(`
        UPDATE backfill_shards SET
          status = COALESCE(?, status),
          cursor = COALESCE(?, cursor),
          last_ledger = COALESCE(?, last_ledger),
          pages = COALESCE(?, pages),
          events_indexed = COALESCE(?, events_indexed),
          attempts = COALESCE(?, attempts),
          last_error = ?,
          updated_at = ?
        WHERE job_id = ? AND shard_index = ?
      `).run(
        status ?? null, cursor ?? null, lastLedger ?? null, pages ?? null,
        eventsIndexed ?? null, attempts ?? null, lastError ?? null, now, jobId, shardIndex
      );
      return true;
    },

    async setLagMonitorState({ monitor, latestLedger = null, indexedLedger = null, checkpointAdvancedAt = null, levels = {}, now = new Date().toISOString() }) {
      database.prepare(`
        INSERT INTO lag_monitor_state (monitor, latest_ledger, indexed_ledger, checkpoint_advanced_at, levels, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (monitor) DO UPDATE SET
          latest_ledger = excluded.latest_ledger,
          indexed_ledger = excluded.indexed_ledger,
          checkpoint_advanced_at = excluded.checkpoint_advanced_at,
          levels = excluded.levels,
          updated_at = excluded.updated_at
      `).run(monitor, latestLedger, indexedLedger, checkpointAdvancedAt, JSON.stringify(levels), now);
      return true;
    },

    async getLagMonitorState(monitor) {
      const row = database.prepare(`
        SELECT monitor, latest_ledger, indexed_ledger, checkpoint_advanced_at, levels, updated_at
        FROM lag_monitor_state WHERE monitor = ?
      `).get(monitor);
      if (!row) return null;
      return {
        monitor: row.monitor,
        latestLedger: row.latest_ledger,
        indexedLedger: row.indexed_ledger,
        checkpointAdvancedAt: row.checkpoint_advanced_at,
        levels: JSON.parse(row.levels),
        updatedAt: row.updated_at,
      };
    },

    async close() {
      database.close();
    },
  };
}

function mapShardRow(row) {
  return {
    jobId: row.job_id,
    index: row.shard_index,
    start: row.start_ledger,
    end: row.end_ledger,
    status: row.status,
    cursor: row.cursor,
    lastLedger: row.last_ledger,
    pages: row.pages,
    eventsIndexed: row.events_indexed,
    attempts: row.attempts,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}
