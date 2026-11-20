import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createApi } from "../src/api.js";
import { loadIndexerConfig, resolveWebhookDashboardConfig } from "../src/config.js";
import { createReadiness } from "../src/health.js";
import { createIndexerMetrics } from "../src/metrics.js";
import { renderWebhookDashboard } from "../src/ops-dashboard.js";
import { loadMigrations } from "../src/store/migrations.js";
import { tokenMatches, webhookOpsRouteLabel } from "../src/webhook-ops.js";
import { createWebhookDispatcher } from "../src/webhooks.js";
import { cleanupTempStores, createStore, describeEachBackend } from "./helpers.js";

afterEach(cleanupTempStores);

const NOW = "2026-10-01T00:00:00.000Z";
const LATER = "2026-10-01T00:05:00.000Z";
const TOKEN = "ops-admin-token-0123456789";
const SUBSCRIPTION = { id: "ops", url: "https://hooks.example.com/secret/path?key=abc", secret: "whsec_0123456789abcdef", topics: null };

async function seed(store, { subscriptionId = "ops", events = ["e1", "e2", "e3"] } = {}) {
  await store.enqueueWebhookDeliveries({
    subscriptionId,
    deliveries: events.map((eventId) => ({ eventId, body: JSON.stringify({ id: eventId, data: { amount: "10" } }) })),
    cursor: events.length,
    now: NOW,
  });
  return store.listWebhookDeliveries({ subscriptionId, limit: 100, offset: 0 });
}

const attemptsOf = (store, id) => store.listWebhookDeliveryAttempts(id);

async function withApi(store, options, run) {
  const metrics = createIndexerMetrics();
  const api = createApi({
    store,
    readiness: createReadiness({ store }),
    metrics,
    startLedger: 1,
    finalityLag: 1,
    tokenAddresses: new Map(),
    webhookDashboard: { enabled: true, adminToken: TOKEN, pageSize: 50, ...options.dashboard },
    webhookSubscriptions: options.subscriptions ?? [SUBSCRIPTION],
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${api.address().port}`;
  try {
    return await run({ base, metrics });
  } finally {
    await new Promise((resolve) => api.close(resolve));
  }
}

const post = (url, token = TOKEN) =>
  fetch(url, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} });

describeEachBackend("delivery attempt history and replay (store)", () => {
  it("records every attempt with its outcome, status and duration", async () => {
    const store = await createStore();
    const [first] = await seed(store, { events: ["e1"] });
    await store.completeWebhookDelivery({
      id: first.id, outcome: "retry", attempts: 1, nextAttemptAt: LATER, statusCode: 503, error: "HTTP 503", durationMs: 41, now: NOW,
    });
    await store.completeWebhookDelivery({ id: first.id, outcome: "delivered", attempts: 2, statusCode: 200, durationMs: 12, now: LATER });

    const attempts = await attemptsOf(store, first.id);
    assert.deepEqual(
      attempts.map(({ attempt, replayRound, outcome, statusCode, error, durationMs, attemptedAt }) =>
        [attempt, replayRound, outcome, statusCode, error, durationMs, attemptedAt]),
      [[1, 0, "retry", 503, "HTTP 503", 41, NOW], [2, 0, "delivered", 200, null, 12, LATER]]
    );
  });

  it("replays a dead delivery as a fresh round while keeping its history", async () => {
    const store = await createStore();
    const [first] = await seed(store, { events: ["e1"] });
    await store.completeWebhookDelivery({ id: first.id, outcome: "dead", attempts: 8, statusCode: 500, error: "gave up", now: NOW });

    const result = await store.replayWebhookDelivery({ id: first.id, now: LATER });
    assert.equal(result.found, true);
    assert.equal(result.previousStatus, "dead");
    assert.equal(result.delivery.status, "pending");
    assert.equal(result.delivery.attempts, 0);
    assert.equal(result.delivery.nextAttemptAt, LATER);
    assert.equal(result.delivery.replayCount, 1);
    assert.equal(result.delivery.lastReplayedAt, LATER);
    assert.equal(result.delivery.body, first.body, "the stored bytes never change");

    await store.completeWebhookDelivery({ id: first.id, outcome: "delivered", attempts: 1, statusCode: 200, now: LATER });
    const attempts = await attemptsOf(store, first.id);
    assert.deepEqual(attempts.map(({ attempt, replayRound, outcome }) => [attempt, replayRound, outcome]), [[8, 0, "dead"], [1, 1, "delivered"]]);
  });

  it("can replay an already delivered delivery", async () => {
    const store = await createStore();
    const [first] = await seed(store, { events: ["e1"] });
    await store.completeWebhookDelivery({ id: first.id, outcome: "delivered", attempts: 1, statusCode: 200, now: NOW });
    const result = await store.replayWebhookDelivery({ id: first.id, now: LATER });
    assert.equal(result.previousStatus, "delivered");
    assert.equal(result.delivery.status, "pending");
    assert.equal(result.delivery.deliveredAt, NOW, "the original delivery time is kept");
  });

  it("is idempotent: replaying a queued delivery only makes it due now", async () => {
    const store = await createStore();
    const [first] = await seed(store, { events: ["e1"] });
    await store.completeWebhookDelivery({ id: first.id, outcome: "dead", attempts: 8, error: "x", now: NOW });

    await store.replayWebhookDelivery({ id: first.id, now: NOW });
    const again = await store.replayWebhookDelivery({ id: first.id, now: LATER });
    assert.equal(again.previousStatus, "pending");
    assert.equal(again.delivery.replayCount, 1, "a double click is one replay");
    assert.equal(again.delivery.nextAttemptAt, LATER);
    assert.equal((await store.countWebhookDeliveries()).pending, 1);

    const concurrent = await Promise.all([1, 2, 3].map(() => store.replayWebhookDelivery({ id: first.id, now: LATER })));
    assert.ok(concurrent.every((entry) => entry.found));
    assert.equal((await store.getWebhookDelivery(first.id)).replayCount, 1);
  });

  it("reports a missing delivery instead of inventing one", async () => {
    const store = await createStore();
    assert.deepEqual(await store.replayWebhookDelivery({ id: 999, now: NOW }), { found: false });
    assert.equal(await store.getWebhookDelivery(999), null);
    assert.deepEqual(await attemptsOf(store, 999), []);
  });

  it("filters by event, orders newest first and summarizes per subscription", async () => {
    const store = await createStore();
    const [a, b, c] = await seed(store);
    await seed(store, { subscriptionId: "other", events: ["e1"] });
    await store.completeWebhookDelivery({ id: a.id, outcome: "delivered", attempts: 1, statusCode: 200, now: NOW });
    await store.completeWebhookDelivery({ id: b.id, outcome: "dead", attempts: 8, error: "x", now: NOW });

    const desc = await store.listWebhookDeliveries({ subscriptionId: "ops", order: "desc", limit: 10, offset: 0 });
    assert.deepEqual(desc.map(({ eventId }) => eventId), ["e3", "e2", "e1"]);
    const byEvent = await store.listWebhookDeliveries({ eventId: "e1", limit: 10, offset: 0 });
    assert.deepEqual(byEvent.map(({ subscriptionId }) => subscriptionId).sort(), ["ops", "other"]);

    await store.replayWebhookDelivery({ id: b.id, now: LATER });
    const summary = await store.summarizeWebhookDeliveries();
    assert.deepEqual(
      summary.map(({ subscriptionId, pending, delivered, dead, replays }) => [subscriptionId, pending, delivered, dead, replays]),
      [["ops", 2, 1, 0, 1], ["other", 1, 0, 0, 0]]
    );
    assert.equal(summary[0].oldestPendingAt, NOW);
    assert.ok(c);
  });

  it("counts a bulk requeue of dead deliveries as a replay", async () => {
    const store = await createStore();
    const rows = await seed(store);
    for (const row of rows) await store.completeWebhookDelivery({ id: row.id, outcome: "dead", attempts: 8, error: "x", now: NOW });
    assert.equal(await store.requeueDeadWebhookDeliveries({ subscriptionId: "ops", now: LATER }), 3);
    assert.deepEqual((await store.listWebhookDeliveries({ limit: 10, offset: 0 })).map(({ replayCount }) => replayCount), [1, 1, 1]);
  });
});

describeEachBackend("webhook dashboard API", () => {
  it("serves the dashboard with a strict per-response CSP", async () => {
    const store = await createStore();
    await withApi(store, {}, async ({ base }) => {
      const first = await fetch(`${base}/ops/webhooks`);
      assert.equal(first.status, 200);
      assert.match(first.headers.get("content-type"), /text\/html/);
      const csp = first.headers.get("content-security-policy");
      const nonce = csp.match(/script-src 'nonce-([^']+)'/)[1];
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /connect-src 'self'/);
      assert.match(csp, /frame-ancestors 'none'/);
      const html = await first.text();
      assert.ok(html.includes(`<script nonce="${nonce}">`));
      assert.equal(first.headers.get("cache-control"), "no-store");

      const second = await fetch(`${base}/ops/webhooks`);
      assert.notEqual(second.headers.get("content-security-policy"), csp, "the nonce is not reused");
      await second.text();
    });
  });

  it("can be switched off", async () => {
    const store = await createStore();
    await withApi(store, { dashboard: { enabled: false } }, async ({ base }) => {
      assert.equal((await fetch(`${base}/ops/webhooks`)).status, 404);
      assert.equal((await fetch(`${base}/webhooks/deliveries/summary`)).status, 404);
    });
  });

  it("shows the summary and one delivery with its payload and attempts, never the secret or URL path", async () => {
    const store = await createStore();
    const [first] = await seed(store, { events: ["e1"] });
    await store.completeWebhookDelivery({ id: first.id, outcome: "retry", attempts: 1, nextAttemptAt: LATER, statusCode: 502, error: "HTTP 502", durationMs: 9, now: NOW });

    await withApi(store, {}, async ({ base }) => {
      const summary = await (await fetch(`${base}/webhooks/deliveries/summary`)).json();
      assert.deepEqual(summary.totals, { pending: 1, delivered: 0, dead: 0 });
      assert.equal(summary.controlsEnabled, true);
      assert.equal(summary.subscriptions[0].subscriptionId, "ops");
      assert.equal(summary.subscriptions[0].configured, true);

      const response = await fetch(`${base}/webhooks/deliveries/${first.id}`);
      const text = await response.text();
      const detail = JSON.parse(text);
      assert.equal(detail.delivery.body, first.body);
      assert.equal(detail.attempts.length, 1);
      assert.equal(detail.attempts[0].statusCode, 502);
      assert.deepEqual(detail.subscription, { id: "ops", configured: true, origin: "https://hooks.example.com", topics: null });
      assert.ok(!text.includes(SUBSCRIPTION.secret));
      assert.ok(!text.includes("/secret/path"));
      assert.ok(!text.includes("key=abc"));
    });
  });

  it("answers 404 for an unknown delivery and 400 for a malformed id", async () => {
    const store = await createStore();
    await withApi(store, {}, async ({ base }) => {
      assert.equal((await fetch(`${base}/webhooks/deliveries/999`)).status, 404);
      assert.equal((await fetch(`${base}/webhooks/deliveries/abc`)).status, 400);
      assert.equal((await fetch(`${base}/webhooks/deliveries/0`)).status, 400);
      assert.equal((await post(`${base}/webhooks/deliveries/999/replay`)).status, 404);
      assert.equal((await post(`${base}/webhooks/deliveries/1.5/replay`)).status, 400);
    });
  });

  it("lists newest first, filters by event, and rejects a bad order", async () => {
    const store = await createStore();
    await seed(store);
    await withApi(store, {}, async ({ base }) => {
      const desc = await (await fetch(`${base}/webhooks/deliveries?order=desc`)).json();
      assert.deepEqual(desc.deliveries.map(({ eventId }) => eventId), ["e3", "e2", "e1"]);
      const one = await (await fetch(`${base}/webhooks/deliveries?event=e2`)).json();
      assert.deepEqual(one.deliveries.map(({ eventId }) => eventId), ["e2"]);
      assert.equal((await fetch(`${base}/webhooks/deliveries?order=sideways`)).status, 400);
    });
  });

  it("refuses to replay until a strong admin token is configured", async () => {
    const store = await createStore();
    const [first] = await seed(store, { events: ["e1"] });
    await store.completeWebhookDelivery({ id: first.id, outcome: "dead", attempts: 8, error: "x", now: NOW });

    await withApi(store, { dashboard: { adminToken: "" } }, async ({ base }) => {
      const single = await post(`${base}/webhooks/deliveries/${first.id}/replay`, TOKEN);
      assert.equal(single.status, 403);
      assert.match((await single.json()).error, /OPS_ADMIN_TOKEN/);
      assert.equal((await post(`${base}/webhooks/deliveries/retry-dead`, TOKEN)).status, 403);
      assert.equal((await (await fetch(`${base}/webhooks/deliveries/summary`)).json()).controlsEnabled, false);
    });
    assert.equal((await store.getWebhookDelivery(first.id)).status, "dead", "nothing changed");
  });

  it("rejects a missing or wrong token without touching the outbox", async () => {
    const store = await createStore();
    const [first] = await seed(store, { events: ["e1"] });
    await store.completeWebhookDelivery({ id: first.id, outcome: "dead", attempts: 8, error: "x", now: NOW });

    await withApi(store, {}, async ({ base }) => {
      for (const token of [null, "wrong-token-0123456789", TOKEN.slice(0, -1)]) {
        const response = await post(`${base}/webhooks/deliveries/${first.id}/replay`, token);
        assert.equal(response.status, 401);
        assert.match(response.headers.get("www-authenticate"), /Bearer/);
      }
      assert.equal((await post(`${base}/webhooks/deliveries/retry-dead`, "nope")).status, 401);
      // A token in the query string is never accepted.
      assert.equal((await fetch(`${base}/webhooks/deliveries/${first.id}/replay?token=${TOKEN}`, { method: "POST" })).status, 401);
      // Replay is POST-only.
      assert.equal((await fetch(`${base}/webhooks/deliveries/${first.id}/replay`)).status, 404);
    });
    assert.equal((await store.getWebhookDelivery(first.id)).status, "dead");
  });

  it("replays one delivery with a valid token and counts it once however often it is clicked", async () => {
    const store = await createStore();
    const [first] = await seed(store, { events: ["e1"] });
    await store.completeWebhookDelivery({ id: first.id, outcome: "dead", attempts: 8, error: "x", now: NOW });

    await withApi(store, {}, async ({ base, metrics }) => {
      const result = await (await post(`${base}/webhooks/deliveries/${first.id}/replay`)).json();
      assert.equal(result.replayed, true);
      assert.equal(result.previousStatus, "dead");
      assert.equal(result.delivery.status, "pending");

      const again = await (await post(`${base}/webhooks/deliveries/${first.id}/replay`)).json();
      assert.equal(again.replayed, false);
      assert.equal(again.delivery.replayCount, 1);
      assert.match(metrics.render(), /accord_indexer_webhook_replays_total\{scope="single"\} 1/);
    });
  });

  it("bulk-retries dead deliveries, optionally for one subscription", async () => {
    const store = await createStore();
    const mine = await seed(store, { events: ["e1", "e2"] });
    const theirs = await seed(store, { subscriptionId: "other", events: ["e1"] });
    for (const row of [...mine, ...theirs]) {
      await store.completeWebhookDelivery({ id: row.id, outcome: "dead", attempts: 8, error: "x", now: NOW });
    }

    await withApi(store, {}, async ({ base, metrics }) => {
      const scoped = await (await post(`${base}/webhooks/deliveries/retry-dead?subscription=ops`)).json();
      assert.deepEqual(scoped, { requeued: 2, subscription: "ops" });
      assert.equal((await store.getWebhookDelivery(theirs[0].id)).status, "dead");

      const rest = await (await post(`${base}/webhooks/deliveries/retry-dead`)).json();
      assert.deepEqual(rest, { requeued: 1, subscription: null });
      assert.equal((await (await post(`${base}/webhooks/deliveries/retry-dead`)).json()).requeued, 0, "nothing left to retry");
      assert.match(metrics.render(), /accord_indexer_webhook_replays_total\{scope="bulk"\} 3/);
    });
  });

  it("a replayed delivery is re-sent with identical bytes and the new attempt is logged", async () => {
    const store = await createStore();
    await seed(store, { events: ["e1"] });
    const requests = [];
    let status = 500;
    const dispatcher = createWebhookDispatcher({
      store,
      subscriptions: [SUBSCRIPTION],
      maxAttempts: 1,
      now: () => Date.parse(LATER),
      logger: { error() {} },
      fetchImpl: async (url, init) => {
        requests.push({ url, body: init.body, headers: init.headers });
        return { status, body: null };
      },
    });

    await dispatcher.tick();
    const [dead] = await store.listWebhookDeliveries({ limit: 10, offset: 0 });
    assert.equal(dead.status, "dead");

    status = 200;
    await withApi(store, {}, async ({ base }) => {
      assert.equal((await post(`${base}/webhooks/deliveries/${dead.id}/replay`)).status, 200);
      await dispatcher.tick();
      const detail = await (await fetch(`${base}/webhooks/deliveries/${dead.id}`)).json();

      assert.equal(detail.delivery.status, "delivered");
      assert.equal(requests.length, 2);
      assert.equal(requests[0].body, requests[1].body);
      assert.equal(requests[0].headers["x-accord-event-id"], requests[1].headers["x-accord-event-id"]);
      assert.equal(requests[1].headers["x-accord-delivery-attempt"], "1", "a replay starts a new attempt count");
      assert.deepEqual(
        detail.attempts.map(({ replayRound, attempt, outcome, statusCode }) => [replayRound, attempt, outcome, statusCode]),
        [[0, 1, "dead", 500], [1, 1, "delivered", 200]]
      );
      assert.ok(detail.attempts.every(({ durationMs }) => Number.isInteger(durationMs)));
    });
  });
});

describe("dashboard page", () => {
  it("embeds config safely and never writes API data as HTML", () => {
    const html = renderWebhookDashboard({ nonce: "n0nce", pageSize: 25, controlsEnabled: true });
    assert.match(html, /<script type="application\/json" id="config">\{"pageSize":25,"controlsEnabled":true\}<\/script>/);
    assert.ok(!html.includes("innerHTML"), "all values are written with textContent");
    assert.ok(!/ style="/.test(html), "inline style attributes would be blocked by the CSP");
    assert.ok(!/https?:\/\//.test(html.replace(/<!doctype[^>]*>/i, "")), "the page makes no external requests");
  });

  it("is valid JavaScript", () => {
    const html = renderWebhookDashboard({ nonce: "n0nce" });
    const script = html.match(/<script nonce="n0nce">([\s\S]*?)<\/script>/)[1];
    assert.doesNotThrow(() => new Function(script));
  });
});

describe("webhook ops helpers", () => {
  it("compares tokens without accepting empty or different values", () => {
    assert.equal(tokenMatches(TOKEN, TOKEN), true);
    assert.equal(tokenMatches(TOKEN, `${TOKEN}x`), false);
    assert.equal(tokenMatches(TOKEN, ""), false);
    assert.equal(tokenMatches("", ""), false);
    assert.equal(tokenMatches(TOKEN, undefined), false);
  });

  it("labels routes without leaking ids into metric labels", () => {
    assert.equal(webhookOpsRouteLabel("/webhooks/deliveries/123"), "/webhooks/deliveries/:id");
    assert.equal(webhookOpsRouteLabel("/webhooks/deliveries/123/replay"), "/webhooks/deliveries/:id/replay");
    assert.equal(webhookOpsRouteLabel("/webhooks/deliveries/summary"), "/webhooks/deliveries/summary");
    assert.equal(webhookOpsRouteLabel("/ops/webhooks"), "/ops/webhooks");
    assert.equal(webhookOpsRouteLabel("/nothing"), null);
  });
});

describe("webhook dashboard config", () => {
  it("is read-only by default", () => {
    assert.deepEqual(resolveWebhookDashboardConfig({}), { enabled: true, adminToken: "", adminTokenRejected: false, pageSize: 50 });
    assert.equal(loadIndexerConfig({}).webhookDashboard.adminToken, "");
  });

  it("enables retry controls only for a strong token", () => {
    assert.equal(resolveWebhookDashboardConfig({ OPS_ADMIN_TOKEN: ` ${TOKEN} ` }).adminToken, TOKEN);
    const weak = resolveWebhookDashboardConfig({ OPS_ADMIN_TOKEN: "short" });
    assert.equal(weak.adminToken, "");
    assert.equal(weak.adminTokenRejected, true);
  });

  it("parses overrides and falls back on out-of-range values", () => {
    assert.equal(resolveWebhookDashboardConfig({ WEBHOOK_DASHBOARD_ENABLED: "false" }).enabled, false);
    assert.equal(resolveWebhookDashboardConfig({ WEBHOOK_DASHBOARD_PAGE_SIZE: "100" }).pageSize, 100);
    assert.equal(resolveWebhookDashboardConfig({ WEBHOOK_DASHBOARD_PAGE_SIZE: "100000" }).pageSize, 50);
  });
});

describe("attempt history migration", () => {
  it("ships a Postgres migration for attempts and replay bookkeeping", () => {
    const migration = loadMigrations().find((entry) => entry.name === "0010_webhook_delivery_attempts");
    assert.ok(migration);
    assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS webhook_delivery_attempts/);
    assert.match(migration.sql, /ADD COLUMN IF NOT EXISTS replay_count/);
  });
});
