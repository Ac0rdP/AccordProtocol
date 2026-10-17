import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  DEFAULT_FINALITY_LAG,
  detectReorg,
  finalLedgerFor,
  isLedgerFinal,
  resolveFinalityLag,
} from "../src/finality.js";
import { indexEventBatch } from "../src/indexing.js";
import {
  cleanupTempStores,
  createStore,
  describeEachBackend,
  createMockRpc,
  expectedBalances,
  makeEvent,
  tokenAddresses,
  tokenNames,
  treasury,
} from "./helpers.js";

afterEach(cleanupTempStores);

const tokens = [{ name: "USDC", address: tokenAddresses.USDC }];

/** Asserts the store holds exactly the chain's final events, in chain order. */
async function assertMatchesChain(store, chainEvents, { latestLedger, finalityLag = DEFAULT_FINALITY_LAG }) {
  const finalLedger = finalLedgerFor(latestLedger, finalityLag);
  const expectedEvents = chainEvents.filter((event) => event.ledger <= finalLedger);
  const indexed = await store.getEntries({ limit: 1000, offset: 0 });
  assert.deepEqual(
    indexed.map(({ eventId }) => eventId).sort(),
    expectedEvents.map(({ id }) => id).sort(),
    "indexed event ids should match the chain's final events"
  );
  const expected = expectedBalances(expectedEvents);
  for (const name of ["USDC", "XLM"]) {
    assert.equal(
      await store.getBalance(name),
      expected[name] ?? "0",
      `indexed balance for ${name} should match the chain's final events`
    );
  }
}

describe("ledger finality policy", () => {
  it("holds back the configured number of ledgers behind the chain head", () => {
    assert.equal(DEFAULT_FINALITY_LAG, 2);
    assert.equal(finalLedgerFor(100), 98);
    assert.equal(finalLedgerFor(100, 0), 100);
    assert.equal(finalLedgerFor(100, 5), 95);
    assert.equal(isLedgerFinal(98, 100), true);
    assert.equal(isLedgerFinal(99, 100), false);
    assert.equal(isLedgerFinal(99, 100, 0), true);
  });

  it("never reports a final ledger past the start of the chain", () => {
    assert.equal(finalLedgerFor(0), 0);
    assert.equal(finalLedgerFor(1), 0);
    assert.equal(isLedgerFinal(1, 1), false);
  });

  it("normalises and validates an externally supplied lag", () => {
    assert.equal(resolveFinalityLag(undefined), DEFAULT_FINALITY_LAG);
    assert.equal(resolveFinalityLag(""), DEFAULT_FINALITY_LAG);
    assert.equal(resolveFinalityLag("4"), 4);
    assert.equal(resolveFinalityLag(0), 0);
    assert.throws(() => resolveFinalityLag(-1), /non-negative integer/);
    assert.throws(() => resolveFinalityLag(1.5), /non-negative integer/);
    assert.throws(() => resolveFinalityLag("abc"), /non-negative integer/);
  });

  it("rejects ledger sequences that are not safe non-negative integers", () => {
    assert.throws(() => finalLedgerFor(-1), /non-negative integer/);
    assert.throws(() => isLedgerFinal("x", 10), /non-negative integer/);
    assert.throws(() => detectReorg({ previousLatestLedger: 5, latestLedger: -2 }), /non-negative integer/);
  });
});

describe("rollback detection", () => {
  it("flags a chain head that moved backwards", () => {
    assert.deepEqual(
      detectReorg({ previousLatestLedger: 100, latestLedger: 97, finalityLag: 2 }),
      { reorg: true, fromLedger: 100, toLedger: 97, rewindTo: 95 }
    );
  });

  it("ignores an advancing or unchanged head, and a cold store", () => {
    assert.equal(detectReorg({ previousLatestLedger: 100, latestLedger: 101 }), null);
    assert.equal(detectReorg({ previousLatestLedger: 100, latestLedger: 100 }), null);
    assert.equal(detectReorg({ previousLatestLedger: 0, latestLedger: 100 }), null);
    assert.equal(detectReorg({ previousLatestLedger: null, latestLedger: 100 }), null);
  });
});

describeEachBackend("finality-aware ingestion", () => {
  it("holds back a not-yet-final ledger and indexes it once the chain advances", async () => {
    const store = await createStore();
    const events = [
      makeEvent({ id: "e10", ledger: 10, amount: 10n }),
      makeEvent({ id: "e11", ledger: 11, amount: 20n }),
      makeEvent({ id: "e12", ledger: 12, amount: 40n }),
    ];
    const stellar = createMockRpc({ events, latestLedger: 12 });

    // Head 12 with a lag of 2 leaves ledger 10 final, so e11/e12 wait.
    const first = await indexEventBatch({
      stellar, store, tokens, treasuryAddress: treasury, startLedger: 1, finalityLag: 2,
    });
    assert.equal(first.indexed, 1);
    assert.equal(first.heldBack, 2);
    assert.equal(first.finalLedger, 10);
    assert.equal(await store.getState("next_ledger"), "11", "checkpoint parks at the first held-back ledger");
    await assertMatchesChain(store, events, { latestLedger: 12 });

    // The chain advances: the held-back ledgers become final and are picked up.
    stellar.setChainHead(14);
    const second = await indexEventBatch({
      stellar, store, tokens, treasuryAddress: treasury, startLedger: 1, finalityLag: 2,
    });
    assert.equal(second.indexed, 2);
    assert.equal(second.heldBack, 0);
    assert.equal(await store.getState("next_ledger"), "13");
    await assertMatchesChain(store, events, { latestLedger: 14 });
    assert.equal(second.reorg, null);
    await store.close();
  });

  it("parks the checkpoint at the held-back ledger instead of a stale cursor", async () => {
    const store = await createStore();
    const events = [makeEvent({ id: "e10", ledger: 10, amount: 10n })];
    const stellar = createMockRpc({ events, latestLedger: 10 });

    await indexEventBatch({ stellar, store, tokens, treasuryAddress: treasury, startLedger: 1, finalityLag: 2 });

    // Ledger 10 is not final at head 10 with a lag of 2, so nothing is stored
    // and the checkpoint points back at the ledger so the next pass re-reads it.
    assert.equal((await store.getEntries({ limit: 10, offset: 0 })).length, 0);
    assert.equal(await store.getState("next_ledger"), "10");
    assert.equal(await store.getState("event_cursor"), "");
    assert.equal(await store.getState("last_seen_ledger"), "10");
    await store.close();
  });

  it("rewinds to a point consistent with the chain after a rollback, then catches up", async () => {
    const store = await createStore();
    const events = [
      makeEvent({ id: "e10", ledger: 10, amount: 10n }),
      makeEvent({ id: "e11", ledger: 11, amount: 20n }),
      makeEvent({ id: "e12", ledger: 12, amount: 40n }),
      makeEvent({ id: "e13", ledger: 13, amount: 80n }),
    ];
    const stellar = createMockRpc({ events, latestLedger: 15 });

    await indexEventBatch({ stellar, store, tokens, treasuryAddress: treasury, startLedger: 1, finalityLag: 2 });
    assert.equal((await store.getEntries({ limit: 100, offset: 0 })).length, 4, "all four ledgers were final at head 15");
    assert.equal(await store.getBalance("USDC"), "150");

    // The RPC replica rewinds to ledger 12, orphaning ledger 13.
    stellar.rollbackTo(12);
    const afterRollback = await indexEventBatch({
      stellar, store, tokens, treasuryAddress: treasury, startLedger: 1, finalityLag: 2,
    });

    assert.ok(afterRollback.reorg, "a head regression is reported as a rollback");
    assert.equal(afterRollback.reorg.fromLedger, 15);
    assert.equal(afterRollback.reorg.toLedger, 12);
    // The rewind is bounded by the regression depth: 15 - 12 = 3 ledgers.
    assert.equal(afterRollback.reorg.rewindTo, 10);
    assert.equal(afterRollback.reorg.removedEntries, 3);
    assert.equal(await store.getState("next_ledger"), "11");
    // Indexed state now equals what the new chain view considers final.
    await assertMatchesChain(store, stellar.state.events, { latestLedger: 12 });

    // The chain recovers and advances; the rewound range is re-ingested.
    stellar.setChainHead(14);
    await indexEventBatch({ stellar, store, tokens, treasuryAddress: treasury, startLedger: 1, finalityLag: 2 });
    await assertMatchesChain(store, stellar.state.events, { latestLedger: 14 });
    assert.equal(await store.getBalance("USDC"), "70", "orphaned ledger 13 stays out of the balance");
    await store.close();
  });

  it("leaves a cold store untouched when nothing has been seen yet", async () => {
    const store = await createStore();
    const stellar = createMockRpc({ events: [makeEvent({ id: "e1", ledger: 5 })], latestLedger: 5 });
    const result = await indexEventBatch({
      stellar, store, tokens, treasuryAddress: treasury, startLedger: 1, finalityLag: 2,
    });
    assert.equal(result.reorg, null);
    assert.equal((await store.getEntries({ limit: 10, offset: 0 })).length, 0);
    await store.close();
  });
});
