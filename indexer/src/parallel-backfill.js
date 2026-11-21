import { parseAccordEvent, parseTokenTransferEvent } from "./events.js";
import { buildContractFilters } from "./indexing.js";

/**
 * Parallel, resumable backfill.
 *
 * The ledger range is split into fixed-size shards. Each shard is walked with
 * its own RPC cursor and persists its own checkpoint (`backfill_shards`), so:
 *
 *   - a failing shard is retried from its own cursor without touching the rest;
 *   - a re-run skips shards already `done` and resumes the others in place;
 *   - replaying any shard from any checkpoint is safe, because every insert is
 *     keyed by event id (the checkpoint is written *after* the page's events).
 *
 * Shard boundaries are anchored at the range start (`start + k * shardSize`),
 * so a later run whose end moved forward only appends or extends shards.
 */

export const DEFAULT_SHARD_SIZE = 50000;
export const DEFAULT_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 60000;

/** Splits `[start, end]` into contiguous shards of at most `shardSize` ledgers. */
export function planShards({ start, end, shardSize = DEFAULT_SHARD_SIZE }) {
  if (!Number.isSafeInteger(start) || start < 1) throw new Error("shard plan start must be a positive integer");
  if (!Number.isSafeInteger(end) || end < start) throw new Error("shard plan end must be an integer >= start");
  if (!Number.isSafeInteger(shardSize) || shardSize < 1) throw new Error("shard size must be a positive integer");
  const shards = [];
  for (let first = start, index = 0; first <= end; first += shardSize, index += 1) {
    shards.push({ index, start: first, end: Math.min(end, first + shardSize - 1) });
  }
  return shards;
}

/** Identifies a job by what makes its shards reusable: the origin and the shard size. */
export function backfillJobId({ start, shardSize }) {
  return `backfill:${start}:${shardSize}`;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Walks one shard to the end of its window, checkpointing after every page. */
async function walkShard({ stellar, store, filters, tokenNames, treasuryAddress, jobId, shard, pageLimit, onPage }) {
  let cursor = shard.cursor || "";
  let pages = shard.pages;
  let eventsIndexed = shard.eventsIndexed;
  let furthest = shard.lastLedger ?? shard.start - 1;

  for (;;) {
    const response = await stellar.getEvents({
      ...(cursor ? { cursor } : { startLedger: shard.start }),
      filters,
      limit: pageLimit,
    });

    let passedEnd = false;
    for (const event of response.events) {
      const eventLedger = Number(event.ledger);
      // Past the shard end belongs to the next shard (or the live indexer).
      if (eventLedger > shard.end) {
        passedEnd = true;
        continue;
      }
      if (eventLedger < shard.start) continue;

      const transferEntry = parseTokenTransferEvent(event, tokenNames, treasuryAddress);
      if (transferEntry && (await store.recordTransfer(transferEntry))) eventsIndexed += 1;
      const accordEntry = parseAccordEvent(event, treasuryAddress);
      if (accordEntry && (await store.recordAccordEvent(accordEntry))) eventsIndexed += 1;
      if (eventLedger > furthest) furthest = eventLedger;
    }

    if (response.events.length < pageLimit || passedEnd) {
      const done = { status: "done", cursor: "", lastLedger: Math.min(Math.max(furthest, shard.start - 1), shard.end), pages, eventsIndexed };
      await store.updateBackfillShard({ jobId, shardIndex: shard.index, ...done });
      onPage(done);
      return;
    }

    if (!response.cursor || response.cursor === cursor) {
      throw new Error("RPC event pagination did not advance its cursor");
    }
    cursor = response.cursor;
    pages += 1;
    const progress = { status: "running", cursor, lastLedger: furthest, pages, eventsIndexed };
    // Written after the page's events: a crash in between replays the page, and
    // the event-id dedupe makes that a no-op.
    await store.updateBackfillShard({ jobId, shardIndex: shard.index, ...progress });
    onPage(progress);
  }
}

/**
 * Backfills `[start, end]` with up to `workers` shards walked concurrently.
 *
 * Returns once every shard is `done`, or once the remaining shards have
 * exhausted their in-run retries (they stay `failed` with their checkpoint, and
 * the next run resumes them).
 *
 * @returns {Promise<{start:number,end:number,pages:number,eventsIndexed:number,
 *   furthestLedger:number,resumed:boolean,complete:boolean,
 *   shards:{total:number,done:number,failed:number,resumed:number},failedShards:object[]}>}
 */
export async function parallelBackfill({
  stellar,
  store,
  tokens,
  treasuryAddress,
  start,
  end,
  workers = 1,
  shardSize = DEFAULT_SHARD_SIZE,
  maxShardRetries = 3,
  retryBaseDelayMs = DEFAULT_RETRY_DELAY_MS,
  pageLimit = 1000,
  onProgress = () => {},
  sleep = defaultSleep,
}) {
  if (!Number.isSafeInteger(workers) || workers < 1) throw new Error("backfill workers must be a positive integer");
  const plan = planShards({ start, end, shardSize });
  const jobId = backfillJobId({ start, shardSize });
  await store.registerBackfillJob({ jobId, shards: plan });

  const planned = new Set(plan.map(({ index }) => index));
  const loadShards = async () => (await store.listBackfillShards(jobId)).filter((shard) => planned.has(shard.index));
  const initial = await loadShards();
  const resumedShards = initial.filter((shard) => shard.status === "done" || shard.cursor || shard.attempts > 0).length;

  const tokenNames = new Map(tokens.map(({ name, address }) => [address.toLowerCase(), name]));
  const filters = buildContractFilters({ tokens, treasuryAddress });

  // In-memory view for progress reporting only; the store stays the source of truth.
  const view = new Map(initial.map((shard) => [shard.index, { ...shard }]));
  const totalLedgers = end - start + 1;
  const report = (complete = false) => {
    let covered = 0;
    let pages = 0;
    let events = 0;
    let furthest = start - 1;
    for (const shard of view.values()) {
      const length = shard.end - shard.start + 1;
      covered += shard.status === "done" ? length : Math.min(length, Math.max(0, (shard.lastLedger ?? shard.start - 1) - shard.start + 1));
      pages += shard.pages;
      events += shard.eventsIndexed;
      if (shard.lastLedger !== null && shard.lastLedger > furthest) furthest = shard.lastLedger;
    }
    const done = [...view.values()].filter((shard) => shard.status === "done").length;
    onProgress({
      start,
      end,
      ledger: furthest,
      events,
      pages,
      percent: complete ? 1 : Math.min(1, covered / totalLedgers),
      complete,
      resumed: resumedShards > 0,
      note: `${done}/${view.size} shards done`,
    });
  };

  const queue = initial.filter((shard) => shard.status !== "done").map((shard) => shard.index);
  const failures = new Map();

  async function runShardWithRetries(index) {
    let failedAttempts = 0;
    for (;;) {
      const shard = (await loadShards()).find((candidate) => candidate.index === index);
      await store.updateBackfillShard({ jobId, shardIndex: index, status: "running", attempts: shard.attempts + 1, lastError: null });
      try {
        await walkShard({
          stellar, store, filters, tokenNames, treasuryAddress, jobId, shard, pageLimit,
          onPage: (update) => {
            Object.assign(view.get(index), update);
            report();
          },
        });
        failures.delete(index);
        return;
      } catch (error) {
        failedAttempts += 1;
        const message = String(error?.message ?? error);
        // Keep whatever checkpoint the walk reached; only the status flips.
        await store.updateBackfillShard({ jobId, shardIndex: index, status: "failed", lastError: message });
        Object.assign(view.get(index), { status: "failed", lastError: message });
        failures.set(index, message);
        if (failedAttempts > maxShardRetries) return;
        await sleep(Math.min(MAX_RETRY_DELAY_MS, retryBaseDelayMs * 2 ** (failedAttempts - 1)));
      }
    }
  }

  async function worker() {
    while (queue.length > 0) {
      await runShardWithRetries(queue.shift());
    }
  }

  report();
  await Promise.all(Array.from({ length: Math.min(workers, Math.max(queue.length, 1)) }, worker));

  const finalShards = await loadShards();
  const done = finalShards.filter((shard) => shard.status === "done");
  const failed = finalShards.filter((shard) => shard.status !== "done");
  const complete = failed.length === 0;
  if (complete) report(true);

  return {
    start,
    end,
    pages: finalShards.reduce((sum, shard) => sum + shard.pages, 0),
    eventsIndexed: finalShards.reduce((sum, shard) => sum + shard.eventsIndexed, 0),
    furthestLedger: finalShards.reduce((max, shard) => Math.max(max, shard.lastLedger ?? 0), start - 1),
    resumed: resumedShards > 0,
    complete,
    shards: { total: finalShards.length, done: done.length, failed: failed.length, resumed: resumedShards },
    failedShards: failed.map((shard) => ({ index: shard.index, start: shard.start, end: shard.end, error: failures.get(shard.index) ?? shard.lastError })),
  };
}
