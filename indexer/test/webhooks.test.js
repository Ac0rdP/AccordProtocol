import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, describe, it } from "node:test";
import { createIndexerMetrics } from "../src/metrics.js";
import {
  buildDeliveryBody,
  computeBackoffMs,
  createWebhookDispatcher,
  loadSubscriptions,
  parseSubscriptions,
  signPayload,
  verifySignature,
} from "../src/webhooks.js";
import { cleanupTempStores, createStore, describeEachBackend } from "./helpers.js";

afterEach(cleanupTempStores);

const SECRET = "whsec_0123456789abcdef";

describe("webhook signatures", () => {
  const body = '{"id":"e1"}';

  it("signs `<timestamp>.<body>` with HMAC-SHA256 and verifies it", () => {
    const header = signPayload({ secret: SECRET, body, timestamp: 1_800_000_000 });
    assert.match(header, /^t=1800000000,v1=[0-9a-f]{64}$/);
    assert.deepEqual(verifySignature({ secret: SECRET, header, body, now: 1_800_000_010 }), { valid: true });
  });

  it("rejects a tampered body, a wrong secret and a malformed header", () => {
    const header = signPayload({ secret: SECRET, body, timestamp: 1_800_000_000 });
    const verify = (overrides) => verifySignature({ secret: SECRET, header, body, now: 1_800_000_000, ...overrides });
    assert.equal(verify({ body: '{"id":"e2"}' }).reason, "signature mismatch");
    assert.equal(verify({ secret: "another-secret-value" }).reason, "signature mismatch");
    assert.equal(verify({ header: "garbage" }).reason, "malformed signature header");
    assert.equal(verify({ header: undefined }).reason, "malformed signature header");
    assert.equal(verify({ header: header.replace(/v1=.{4}/, "v1=0000") }).valid, false);
    assert.equal(verify({ header: `t=1800000000,v1=abc` }).valid, false, "a short signature never throws");
  });

  it("rejects replays outside the tolerance window", () => {
    const header = signPayload({ secret: SECRET, body, timestamp: 1_800_000_000 });
    const result = verifySignature({ secret: SECRET, header, body, now: 1_800_000_000 + 301 });
    assert.deepEqual(result, { valid: false, reason: "timestamp outside tolerance" });
    assert.equal(verifySignature({ secret: SECRET, header, body, now: 1_800_000_000 - 301 }).valid, false);
    assert.equal(
      verifySignature({ secret: SECRET, header, body, now: 1_800_000_301, toleranceSeconds: 600 }).valid,
      true
    );
  });

  it("binds the timestamp into the MAC", () => {
    const header = signPayload({ secret: SECRET, body, timestamp: 1_800_000_000 });
    const forged = header.replace("t=1800000000", "t=1800000100");
    assert.equal(verifySignature({ secret: SECRET, header: forged, body, now: 1_800_000_100 }).valid, false);
  });

  it("accepts any matching v1 signature, which allows secret rotation", () => {
    const current = signPayload({ secret: SECRET, body, timestamp: 1_800_000_000 });
    const old = signPayload({ secret: "previous-secret-value", body, timestamp: 1_800_000_000 });
    const header = `${old},${current.split(",")[1]}`;
    assert.equal(verifySignature({ secret: SECRET, header, body, now: 1_800_000_000 }).valid, true);
  });
});

describe("webhook backoff", () => {
  it("doubles per attempt up to the cap", () => {
    const options = { baseMs: 1000, maxMs: 10_000, jitter: 0 };
    assert.deepEqual([1, 2, 3, 4, 5, 6].map((attempt) => computeBackoffMs(attempt, options)), [1000, 2000, 4000, 8000, 10_000, 10_000]);
  });

  it("spreads retries by the jitter fraction", () => {
    assert.equal(computeBackoffMs(1, { baseMs: 1000, jitter: 0.2, random: () => 0 }), 800);
    assert.equal(computeBackoffMs(1, { baseMs: 1000, jitter: 0.2, random: () => 1 }), 1200);
    assert.equal(computeBackoffMs(1, { baseMs: 1000, jitter: 0.2, random: () => 0.5 }), 1000);
  });
});

describe("webhook subscription config", () => {
  const valid = { id: "ops", url: "https://hooks.example.com/accord", secret: SECRET };

  it("accepts a complete subscription and normalises it", () => {
    const [subscription] = parseSubscriptions([{ ...valid, topics: ["created"] }]);
    assert.deepEqual(subscription, { id: "ops", url: "https://hooks.example.com/accord", secret: SECRET, topics: ["created"] });
    assert.equal(parseSubscriptions([valid])[0].topics, null, "no topics means every event");
  });

  it("reads the secret from the environment and skips disabled entries", () => {
    const parsed = parseSubscriptions(
      [{ id: "ops", url: valid.url, secretEnv: "OPS_HOOK_SECRET" }, { ...valid, id: "off", enabled: false, secret: "short" }],
      { env: { OPS_HOOK_SECRET: SECRET } }
    );
    assert.deepEqual(parsed.map(({ id, secret }) => [id, secret]), [["ops", SECRET]]);
  });

  it("rejects unsafe or malformed entries", () => {
    const reject = (entry, pattern) => assert.throws(() => parseSubscriptions([entry]), pattern);
    reject({ ...valid, id: "bad id!" }, /id must be/);
    reject({ ...valid, url: "not a url" }, /not a valid URL/);
    reject({ ...valid, url: "http://hooks.example.com/x" }, /must be https/);
    reject({ ...valid, url: "ftp://hooks.example.com/x" }, /must be https/);
    reject({ ...valid, secret: "short" }, /at least 16/);
    reject({ id: "ops", url: valid.url, secretEnv: "UNSET_VAR" }, /at least 16/);
    reject({ ...valid, topics: "created" }, /topics must be an array/);
    assert.throws(() => parseSubscriptions([valid, valid]), /duplicate/);
    assert.throws(() => parseSubscriptions({}), /JSON array/);
  });

  it("allows plain http only for local receivers", () => {
    assert.equal(parseSubscriptions([{ ...valid, url: "http://localhost:9000/hook" }]).length, 1);
    assert.equal(parseSubscriptions([{ ...valid, url: "http://127.0.0.1:9000/hook" }]).length, 1);
  });

  it("loads inline JSON and treats an empty environment as no webhooks", () => {
    assert.deepEqual(loadSubscriptions({}), []);
    assert.equal(loadSubscriptions({ WEBHOOK_SUBSCRIPTIONS: JSON.stringify([valid]) }).length, 1);
    assert.throws(() => loadSubscriptions({ WEBHOOK_SUBSCRIPTIONS: "{" }), /could not read webhook subscriptions/);
    assert.throws(() => loadSubscriptions({ WEBHOOK_SUBSCRIPTIONS_FILE: "/nonexistent/hooks.json" }), /could not read/);
  });
});

/** A fake clock and receiver so retry timing is asserted without sleeping. */
function harness({ responses = [], subscriptions, ...options } = {}) {
  const clock = { now: Date.parse("2026-09-27T12:00:00.000Z") };
  const requests = [];
  const queue = [...responses];
  const fetchImpl = async (url, init) => {
    requests.push({ url, ...init });
    const next = queue.length ? queue.shift() : { status: 200 };
    if (next instanceof Error) throw next;
    return { status: next.status, body: { cancel: async () => {} } };
  };
  const logger = { error() {} };
  const metrics = createIndexerMetrics();
  return {
    clock,
    requests,
    metrics,
    queueResponses: (...more) => queue.push(...more),
    build: (store) =>
      createWebhookDispatcher({
        store,
        subscriptions: subscriptions ?? parseSubscriptions([{ id: "ops", url: "https://hooks.example.com/accord", secret: SECRET }]),
        metrics,
        fetchImpl,
        now: () => clock.now,
        random: () => 0.5,
        backoffBaseMs: 1000,
        backoffMaxMs: 60_000,
        logger,
        ...options,
      }),
  };
}

const protocolEvent = (n, topic = "created") => ({
  eventId: `evt-${n}`, topic, payload: { id: String(n) }, ledger: 100 + n, transactionHash: `tx-${n}`,
  occurredAt: "2026-09-27T11:59:00.000Z",
});

describeEachBackend("webhook delivery", () => {
  it("starts new subscriptions at the present instead of replaying history", async () => {
    const store = await createStore();
    const { build, requests } = harness();
    await store.recordAccordEvent(protocolEvent(1));
    const dispatcher = build(store);

    assert.deepEqual(await dispatcher.tick(), { enqueued: 0, delivered: 0, retry: 0, dead: 0 });
    assert.equal(requests.length, 0);

    await store.recordAccordEvent(protocolEvent(2));
    assert.deepEqual(await dispatcher.tick(), { enqueued: 1, delivered: 1, retry: 0, dead: 0 });
    assert.deepEqual(requests.map(({ headers }) => headers["x-accord-event-id"]), ["evt-2"]);
  });

  it("delivers a signed body the receiver can verify", async () => {
    const store = await createStore();
    const { build, requests, clock } = harness();
    const dispatcher = build(store);
    await dispatcher.tick();
    await store.recordAccordEvent(protocolEvent(1));
    await dispatcher.tick();

    const [request] = requests;
    assert.equal(request.url, "https://hooks.example.com/accord");
    assert.equal(request.method, "POST");
    assert.equal(request.redirect, "manual");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers["x-accord-delivery-attempt"], "1");
    assert.deepEqual(JSON.parse(request.body), {
      id: "evt-1", type: "created", subscription: "ops", ledger: 101, transactionHash: "tx-1",
      occurredAt: "2026-09-27T11:59:00.000Z", data: { id: "1" },
    });
    assert.equal(request.body, buildDeliveryBody("ops", { ...protocolEvent(1) }));
    assert.deepEqual(
      verifySignature({
        secret: SECRET, header: request.headers["x-accord-signature"], body: request.body, now: Math.floor(clock.now / 1000),
      }),
      { valid: true }
    );
    assert.deepEqual(await store.countWebhookDeliveries(), { pending: 0, delivered: 1, dead: 0 });
  });

  it("only sends the topics a subscription asked for, and still advances past the rest", async () => {
    const store = await createStore();
    const subscriptions = parseSubscriptions([
      { id: "ops", url: "https://hooks.example.com/accord", secret: SECRET, topics: ["executed"] },
    ]);
    const { build, requests } = harness({ subscriptions });
    const dispatcher = build(store);
    await dispatcher.tick();
    await store.recordAccordEvent(protocolEvent(1, "created"));
    await store.recordAccordEvent(protocolEvent(2, "executed"));
    await dispatcher.tick();
    await dispatcher.tick();

    assert.deepEqual(requests.map(({ headers }) => headers["x-accord-event-id"]), ["evt-2"]);
    assert.equal(await store.getState("webhook_cursor:ops"), String(await store.getLatestAccordEventId()));
  });

  it("retries a failing receiver with exponential backoff, then succeeds", async () => {
    const store = await createStore();
    const { build, requests, clock, metrics } = harness({ responses: [{ status: 503 }, new Error("connect ECONNREFUSED")] });
    const dispatcher = build(store);
    await dispatcher.tick();
    await store.recordAccordEvent(protocolEvent(1));

    assert.equal((await dispatcher.tick()).retry, 1);
    let [delivery] = await store.listWebhookDeliveries({ limit: 10, offset: 0 });
    assert.equal(delivery.status, "pending");
    assert.equal(delivery.attempts, 1);
    assert.equal(delivery.lastStatusCode, 503);
    assert.match(delivery.lastError, /HTTP 503/);
    assert.equal(delivery.nextAttemptAt, new Date(clock.now + 1000).toISOString());

    // Not due yet: nothing is sent.
    assert.equal((await dispatcher.tick()).retry, 0);
    assert.equal(requests.length, 1);

    clock.now += 1000;
    assert.equal((await dispatcher.tick()).retry, 1);
    [delivery] = await store.listWebhookDeliveries({ limit: 10, offset: 0 });
    assert.match(delivery.lastError, /ECONNREFUSED/);
    assert.equal(delivery.nextAttemptAt, new Date(clock.now + 2000).toISOString(), "the delay doubles");

    clock.now += 2000;
    assert.equal((await dispatcher.tick()).delivered, 1);
    [delivery] = await store.listWebhookDeliveries({ limit: 10, offset: 0 });
    assert.equal(delivery.status, "delivered");
    assert.equal(delivery.attempts, 3);
    assert.deepEqual(requests.map(({ headers }) => headers["x-accord-delivery-attempt"]), ["1", "2", "3"]);
    // Every attempt carries identical bytes but a fresh signature timestamp.
    assert.equal(new Set(requests.map(({ body }) => body)).size, 1);

    const rendered = metrics.render();
    assert.match(rendered, /accord_indexer_webhook_deliveries_total\{subscription="ops",result="retry"\} 2/);
    assert.match(rendered, /accord_indexer_webhook_deliveries_total\{subscription="ops",result="delivered"\} 1/);
    assert.match(rendered, /accord_indexer_webhook_deliveries\{status="delivered"\} 1/);
  });

  it("moves a delivery to the dead-letter queue after the attempt limit, and can requeue it", async () => {
    const store = await createStore();
    const { build, requests, clock, queueResponses, metrics } = harness({
      maxAttempts: 3,
      responses: [{ status: 500 }, { status: 500 }, { status: 500 }],
    });
    const dispatcher = build(store);
    await dispatcher.tick();
    await store.recordAccordEvent(protocolEvent(1));

    await dispatcher.tick();
    clock.now += 1000;
    await dispatcher.tick();
    clock.now += 2000;
    assert.equal((await dispatcher.tick()).dead, 1);

    const [dead] = await store.listWebhookDeliveries({ status: "dead", limit: 10, offset: 0 });
    assert.equal(dead.attempts, 3);
    assert.match(dead.lastError, /HTTP 500/);
    assert.deepEqual(await store.countWebhookDeliveries(), { pending: 0, delivered: 0, dead: 1 });
    assert.match(metrics.render(), /accord_indexer_webhook_deliveries\{status="dead"\} 1/);

    // Dead letters are not retried on their own...
    clock.now += 3_600_000;
    await dispatcher.tick();
    assert.equal(requests.length, 3);

    // ...until an operator requeues them.
    queueResponses({ status: 204 });
    assert.equal(await store.requeueDeadWebhookDeliveries({ now: new Date(clock.now).toISOString() }), 1);
    assert.equal((await dispatcher.tick()).delivered, 1);
    assert.deepEqual(await store.countWebhookDeliveries(), { pending: 0, delivered: 1, dead: 0 });
  });

  it("treats redirects as failures instead of following them", async () => {
    const store = await createStore();
    const { build } = harness({ responses: [{ status: 302 }] });
    const dispatcher = build(store);
    await dispatcher.tick();
    await store.recordAccordEvent(protocolEvent(1));
    assert.equal((await dispatcher.tick()).retry, 1);
  });

  it("dead-letters deliveries whose subscription was removed from the config", async () => {
    const store = await createStore();
    const first = harness();
    const dispatcher = first.build(store);
    await dispatcher.tick();
    await store.recordAccordEvent(protocolEvent(1));
    first.queueResponses({ status: 500 });
    await dispatcher.tick();

    const afterRemoval = harness({ subscriptions: [] });
    afterRemoval.clock.now += 3_600_000;
    await afterRemoval.build(store).tick();
    const [delivery] = await store.listWebhookDeliveries({ status: "dead", limit: 10, offset: 0 });
    assert.match(delivery.lastError, /no longer configured/);
  });

  it("never resends an event after the store is rebuilt", async () => {
    const store = await createStore();
    const { build, requests } = harness();
    const dispatcher = build(store);
    await dispatcher.tick();
    await store.recordAccordEvent(protocolEvent(1));
    await dispatcher.tick();
    assert.equal(requests.length, 1);

    await store.clearHistory();
    await dispatcher.tick(); // cursor was dropped, so it is re-initialised
    await store.recordAccordEvent(protocolEvent(1)); // the rebuild re-ingests the same event
    await store.recordAccordEvent(protocolEvent(2));
    await dispatcher.tick();
    await dispatcher.tick();

    assert.deepEqual(requests.map(({ headers }) => headers["x-accord-event-id"]), ["evt-1", "evt-2"]);
  });

  it("delivers to several subscriptions independently", async () => {
    const store = await createStore();
    const subscriptions = parseSubscriptions([
      { id: "a", url: "https://a.example.com/hook", secret: SECRET },
      { id: "b", url: "https://b.example.com/hook", secret: `${SECRET}-b` },
    ]);
    const { build, requests, clock } = harness({ subscriptions, responses: [{ status: 200 }, { status: 500 }] });
    const dispatcher = build(store);
    await dispatcher.tick();
    await store.recordAccordEvent(protocolEvent(1));
    await dispatcher.tick();

    assert.deepEqual(requests.map(({ url }) => url).sort(), ["https://a.example.com/hook", "https://b.example.com/hook"]);
    assert.deepEqual(await store.countWebhookDeliveries(), { pending: 1, delivered: 1, dead: 0 });
    // Each receiver is signed with its own secret.
    const bRequest = requests.find(({ url }) => url.includes("b.example"));
    const check = (secret) =>
      verifySignature({
        secret, header: bRequest.headers["x-accord-signature"], body: bRequest.body, now: Math.floor(clock.now / 1000),
      }).valid;
    assert.equal(check(`${SECRET}-b`), true);
    assert.equal(check(SECRET), false);
  });
});

describe("webhook delivery over HTTP", () => {
  it("posts to a real receiver that verifies the signature", async () => {
    const received = [];
    const server = createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const check = verifySignature({ secret: SECRET, header: request.headers["x-accord-signature"], body });
        received.push({ valid: check.valid, event: JSON.parse(body) });
        response.writeHead(check.valid ? 200 : 401).end();
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const store = await createStore("sqlite");
      const subscriptions = parseSubscriptions([
        { id: "local", url: `http://127.0.0.1:${server.address().port}/hook`, secret: SECRET },
      ]);
      const metrics = createIndexerMetrics();
      const dispatcher = createWebhookDispatcher({ store, subscriptions, metrics, logger: { error() {} } });
      await dispatcher.tick();
      await store.recordAccordEvent(protocolEvent(7));
      assert.equal((await dispatcher.tick()).delivered, 1);
      assert.deepEqual(received.map(({ valid, event }) => [valid, event.id, event.type]), [[true, "evt-7", "created"]]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("times out a receiver that never answers", async () => {
    const server = createServer(() => {}); // accepts the request and stays silent
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const store = await createStore("sqlite");
      const subscriptions = parseSubscriptions([
        { id: "slow", url: `http://127.0.0.1:${server.address().port}/hook`, secret: SECRET },
      ]);
      const dispatcher = createWebhookDispatcher({ store, subscriptions, timeoutMs: 100, logger: { error() {} } });
      await dispatcher.tick();
      await store.recordAccordEvent(protocolEvent(1));
      assert.equal((await dispatcher.tick()).retry, 1);
      const [delivery] = await store.listWebhookDeliveries({ limit: 10, offset: 0 });
      assert.match(delivery.lastError, /timed out after 100ms/);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
