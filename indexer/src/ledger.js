import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
  `);

  const insertEntry = database.prepare(`
    INSERT INTO ledger_entries (
      event_id, token, token_address, direction, amount, balance, ledger,
      transaction_hash, occurred_at, from_address, to_address
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
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

  return {
    recordTransfer(entry) {
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

    getBalance(token) {
      return selectBalance.get(token)?.balance ?? "0";
    },

    getEntries({ token, from, to, limit, offset }) {
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
      `).all(...values, limit, offset);
    },

    recordAccordEvent(entry) {
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

    getAccordEvents({ topic, from, to, limit, offset }) {
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

    setState(key, value) {
      database.prepare(`
        INSERT INTO indexer_state (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, String(value));
    },

    getState(key) {
      return database.prepare("SELECT value FROM indexer_state WHERE key = ?").get(key)?.value ?? null;
    },

    recordReconciliation(result) {
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

    getLatestReconciliations() {
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

    close() {
      database.close();
    },
  };
}