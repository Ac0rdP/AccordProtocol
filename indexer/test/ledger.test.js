import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { parseTokenTransferEvent } from "../src/events.js";
import { indexEventBatch } from "../src/indexing.js";
import {
  cleanupTempStores,
  createStore,
  describeEachBackend,
  makeEvent,
  sender,
  tokenAddress,
  treasury,
} from "./helpers.js";

const event = ({ id = "event-1", from = sender, to = treasury, amount = 125n, ledger = 42 } = {}) =>
  makeEvent({ id, from, to, amount, ledger });

afterEach(cleanupTempStores);

describeEachBackend("treasury ledger", () => {
  it("records transfers once and keeps per-token running balances", async () => {
    const store = await createStore();
    const entry = parseTokenTransferEvent(event(), new Map([[tokenAddress.toLowerCase(), "USDC"]]), treasury);

    assert.ok(entry);
    assert.equal(await store.recordTransfer(entry), true);
    assert.equal(await store.recordTransfer(entry), false);
    assert.equal(await store.getBalance("USDC"), "125");

    const outflow = parseTokenTransferEvent(
      event({ id: "event-2", from: treasury, to: sender, amount: 25n }),
      new Map([[tokenAddress.toLowerCase(), "USDC"]]),
      treasury
    );
    assert.ok(outflow);
    assert.equal(outflow.direction, "outflow");
    await store.recordTransfer(outflow);

    assert.equal(await store.getBalance("USDC"), "100");
    assert.equal((await store.getEntries({ token: "USDC", from: "2026-09-27T00:00:00.000Z", to: "2026-09-27T23:59:59.999Z", limit: 10, offset: 0 })).length, 2);
    await store.close();
  });

  it("ignores unrelated token activity", () => {
    const parsed = parseTokenTransferEvent(
      event({ to: sender }),
      new Map([[tokenAddress.toLowerCase(), "USDC"]]),
      treasury
    );
    assert.equal(parsed, null);
  });

  it("stores the latest reconciliation result per token", async () => {
    const store = await createStore();
    await store.recordReconciliation({
      token: "XLM",
      tokenAddress,
      checkedAt: "2026-09-27T12:00:00.000Z",
      impliedBalance: "100",
      actualBalance: "125",
      drift: "25",
    });
    await store.recordReconciliation({
      token: "XLM",
      tokenAddress,
      checkedAt: "2026-09-27T12:01:00.000Z",
      impliedBalance: "125",
      actualBalance: "125",
      drift: "0",
    });

    assert.equal((await store.getLatestReconciliations()).length, 1);
    assert.equal((await store.getLatestReconciliations())[0].drift, "0");
    await store.close();
  });

  it("replays configured ledgers across pages before handing off to live indexing", async () => {
    const store = await createStore();
    const responses = [
      {
        events: [
          event({ id: "event-1", amount: 10n }),
          event({ id: "event-2", amount: 20n }),
        ],
        cursor: "page-1",
        latestLedger: 42,
      },
      {
        events: [event({ id: "event-3", amount: 30n, ledger: 43 })],
        latestLedger: 43,
      },
    ];
    const requests = [];
    const stellar = {
      getEvents: async (request) => {
        requests.push(request);
        return responses.shift();
      },
    };

    await indexEventBatch({
      stellar,
      store,
      tokens: [{ name: "USDC", address: tokenAddress }],
      treasuryAddress: treasury,
      startLedger: 40,
      pageLimit: 2,
      // Pagination mechanics are what this test covers; finality is exercised
      // separately in finality.test.js. A lag of 0 makes every closed ledger final.
      finalityLag: 0,
    });

    assert.equal(requests[0].startLedger, 40);
    assert.equal(requests[1].cursor, "page-1");
    assert.deepEqual(
      (await store.getEntries({ token: "USDC", limit: 10, offset: 0 })).map(({ eventId, balance }) => [eventId, balance]),
      [["event-1", "10"], ["event-2", "30"], ["event-3", "60"]]
    );
    assert.equal(await store.getState("next_ledger"), "44");
    assert.equal(await store.getState("event_cursor"), "");
    await store.close();
  });

  it("rewinds indexed data when the store is rolled back to a safe point", async () => {
    const store = await createStore();
    const tokenNames = new Map([[tokenAddress.toLowerCase(), "USDC"]]);
    for (const [id, amount, ledger] of [["event-1", 10n, 40], ["event-2", 20n, 41], ["event-3", 5n, 42]]) {
      const entry = parseTokenTransferEvent(event({ id, amount, ledger }), tokenNames, treasury);
      assert.equal(await store.recordTransfer(entry), true);
    }
    await store.recordAccordEvent({
      eventId: "accord-1", topic: "created", payload: {}, ledger: 42, transactionHash: "hash", occurredAt: "2026-09-27T12:00:00Z",
    });
    assert.equal(await store.getBalance("USDC"), "35");

    const removed = await store.rewindToLedger(41);

    assert.deepEqual(removed, { removedEntries: 1, removedEvents: 1 });
    // Running balance re-folds over what survived the rewind.
    assert.equal(await store.getBalance("USDC"), "30");
    assert.deepEqual(
      (await store.getEntries({ token: "USDC", limit: 10, offset: 0 })).map(({ eventId, balance }) => [eventId, balance]),
      [["event-1", "10"], ["event-2", "30"]]
    );
    assert.equal((await store.getAccordEvents({ limit: 10, offset: 0 })).length, 0);
    // Rewinding to the same point again is a no-op, not an error.
    assert.deepEqual(await store.rewindToLedger(41), { removedEntries: 0, removedEvents: 0 });
    await store.close();
  });

  it("rejects a rewind target that is not a non-negative integer", async () => {
    const store = await createStore();
    await assert.rejects(() => store.rewindToLedger(-1), /non-negative integer/);
    await assert.rejects(() => store.rewindToLedger(1.5), /non-negative integer/);
    await store.close();
  });

  it("clears all indexed history so the store can be rebuilt", async () => {
    const store = await createStore();
    const entry = parseTokenTransferEvent(
      event({ amount: 40n }),
      new Map([[tokenAddress.toLowerCase(), "USDC"]]),
      treasury
    );
    await store.recordTransfer(entry);
    await store.recordAccordEvent({
      eventId: "accord-1", topic: "created", payload: {}, ledger: 42, transactionHash: "hash", occurredAt: "2026-09-27T12:00:00Z",
    });
    await store.recordReconciliation({
      token: "USDC", tokenAddress, checkedAt: "2026-09-27T12:00:00.000Z",
      impliedBalance: "40", actualBalance: "40", drift: "0",
    });
    await store.setState("next_ledger", "43");

    const cleared = await store.clearHistory();

    assert.deepEqual(
      { removedEntries: cleared.removedEntries, removedEvents: cleared.removedEvents, removedReconciliations: cleared.removedReconciliations },
      { removedEntries: 1, removedEvents: 1, removedReconciliations: 1 }
    );
    assert.equal(await store.getBalance("USDC"), "0");
    assert.equal((await store.getEntries({ limit: 10, offset: 0 })).length, 0);
    assert.equal((await store.getLatestReconciliations()).length, 0);
    // Checkpoints belong to the caller, not to the wipe.
    assert.equal(await store.getState("next_ledger"), "43");
    await store.close();
  });
});