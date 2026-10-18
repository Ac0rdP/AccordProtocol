import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 1;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ledger_entries (
    id INTEGER PRIMARY KEY,
    network TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    token TEXT NOT NULL,
    token_address TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('inflow', 'outflow')),
    amount TEXT NOT NULL,
    balance TEXT NOT NULL,
    ledger INTEGER NOT NULL,
    transaction_hash TEXT,
    occurred_at TEXT NOT NULL,
    from_address TEXT NOT NULL,
    to_address TEXT NOT NULL,
    UNIQUE (network, contract_id, event_id)
  );
  CREATE INDEX IF NOT EXISTS ledger_entries_time_idx
    ON ledger_entries (network, contract_id, occurred_at, id);
  CREATE INDEX IF NOT EXISTS ledger_entries_token_time_idx
    ON ledger_entries (network, contract_id, token, occurred_at, id);

  CREATE TABLE IF NOT EXISTS token_balances (
    network TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    token TEXT NOT NULL,
    balance TEXT NOT NULL,
    PRIMARY KEY (network, contract_id, token)
  );

  CREATE TABLE IF NOT EXISTS accord_events (
    id INTEGER PRIMARY KEY,
    network TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    payload TEXT NOT NULL,
    ledger INTEGER NOT NULL,
    transaction_hash TEXT,
    occurred_at TEXT NOT NULL,
    UNIQUE (network, contract_id, event_id)
  );
  CREATE INDEX IF NOT EXISTS accord_events_time_idx
    ON accord_events (network, contract_id, occurred_at, id);
  CREATE INDEX IF NOT EXISTS accord_events_topic_time_idx
    ON accord_events (network, contract_id, topic, occurred_at, id);

  CREATE TABLE IF NOT EXISTS indexer_state (
    network TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (network, contract_id, key)
  );

  CREATE TABLE IF NOT EXISTS reconciliation_results (
    id INTEGER PRIMARY KEY,
    network TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    check_name TEXT NOT NULL,
    subject TEXT NOT NULL,
    subject_address TEXT,
    checked_at TEXT NOT NULL,
    implied_balance TEXT NOT NULL,
    actual_balance TEXT NOT NULL,
    drift TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok', 'drift', 'error')),
    details TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS reconciliation_subject_time_idx
    ON reconciliation_results (network, contract_id, check_name, subject, checked_at DESC);

  CREATE TABLE IF NOT EXISTS ledger_daily_aggregates (
    network TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    token TEXT NOT NULL,
    day TEXT NOT NULL,
    inflow TEXT NOT NULL DEFAULT '0',
    outflow TEXT NOT NULL DEFAULT '0',
    entry_count INTEGER NOT NULL DEFAULT 0,
    closing_balance TEXT NOT NULL DEFAULT '0',
    last_ledger INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (network, contract_id, token, day)
  );

  CREATE TABLE IF NOT EXISTS event_daily_aggregates (
    network TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    day TEXT NOT NULL,
    event_count INTEGER NOT NULL DEFAULT 0,
    last_ledger INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (network, contract_id, topic, day)
  );

  CREATE TABLE IF NOT EXISTS retention_runs (
    id INTEGER PRIMARY KEY,
    network TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    ran_at TEXT NOT NULL,
    entries_rolled_up INTEGER NOT NULL DEFAULT 0,
    entries_removed INTEGER NOT NULL DEFAULT 0,
    events_rolled_up INTEGER NOT NULL DEFAULT 0,
    events_removed INTEGER NOT NULL DEFAULT 0,
    reconciliations_removed INTEGER NOT NULL DEFAULT 0,
    aggregates_removed INTEGER NOT NULL DEFAULT 0,
    archive_paths TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS retention_runs_time_idx
    ON retention_runs (network, contract_id, ran_at DESC);
`;

function tableExists(database, name) {
  return Boolean(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name)
  );
}

function hasColumn(database, table, column) {
  return database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}

/**
 * Databases written before multi-target support have no network/contract_id
 * columns. Their rows all belong to whichever single contract was configured,
 * so copy them into the new tables under that target before dropping them.
 */
function migrateSingleTargetTables(database, legacyTarget) {
  const legacyTables = ["ledger_entries", "token_balances", "accord_events", "indexer_state", "reconciliation_results"];
  const stale = legacyTables.filter(
    (table) => tableExists(database, table) && !hasColumn(database, table, "network")
  );
  if (stale.length === 0) return;

  if (!legacyTarget?.network || !legacyTarget?.contractId) {
    throw new Error(
      "This database predates multi-network indexing. Set ACCORD_CONTRACT_ID (and NETWORK_PASSPHRASE) " +
        "to the contract it was built from so its rows can be tagged, or point DATABASE_PATH at a new file."
    );
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    for (const table of stale) {
      database.exec(`ALTER TABLE ${table} RENAME TO ${table}_v0`);
    }
    database.exec(SCHEMA);

    const { network, contractId } = legacyTarget;
    if (stale.includes("ledger_entries")) {
      database
        .prepare(
          `INSERT INTO ledger_entries (
             network, contract_id, event_id, token, token_address, direction, amount, balance,
             ledger, transaction_hash, occurred_at, from_address, to_address
           )
           SELECT ?, ?, event_id, token, token_address, direction, amount, balance,
             ledger, transaction_hash, occurred_at, from_address, to_address
           FROM ledger_entries_v0 ORDER BY id`
        )
        .run(network, contractId);
    }
    if (stale.includes("token_balances")) {
      database
        .prepare(
          "INSERT INTO token_balances (network, contract_id, token, balance) SELECT ?, ?, token, balance FROM token_balances_v0"
        )
        .run(network, contractId);
    }
    if (stale.includes("accord_events")) {
      database
        .prepare(
          `INSERT INTO accord_events (
             network, contract_id, event_id, topic, payload, ledger, transaction_hash, occurred_at
           )
           SELECT ?, ?, event_id, topic, payload, ledger, transaction_hash, occurred_at
           FROM accord_events_v0 ORDER BY id`
        )
        .run(network, contractId);
    }
    if (stale.includes("indexer_state")) {
      database
        .prepare("INSERT INTO indexer_state (network, contract_id, key, value) SELECT ?, ?, key, value FROM indexer_state_v0")
        .run(network, contractId);
    }
    if (stale.includes("reconciliation_results")) {
      database
        .prepare(
          `INSERT INTO reconciliation_results (
             network, contract_id, check_name, subject, subject_address, checked_at,
             implied_balance, actual_balance, drift, status, details
           )
           SELECT ?, ?, 'token_balance', token, token_address, checked_at,
             implied_balance, actual_balance, drift,
             CASE WHEN drift = '0' THEN 'ok' ELSE 'drift' END, '{}'
           FROM reconciliation_results_v0 ORDER BY id`
        )
        .run(network, contractId);
    }

    for (const table of stale) {
      database.exec(`DROP TABLE ${table}_v0`);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function scopeClause(filters, alias = "") {
  const prefix = alias ? `${alias}.` : "";
  const clauses = [];
  const values = [];
  if (filters.network) {
    clauses.push(`${prefix}network = ?`);
    values.push(filters.network);
  }
  if (filters.contractId) {
    clauses.push(`${prefix}contract_id = ?`);
    values.push(filters.contractId);
  }
  return { clauses, values };
}

function dayOf(isoTimestamp) {
  return isoTimestamp.slice(0, 10);
}

export function openLedgerStore(databasePath, { legacyTarget } = {}) {
  const resolvedPath = resolve(databasePath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  const database = new DatabaseSync(resolvedPath);

  database.exec("PRAGMA journal_mode = WAL");
  migrateSingleTargetTables(database, legacyTarget);
  database.exec(SCHEMA);
  database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

  const insertEntry = database.prepare(`
    INSERT INTO ledger_entries (
      network, contract_id, event_id, token, token_address, direction, amount, balance,
      ledger, transaction_hash, occurred_at, from_address, to_address
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAccordEvent = database.prepare(`
    INSERT INTO accord_events (
      network, contract_id, event_id, topic, payload, ledger, transaction_hash, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectBalance = database.prepare(
    "SELECT balance FROM token_balances WHERE network = ? AND contract_id = ? AND token = ?"
  );
  const updateBalance = database.prepare(`
    INSERT INTO token_balances (network, contract_id, token, balance) VALUES (?, ?, ?, ?)
    ON CONFLICT(network, contract_id, token) DO UPDATE SET balance = excluded.balance
  `);

  const store = {
    recordTransfer(entry) {
      const amount = BigInt(entry.amount);
      if (amount <= 0n) throw new Error("Transfer amount must be positive");
      if (!entry.network || !entry.contractId) {
        throw new Error("Ledger entries must carry a network and contractId");
      }
      const balanceBefore = BigInt(
        selectBalance.get(entry.network, entry.contractId, entry.token)?.balance ?? "0"
      );
      const balanceAfter = balanceBefore + (entry.direction === "inflow" ? amount : -amount);

      database.exec("BEGIN IMMEDIATE");
      try {
        insertEntry.run(
          entry.network,
          entry.contractId,
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
        updateBalance.run(entry.network, entry.contractId, entry.token, balanceAfter.toString());
        database.exec("COMMIT");
        return true;
      } catch (error) {
        database.exec("ROLLBACK");
        if (String(error.message).includes("UNIQUE constraint failed")) {
          return false;
        }
        throw error;
      }
    },

    getBalance({ network, contractId, token }) {
      return selectBalance.get(network, contractId, token)?.balance ?? "0";
    },

    getBalances({ network, contractId } = {}) {
      const { clauses, values } = scopeClause({ network, contractId });
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      return database
        .prepare(
          `SELECT network, contract_id AS contractId, token, balance
           FROM token_balances ${where} ORDER BY network, contract_id, token`
        )
        .all(...values);
    },

    getEntries({ network, contractId, token, from, to, limit, offset }) {
      const { clauses, values } = scopeClause({ network, contractId });
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
        SELECT network, contract_id AS contractId, event_id AS eventId, token,
          token_address AS tokenAddress, direction, amount, balance, ledger,
          transaction_hash AS transactionHash, occurred_at AS occurredAt,
          from_address AS "from", to_address AS "to"
        FROM ledger_entries ${where}
        ORDER BY ledger ASC, id ASC LIMIT ? OFFSET ?
      `).all(...values, limit, offset);
    },

    recordAccordEvent(entry) {
      if (!entry.network || !entry.contractId) {
        throw new Error("Accord events must carry a network and contractId");
      }
      try {
        insertAccordEvent.run(
          entry.network,
          entry.contractId,
          entry.eventId,
          entry.topic,
          JSON.stringify(entry.payload),
          entry.ledger,
          entry.transactionHash ?? null,
          entry.occurredAt
        );
        return true;
      } catch (error) {
        if (String(error.message).includes("UNIQUE constraint failed")) {
          return false;
        }
        throw error;
      }
    },

    getAccordEvents({ network, contractId, topic, from, to, limit, offset }) {
      const { clauses, values } = scopeClause({ network, contractId });
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
        SELECT network, contract_id AS contractId, event_id AS eventId, topic, payload, ledger,
          transaction_hash AS transactionHash, occurred_at AS occurredAt
        FROM accord_events ${where}
        ORDER BY ledger ASC, id ASC LIMIT ? OFFSET ?
      `).all(...values, limit, offset).map((row) => ({
        ...row,
        payload: JSON.parse(row.payload),
      }));
    },

    countAccordEvents({ network, contractId, topic } = {}) {
      const { clauses, values } = scopeClause({ network, contractId });
      if (topic) {
        clauses.push("topic = ?");
        values.push(topic);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const live = database
        .prepare(`SELECT COUNT(*) AS total FROM accord_events ${where}`)
        .get(...values).total;
      const aggregateFilters = scopeClause({ network, contractId });
      if (topic) {
        aggregateFilters.clauses.push("topic = ?");
        aggregateFilters.values.push(topic);
      }
      const aggregateWhere = aggregateFilters.clauses.length
        ? `WHERE ${aggregateFilters.clauses.join(" AND ")}`
        : "";
      const archived = database
        .prepare(
          `SELECT COALESCE(SUM(event_count), 0) AS total FROM event_daily_aggregates ${aggregateWhere}`
        )
        .get(...aggregateFilters.values).total;
      return Number(live) + Number(archived);
    },

    setState({ network, contractId }, key, value) {
      database.prepare(`
        INSERT INTO indexer_state (network, contract_id, key, value) VALUES (?, ?, ?, ?)
        ON CONFLICT(network, contract_id, key) DO UPDATE SET value = excluded.value
      `).run(network, contractId, key, String(value));
    },

    getState({ network, contractId }, key) {
      return database
        .prepare("SELECT value FROM indexer_state WHERE network = ? AND contract_id = ? AND key = ?")
        .get(network, contractId, key)?.value ?? null;
    },

    getCheckpoints({ network, contractId } = {}) {
      const { clauses, values } = scopeClause({ network, contractId });
      clauses.push("key IN ('next_ledger', 'event_cursor')");
      return database
        .prepare(
          `SELECT network, contract_id AS contractId, key, value
           FROM indexer_state WHERE ${clauses.join(" AND ")}
           ORDER BY network, contract_id, key`
        )
        .all(...values);
    },

    recordReconciliation(result) {
      database.prepare(`
        INSERT INTO reconciliation_results (
          network, contract_id, check_name, subject, subject_address, checked_at,
          implied_balance, actual_balance, drift, status, details
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        result.network,
        result.contractId,
        result.check ?? "token_balance",
        result.subject,
        result.subjectAddress ?? null,
        result.checkedAt,
        result.impliedBalance,
        result.actualBalance,
        result.drift,
        result.status,
        JSON.stringify(result.details ?? {})
      );
    },

    getLatestReconciliations({ network, contractId, check } = {}) {
      const { clauses, values } = scopeClause({ network, contractId }, "current");
      if (check) {
        clauses.push("current.check_name = ?");
        values.push(check);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")} AND` : "WHERE";
      return database.prepare(`
        SELECT current.network, current.contract_id AS contractId, current.check_name AS "check",
          current.subject, current.subject_address AS subjectAddress, current.checked_at AS checkedAt,
          current.implied_balance AS impliedBalance, current.actual_balance AS actualBalance,
          current.drift, current.status, current.details
        FROM reconciliation_results AS current
        ${where} current.id = (
          SELECT MAX(id) FROM reconciliation_results
          WHERE network = current.network AND contract_id = current.contract_id
            AND check_name = current.check_name AND subject = current.subject
        )
        ORDER BY current.network, current.contract_id, current.check_name, current.subject
      `).all(...values).map((row) => ({ ...row, details: JSON.parse(row.details) }));
    },

    /** Rolls raw rows older than `before` into the daily aggregate tables. */
    rollUpBefore({ network, contractId, before }) {
      const entries = database
        .prepare(
          `SELECT token, occurred_at, direction, amount, balance, ledger
           FROM ledger_entries
           WHERE network = ? AND contract_id = ? AND occurred_at < ?
           ORDER BY ledger ASC, id ASC`
        )
        .all(network, contractId, before);

      const buckets = new Map();
      for (const row of entries) {
        const day = dayOf(row.occurred_at);
        const key = `${row.token}\u0000${day}`;
        const bucket = buckets.get(key) ?? {
          token: row.token,
          day,
          inflow: 0n,
          outflow: 0n,
          count: 0,
          closingBalance: "0",
          lastLedger: 0,
        };
        const amount = BigInt(row.amount);
        if (row.direction === "inflow") bucket.inflow += amount;
        else bucket.outflow += amount;
        bucket.count += 1;
        bucket.closingBalance = row.balance;
        bucket.lastLedger = Math.max(bucket.lastLedger, Number(row.ledger));
        buckets.set(key, bucket);
      }

      const upsertEntryAggregate = database.prepare(`
        INSERT INTO ledger_daily_aggregates (
          network, contract_id, token, day, inflow, outflow, entry_count, closing_balance, last_ledger
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(network, contract_id, token, day) DO UPDATE SET
          inflow = excluded.inflow,
          outflow = excluded.outflow,
          entry_count = ledger_daily_aggregates.entry_count + excluded.entry_count,
          closing_balance = excluded.closing_balance,
          last_ledger = MAX(ledger_daily_aggregates.last_ledger, excluded.last_ledger)
      `);
      for (const bucket of buckets.values()) {
        const existing = database
          .prepare(
            `SELECT inflow, outflow FROM ledger_daily_aggregates
             WHERE network = ? AND contract_id = ? AND token = ? AND day = ?`
          )
          .get(network, contractId, bucket.token, bucket.day);
        upsertEntryAggregate.run(
          network,
          contractId,
          bucket.token,
          bucket.day,
          (BigInt(existing?.inflow ?? "0") + bucket.inflow).toString(),
          (BigInt(existing?.outflow ?? "0") + bucket.outflow).toString(),
          bucket.count,
          bucket.closingBalance,
          bucket.lastLedger
        );
      }

      const eventRows = database
        .prepare(
          `SELECT topic, SUBSTR(occurred_at, 1, 10) AS day, COUNT(*) AS event_count,
             MAX(ledger) AS last_ledger
           FROM accord_events
           WHERE network = ? AND contract_id = ? AND occurred_at < ?
           GROUP BY topic, day`
        )
        .all(network, contractId, before);
      const upsertEventAggregate = database.prepare(`
        INSERT INTO event_daily_aggregates (network, contract_id, topic, day, event_count, last_ledger)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(network, contract_id, topic, day) DO UPDATE SET
          event_count = event_daily_aggregates.event_count + excluded.event_count,
          last_ledger = MAX(event_daily_aggregates.last_ledger, excluded.last_ledger)
      `);
      for (const row of eventRows) {
        upsertEventAggregate.run(
          network,
          contractId,
          row.topic,
          row.day,
          Number(row.event_count),
          Number(row.last_ledger)
        );
      }

      return { entries: entries.length, events: eventRows.reduce((sum, row) => sum + Number(row.event_count), 0) };
    },

    selectEntriesBefore({ network, contractId, before }) {
      return database
        .prepare(
          `SELECT network, contract_id AS contractId, event_id AS eventId, token,
             token_address AS tokenAddress, direction, amount, balance, ledger,
             transaction_hash AS transactionHash, occurred_at AS occurredAt,
             from_address AS "from", to_address AS "to"
           FROM ledger_entries WHERE network = ? AND contract_id = ? AND occurred_at < ?
           ORDER BY ledger ASC, id ASC`
        )
        .all(network, contractId, before);
    },

    selectAccordEventsBefore({ network, contractId, before }) {
      return database
        .prepare(
          `SELECT network, contract_id AS contractId, event_id AS eventId, topic, payload, ledger,
             transaction_hash AS transactionHash, occurred_at AS occurredAt
           FROM accord_events WHERE network = ? AND contract_id = ? AND occurred_at < ?
           ORDER BY ledger ASC, id ASC`
        )
        .all(network, contractId, before)
        .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
    },

    deleteEntriesBefore({ network, contractId, before }) {
      return database
        .prepare("DELETE FROM ledger_entries WHERE network = ? AND contract_id = ? AND occurred_at < ?")
        .run(network, contractId, before).changes;
    },

    deleteAccordEventsBefore({ network, contractId, before }) {
      return database
        .prepare("DELETE FROM accord_events WHERE network = ? AND contract_id = ? AND occurred_at < ?")
        .run(network, contractId, before).changes;
    },

    deleteReconciliationsBefore({ network, contractId, before }) {
      return database
        .prepare(
          `DELETE FROM reconciliation_results
           WHERE network = ? AND contract_id = ? AND checked_at < ?
             AND id NOT IN (
               SELECT MAX(id) FROM reconciliation_results
               WHERE network = ? AND contract_id = ?
               GROUP BY check_name, subject
             )`
        )
        .run(network, contractId, before, network, contractId).changes;
    },

    deleteAggregatesBefore({ network, contractId, beforeDay }) {
      const entries = database
        .prepare("DELETE FROM ledger_daily_aggregates WHERE network = ? AND contract_id = ? AND day < ?")
        .run(network, contractId, beforeDay).changes;
      const events = database
        .prepare("DELETE FROM event_daily_aggregates WHERE network = ? AND contract_id = ? AND day < ?")
        .run(network, contractId, beforeDay).changes;
      return entries + events;
    },

    getDailyAggregates({ network, contractId, token, fromDay, toDay } = {}) {
      const { clauses, values } = scopeClause({ network, contractId });
      if (token) {
        clauses.push("token = ?");
        values.push(token);
      }
      if (fromDay) {
        clauses.push("day >= ?");
        values.push(fromDay);
      }
      if (toDay) {
        clauses.push("day <= ?");
        values.push(toDay);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      return database
        .prepare(
          `SELECT network, contract_id AS contractId, token, day, inflow, outflow,
             entry_count AS entryCount, closing_balance AS closingBalance, last_ledger AS lastLedger
           FROM ledger_daily_aggregates ${where}
           ORDER BY network, contract_id, token, day`
        )
        .all(...values);
    },

    recordRetentionRun(run) {
      database.prepare(`
        INSERT INTO retention_runs (
          network, contract_id, ran_at, entries_rolled_up, entries_removed,
          events_rolled_up, events_removed, reconciliations_removed, aggregates_removed, archive_paths
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.network,
        run.contractId,
        run.ranAt,
        run.entriesRolledUp,
        run.entriesRemoved,
        run.eventsRolledUp,
        run.eventsRemoved,
        run.reconciliationsRemoved,
        run.aggregatesRemoved,
        JSON.stringify(run.archivePaths ?? [])
      );
    },

    getRetentionRuns({ network, contractId, limit = 20 } = {}) {
      const { clauses, values } = scopeClause({ network, contractId });
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      return database
        .prepare(
          `SELECT network, contract_id AS contractId, ran_at AS ranAt,
             entries_rolled_up AS entriesRolledUp, entries_removed AS entriesRemoved,
             events_rolled_up AS eventsRolledUp, events_removed AS eventsRemoved,
             reconciliations_removed AS reconciliationsRemoved,
             aggregates_removed AS aggregatesRemoved, archive_paths AS archivePaths
           FROM retention_runs ${where} ORDER BY id DESC LIMIT ?`
        )
        .all(...values, limit)
        .map((row) => ({ ...row, archivePaths: JSON.parse(row.archivePaths) }));
    },

    close() {
      database.close();
    },
  };

  return store;
}
// Kept for existing imports; the SQLite store now lives in ./store/sqlite.js.
export { openLedgerStore } from "./store/sqlite.js";
