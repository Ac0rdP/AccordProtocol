import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Keypair, nativeToScVal, StrKey, xdr } from "@stellar/stellar-sdk";
import { parseTokenTransferEvent } from "../src/events.js";
import { indexEventBatch } from "../src/indexing.js";
import { openLedgerStore } from "../src/ledger.js";

const tempDirectories = [];
const treasury = StrKey.encodeContract(Buffer.alloc(32, 1));
const sender = Keypair.random().publicKey();
const tokenAddress = StrKey.encodeContract(Buffer.alloc(32, 2));

function encoded(value, type) {
  return xdr.ScVal.fromXDR(nativeToScVal(value, { type }).toXDR("base64"), "base64");
}

function event({ id = "event-1", from = sender, to = treasury, amount = 125n, ledger = 42 } = {}) {
  return {
    id,
    contractId: tokenAddress,
    ledger,
    ledgerClosedAt: "2026-09-27T12:00:00Z",
    txHash: "transaction-hash",
    topic: [encoded("transfer", "symbol"), encoded(from, "address"), encoded(to, "address")],
    value: encoded(amount, "i128"),
  };
}

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "accord-indexer-"));
  tempDirectories.push(directory);
  return openLedgerStore(join(directory, "ledger.sqlite"));
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("treasury ledger", () => {
  it("records transfers once and keeps per-token running balances", () => {
    const store = createStore();
    const entry = parseTokenTransferEvent(event(), new Map([[tokenAddress.toLowerCase(), "USDC"]]), treasury);

    assert.ok(entry);
    assert.equal(store.recordTransfer(entry), true);
    assert.equal(store.recordTransfer(entry), false);
    assert.equal(store.getBalance("USDC"), "125");

    const outflow = parseTokenTransferEvent(
      event({ id: "event-2", from: treasury, to: sender, amount: 25n }),
      new Map([[tokenAddress.toLowerCase(), "USDC"]]),
      treasury
    );
    assert.ok(outflow);
    assert.equal(outflow.direction, "outflow");
    store.recordTransfer(outflow);

    assert.equal(store.getBalance("USDC"), "100");
    assert.equal(store.getEntries({ token: "USDC", from: "2026-09-27T00:00:00.000Z", to: "2026-09-27T23:59:59.999Z", limit: 10, offset: 0 }).length, 2);
    store.close();
  });

  it("ignores unrelated token activity", () => {
    const parsed = parseTokenTransferEvent(
      event({ to: sender }),
      new Map([[tokenAddress.toLowerCase(), "USDC"]]),
      treasury
    );
    assert.equal(parsed, null);
  });

  it("stores the latest reconciliation result per token", () => {
    const store = createStore();
    store.recordReconciliation({
      token: "XLM",
      tokenAddress,
      checkedAt: "2026-09-27T12:00:00.000Z",
      impliedBalance: "100",
      actualBalance: "125",
      drift: "25",
    });
    store.recordReconciliation({
      token: "XLM",
      tokenAddress,
      checkedAt: "2026-09-27T12:01:00.000Z",
      impliedBalance: "125",
      actualBalance: "125",
      drift: "0",
    });

    assert.equal(store.getLatestReconciliations().length, 1);
    assert.equal(store.getLatestReconciliations()[0].drift, "0");
    store.close();
  });

  it("replays configured ledgers across pages before handing off to live indexing", async () => {
    const store = createStore();
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
      store.getEntries({ token: "USDC", limit: 10, offset: 0 }).map(({ eventId, balance }) => [eventId, balance]),
      [["event-1", "10"], ["event-2", "30"], ["event-3", "60"]]
    );
    assert.equal(store.getState("next_ledger"), "44");
    assert.equal(store.getState("event_cursor"), "");
    store.close();
  });

  it("rewinds indexed data when the store is rolled back to a safe point", () => {
    const store = createStore();
    const tokenNames = new Map([[tokenAddress.toLowerCase(), "USDC"]]);
    for (const [id, amount, ledger] of [["event-1", 10n, 40], ["event-2", 20n, 41], ["event-3", 5n, 42]]) {
      const entry = parseTokenTransferEvent(event({ id, amount, ledger }), tokenNames, treasury);
      assert.equal(store.recordTransfer(entry), true);
    }
    store.recordAccordEvent({
      eventId: "accord-1", topic: "created", payload: {}, ledger: 42, transactionHash: "hash", occurredAt: "2026-09-27T12:00:00Z",
    });
    assert.equal(store.getBalance("USDC"), "35");

    const removed = store.rewindToLedger(41);

    assert.deepEqual(removed, { removedEntries: 1, removedEvents: 1 });
    // Running balance re-folds over what survived the rewind.
    assert.equal(store.getBalance("USDC"), "30");
    assert.deepEqual(
      store.getEntries({ token: "USDC", limit: 10, offset: 0 }).map(({ eventId, balance }) => [eventId, balance]),
      [["event-1", "10"], ["event-2", "30"]]
    );
    assert.equal(store.getAccordEvents({ limit: 10, offset: 0 }).length, 0);
    // Rewinding to the same point again is a no-op, not an error.
    assert.deepEqual(store.rewindToLedger(41), { removedEntries: 0, removedEvents: 0 });
    store.close();
  });

  it("rejects a rewind target that is not a non-negative integer", () => {
    const store = createStore();
    assert.throws(() => store.rewindToLedger(-1), /non-negative integer/);
    assert.throws(() => store.rewindToLedger(1.5), /non-negative integer/);
    store.close();
  });

  it("clears all indexed history so the store can be rebuilt", () => {
    const store = createStore();
    const entry = parseTokenTransferEvent(
      event({ amount: 40n }),
      new Map([[tokenAddress.toLowerCase(), "USDC"]]),
      treasury
    );
    store.recordTransfer(entry);
    store.recordAccordEvent({
      eventId: "accord-1", topic: "created", payload: {}, ledger: 42, transactionHash: "hash", occurredAt: "2026-09-27T12:00:00Z",
    });
    store.recordReconciliation({
      token: "USDC", tokenAddress, checkedAt: "2026-09-27T12:00:00.000Z",
      impliedBalance: "40", actualBalance: "40", drift: "0",
    });
    store.setState("next_ledger", "43");

    const cleared = store.clearHistory();

    assert.deepEqual(
      { removedEntries: cleared.removedEntries, removedEvents: cleared.removedEvents, removedReconciliations: cleared.removedReconciliations },
      { removedEntries: 1, removedEvents: 1, removedReconciliations: 1 }
    );
    assert.equal(store.getBalance("USDC"), "0");
    assert.equal(store.getEntries({ limit: 10, offset: 0 }).length, 0);
    assert.equal(store.getLatestReconciliations().length, 0);
    // Checkpoints belong to the caller, not to the wipe.
    assert.equal(store.getState("next_ledger"), "43");
    store.close();
  });
});