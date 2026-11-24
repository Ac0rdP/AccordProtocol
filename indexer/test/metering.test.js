import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { resolveUsageMeteringConfig } from "../src/config.js";
import { createHttpBillingHook, createMeteringService } from "../src/metering.js";
import { loadMigrations } from "../src/store/migrations.js";
import { cleanupTempStores, createStore, describeEachBackend } from "./helpers.js";

afterEach(cleanupTempStores);

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const quiet = { error() {}, warn() {}, log() {} };

function setup(store, { hooks = [], config = {} } = {}) {
  const time = { now: T0 };
  const service = createMeteringService({
    store,
    config: { ...resolveUsageMeteringConfig({ USAGE_METERING_ENABLED: "true" }), backoffBaseMs: 1000, ...config },
    hooks,
    now: () => time.now,
    random: () => 0.5,
    logger: quiet,
  });
  return { service, time };
}

describe("usage metering configuration", () => {
  it("is off by default with no hook", () => {
    const config = resolveUsageMeteringConfig({});
    assert.equal(config.enabled, false);
    assert.equal(config.hookUrl, "");
    assert.equal(config.hookRejected, false);
    assert.deepEqual([config.maxAttempts, config.batchSize], [5, 100]);
  });

  it("ignores a hook that is not https or has a weak secret", () => {
    const secret = "s".repeat(16);
    for (const env of [
      { USAGE_BILLING_HOOK_URL: "http://billing.example.com/x", USAGE_BILLING_HOOK_SECRET: secret },
      { USAGE_BILLING_HOOK_URL: "https://billing.example.com/x", USAGE_BILLING_HOOK_SECRET: "short" },
      { USAGE_BILLING_HOOK_URL: "not a url", USAGE_BILLING_HOOK_SECRET: secret },
    ]) {
      const config = resolveUsageMeteringConfig(env);
      assert.equal(config.hookUrl, "");
      assert.equal(config.hookRejected, true);
    }
    const ok = resolveUsageMeteringConfig({ USAGE_BILLING_HOOK_URL: "http://localhost:9/x", USAGE_BILLING_HOOK_SECRET: secret });
    assert.equal(ok.hookUrl, "http://localhost:9/x");
  });

  it("falls back to safe defaults for out-of-range numbers", () => {
    const config = resolveUsageMeteringConfig({ USAGE_BILLING_MAX_ATTEMPTS: "0", USAGE_BILLING_BATCH_SIZE: "abc" });
    assert.deepEqual([config.maxAttempts, config.batchSize], [5, 100]);
  });
});

describeEachBackend("usage metering", () => {
  it("records nothing while disabled", async () => {
    const store = await createStore();
    const service = createMeteringService({ store, config: resolveUsageMeteringConfig({}), logger: quiet });
    assert.equal(await service.record({ eventId: "a", kind: "api_call" }), false);
    assert.deepEqual(await service.summary({}), []);
  });

  it("dedupes: recording the same event id twice, or replaying, counts once", async () => {
    const store = await createStore();
    const { service } = setup(store);
    const usage = { eventId: "webhook:sub:evt-1", kind: "webhook", subject: "sub", occurredAt: "2026-10-01T00:00:00.000Z" };
    assert.equal(await service.record(usage), true);
    for (let replay = 0; replay < 3; replay += 1) assert.equal(await service.record(usage), false);
    await service.record({ eventId: "api:1", kind: "api_call", subject: "key-a", quantity: 3, occurredAt: "2026-10-01T00:00:00.000Z" });

    assert.deepEqual(await service.summary({}), [
      { kind: "api_call", subject: "key-a", events: 1, quantity: 3 },
      { kind: "webhook", subject: "sub", events: 1, quantity: 1 },
    ]);
  });

  it("validates what it records", async () => {
    const store = await createStore();
    const { service } = setup(store);
    await assert.rejects(service.record({ eventId: "a", kind: "nope" }), /usage kind must be/);
    await assert.rejects(service.record({ eventId: "", kind: "report" }), /eventId/);
    await assert.rejects(service.record({ eventId: "a", kind: "report", quantity: 0 }), /quantity/);
    assert.equal(await service.recordSafely({ eventId: "a", kind: "nope" }), false, "recordSafely never throws");
  });

  it("filters the summary by period, kind and subject", async () => {
    const store = await createStore();
    const { service } = setup(store);
    await service.record({ eventId: "1", kind: "api_call", subject: "a", occurredAt: "2026-09-30T23:59:59.000Z" });
    await service.record({ eventId: "2", kind: "api_call", subject: "a", occurredAt: "2026-10-01T10:00:00.000Z" });
    await service.record({ eventId: "3", kind: "report", subject: "b", occurredAt: "2026-10-01T11:00:00.000Z" });

    const october = { from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" };
    assert.equal((await service.summary(october)).reduce((sum, row) => sum + row.events, 0), 2);
    assert.deepEqual(await service.summary({ ...october, kind: "report" }), [{ kind: "report", subject: "b", events: 1, quantity: 1 }]);
    assert.deepEqual(await service.summary({ subject: "zzz" }), []);
  });

  it("hands each record to the hook once and marks it emitted", async () => {
    const store = await createStore();
    const seen = [];
    const { service } = setup(store, { hooks: [async (event) => { seen.push(event); }] });
    await service.record({ eventId: "api:1", kind: "api_call", subject: "key-a", metadata: { route: "/ledger" } });

    assert.deepEqual(await service.flush(), { emitted: 1, retry: 0, dead: 0 });
    assert.deepEqual(await service.flush(), { emitted: 0, retry: 0, dead: 0 }, "nothing is emitted twice");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].id, "api:1");
    assert.deepEqual(seen[0].metadata, { route: "/ledger" });
    assert.deepEqual(await service.counts(), { pending: 0, emitted: 1, dead: 0 });
  });

  it("retries a failing hook with backoff and succeeds once it recovers", async () => {
    const store = await createStore();
    let healthy = false;
    const calls = [];
    const { service, time } = setup(store, {
      hooks: [async (event) => { calls.push(event.id); if (!healthy) throw new Error("billing is down"); }],
    });
    await service.record({ eventId: "report:1", kind: "report", subject: "anonymous" });

    assert.deepEqual(await service.flush(), { emitted: 0, retry: 1, dead: 0 });
    assert.deepEqual(await service.flush(), { emitted: 0, retry: 0, dead: 0 }, "not due until the backoff has passed");
    assert.deepEqual(await service.counts(), { pending: 1, emitted: 0, dead: 0 });

    healthy = true;
    time.now += 60_000;
    assert.deepEqual(await service.flush(), { emitted: 1, retry: 0, dead: 0 });
    assert.deepEqual(calls, ["report:1", "report:1"], "the same idempotency id is retried");
  });

  it("dead-letters after the maximum attempts and can be requeued", async () => {
    const store = await createStore();
    let healthy = false;
    const { service, time } = setup(store, {
      config: { maxAttempts: 2 },
      hooks: [async () => { if (!healthy) throw new Error("nope"); }],
    });
    await service.record({ eventId: "api:9", kind: "api_call" });
    await service.flush();
    time.now += 60_000;
    assert.deepEqual(await service.flush(), { emitted: 0, retry: 0, dead: 1 });
    assert.deepEqual(await service.counts(), { pending: 0, emitted: 0, dead: 1 });

    healthy = true;
    assert.equal(await service.requeueDead(), 1);
    assert.deepEqual(await service.flush(), { emitted: 1, retry: 0, dead: 0 });
  });

  it("resumes after a restart: pending usage survives and is emitted by a new service", async () => {
    const store = await createStore();
    const first = setup(store, { hooks: [async () => { throw new Error("crash"); }] });
    await first.service.record({ eventId: "api:1", kind: "api_call", subject: "k" });
    await first.service.flush();

    const seen = [];
    const second = setup(store, { hooks: [async (event) => { seen.push(event.id); }] });
    second.time.now = T0 + 60_000;
    assert.deepEqual(await second.service.flush(), { emitted: 1, retry: 0, dead: 0 });
    assert.deepEqual(seen, ["api:1"]);
  });

  it("stays compatible: a record made before a hook was configured is emitted once one is", async () => {
    const store = await createStore();
    const { service } = setup(store);
    await service.record({ eventId: "api:1", kind: "api_call" });
    assert.deepEqual(await service.flush(), { emitted: 0, retry: 0, dead: 0 }, "no hooks, nothing is consumed");
    assert.deepEqual(await service.counts(), { pending: 1, emitted: 0, dead: 0 });
  });
});

describe("HTTP billing hook", () => {
  const event = { id: "api:1", kind: "api_call", subject: "k", quantity: 1, occurredAt: "2026-10-01T00:00:00.000Z", metadata: {} };

  it("posts a signed event with its idempotency id", async () => {
    let request;
    const hook = createHttpBillingHook({
      url: "https://billing.example.com/hook",
      secret: "s".repeat(16),
      now: () => T0,
      fetchImpl: async (url, init) => { request = { url, init }; return new Response(null, { status: 204 }); },
    });
    await hook(event);
    assert.equal(request.url, "https://billing.example.com/hook");
    assert.equal(request.init.headers["x-accord-usage-id"], "api:1");
    assert.match(request.init.headers["x-accord-signature"], /^t=\d+,v1=[0-9a-f]{64}$/);
    assert.deepEqual(JSON.parse(request.init.body), event);
  });

  it("fails on a non-2xx response", async () => {
    const hook = createHttpBillingHook({
      url: "https://billing.example.com/hook",
      secret: "s".repeat(16),
      fetchImpl: async () => new Response(null, { status: 503 }),
    });
    await assert.rejects(hook(event), /HTTP 503/);
  });
});

describe("usage metering migration", () => {
  it("ships a Postgres migration with a unique idempotency key", () => {
    const migration = loadMigrations().find((entry) => entry.name === "0013_usage_events");
    assert.ok(migration);
    assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS usage_events/);
    assert.match(migration.sql, /event_id TEXT NOT NULL UNIQUE/);
  });
});
