import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { backfill } from "../src/commands.js";
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
const base = () => ({ tokens, treasuryAddress: treasury });

function generateEvents(count = 20, startLedger = 10) {
  const events = [];
  for (let i = 0; i < count; i += 1) {
    events.push(
      makeEvent({
        id: `chaos-evt-${startLedger + i}`,
        ledger: startLedger + i,
        amount: 25n,
      })
    );
  }
  return events;
}

describeEachBackend("indexer RPC outage and chaos resilience", () => {
  it("survives an mid-backfill RPC outage, leaves state uncorrupted, and resumes without event loss or duplication", async () => {
    const store = await createStore();
    const events = generateEvents(30, 10);
    const expected = expectedBalances(events);

    // Mock RPC that fails on request #3 (mid-stream after 2 pages)
    let failureCount = 0;
    const stellar = createMockRpc({
      events,
      oldestLedger: 10,
      latestLedger: 50,
      failOnRequest: (_req, count) => {
        if (count === 3 && failureCount === 0) {
          failureCount += 1;
          return true; // throw RPC unavailable
        }
        return false;
      },
    });

    // 1. Initial backfill attempt encounters outage
    await assert.rejects(
      () =>
        backfill({
          ...base(),
          store,
          stellar,
          from: 10,
          to: 39,
          finalityLag: 0,
          pageLimit: 5,
        }),
      /RPC unavailable/
    );

    // 2. Assert no corruption during the outage:
    // Partial progress was recorded safely in the database
    const entriesMidOutage = await store.getEntries({ limit: 100, offset: 0 });
    assert.ok(entriesMidOutage.length > 0, "Partial progress before crash is preserved");
    assert.ok(entriesMidOutage.length < 30, "Outage halted ingestion without completing");

    // The checkpoint cursor reflects the furthest safely ingested page
    const savedCursor = await store.getState("backfill_cursor");
    assert.ok(savedCursor, "Saved cursor must be preserved for resume");

    // 3. RPC recovers (failOnRequest is now cleared)
    stellar.state.failOnRequest = null;

    // 4. Resume backfill
    const resumed = await backfill({
      ...base(),
      store,
      stellar,
      from: 10,
      to: 39,
      finalityLag: 0,
      pageLimit: 5,
    });

    assert.equal(resumed.complete, true, "Resumed backfill completes successfully");
    assert.equal(resumed.resumed, true, "Backfill must detect and resume from saved state");

    // 5. Assert final state integrity: exactly 30 unique events, 0 duplicates, correct balance
    const finalEntries = await store.getEntries({ limit: 100, offset: 0 });
    assert.equal(finalEntries.length, 30, "All 30 events must be indexed after recovery");

    const uniqueIds = new Set(finalEntries.map((e) => e.eventId));
    assert.equal(uniqueIds.size, 30, "Zero duplicates after resume");

    const finalBalance = await store.getBalance("USDC");
    assert.equal(finalBalance, expected.USDC, "Balances must strictly match after resume");

    await store.close();
  });

  it("handles repeated transient RPC failures and recovers cleanly", async () => {
    const store = await createStore();
    const events = generateEvents(15, 100);
    const expected = expectedBalances(events);

    let transientFailures = 0;
    const stellar = createMockRpc({
      events,
      oldestLedger: 100,
      latestLedger: 120,
      failOnRequest: () => {
        if (transientFailures < 2) {
          transientFailures += 1;
          return true;
        }
        return false;
      },
    });

    // 1st failure
    await assert.rejects(
      () => backfill({ ...base(), store, stellar, from: 100, to: 114, finalityLag: 0, pageLimit: 5 }),
      /RPC unavailable/
    );

    // 2nd failure
    await assert.rejects(
      () => backfill({ ...base(), store, stellar, from: 100, to: 114, finalityLag: 0, pageLimit: 5 }),
      /RPC unavailable/
    );

    // 3rd attempt succeeds as RPC is now stable
    const result = await backfill({
      ...base(),
      store,
      stellar,
      from: 100,
      to: 114,
      finalityLag: 0,
      pageLimit: 5,
    });

    assert.equal(result.complete, true);
    const entries = await store.getEntries({ limit: 50, offset: 0 });
    assert.equal(entries.length, 15);
    assert.equal(await store.getBalance("USDC"), expected.USDC);

    await store.close();
  });
});
