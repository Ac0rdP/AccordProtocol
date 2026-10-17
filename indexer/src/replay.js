import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { resolveHistoryRange, walkHistory, DEFAULT_PAGE_LIMIT } from "./commands.js";
import { DEFAULT_FINALITY_LAG } from "./finality.js";
import { openPostgresStore } from "./store/postgres.js";
import { openLedgerStore } from "./store/sqlite.js";

/** SQLite's in-memory database: gone when the process exits, shared with nothing. */
export const IN_MEMORY_STORE = ":memory:";

/**
 * Works out which ledgers a replay covers.
 *
 * Either an explicit `--from`/`--to` range, or a window relative to the live
 * indexer's checkpoint (`next_ledger`, the first ledger it has not yet indexed):
 *
 *   --before-checkpoint N   the N ledgers already indexed: [checkpoint-N, checkpoint-1]
 *   --after-checkpoint N    the N ledgers the indexer has yet to cover: [checkpoint, checkpoint+N-1]
 *
 * `checkpoint` is supplied by the caller so this stays a pure function.
 */
export function resolveReplayWindow({ from, to, beforeCheckpoint, afterCheckpoint, checkpoint }) {
  const relative = [beforeCheckpoint, afterCheckpoint].filter((value) => value !== undefined);
  if (relative.length > 1) {
    throw new Error("--before-checkpoint and --after-checkpoint cannot be combined");
  }
  if (relative.length === 1) {
    if (from !== undefined || to !== undefined) {
      throw new Error("--from/--to cannot be combined with --before-checkpoint/--after-checkpoint");
    }
    const count = relative[0];
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error("checkpoint window size must be a positive integer");
    }
    if (!Number.isSafeInteger(checkpoint) || checkpoint < 1) {
      throw new Error("the live store has no checkpoint yet; use --from/--to instead");
    }
    if (beforeCheckpoint !== undefined) {
      return { from: Math.max(1, checkpoint - count), to: checkpoint - 1, checkpoint, relativeTo: "before-checkpoint" };
    }
    return { from: checkpoint, to: checkpoint + count - 1, checkpoint, relativeTo: "after-checkpoint" };
  }
  if (from === undefined || to === undefined) {
    throw new Error("replay needs --from and --to (or --before-checkpoint / --after-checkpoint)");
  }
  if (to < from) throw new Error("--to must not be before --from");
  return { from, to, checkpoint: Number.isSafeInteger(checkpoint) ? checkpoint : null, relativeTo: null };
}

/**
 * Reads the live indexer's checkpoint (`next_ledger`) without writing to it:
 * SQLite is opened read-only and Postgres without running migrations.
 * Returns null when the live store has no checkpoint yet.
 */
export async function readLiveCheckpoint(storeConfig) {
  let value = null;
  if (storeConfig.backend === "postgres") {
    const live = await openPostgresStore({ ...storeConfig, migrate: false });
    try {
      value = await live.getState("next_ledger");
    } finally {
      await live.close();
    }
  } else if (existsSync(storeConfig.databasePath)) {
    const live = new DatabaseSync(resolve(storeConfig.databasePath), { readOnly: true });
    try {
      value = live.prepare("SELECT value FROM indexer_state WHERE key = 'next_ledger'").get()?.value ?? null;
    } catch {
      value = null; // not an indexer database yet
    } finally {
      live.close();
    }
  }
  const checkpoint = Number(value);
  return Number.isSafeInteger(checkpoint) && checkpoint >= 1 ? checkpoint : null;
}

/**
 * Opens the store a replay writes to. It is always a SQLite database that is
 * never the live one: in memory by default, or a file the operator names so the
 * result can be inspected afterwards. A path that resolves to the live SQLite
 * file is refused so a typo cannot overwrite production data.
 */
export function openReplayStore({ path = IN_MEMORY_STORE, liveDatabasePath } = {}) {
  if (path !== IN_MEMORY_STORE && liveDatabasePath && resolve(path) === resolve(liveDatabasePath)) {
    throw new Error("--replay-store must not be the live DATABASE_PATH");
  }
  return openLedgerStore(path);
}

/** One human-readable line describing what a replayed event decoded to. */
export function formatReplayEvent({ event, ledger, transfer, accord, transferRecorded, accordRecorded }) {
  const id = event.id ?? event.pagingToken ?? "?";
  const tx = event.txHash ? ` tx=${event.txHash}` : "";
  const parts = [];
  if (transfer) {
    const arrow = transfer.direction === "inflow" ? "<-" : "->";
    const counterparty = transfer.direction === "inflow" ? transfer.from : transfer.to;
    parts.push(`${transfer.token} ${transfer.direction} ${transfer.amount} ${arrow} ${counterparty}${transferRecorded ? "" : " (duplicate)"}`);
  }
  if (accord) {
    parts.push(`accord:${accord.topic} ${JSON.stringify(accord.payload)}${accordRecorded ? "" : " (duplicate)"}`);
  }
  if (parts.length === 0) parts.push("ignored (not a treasury transfer or catalogued Accord event)");
  return `ledger ${ledger} event ${id}${tx} :: ${parts.join(" | ")}`;
}

/** The same detail as a JSON-serialisable object, for `--json` output. */
export function replayEventRecord({ event, ledger, transfer, accord, transferRecorded, accordRecorded }) {
  return {
    kind: "event",
    ledger,
    id: event.id ?? event.pagingToken ?? null,
    transactionHash: event.txHash ?? null,
    transfer: transfer ?? null,
    transferRecorded,
    accord: accord ?? null,
    accordRecorded,
  };
}

/**
 * Replays a ledger range into `replayStore` and reports every event.
 *
 * The caller owns the store, which must not be the live one (see
 * `openReplayStore`). The live store is only ever read, and only through
 * `readCheckpoint`, so a replay cannot change production data.
 *
 * @returns {Promise<object>} the range, walk summary and resulting balances
 */
export async function replay({
  stellar,
  replayStore,
  tokens,
  treasuryAddress,
  from,
  to,
  finalityLag = DEFAULT_FINALITY_LAG,
  pageLimit = DEFAULT_PAGE_LIMIT,
  onEvent = () => {},
  onProgress = () => {},
}) {
  const range = await resolveHistoryRange({ stellar, from, to, finalityLag, fallbackStart: from });
  if (range.start > range.end) {
    return { ...range, eventsIndexed: 0, eventsSeen: 0, pages: 0, complete: true, nothingToDo: true, balances: {} };
  }

  let eventsSeen = 0;
  const walk = await walkHistory({
    stellar,
    store: replayStore,
    tokens,
    treasuryAddress,
    start: range.start,
    end: range.end,
    stateKey: "replay",
    pageLimit,
    onProgress,
    onEvent: (detail) => {
      eventsSeen += 1;
      onEvent(detail);
    },
  });

  await replayStore.recomputeBalances();
  const balances = {};
  for (const { name } of tokens) balances[name] = await replayStore.getBalance(name);

  return { ...range, ...walk, eventsSeen, nothingToDo: false, balances };
}
