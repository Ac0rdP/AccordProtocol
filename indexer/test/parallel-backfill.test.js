import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { backfill, reindex } from "../src/commands.js";
import { resolveBackfillConfig, loadIndexerConfig } from "../src/config.js";
import { backfillJobId, parallelBackfill, planShards } from "../src/parallel-backfill.js";
import {
  cleanupTempStores,
  createMockRpc,
  createStore,
  describeEachBackend,
  expectedBalances,
  makeEvent,
  tokenAddresses,
  treasury,
} from "./helpers.js";

afterEach(cleanupTempStores);

const tokens = [{ name: "USDC", address: tokenAddresses.USDC }];
const noSleep = async () => {};

function chain(first = 1, last = 30, amount = 10n) {
  const events = [];
  for (let ledger = first; ledger <= last; ledger += 1) events.push(makeEvent({ id: `e${ledger}`, ledger, amount }));
  return events;
}

async function entryIds(store) {
  return (await store.getEntries({ limit: 1000, offset: 0 })).map((entry) => entry.eventId).sort();
}

const parallel = { workers: 3, shardSize: 10, maxShardRetries: 1, retryBaseDelayMs: 0, sleep: noSleep };

function run(store, rpc, extra = {}) {
  return backfill({
    stellar: rpc, store, tokens, treasuryAddress: treasury,
    finalityLag: 0, pageLimit: 4, parallel, ...extra,
  });
}

describe("backfill configuration", () => {
  it("defaults to a single sequential worker", () => {
    assert.deepEqual(resolveBackfillConfig({}), {
      workers: 1, shardSize: 50000, maxShardRetries: 3, retryBaseDelayMs: 1000,
    });
    assert.equal(loadIndexerConfig({}).backfill.workers, 1);
  });

  it("applies overrides and falls back on invalid values", () => {
    const config = resolveBackfillConfig({
      BACKFILL_WORKERS: "8", BACKFILL_SHARD_SIZE: "1000",
      BACKFILL_SHARD_MAX_RETRIES: "0", BACKFILL_SHARD_RETRY_DELAY_MS: "250",
    });
    assert.deepEqual(config, { workers: 8, shardSize: 1000, maxShardRetries: 0, retryBaseDelayMs: 250 });
    assert.equal(resolveBackfillConfig({ BACKFILL_WORKERS: "0" }).workers, 1);
    assert.equal(resolveBackfillConfig({ BACKFILL_WORKERS: "999" }).workers, 1);
    assert.equal(resolveBackfillConfig({ BACKFILL_SHARD_SIZE: "abc" }).shardSize, 50000);
  });
});

describe("shard planning", () => {
  it("splits a range into contiguous shards anchored at the start", () => {
    assert.deepEqual(planShards({ start: 5, end: 27, shardSize: 10 }), [
      { index: 0, start: 5, end: 14 },
      { index: 1, start: 15, end: 24 },
      { index: 2, start: 25, end: 27 },
    ]);
    assert.deepEqual(planShards({ start: 1, end: 1, shardSize: 10 }), [{ index: 0, start: 1, end: 1 }]);
  });

  it("rejects invalid ranges and sizes", () => {
    assert.throws(() => planShards({ start: 0, end: 5, shardSize: 2 }), /start/);
    assert.throws(() => planShards({ start: 5, end: 4, shardSize: 2 }), /end/);
    assert.throws(() => planShards({ start: 1, end: 5, shardSize: 0 }), /shard size/);
  });

  it("keeps the job id stable when only the end moves", () => {
    assert.equal(backfillJobId({ start: 1, shardSize: 10 }), backfillJobId({ start: 1, shardSize: 10 }));
    assert.notEqual(backfillJobId({ start: 1, shardSize: 10 }), backfillJobId({ start: 2, shardSize: 10 }));
  });
});

describeEachBackend("backfill shard store", () => {
  it("registers shards once and keeps their checkpoints on re-register", async () => {
    const store = await createStore();
    const jobId = "job-a";
    await store.registerBackfillJob({ jobId, shards: planShards({ start: 1, end: 20, shardSize: 10 }) });
    await store.updateBackfillShard({ jobId, shardIndex: 0, status: "running", cursor: "c1", lastLedger: 4, pages: 1, eventsIndexed: 3 });
    await store.registerBackfillJob({ jobId, shards: planShards({ start: 1, end: 20, shardSize: 10 }) });

    const [first, second] = await store.listBackfillShards(jobId);
    // A shard left 'running' by a crashed worker is handed back, checkpoint intact.
    assert.equal(first.status, "pending");
    assert.equal(first.cursor, "c1");
    assert.equal(first.lastLedger, 4);
    assert.equal(first.eventsIndexed, 3);
    assert.equal(second.status, "pending");
  });

  it("reopens a finished shard when the range end moves forward", async () => {
    const store = await createStore();
    const jobId = "job-b";
    await store.registerBackfillJob({ jobId, shards: planShards({ start: 1, end: 15, shardSize: 10 }) });
    await store.updateBackfillShard({ jobId, shardIndex: 1, status: "done", cursor: "" });
    await store.registerBackfillJob({ jobId, shards: planShards({ start: 1, end: 25, shardSize: 10 }) });

    const shards = await store.listBackfillShards(jobId);
    assert.equal(shards.length, 3);
    assert.equal(shards[1].end, 20);
    assert.equal(shards[1].status, "pending");
  });

  it("drops shards that belong to a different job", async () => {
    const store = await createStore();
    await store.registerBackfillJob({ jobId: "old", shards: planShards({ start: 1, end: 10, shardSize: 10 }) });
    await store.registerBackfillJob({ jobId: "new", shards: planShards({ start: 5, end: 14, shardSize: 10 }) });
    assert.equal((await store.listBackfillShards("old")).length, 0);
    assert.equal((await store.listBackfillShards("new")).length, 1);
  });

  it("invalidates shards on clearHistory and on rewind", async () => {
    const store = await createStore();
    const shards = planShards({ start: 1, end: 30, shardSize: 10 });
    await store.registerBackfillJob({ jobId: "j", shards });
    await store.rewindToLedger(15);
    assert.deepEqual((await store.listBackfillShards("j")).map((shard) => shard.index), [0]);
    await store.clearHistory();
    assert.equal((await store.listBackfillShards("j")).length, 0);
  });
});

describeEachBackend("parallel backfill", () => {
  it("indexes the same history as the sequential backfill", async () => {
    const events = chain();
    const sequential = await createStore();
    await backfill({
      stellar: createMockRpc({ events, latestLedger: 30 }), store: sequential,
      tokens, treasuryAddress: treasury, finalityLag: 0, pageLimit: 4,
    });

    const sharded = await createStore();
    const result = await run(sharded, createMockRpc({ events, latestLedger: 30 }));

    assert.equal(result.complete, true);
    assert.equal(result.shards.total, 3);
    assert.equal(result.eventsIndexed, 30);
    assert.deepEqual(await entryIds(sharded), await entryIds(sequential));
    assert.equal(await sharded.getBalance("USDC"), await sequential.getBalance("USDC"));
    assert.deepEqual({ USDC: await sharded.getBalance("USDC") }, expectedBalances(events));
    assert.equal(await sharded.getState("next_ledger"), "31");
  });

  it("is idempotent: a replay of a finished job skips every shard", async () => {
    const store = await createStore();
    const rpc = createMockRpc({ events: chain(), latestLedger: 30 });
    await run(store, rpc);
    const before = { ids: await entryIds(store), balance: await store.getBalance("USDC") };
    const requestsBefore = rpc.state.requests.length;

    const again = await run(store, rpc);

    assert.equal(again.complete, true);
    assert.equal(again.shards.resumed, 3);
    assert.equal(rpc.state.requests.length, requestsBefore);
    assert.deepEqual({ ids: await entryIds(store), balance: await store.getBalance("USDC") }, before);
  });

  it("dedupes when a shard is replayed from the start over already indexed events", async () => {
    const store = await createStore();
    const events = chain();
    // A prior sequential run already indexed everything.
    await backfill({
      stellar: createMockRpc({ events, latestLedger: 30 }), store,
      tokens, treasuryAddress: treasury, finalityLag: 0, pageLimit: 4,
    });
    const before = await entryIds(store);

    const result = await run(store, createMockRpc({ events, latestLedger: 30 }));

    assert.equal(result.complete, true);
    // Everything was already recorded, so nothing is counted as newly indexed.
    assert.equal(result.eventsIndexed, 0);
    assert.deepEqual(await entryIds(store), before);
    assert.equal(await store.getBalance("USDC"), "300");
  });

  it("leaves a failed shard resumable and finishes only that shard on re-run", async () => {
    const store = await createStore();
    const events = chain();
    // Shard 1 (ledgers 11-20) cannot be reached at all.
    const rpc = createMockRpc({
      events, latestLedger: 30,
      failOnRequest: (request) => request.startLedger === 11,
    });

    const first = await run(store, rpc);

    assert.equal(first.complete, false);
    assert.deepEqual(first.shards, { total: 3, done: 2, failed: 1, resumed: 0 });
    assert.equal(first.failedShards[0].index, 1);
    assert.match(first.failedShards[0].error, /RPC unavailable/);
    // The live checkpoint must not move while the range has a hole in it.
    assert.equal(await store.getState("next_ledger"), null);
    assert.equal((await entryIds(store)).length, 20);

    rpc.state.failOnRequest = null;
    rpc.state.requests.length = 0;
    const second = await run(store, rpc);

    assert.equal(second.complete, true);
    assert.equal(second.shards.resumed, 3);
    // Only the failed shard hit the RPC again.
    assert.ok(rpc.state.requests.length > 0);
    assert.ok(rpc.state.requests.every((request) => request.startLedger === 11 || request.cursor));
    assert.equal(await store.getState("next_ledger"), "31");
    assert.deepEqual({ USDC: await store.getBalance("USDC") }, expectedBalances(events));
  });

  it("retries a shard from its own cursor instead of restarting it", async () => {
    const store = await createStore();
    let failed = false;
    const rpc = createMockRpc({
      events: chain(), latestLedger: 30,
      // Fail once on a mid-shard page request.
      failOnRequest: (request) => {
        if (!failed && request.cursor === "e14") {
          failed = true;
          return true;
        }
        return false;
      },
    });

    const result = await run(store, rpc);

    assert.equal(failed, true);
    assert.equal(result.complete, true);
    // Shard 1 opened its window exactly once; the retry continued from the cursor.
    assert.equal(rpc.state.requests.filter((request) => request.startLedger === 11).length, 1);
    assert.equal((await entryIds(store)).length, 30);
    const shard = (await store.listBackfillShards(backfillJobId({ start: 1, shardSize: 10 })))[1];
    assert.equal(shard.status, "done");
    assert.equal(shard.attempts, 2);
    assert.equal(shard.lastError, null);
  });

  it("resumes from the persisted cursor after a crash between pages", async () => {
    const store = await createStore();
    const events = chain();
    const jobId = backfillJobId({ start: 1, shardSize: 10 });
    // First run dies hard on shard 1's second page and is not retried.
    const crashing = createMockRpc({
      events, latestLedger: 30,
      failOnRequest: (request) => request.cursor === "e14",
    });
    const first = await run(store, crashing, { parallel: { ...parallel, maxShardRetries: 0 } });
    assert.equal(first.complete, false);
    const stalled = (await store.listBackfillShards(jobId))[1];
    assert.equal(stalled.status, "failed");
    assert.equal(stalled.cursor, "e14");

    const healthy = createMockRpc({ events, latestLedger: 30 });
    const second = await run(store, healthy);

    assert.equal(second.complete, true);
    // The failed shard picked up at its cursor rather than reopening its window.
    assert.equal(healthy.state.requests.some((request) => request.startLedger === 11), false);
    assert.deepEqual({ USDC: await store.getBalance("USDC") }, expectedBalances(events));
  });

  it("fails a shard whose RPC never advances its cursor", async () => {
    const store = await createStore();
    const rpc = createMockRpc({ events: chain(), latestLedger: 30 });
    const original = rpc.getEvents.bind(rpc);
    rpc.getEvents = async (request) => ({ ...(await original(request)), cursor: request.cursor });
    const result = await run(store, rpc, { parallel: { ...parallel, maxShardRetries: 0 } });
    assert.equal(result.complete, false);
    assert.match(result.failedShards[0].error, /did not advance its cursor/);
  });

  it("extends the job when the chain tip moves between runs", async () => {
    const store = await createStore();
    const events = chain();
    const rpc = createMockRpc({ events, latestLedger: 15 });
    const first = await run(store, rpc);
    assert.equal(first.complete, true);
    assert.equal((await entryIds(store)).length, 15);

    rpc.setChainHead(30);
    const second = await run(store, rpc);

    assert.equal(second.complete, true);
    assert.equal(second.shards.total, 3);
    assert.equal((await entryIds(store)).length, 30);
    assert.deepEqual({ USDC: await store.getBalance("USDC") }, expectedBalances(events));
    assert.equal(await store.getState("next_ledger"), "31");
  });

  it("starts a fresh job when the range origin changes", async () => {
    const store = await createStore();
    const rpc = createMockRpc({ events: chain(), latestLedger: 30 });
    await run(store, rpc, { from: 1 });
    await run(store, rpc, { from: 6 });
    assert.equal((await store.listBackfillShards(backfillJobId({ start: 1, shardSize: 10 }))).length, 0);
    assert.equal((await store.listBackfillShards(backfillJobId({ start: 6, shardSize: 10 }))).length, 3);
  });

  it("reports aggregate progress and completes at 100%", async () => {
    const store = await createStore();
    const reports = [];
    await run(store, createMockRpc({ events: chain(), latestLedger: 30 }), { onProgress: (progress) => reports.push(progress) });
    const percents = reports.map((progress) => progress.percent);
    assert.ok(percents.every((percent) => percent >= 0 && percent <= 1));
    assert.equal(reports.at(-1).complete, true);
    assert.equal(reports.at(-1).percent, 1);
  });

  it("rejects an invalid worker count", async () => {
    const store = await createStore();
    await assert.rejects(
      parallelBackfill({ stellar: createMockRpc(), store, tokens, treasuryAddress: treasury, start: 1, end: 5, workers: 0 }),
      /workers/,
    );
  });
});

describeEachBackend("backfill compatibility", () => {
  it("keeps using the single-cursor walk with the default config", async () => {
    const store = await createStore();
    const rpc = createMockRpc({ events: chain(), latestLedger: 30 });
    const result = await run(store, rpc, { parallel: resolveBackfillConfig({}) });

    assert.equal(result.complete, true);
    assert.equal(await store.getState("backfill_done"), "true");
    assert.equal((await store.listBackfillShards(backfillJobId({ start: 1, shardSize: 50000 }))).length, 0);
    assert.equal((await entryIds(store)).length, 30);
  });

  it("a reindex discards shard progress so a later backfill re-walks everything", async () => {
    const store = await createStore();
    const events = chain();
    const rpc = createMockRpc({ events, latestLedger: 30 });
    await run(store, rpc);

    await reindex({ stellar: rpc, store, tokens, treasuryAddress: treasury, finalityLag: 0, pageLimit: 4 });
    assert.equal((await store.listBackfillShards(backfillJobId({ start: 1, shardSize: 10 }))).length, 0);

    await store.clearHistory();
    const result = await run(store, rpc);
    assert.equal(result.complete, true);
    assert.equal(result.shards.resumed, 0);
    assert.equal((await entryIds(store)).length, 30);
  });
});
