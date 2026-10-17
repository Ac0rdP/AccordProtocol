import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { backfill, reindex, resolveFirstLedger, resolveHistoryRange } from "../src/commands.js";
import { finalLedgerFor } from "../src/finality.js";
import {
  cleanupTempStores,
  createStore,
  createMockRpc,
  makeEvent,
  tokenAddresses,
  treasury,
} from "./helpers.js";

afterEach(cleanupTempStores);

const tokens = [{ name: "USDC", address: tokenAddresses.USDC }];
const base = () => ({ tokens, treasuryAddress: treasury });


/** A ten-ledger chain with one inflow per ledger, starting at ledger 10. */
function chainFromGenesis({ latestLedger = 19, amount = 10n } = {}) {
  const events = [];
  for (let ledger = 10; ledger <= latestLedger; ledger += 1) {
    events.push(makeEvent({ id: `e${ledger}`, ledger, amount }));
  }
  return events;
}

describe("range resolution", () => {
  it("uses the oldest ledger the RPC retains as the practical genesis", async () => {
    const stellar = createMockRpc({ events: [], oldestLedger: 7, latestLedger: 50 });
    assert.equal(await resolveFirstLedger(stellar), 7);
    // An explicit request wins over the retention window.
    assert.equal(await resolveFirstLedger(stellar, { requested: 3 }), 3);
  });

  it("falls back when the RPC cannot report a retention window", async () => {
    assert.equal(await resolveFirstLedger({}, { fallback: 12 }), 12);
    assert.equal(await resolveFirstLedger({ getLedgers: async () => { throw new Error("nope"); } }), 1);
    assert.equal(await resolveFirstLedger({ getLedgers: async () => ({}) }), 1);
  });

  it("clamps the end to the final ledger", async () => {
    const stellar = createMockRpc({ events: [], oldestLedger: 10, latestLedger: 100 });
    const range = await resolveHistoryRange({ stellar, from: 20, to: 200, finalityLag: 2 });
    assert.equal(range.start, 20);
    assert.equal(range.end, 98, "never indexes past the final ledger");
    assert.equal(range.latestLedger, 100);
    assert.equal(range.finalLedger, 98);
    assert.equal(range.clamped, true);
  });

  it("defaults the end to the final ledger when no --to is given", async () => {
    const stellar = createMockRpc({ events: [], oldestLedger: 1, latestLedger: 40 });
    const range = await resolveHistoryRange({ stellar, finalityLag: 5 });
    assert.equal(range.end, finalLedgerFor(40, 5));
    assert.equal(range.clamped, false);
  });

  it("rejects malformed ledger bounds", async () => {
    const stellar = createMockRpc({ events: [], oldestLedger: 1, latestLedger: 40 });
    await assert.rejects(() => resolveHistoryRange({ stellar, from: 0 }), /positive integer/);
    await assert.rejects(() => resolveHistoryRange({ stellar, to: -3 }), /positive integer/);
    await assert.rejects(() => resolveHistoryRange({ stellar, to: 1.5 }), /positive integer/);
  });
});

describe("backfill", () => {
  it("indexes history from the first relevant ledger to the present", async () => {
    const store = createStore();
    const events = chainFromGenesis();
    const stellar = createMockRpc({ events, oldestLedger: 10, latestLedger: 21 });

    const result = await backfill({ ...base(), store, stellar, finalityLag: 2 });

    assert.equal(result.start, 10);
    assert.equal(result.end, finalLedgerFor(21, 2));
    assert.equal(result.complete, true);
    const indexed = store.getEntries({ limit: 100, offset: 0 });
    assert.equal(indexed.length, 10, "every ledger in the chain is indexed");
    assert.deepEqual(indexed.map(({ eventId }) => eventId), events.map(({ id }) => id));
    // Running balances fold in chain order, not insertion order.
    assert.equal(store.getBalance("USDC"), "100");
    // The live indexer picks up where the backfill stopped.
    assert.equal(store.getState("next_ledger"), String(result.end + 1));
    assert.equal(store.getState("backfill_done"), "true");
    store.close();
  });

  it("reports progress while it walks the range", async () => {
    const store = createStore();
    const events = chainFromGenesis();
    const stellar = createMockRpc({ events, oldestLedger: 10, latestLedger: 21 });
    const progress = [];

    await backfill({
      ...base(), store, stellar, finalityLag: 2, pageLimit: 3,
      onProgress: (snapshot) => progress.push(snapshot),
    });

    assert.ok(progress.length >= 3, "progress is reported per page, not just at the end");
    assert.deepEqual(progress.map(({ percent }) => Math.round(percent * 100) / 100), [...progress.map(({ percent }) => Math.round(percent * 100) / 100)].sort((a, b) => a - b), "progress is monotonic");
    const last = progress.at(-1);
    assert.equal(last.complete, true);
    assert.equal(last.percent, 1);
    assert.equal(last.events, 10);
    for (const snapshot of progress) {
      assert.equal(typeof snapshot.ledger, "number");
      assert.equal(snapshot.start, 10);
    }
    store.close();
  });

  it("resumes from its checkpoint instead of restarting after an interruption", async () => {
    const store = createStore();
    const events = chainFromGenesis();
    const stellar = createMockRpc({
      events,
      oldestLedger: 10,
      latestLedger: 21,
      failOnRequest: (_request, count) => count === 2,
    });

    await assert.rejects(
      () => backfill({ ...base(), store, stellar, finalityLag: 2, pageLimit: 3 }),
      /RPC unavailable/
    );
    const afterCrash = store.getEntries({ limit: 100, offset: 0 }).length;
    assert.ok(afterCrash > 0 && afterCrash < 10, "the interrupted run made partial progress");
    assert.equal(store.getState("backfill_done"), "false");

    // The RPC is healthy again; the second run must continue, not restart.
    stellar.state.failOnRequest = null;
    stellar.state.requests.length = 0;
    const resumed = await backfill({ ...base(), store, stellar, finalityLag: 2, pageLimit: 3 });

    assert.equal(resumed.resumed, true, "the run reports that it resumed");
    assert.equal(resumed.complete, true);
    // Resumption continues from the saved cursor rather than the range start.
    assert.equal(stellar.state.requests[0].cursor, "e12");
    assert.equal(stellar.state.requests[0].startLedger, undefined);
    assert.equal(store.getEntries({ limit: 100, offset: 0 }).length, 10, "no event is duplicated by the resume");
    assert.equal(store.getBalance("USDC"), "100");
    store.close();
  });

  it("is idempotent when re-run over an already indexed range", async () => {
    const store = createStore();
    const events = chainFromGenesis();
    const stellar = createMockRpc({ events, oldestLedger: 10, latestLedger: 21 });

    await backfill({ ...base(), store, stellar, finalityLag: 2 });
    await backfill({ ...base(), store, stellar, finalityLag: 2 });

    assert.equal(store.getEntries({ limit: 100, offset: 0 }).length, 10);
    assert.equal(store.getBalance("USDC"), "100");
    store.close();
  });

  it("fills older history into an existing store and re-folds its balances", async () => {
    const store = createStore();
    // The store already holds the recent tail, as a live indexer would.
    const recent = chainFromGenesis({ latestLedger: 19 }).slice(8);
    const stellarTail = createMockRpc({ events: recent, oldestLedger: 18, latestLedger: 21 });
    await backfill({ ...base(), store, stellar: stellarTail, finalityLag: 2 });
    assert.equal(store.getEntries({ limit: 100, offset: 0 }).length, 2);
    assert.equal(store.getBalance("USDC"), "20");
    store.setState("next_ledger", "20");

    // Now the operator backfills the missing earlier history.
    const events = chainFromGenesis({ latestLedger: 19 });
    const stellar = createMockRpc({ events, oldestLedger: 10, latestLedger: 21 });
    await backfill({ ...base(), store, stellar, from: 10, to: 17, finalityLag: 2 });

    assert.equal(store.getEntries({ limit: 100, offset: 0 }).length, 10);
    // Balances re-fold in chain order rather than insertion order.
    assert.equal(store.getBalance("USDC"), "100");
    assert.equal(store.getState("next_ledger"), "20", "the live checkpoint is never walked backwards");
    store.close();
  });

  it("does nothing when the requested range is already behind the chain", async () => {
    const store = createStore();
    const stellar = createMockRpc({ events: [], oldestLedger: 10, latestLedger: 12 });
    const result = await backfill({ ...base(), store, stellar, from: 10, to: 9, finalityLag: 2 });
    assert.equal(result.nothingToDo, true);
    assert.equal(stellar.state.requests.length, 0, "no RPC walk is attempted");
    store.close();
  });
});

describe("reindex", () => {
  it("rebuilds the store from chain events", async () => {
    const store = createStore();
    // Seed the store with data that no longer matches the chain.
    const stale = createMockRpc({
      events: [makeEvent({ id: "stale-1", ledger: 4, amount: 999n }), makeEvent({ id: "stale-2", ledger: 5, amount: 1n })],
      oldestLedger: 1,
      latestLedger: 5,
    });
    await backfill({ ...base(), store, stellar: stale, from: 4, to: 5, finalityLag: 0 });
    assert.equal(store.getBalance("USDC"), "1000");
    store.recordAccordEvent({
      eventId: "stale-accord", topic: "created", payload: {}, ledger: 5, transactionHash: "hash", occurredAt: "2026-09-27T12:00:00Z",
    });

    const events = chainFromGenesis();
    const stellar = createMockRpc({ events, oldestLedger: 10, latestLedger: 21 });
    const result = await reindex({ ...base(), store, stellar, finalityLag: 2 });

    assert.equal(result.complete, true);
    assert.equal(result.resumedRebuild, false);
    const indexed = store.getEntries({ limit: 100, offset: 0 });
    assert.deepEqual(indexed.map(({ eventId }) => eventId), events.map(({ id }) => id), "stale rows are gone");
    assert.equal(store.getBalance("USDC"), "100");
    assert.equal(store.getAccordEvents({ limit: 100, offset: 0 }).length, 0, "stale protocol events are cleared");
    assert.equal(store.getState("store_rebuilding"), "false");
    assert.equal(store.getState("next_ledger"), String(result.end + 1));
    store.close();
  });

  it("resumes an interrupted rebuild without wiping its partial progress", async () => {
    const store = createStore();
    const events = chainFromGenesis();
    const stellar = createMockRpc({
      events,
      oldestLedger: 10,
      latestLedger: 21,
      failOnRequest: (_request, count) => count === 2,
    });

    await assert.rejects(
      () => reindex({ ...base(), store, stellar, finalityLag: 2, pageLimit: 3 }),
      /RPC unavailable/
    );
    const afterCrash = store.getEntries({ limit: 100, offset: 0 }).length;
    assert.ok(afterCrash > 0, "the interrupted rebuild left partial progress on disk");
    assert.equal(store.getState("store_rebuilding"), "true", "an unfinished rebuild stays flagged");

    stellar.state.failOnRequest = null;
    stellar.state.requests.length = 0;
    const resumed = await reindex({ ...base(), store, stellar, finalityLag: 2, pageLimit: 3 });

    assert.equal(resumed.resumedRebuild, true);
    assert.equal(resumed.resumed, true, "the walk resumes from the saved cursor");
    assert.equal(stellar.state.requests[0].cursor, "e12");
    assert.equal(stellar.state.requests[0].startLedger, undefined);
    assert.equal(store.getEntries({ limit: 100, offset: 0 }).length, 10, "no duplicates from the resume");
    assert.equal(store.getBalance("USDC"), "100");
    assert.equal(store.getState("store_rebuilding"), "false");
    store.close();
  });

  it("starts over when a new range is requested mid-rebuild", async () => {
    const store = createStore();
    const events = chainFromGenesis();
    const stellar = createMockRpc({
      events,
      oldestLedger: 10,
      latestLedger: 21,
      failOnRequest: (_request, count) => count === 2,
    });

    await assert.rejects(
      () => reindex({ ...base(), store, stellar, from: 10, to: 19, finalityLag: 2, pageLimit: 3 }),
      /RPC unavailable/
    );
    assert.equal(store.getEntries({ limit: 100, offset: 0 }).length, 3, "one full page landed before the failure");

    // A different range cannot resume the old checkpoint, so it rebuilds clean.
    stellar.state.failOnRequest = null;
    const result = await reindex({ ...base(), store, stellar, from: 14, to: 19, finalityLag: 2, pageLimit: 3 });

    assert.equal(result.resumedRebuild, false);
    assert.deepEqual(
      store.getEntries({ limit: 100, offset: 0 }).map(({ eventId }) => eventId),
      ["e14", "e15", "e16", "e17", "e18", "e19"],
      "the old partial range is dropped, not merged in"
    );
    store.close();
  });
});
