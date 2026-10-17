import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { cleanupTempStores, createStore, describeEachBackend } from "./helpers.js";

afterEach(cleanupTempStores);

const transfer = (overrides = {}) => ({
  eventId: "t1",
  token: "USDC",
  tokenAddress: "CTOKEN",
  direction: "inflow",
  amount: "100",
  ledger: 10,
  transactionHash: "hash-1",
  occurredAt: "2026-09-27T12:00:00.000Z",
  from: "GSENDER",
  to: "CTREASURY",
  ...overrides,
});

const accordEvent = (overrides = {}) => ({
  eventId: "a1",
  topic: "created",
  payload: { id: "7", nested: { owners: ["GA", "GB"] }, big: "12345678901234567890" },
  ledger: 10,
  transactionHash: "hash-a1",
  occurredAt: "2026-09-27T12:00:00.000Z",
  ...overrides,
});

// One suite, run against every backend (see describeEachBackend): the stores
// must be indistinguishable to the rest of the indexer.
describeEachBackend("store contract", (backend) => {
  it("reports its backend and answers a ping", async () => {
    const store = await createStore();
    assert.equal(store.backend, backend);
    await store.ping();
  });

  it("rejects non-positive transfer amounts", async () => {
    const store = await createStore();
    await assert.rejects(() => store.recordTransfer(transfer({ amount: "0" })), /must be positive/);
    await assert.rejects(() => store.recordTransfer(transfer({ amount: "-5" })), /must be positive/);
    assert.equal(await store.getBalance("USDC"), "0");
  });

  it("filters and orders entries by chain position, with stable paging", async () => {
    const store = await createStore();
    await store.recordTransfer(transfer({ eventId: "late", ledger: 30, occurredAt: "2026-09-29T00:00:00.000Z", amount: "5" }));
    await store.recordTransfer(transfer({ eventId: "early", ledger: 10, occurredAt: "2026-09-27T00:00:00.000Z", amount: "1" }));
    await store.recordTransfer(transfer({ eventId: "xlm", token: "XLM", ledger: 20, occurredAt: "2026-09-28T00:00:00.000Z", amount: "9" }));

    await store.recomputeBalances(); // inserted out of order, so fold the running balances first
    const all = await store.getEntries({ limit: 10, offset: 0 });
    assert.deepEqual(all.map(({ eventId }) => eventId), ["early", "xlm", "late"]);
    assert.deepEqual(
      (await store.getEntries({ token: "USDC", limit: 10, offset: 0 })).map(({ eventId }) => eventId),
      ["early", "late"]
    );
    assert.deepEqual(
      (await store.getEntries({ from: "2026-09-28T00:00:00.000Z", to: "2026-09-28T23:59:59.999Z", limit: 10, offset: 0 }))
        .map(({ eventId }) => eventId),
      ["xlm"]
    );
    assert.deepEqual(
      (await store.getEntries({ limit: 1, offset: 1 })).map(({ eventId }) => eventId),
      ["xlm"]
    );
    // Shape and types are part of the contract: timestamps are ISO strings, ledgers numbers.
    assert.deepEqual(all[0], {
      eventId: "early", token: "USDC", tokenAddress: "CTOKEN", direction: "inflow", amount: "1", balance: "1",
      ledger: 10, transactionHash: "hash-1", occurredAt: "2026-09-27T00:00:00.000Z", from: "GSENDER", to: "CTREASURY",
    });
  });

  it("refolds balances in chain order after an out-of-order insert", async () => {
    const store = await createStore();
    await store.recordTransfer(transfer({ eventId: "new", ledger: 20, amount: "40" }));
    await store.recordTransfer(transfer({ eventId: "old", ledger: 10, amount: "60", direction: "inflow" }));
    await store.recordTransfer(transfer({ eventId: "out", ledger: 15, amount: "25", direction: "outflow" }));

    assert.equal(await store.recomputeBalances(), 1);
    assert.deepEqual(
      (await store.getEntries({ limit: 10, offset: 0 })).map(({ eventId, balance }) => [eventId, balance]),
      [["old", "60"], ["out", "35"], ["new", "75"]]
    );
    assert.equal(await store.getBalance("USDC"), "75");
  });

  it("keeps balances exact when transfers are recorded concurrently", async () => {
    const store = await createStore();
    await Promise.all(
      Array.from({ length: 25 }, (_, index) => store.recordTransfer(transfer({ eventId: `c${index}`, ledger: 10 + index, amount: "4" })))
    );
    assert.equal(await store.getBalance("USDC"), "100");
    const entries = await store.getEntries({ limit: 100, offset: 0 });
    assert.equal(entries.length, 25);
    assert.equal(entries.at(-1).balance, "100", "the last running balance equals the snapshot");
  });

  it("round-trips protocol event payloads and ignores duplicates", async () => {
    const store = await createStore();
    assert.equal(await store.recordAccordEvent(accordEvent()), true);
    assert.equal(await store.recordAccordEvent(accordEvent()), false);
    await store.recordAccordEvent(accordEvent({ eventId: "a2", topic: "approved", ledger: 11, occurredAt: "2026-09-28T12:00:00.000Z" }));

    const events = await store.getAccordEvents({ limit: 10, offset: 0 });
    assert.deepEqual(events.map(({ eventId }) => eventId), ["a1", "a2"]);
    assert.deepEqual(events[0].payload, accordEvent().payload);
    assert.equal(events[0].occurredAt, "2026-09-27T12:00:00.000Z");
    assert.deepEqual(
      (await store.getAccordEvents({ topic: "approved", limit: 10, offset: 0 })).map(({ eventId }) => eventId),
      ["a2"]
    );
    assert.equal((await store.getAccordEvents({ from: "2026-09-28T00:00:00.000Z", limit: 10, offset: 0 })).length, 1);
  });

  it("stores checkpoints as strings and overwrites them", async () => {
    const store = await createStore();
    assert.equal(await store.getState("next_ledger"), null);
    await store.setState("next_ledger", 12);
    await store.setState("next_ledger", 13);
    assert.equal(await store.getState("next_ledger"), "13");
  });

  it("lists the latest reconciliation per token in token order", async () => {
    const store = await createStore();
    const result = (token, checkedAt, drift) => ({
      token, tokenAddress: `C${token}`, checkedAt, impliedBalance: "1", actualBalance: "1", drift,
    });
    await store.recordReconciliation(result("XLM", "2026-09-27T12:00:00.000Z", "5"));
    await store.recordReconciliation(result("USDC", "2026-09-27T12:00:00.000Z", "1"));
    await store.recordReconciliation(result("XLM", "2026-09-27T12:01:00.000Z", "0"));

    assert.deepEqual(
      (await store.getLatestReconciliations()).map(({ token, drift, checkedAt }) => [token, drift, checkedAt]),
      [["USDC", "1", "2026-09-27T12:00:00.000Z"], ["XLM", "0", "2026-09-27T12:01:00.000Z"]]
    );
  });


  // The outbox behind webhook delivery.
  const NOW = "2026-09-27T12:00:00.000Z";
  const LATER = "2026-09-27T12:05:00.000Z";

  it("enqueues deliveries once per subscription and event, moving the cursor atomically", async () => {
    const store = await createStore();
    await store.recordAccordEvent(accordEvent());
    await store.recordAccordEvent(accordEvent({ eventId: "a2" }));
    const [first, second] = await store.getAccordEventsAfter(0, 10);
    assert.deepEqual([first.eventId, second.eventId], ["a1", "a2"]);
    assert.equal(await store.getLatestAccordEventId(), second.id);
    assert.deepEqual((await store.getAccordEventsAfter(first.id, 10)).map(({ eventId }) => eventId), ["a2"]);

    const enqueue = (deliveries, cursor) => store.enqueueWebhookDeliveries({ subscriptionId: "s1", deliveries, cursor, now: NOW });
    assert.equal(await enqueue([{ eventId: "a1", body: "{}" }, { eventId: "a2", body: "{}" }], second.id), 2);
    assert.equal(await store.getState("webhook_cursor:s1"), String(second.id));
    // Replaying the same events is a no-op, and another subscription is independent.
    assert.equal(await enqueue([{ eventId: "a1", body: "{}" }], second.id), 0);
    assert.equal(
      await store.enqueueWebhookDeliveries({ subscriptionId: "s2", deliveries: [{ eventId: "a1", body: "{}" }], cursor: 1, now: NOW }),
      1
    );
    assert.deepEqual(await store.countWebhookDeliveries(), { pending: 3, delivered: 0, dead: 0 });
  });

  it("claims only due pending deliveries and tracks their outcome", async () => {
    const store = await createStore();
    const deliveries = ["e1", "e2", "e3"].map((eventId) => ({ eventId, body: `{"id":"${eventId}"}` }));
    await store.enqueueWebhookDeliveries({ subscriptionId: "s1", deliveries, cursor: 3, now: NOW });

    const due = await store.claimDueWebhookDeliveries({ now: NOW, limit: 10 });
    assert.deepEqual(due.map(({ eventId }) => eventId), ["e1", "e2", "e3"]);
    assert.equal(due[0].status, "pending");
    assert.equal(due[0].attempts, 0);
    assert.equal(due[0].body, '{"id":"e1"}');

    await store.completeWebhookDelivery({ id: due[0].id, outcome: "delivered", attempts: 1, statusCode: 200, now: NOW });
    await store.completeWebhookDelivery({
      id: due[1].id, outcome: "retry", attempts: 1, nextAttemptAt: LATER, statusCode: 503, error: "HTTP 503", now: NOW,
    });
    await store.completeWebhookDelivery({ id: due[2].id, outcome: "dead", attempts: 8, error: "gave up", now: NOW });

    assert.deepEqual(await store.countWebhookDeliveries(), { pending: 1, delivered: 1, dead: 1 });
    // The retry is not due yet, then becomes due.
    assert.deepEqual(await store.claimDueWebhookDeliveries({ now: NOW, limit: 10 }), []);
    const retry = await store.claimDueWebhookDeliveries({ now: LATER, limit: 10 });
    assert.equal(retry.length, 1);
    assert.equal(retry[0].eventId, "e2");
    assert.equal(retry[0].attempts, 1);
    assert.equal(retry[0].lastError, "HTTP 503");
    assert.equal(retry[0].lastStatusCode, 503);
    assert.equal(retry[0].nextAttemptAt, LATER);

    const delivered = await store.listWebhookDeliveries({ status: "delivered", limit: 10, offset: 0 });
    assert.equal(delivered[0].deliveredAt, NOW);
    const dead = await store.listWebhookDeliveries({ status: "dead", subscriptionId: "s1", limit: 10, offset: 0 });
    assert.deepEqual(dead.map(({ eventId, lastError }) => [eventId, lastError]), [["e3", "gave up"]]);
    assert.equal((await store.listWebhookDeliveries({ limit: 2, offset: 2 })).length, 1);
  });

  it("requeues dead letters, optionally for one subscription", async () => {
    const store = await createStore();
    for (const subscriptionId of ["s1", "s2"]) {
      await store.enqueueWebhookDeliveries({ subscriptionId, deliveries: [{ eventId: "e1", body: "{}" }], cursor: 1, now: NOW });
    }
    for (const delivery of await store.claimDueWebhookDeliveries({ now: NOW, limit: 10 })) {
      await store.completeWebhookDelivery({ id: delivery.id, outcome: "dead", attempts: 8, error: "x", now: NOW });
    }

    assert.equal(await store.requeueDeadWebhookDeliveries({ subscriptionId: "s1", now: LATER }), 1);
    const [requeued] = await store.listWebhookDeliveries({ status: "pending", limit: 10, offset: 0 });
    assert.equal(requeued.subscriptionId, "s1");
    assert.equal(requeued.attempts, 0);
    assert.equal(await store.requeueDeadWebhookDeliveries({ now: LATER }), 1);
    assert.deepEqual(await store.countWebhookDeliveries(), { pending: 2, delivered: 0, dead: 0 });
  });

  it("drops webhook cursors but keeps deliveries when history is cleared", async () => {
    const store = await createStore();
    await store.recordAccordEvent(accordEvent());
    await store.enqueueWebhookDeliveries({ subscriptionId: "s1", deliveries: [{ eventId: "a1", body: "{}" }], cursor: 1, now: NOW });
    await store.setState("next_ledger", "11");

    await store.clearHistory();

    assert.equal(await store.getState("webhook_cursor:s1"), null, "the cursor indexed rows that no longer exist");
    assert.equal(await store.getState("next_ledger"), "11");
    assert.equal((await store.countWebhookDeliveries()).pending, 1, "deliveries survive so a rebuild cannot resend");
    assert.equal(await store.getLatestAccordEventId(), 0);
  });
});
