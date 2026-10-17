import { parseAccordEvent, parseTokenTransferEvent } from "./events.js";
import { DEFAULT_FINALITY_LAG, finalLedgerFor, resolveFinalityLag } from "./finality.js";
import { buildContractFilters } from "./indexing.js";

/** Events requested per RPC page. */
export const DEFAULT_PAGE_LIMIT = 1000;
/** Ledger sequence assumed to be the chain genesis when the RPC cannot say. */
export const DEFAULT_GENESIS_LEDGER = 1;

/**
 * Discovers the oldest ledger the RPC still retains. History before that point
 * is no longer servable, so it is the practical "genesis" for a backfill.
 * Falls back to `INDEXER_START_LEDGER` (or ledger 1) when the RPC does not
 * expose the retention window.
 */
export async function resolveFirstLedger(stellar, { requested, fallback = DEFAULT_GENESIS_LEDGER } = {}) {
  if (requested !== undefined && requested !== null) return requested;
  if (typeof stellar.getLedgers === "function") {
    try {
      const response = await stellar.getLedgers({ pagination: { limit: 1 } });
      const oldest = Number(response?.oldestLedger);
      if (Number.isSafeInteger(oldest) && oldest >= 1) return oldest;
    } catch {
      // Older RPC nodes may not implement getLedgers; fall through.
    }
  }
  return fallback;
}

async function resolveChainHead(stellar) {
  if (typeof stellar.getLatestLedger === "function") {
    const response = await stellar.getLatestLedger();
    const sequence = Number(response?.sequence ?? response);
    if (Number.isSafeInteger(sequence) && sequence >= 0) return sequence;
  }
  return null;
}

/**
 * Works out the ledger range a history walk should cover.
 *
 * The end is always clamped to the final ledger: non-final ledgers are never
 * indexed, so an explicit `--to` past the final ledger is honoured only up to
 * that point.
 */
export async function resolveHistoryRange({
  stellar,
  from,
  to,
  finalityLag = DEFAULT_FINALITY_LAG,
  fallbackStart = DEFAULT_GENESIS_LEDGER,
}) {
  const lag = resolveFinalityLag(finalityLag);
  const head = await resolveChainHead(stellar);
  const finalLedger = head === null ? Number.POSITIVE_INFINITY : finalLedgerFor(head, lag);
  const requestedEnd = to === undefined || to === null ? Number.POSITIVE_INFINITY : Number(to);
  const end = Math.min(requestedEnd, finalLedger);
  const start = await resolveFirstLedger(stellar, { requested: from, fallback: fallbackStart });

  if (!Number.isSafeInteger(start) || start < 1) {
    throw new Error("backfill start ledger must be a positive integer");
  }
  if (to !== undefined && to !== null && (!Number.isSafeInteger(Number(to)) || Number(to) < 1)) {
    throw new Error("backfill end ledger must be a positive integer");
  }

  return {
    start,
    end,
    latestLedger: head,
    finalLedger,
    // Only an explicit --to can be clamped; omitting it just means "to the tip".
    clamped: to !== undefined && to !== null && Number.isFinite(finalLedger) && Number(to) > finalLedger,
  };
}

function progressFraction(start, end, ledger) {
  if (!Number.isFinite(end) || end < start) return 0;
  return Math.min(1, Math.max(0, (ledger - start + 1) / (end - start + 1)));
}

/**
 * Walks a ledger range and ingests its events, persisting a checkpoint after
 * every page so an interrupted run resumes where it stopped instead of
 * starting over.
 *
 * `stateKey` namespaces the checkpoint, which is how `backfill` and `reindex`
 * keep independent progress and how `reindex` can tell "resume this rebuild"
 * from "start a new one".
 */
export async function walkHistory({
  stellar,
  store,
  tokens,
  treasuryAddress,
  start,
  end,
  stateKey = "backfill",
  pageLimit = DEFAULT_PAGE_LIMIT,
  maxPages = Number.MAX_SAFE_INTEGER,
  onProgress = () => {},
}) {
  const tokenNames = new Map(tokens.map(({ name, address }) => [address.toLowerCase(), name]));
  const filters = buildContractFilters({ tokens, treasuryAddress });
  const cursorKey = `${stateKey}_cursor`;
  const startLedgerKey = `${stateKey}_start_ledger`;
  const fromKey = `${stateKey}_from`;
  const toKey = `${stateKey}_to`;
  const doneKey = `${stateKey}_done`;
  const eventsKey = `${stateKey}_events`;

  // Resume only when a previous run of this command covered exactly the same
  // range and never finished; any other stored checkpoint belongs to a
  // different job and is replaced.
  const resuming =
    (await store.getState(doneKey)) !== "true" &&
    Number(await store.getState(fromKey)) === start &&
    Number(await store.getState(toKey)) === end;

  let cursor = resuming ? (await store.getState(cursorKey)) ?? "" : "";
  let walkLedger = resuming ? Number(await store.getState(startLedgerKey) ?? start) : start;
  let pages = resuming ? Number(await store.getState(`${stateKey}_pages`) ?? 0) : 0;
  let eventsIndexed = resuming ? Number(await store.getState(eventsKey) ?? 0) : 0;

  await store.setState(fromKey, start);
  await store.setState(toKey, end);
  await store.setState(doneKey, "false");

  let furthestLedger = Math.max(start - 1, resuming ? Number(await store.getState(`${stateKey}_ledger`) ?? start - 1) : start - 1);

  while (pages < maxPages) {
    const response = await stellar.getEvents({
      ...(cursor ? { cursor } : { startLedger: walkLedger }),
      filters,
      limit: pageLimit,
    });

    let passedEnd = false;

    for (const event of response.events) {
      const eventLedger = Number(event.ledger);
      // Everything past the requested end belongs to the live indexer, so stop
      // ingesting here but keep it in view for progress reporting.
      if (Number.isFinite(end) && eventLedger > end) {
        passedEnd = true;
        continue;
      }
      if (eventLedger < start) continue;

      const transferEntry = parseTokenTransferEvent(event, tokenNames, treasuryAddress);
      if (transferEntry && (await store.recordTransfer(transferEntry))) eventsIndexed += 1;
      const accordEntry = parseAccordEvent(event, treasuryAddress);
      if (accordEntry && (await store.recordAccordEvent(accordEntry))) eventsIndexed += 1;
      if (eventLedger > furthestLedger) furthestLedger = eventLedger;
    }

    const exhausted = response.events.length < pageLimit || passedEnd;

    if (exhausted) {
      await store.setState(eventsKey, eventsIndexed);
      await store.setState(doneKey, "true");
      await store.setState(cursorKey, "");
      onProgress({
        start,
        end,
        ledger: Math.min(furthestLedger, Number.isFinite(end) ? end : furthestLedger),
        events: eventsIndexed,
        pages,
        percent: 1,
        complete: true,
        resumed: resuming,
      });
      return { start, end, pages, eventsIndexed, furthestLedger, resumed: resuming, complete: true };
    }

    if (!response.cursor || response.cursor === cursor) {
      throw new Error("RPC event pagination did not advance its cursor");
    }
    cursor = response.cursor;
    pages += 1;
    await store.setState(cursorKey, cursor);
    await store.setState(startLedgerKey, walkLedger);
    await store.setState(`${stateKey}_pages`, pages);
    await store.setState(`${stateKey}_ledger`, furthestLedger);
    await store.setState(eventsKey, eventsIndexed);

    onProgress({
      start,
      end,
      ledger: furthestLedger,
      events: eventsIndexed,
      pages,
      percent: progressFraction(start, end, furthestLedger),
      complete: false,
      resumed: resuming,
    });
  }

  return { start, end, pages, eventsIndexed, furthestLedger, resumed: resuming, complete: false };
}

/**
 * Backfills history from the first relevant ledger to the present.
 *
 * Safe on both a fresh deployment (nothing indexed yet) and an existing one:
 * inserts are keyed by event id so re-ingesting an overlap is a no-op, and the
 * running balances are re-folded in chain order once the walk completes.
 *
 * @returns {Promise<object>} the walk summary plus the range that was covered
 */
export async function backfill(options) {
  const {
    stellar, store, tokens, treasuryAddress,
    from, to, finalityLag = DEFAULT_FINALITY_LAG,
    pageLimit = DEFAULT_PAGE_LIMIT, onProgress = () => {},
    fallbackStart = DEFAULT_GENESIS_LEDGER,
  } = options;

  const range = await resolveHistoryRange({ stellar, from, to, finalityLag, fallbackStart });
  onRangeResolved(range, onProgress);

  if (range.start > range.end) {
    onProgress({ ...range, events: 0, pages: 0, percent: 1, complete: true, resumed: false, note: "nothing to backfill" });
    return { ...range, eventsIndexed: 0, pages: 0, complete: true, nothingToDo: true };
  }

  const walk = await walkHistory({
    stellar, store, tokens, treasuryAddress,
    start: range.start, end: range.end,
    stateKey: "backfill", pageLimit, onProgress,
  });

  if (walk.complete) {
    await finishHistoryRun(store, range.end);
    await store.recomputeBalances();
  }

  return { ...range, ...walk, nothingToDo: false };
}

/**
 * Rebuilds the store from chain events: clears everything indexed so far and
 * re-walks history.
 *
 * A rebuild that is interrupted leaves `store_rebuilding` set and its walk
 * checkpoint on disk; the next `reindex` for the same range resumes it instead
 * of wiping the partial progress again.
 */
export async function reindex(options) {
  const {
    stellar, store, tokens, treasuryAddress,
    from, to, finalityLag = DEFAULT_FINALITY_LAG,
    pageLimit = DEFAULT_PAGE_LIMIT, onProgress = () => {},
    fallbackStart = DEFAULT_GENESIS_LEDGER,
  } = options;

  const range = await resolveHistoryRange({ stellar, from, to, finalityLag, fallbackStart });
  onRangeResolved(range, onProgress);

  const resumingRebuild =
    (await store.getState("store_rebuilding")) === "true" &&
    (await store.getState("reindex_done")) !== "true" &&
    Number(await store.getState("reindex_from")) === range.start &&
    Number(await store.getState("reindex_to")) === range.end;

  if (range.start > range.end) {
    if (!resumingRebuild) await store.clearHistory();
    onProgress({ ...range, events: 0, pages: 0, percent: 1, complete: true, resumed: resumingRebuild, note: "nothing to reindex" });
    return { ...range, eventsIndexed: 0, pages: 0, complete: true, nothingToDo: true };
  }

  if (!resumingRebuild) {
    const cleared = await store.clearHistory();
    // A fresh rebuild must not inherit the previous walk's checkpoint.
    for (const key of ["reindex_cursor", "reindex_start_ledger", "reindex_pages", "reindex_ledger", "reindex_events", "reindex_done"]) {
      await store.setState(key, "");
    }
    onProgress({ ...range, cleared, events: 0, pages: 0, percent: 0, complete: false, resumed: false, note: "cleared store" });
  }

  await store.setState("store_rebuilding", "true");

  const walk = await walkHistory({
    stellar, store, tokens, treasuryAddress,
    start: range.start, end: range.end,
    stateKey: "reindex", pageLimit, onProgress,
  });

  if (walk.complete) {
    await finishHistoryRun(store, range.end);
    await store.recomputeBalances();
    await store.setState("store_rebuilding", "false");
  }

  return { ...range, ...walk, nothingToDo: false, resumedRebuild: resumingRebuild };
}

async function finishHistoryRun(store, end) {
  // Hand the range over to the live indexer: it should continue from the first
  // ledger after the range we just covered, never from an older checkpoint.
  const currentNext = Number(await store.getState("next_ledger") ?? 0);
  if (end + 1 > currentNext) await store.setState("next_ledger", end + 1);
  await store.setState("event_cursor", "");
}

function onRangeResolved(range, onProgress) {
  onProgress({
    ...range,
    // The walk has not moved yet, so report the ledger just before the range.
    ledger: range.start - 1,
    events: 0,
    pages: 0,
    percent: 0,
    complete: false,
    resumed: false,
    note: range.clamped ? "end clamped to the final ledger" : "range resolved",
  });
}
