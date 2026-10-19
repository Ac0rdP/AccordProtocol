import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { performance } from "node:perf_hooks";
import { backfill } from "../src/commands.js";
import {
  cleanupTempStores,
  createMockRpc,
  createStore,
  describeEachBackend,
  encoded,
  expectedBalances,
  makeEvent,
  sender,
  tokenAddresses,
  treasury,
} from "./helpers.js";

afterEach(cleanupTempStores);

const tokens = [
  { name: "USDC", address: tokenAddresses.USDC },
  { name: "XLM", address: tokenAddresses.XLM },
];
const base = () => ({ tokens, treasuryAddress: treasury });

/**
 * Generates a realistic, large synthetic history across many ledgers.
 * Includes a mixture of USDC and XLM transfers (both inbound and outbound)
 * and Accord protocol lifecycle events.
 */
function generateLargeHistory({
  startLedger = 100,
  ledgersCount = 500,
  eventsPerLedger = 5,
} = {}) {
  const events = [];
  let eventSeq = 0;

  for (let l = 0; l < ledgersCount; l += 1) {
    const ledger = startLedger + l;
    for (let e = 0; e < eventsPerLedger; e += 1) {
      eventSeq += 1;
      const isXlm = eventSeq % 3 === 0;
      const isOutflow = eventSeq % 7 === 0;
      const token = isXlm ? "XLM" : "USDC";
      const contractId = tokenAddresses[token];
      const from = isOutflow ? treasury : sender;
      const to = isOutflow ? sender : treasury;
      const amount = BigInt((eventSeq % 100) + 1) * 10_000_000n;

      events.push(
        makeEvent({
          id: `load-evt-${ledger}-${e}-${eventSeq}`,
          from,
          to,
          amount,
          ledger,
          contractId,
          closedAt: new Date(1760000000000 + ledger * 5000).toISOString(),
        })
      );
    }
  }

  return events;
}

describeEachBackend("indexer load testing against historical backfill", () => {
  it("completes a large historical backfill (2,500+ events) with zero data loss or duplicates", async () => {
    const store = await createStore();
    const totalEvents = 2500;
    const ledgersCount = 500;
    const eventsPerLedger = 5;
    const startLedger = 1000;
    const endLedger = startLedger + ledgersCount - 1;

    const events = generateLargeHistory({
      startLedger,
      ledgersCount,
      eventsPerLedger,
    });
    assert.equal(events.length, totalEvents);

    const stellar = createMockRpc({
      events,
      oldestLedger: startLedger,
      latestLedger: endLedger + 10,
    });

    const memBefore = process.memoryUsage().heapUsed;
    const t0 = performance.now();

    const result = await backfill({
      ...base(),
      store,
      stellar,
      from: startLedger,
      to: endLedger,
      finalityLag: 0,
      pageLimit: 500,
    });

    const t1 = performance.now();
    const durationMs = t1 - t0;
    const throughput = (totalEvents / (durationMs / 1000)).toFixed(1);
    const memDeltaMb = ((process.memoryUsage().heapUsed - memBefore) / 1024 / 1024).toFixed(2);

    // 1. Assert backfill completed fully
    assert.equal(result.complete, true, "Backfill must complete successfully");
    assert.equal(result.start, startLedger);
    assert.equal(result.end, endLedger);
    assert.equal(result.eventsIndexed, totalEvents, "All events must be indexed without loss");

    // 2. Assert store count and verify no missing records
    const storedEntries = await store.getEntries({ limit: totalEvents + 100, offset: 0 });
    assert.equal(storedEntries.length, totalEvents, "Stored entries count must match total event count");

    // 3. Assert zero duplicates
    const uniqueEventIds = new Set(storedEntries.map((e) => e.eventId));
    assert.equal(uniqueEventIds.size, totalEvents, "There must be zero duplicate event IDs");

    // 4. Assert balances match mathematical expectation
    const expected = expectedBalances(events);
    const usdcBalance = await store.getBalance("USDC");
    const xlmBalance = await store.getBalance("XLM");
    assert.equal(usdcBalance, expected.USDC);
    assert.equal(xlmBalance, expected.XLM);

    // 5. Assert idempotency under load: Re-running backfill must not duplicate events or corrupt balances
    const rerunResult = await backfill({
      ...base(),
      store,
      stellar,
      from: startLedger,
      to: endLedger,
      finalityLag: 0,
      pageLimit: 500,
    });
    assert.equal(rerunResult.complete, true);
    assert.equal(rerunResult.eventsIndexed, 0, "No duplicate events should be newly recorded on replay");

    const entriesAfterRerun = await store.getEntries({ limit: totalEvents + 100, offset: 0 });
    assert.equal(entriesAfterRerun.length, totalEvents, "Entry count must remain identical after rerun");
    assert.equal(await store.getBalance("USDC"), expected.USDC);
    assert.equal(await store.getBalance("XLM"), expected.XLM);

    // 6. Performance baseline assertions
    assert.ok(durationMs > 0, "Elapsed duration must be measurable");
    // Ensure throughput meets sustained ingestion ceiling threshold (> 50 events/sec even in test mock environment)
    assert.ok(
      Number(throughput) > 50,
      `Throughput (${throughput} events/s) should exceed minimum baseline threshold`
    );

    await store.close();
  });

  it("handles heavy pagination and cursor advancement across 1,000 events without state drift", async () => {
    const store = await createStore();
    const totalEvents = 1000;
    const events = generateLargeHistory({
      startLedger: 500,
      ledgersCount: 200,
      eventsPerLedger: 5,
    });

    const stellar = createMockRpc({
      events,
      oldestLedger: 500,
      latestLedger: 750,
    });

    // Run backfill with small page size (50 events/page = 20 pages)
    const result = await backfill({
      ...base(),
      store,
      stellar,
      from: 500,
      to: 699,
      finalityLag: 0,
      pageLimit: 50,
    });

    assert.equal(result.complete, true);
    assert.equal(result.eventsIndexed, totalEvents);
    assert.equal(result.pages, 20, "Must advance correctly through all 20 pages");

    const stored = await store.getEntries({ limit: 1200, offset: 0 });
    assert.equal(stored.length, totalEvents);

    await store.close();
  });
});
