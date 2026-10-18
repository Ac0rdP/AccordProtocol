import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { backfill, reindex } from "../src/commands.js";
import { eventDedupeKey, parseAccordEvent, parseTokenTransferEvent } from "../src/events.js";
import { indexEventBatch } from "../src/indexing.js";
import {
  cleanupTempStores,
  createMockRpc,
  createStore,
  describeEachBackend,
  encoded,
  makeEvent,
  tokenAddresses,
  treasury,
} from "./helpers.js";

afterEach(cleanupTempStores);

const tokens = [{ name: "USDC", address: tokenAddresses.USDC }];
const base = () => ({ tokens, treasuryAddress: treasury });
const tokenNames = new Map([[tokenAddresses.USDC.toLowerCase(), "USDC"]]);

/** An event shaped like the real RPC: id is `<toid>-<eventIndex>`. */
const positioned = ({ toid = "0000000180388626432", index = 0, ledger = 42, amount = 10n, txHash = "tx-a" } = {}) => ({
  ...makeEvent({ id: `${toid}-${String(index).padStart(10, "0")}`, ledger, amount }),
  txHash,
});

const accordEvent = ({ id, ledger = 42, txHash = "tx-a" }) => ({
  id,
  pagingToken: id,
  contractId: treasury,
  ledger,
  ledgerClosedAt: "2026-09-27T12:00:00Z",
  txHash,
  topic: [encoded("migrated", "symbol")],
  value: encoded({ owner_count: 2, total_weight: 2, version: 1 }, undefined),
});

describe("dedupe key", () => {
  it("is built from ledger, transaction and event index", () => {
    assert.equal(eventDedupeKey(positioned({ index: 3 })), "42:tx-a:3");
  });

  it("is stable across fetches and independent of the RPC paging token", () => {
    const first = positioned({ index: 1 });
    const refetched = { ...first, pagingToken: "a-different-cursor", id: "0000000180388626432-0000000001" };
    assert.equal(eventDedupeKey(first), eventDedupeKey(refetched));
  });

  it("separates events that differ in any of the three parts", () => {
    const keys = new Set([
      eventDedupeKey(positioned({ index: 0 })),
      eventDedupeKey(positioned({ index: 1 })),
      eventDedupeKey(positioned({ index: 0, txHash: "tx-b" })),
      eventDedupeKey(positioned({ index: 0, ledger: 43 })),
    ]);
    assert.equal(keys.size, 4);
  });

  it("prefers an explicit event index and never collides when none can be derived", () => {
    assert.equal(eventDedupeKey({ ...positioned({ index: 7 }), eventIndex: 2 }), "42:tx-a:2");
    const opaque = (id) => eventDedupeKey({ id, ledger: 5, txHash: "t" });
    assert.notEqual(opaque("abc"), opaque("abd"));
  });

  it("is attached to parsed transfer and protocol entries", () => {
    const transfer = parseTokenTransferEvent(positioned({ index: 4 }), tokenNames, treasury);
    assert.equal(transfer.dedupeKey, "42:tx-a:4");
    const accord = parseAccordEvent(accordEvent({ id: "0000000180388626432-0000000005" }), treasury);
    assert.equal(accord.dedupeKey, "42:tx-a:5");
  });
});

describeEachBackend("idempotent ingestion", () => {
  it("rejects the same chain position even when the RPC id differs", async () => {
    const store = await createStore();
    const original = parseTokenTransferEvent(positioned({ index: 2 }), tokenNames, treasury);
    const replayed = { ...original, eventId: "some-other-id" };

    assert.equal(await store.recordTransfer(original), true);
    assert.equal(await store.recordTransfer(replayed), false);
    assert.equal(await store.getBalance("USDC"), "10");
    assert.equal((await store.getEntries({ limit: 10, offset: 0 })).length, 1);

    const accord = parseAccordEvent(accordEvent({ id: "0000000180388626432-0000000003" }), treasury);
    assert.equal(await store.recordAccordEvent(accord), true);
    assert.equal(await store.recordAccordEvent({ ...accord, eventId: "some-other-id" }), false);
    assert.equal((await store.getAccordEvents({ limit: 10, offset: 0 })).length, 1);
    await store.close();
  });

  it("keeps distinct events in the same transaction", async () => {
    const store = await createStore();
    for (const index of [0, 1]) {
      const entry = parseTokenTransferEvent(positioned({ index }), tokenNames, treasury);
      assert.equal(await store.recordTransfer(entry), true);
    }
    assert.equal(await store.getBalance("USDC"), "20");
    await store.close();
  });

  it("does not double-count when the live indexer re-reads a ledger", async () => {
    const store = await createStore();
    const events = [positioned({ index: 0, ledger: 42 }), positioned({ index: 1, ledger: 43, amount: 5n })];
    const run = async () => {
      const stellar = createMockRpc({ events, latestLedger: 50 });
      return indexEventBatch({ stellar, store, ...base(), startLedger: 40, finalityLag: 0 });
    };

    const first = await run();
    assert.equal(first.indexed, 2);
    assert.equal(await store.getBalance("USDC"), "15");

    // Force the checkpoint back so the same ledgers are fetched again.
    await store.setState("next_ledger", "40");
    await store.setState("event_cursor", "");
    const second = await run();

    assert.equal(second.indexed, 0, "nothing new is recorded on reprocessing");
    assert.equal(await store.getBalance("USDC"), "15");
    assert.equal((await store.getEntries({ limit: 10, offset: 0 })).length, 2);
    await store.close();
  });

  it("does not double-count when the same ledger is re-ingested under a different paging token", async () => {
    const store = await createStore();
    const stellar = (events) => createMockRpc({ events, latestLedger: 50 });
    await indexEventBatch({ stellar: stellar([positioned({ index: 0 })]), store, ...base(), startLedger: 40, finalityLag: 0 });
    await store.setState("next_ledger", "40");

    // Same chain position, but the RPC hands back a different paging token.
    const reissued = { ...positioned({ index: 0 }), pagingToken: "retry" };
    const rerun = await indexEventBatch({ stellar: stellar([reissued]), store, ...base(), startLedger: 40, finalityLag: 0 });

    assert.equal(rerun.indexed, 0);
    assert.equal(await store.getBalance("USDC"), "10");
    await store.close();
  });

  it("honors dedupe on a repeated backfill", async () => {
    const store = await createStore();
    const events = [10, 11, 12].map((ledger) => positioned({ ledger, toid: `00000000000000${ledger}`, amount: 4n }));
    const stellar = createMockRpc({ events, oldestLedger: 10, latestLedger: 20 });

    await backfill({ ...base(), store, stellar, finalityLag: 0 });
    const again = await backfill({ ...base(), store, stellar, finalityLag: 0 });

    assert.equal(again.eventsIndexed, 0, "the second pass records nothing new");
    assert.equal(await store.getBalance("USDC"), "12");
    assert.equal((await store.getEntries({ limit: 10, offset: 0 })).length, 3);
    await store.close();
  });

  it("backfill over data the live indexer already ingested does not duplicate it", async () => {
    const store = await createStore();
    const events = [10, 11, 12].map((ledger) => positioned({ ledger, toid: `00000000000000${ledger}`, amount: 4n }));
    const stellar = createMockRpc({ events, oldestLedger: 10, latestLedger: 20 });

    await indexEventBatch({ stellar, store, ...base(), startLedger: 10, finalityLag: 0 });
    await backfill({ ...base(), store, stellar, finalityLag: 0 });

    assert.equal(await store.getBalance("USDC"), "12");
    assert.equal((await store.getEntries({ limit: 10, offset: 0 })).length, 3);
    await store.close();
  });

  it("reindex rebuilds to the same totals however many times it runs", async () => {
    const store = await createStore();
    const events = [10, 11, 12].map((ledger) => positioned({ ledger, toid: `00000000000000${ledger}`, amount: 4n }));
    const stellar = createMockRpc({ events, oldestLedger: 10, latestLedger: 20 });

    await reindex({ ...base(), store, stellar, finalityLag: 0 });
    await reindex({ ...base(), store, stellar, finalityLag: 0 });

    assert.equal(await store.getBalance("USDC"), "12");
    assert.equal((await store.getEntries({ limit: 10, offset: 0 })).length, 3);
    await store.close();
  });

  it("dedupes protocol events on re-ingestion", async () => {
    const store = await createStore();
    const events = [accordEvent({ id: "0000000180388626432-0000000000" })];
    const stellar = createMockRpc({ events, latestLedger: 50 });

    await indexEventBatch({ stellar, store, ...base(), startLedger: 40, finalityLag: 0 });
    await store.setState("next_ledger", "40");
    const rerun = await indexEventBatch({ stellar, store, ...base(), startLedger: 40, finalityLag: 0 });

    assert.equal(rerun.indexed, 0);
    assert.equal((await store.getAccordEvents({ limit: 10, offset: 0 })).length, 1);
    await store.close();
  });
});
