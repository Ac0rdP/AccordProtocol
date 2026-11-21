import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createApiKeyService, extractApiKey, generateApiKey, normalizeScopes, parseApiKey, apiKeyOpsRouteLabel } from "../src/api-keys.js";
import { createApi } from "../src/api.js";
import { loadIndexerConfig, resolveApiKeysConfig } from "../src/config.js";
import { createReadiness } from "../src/health.js";
import { createIndexerMetrics } from "../src/metrics.js";
import { loadMigrations } from "../src/store/migrations.js";
import { cleanupTempStores, createStore, describeEachBackend } from "./helpers.js";

afterEach(cleanupTempStores);

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const ADMIN = "ops-admin-token-0123456789";
const config = resolveApiKeysConfig({});

function setup(store, options = {}) {
  const time = { now: T0 };
  const metrics = createIndexerMetrics();
  const service = createApiKeyService({ store, config: { ...config, ...options.config }, metrics, now: () => time.now });
  return { service, time, metrics };
}

const issue = (service, overrides = {}) =>
  service.create({ name: "dashboard", scopes: ["ledger", "events"], quotaLimit: 3, quotaWindowSeconds: 60, ...overrides });

describe("api key format", () => {
  it("generates parseable keys with a public id and a secret", () => {
    const { id, secret, key } = generateApiKey();
    assert.match(key, /^acck_[0-9a-f]{16}_[0-9a-f]{64}$/);
    assert.deepEqual(parseApiKey(key), { id, secret });
    assert.notEqual(generateApiKey().key, key);
  });

  it("rejects anything that is not a key", () => {
    for (const raw of ["", "acck_short", `acck_${"g".repeat(16)}_${"a".repeat(64)}`, undefined, 5, "Bearer x"]) {
      assert.equal(parseApiKey(raw), null);
    }
  });

  it("reads the key from Authorization or X-API-Key only", () => {
    assert.equal(extractApiKey({ headers: { authorization: "Bearer abc " } }), "abc");
    assert.equal(extractApiKey({ headers: { "x-api-key": " abc " } }), "abc");
    assert.equal(extractApiKey({ headers: { authorization: "Basic abc" } }), "");
    assert.equal(extractApiKey({ headers: {} }), "");
  });

  it("normalises scopes and refuses unknown ones", () => {
    assert.deepEqual(normalizeScopes(["events", "ledger", "events"]), ["events", "ledger"]);
    assert.deepEqual(normalizeScopes("*"), ["events", "ledger", "reconciliation", "subscriptions"]);
    for (const bad of [[], "ledger", ["admin"], undefined, null]) assert.throws(() => normalizeScopes(bad), /scopes must be/);
  });
});

describeEachBackend("api key lifecycle", () => {
  it("issues a key once and stores only a hash of its secret", async () => {
    const store = await createStore();
    const { service } = setup(store);
    const { key, apiKey } = await issue(service);
    const { secret, id } = parseApiKey(key);

    assert.equal(apiKey.id, id);
    assert.deepEqual(apiKey.scopes, ["events", "ledger"]);
    assert.equal(apiKey.quotaLimit, 3);
    assert.equal(apiKey.status, "active");
    assert.equal(JSON.stringify(apiKey).includes(secret), false);
    assert.equal("secretHash" in apiKey, false);

    const stored = await store.getApiKey(id);
    assert.notEqual(stored.secretHash, secret);
    assert.match(stored.secretHash, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(await service.list({ limit: 10, offset: 0 })).includes(secret), false);
  });

  it("applies the configured defaults and validates input", async () => {
    const store = await createStore();
    const { service } = setup(store);
    const { apiKey } = await service.create({ name: "defaults", scopes: "*" });
    assert.deepEqual([apiKey.quotaLimit, apiKey.quotaWindowSeconds], [1000, 3600]);

    const rejects = (input, pattern) => assert.rejects(service.create({ name: "x", scopes: ["ledger"], ...input }), pattern);
    await rejects({ name: "" }, /name must be/);
    await rejects({ name: "x".repeat(101) }, /name must be/);
    await rejects({ scopes: ["nope"] }, /scopes must be/);
    await rejects({ quotaLimit: 0 }, /limit must be/);
    await rejects({ quotaLimit: 1.5 }, /limit must be/);
    await rejects({ quotaWindowSeconds: 0 }, /windowSeconds must be/);
    await rejects({ expiresAt: "2026-09-01T00:00:00Z" }, /expiresAt must be a valid date in the future/);
    await rejects({ expiresAt: "garbage" }, /expiresAt must be a valid date/);
    assert.equal((await service.list({ limit: 10, offset: 0 })).length, 1, "invalid requests create nothing");
  });

  it("lists by status", async () => {
    const store = await createStore();
    const { service } = setup(store);
    const first = await issue(service, { name: "a" });
    await issue(service, { name: "b" });
    await service.revoke(first.apiKey.id);
    assert.deepEqual((await service.list({ status: "active", limit: 10, offset: 0 })).map(({ name }) => name), ["b"]);
    assert.deepEqual((await service.list({ status: "revoked", limit: 10, offset: 0 })).map(({ name }) => name), ["a"]);
    assert.equal((await service.list({ limit: 10, offset: 0 })).length, 2);
  });

  it("revokes immediately, and revoking again changes nothing", async () => {
    const store = await createStore();
    const { service } = setup(store);
    const { key, apiKey } = await issue(service);
    assert.equal((await service.check(key, "ledger")).ok, true);

    assert.deepEqual(await service.revoke(apiKey.id), { found: true, changed: true });
    assert.deepEqual(await service.revoke(apiKey.id), { found: true, changed: false });
    assert.deepEqual(await service.revoke("0".repeat(16)), { found: false, changed: false });
    const denied = await service.check(key, "ledger");
    assert.deepEqual([denied.ok, denied.status], [false, 401]);
    assert.match(denied.error, /revoked/);
    assert.equal(await service.rotate(apiKey.id), null, "a revoked key cannot be rotated back to life");
  });

  it("stops accepting an expired key", async () => {
    const store = await createStore();
    const { service, time } = setup(store);
    const { key } = await issue(service, { expiresAt: new Date(T0 + 60_000).toISOString() });
    assert.equal((await service.check(key, "ledger")).ok, true);
    time.now = T0 + 60_000;
    const expired = await service.check(key, "ledger");
    assert.deepEqual([expired.ok, expired.status], [false, 401]);
    assert.match(expired.error, /expired/);
  });
});

describeEachBackend("api key authentication and quota", () => {
  it("rejects missing, malformed, unknown and wrong-secret keys without counting them", async () => {
    const store = await createStore();
    const { service, metrics } = setup(store);
    const { key, apiKey } = await issue(service);
    const wrongSecret = `acck_${apiKey.id}_${"0".repeat(64)}`;
    const unknownId = `acck_${"0".repeat(16)}_${parseApiKey(key).secret}`;

    for (const attempt of ["", "garbage", wrongSecret, unknownId]) {
      const result = await service.check(attempt, "ledger");
      assert.deepEqual([result.ok, result.status], [false, 401], attempt);
    }
    assert.equal((await service.check(key, "ledger")).quota.remaining, 2, "none of that touched the quota");
    assert.match(metrics.render(), /accord_indexer_api_key_requests_total\{key="unknown",result="unauthorized"\} 4/);
  });

  it("enforces scopes and does not charge a refused request", async () => {
    const store = await createStore();
    const { service } = setup(store);
    const { key } = await issue(service, { scopes: ["ledger"] });
    const refused = await service.check(key, "events");
    assert.deepEqual([refused.ok, refused.status], [false, 403]);
    assert.match(refused.error, /"events" scope/);
    assert.equal((await service.check(key, "ledger")).quota.remaining, 2);
  });

  it("counts down, then refuses with the time until the window resets", async () => {
    const store = await createStore();
    const { service, time, metrics } = setup(store);
    const { key } = await issue(service);

    time.now = T0 + 10_000;
    const remaining = [];
    for (let i = 0; i < 3; i += 1) remaining.push((await service.check(key, "ledger")).quota.remaining);
    assert.deepEqual(remaining, [2, 1, 0]);

    const refused = await service.check(key, "ledger");
    assert.deepEqual([refused.ok, refused.status, refused.error], [false, 429, "API key quota exceeded"]);
    assert.equal(refused.retryAfterSeconds, 50);
    assert.equal(refused.quota.resetAt, T0 / 1000 + 60);
    assert.equal(refused.quota.remaining, 0);
    // Hammering a refused key does not push the counter past the limit.
    for (let i = 0; i < 5; i += 1) await service.check(key, "ledger");
    assert.equal((await service.check(key, "events")).quota.remaining, 0);
    assert.match(metrics.render(), /result="quota_exceeded"\} 7/);
  });

  it("starts a fresh quota in the next window", async () => {
    const store = await createStore();
    const { service, time } = setup(store);
    const { key } = await issue(service);
    for (let i = 0; i < 3; i += 1) await service.check(key, "ledger");
    assert.equal((await service.check(key, "ledger")).status, 429);

    time.now = T0 + 60_000;
    const next = await service.check(key, "ledger");
    assert.equal(next.ok, true);
    assert.equal(next.quota.remaining, 2);
  });

  it("keeps quotas separate per key", async () => {
    const store = await createStore();
    const { service } = setup(store);
    const a = await issue(service, { name: "a", quotaLimit: 1 });
    const b = await issue(service, { name: "b", quotaLimit: 1 });
    assert.equal((await service.check(a.key, "ledger")).ok, true);
    assert.equal((await service.check(a.key, "ledger")).status, 429);
    assert.equal((await service.check(b.key, "ledger")).ok, true);
  });

  it("never lets concurrent requests overshoot the quota", async () => {
    const store = await createStore();
    const { service } = setup(store);
    const { key } = await issue(service, { quotaLimit: 5 });
    const results = await Promise.all(Array.from({ length: 20 }, () => service.check(key, "ledger")));
    assert.equal(results.filter(({ ok }) => ok).length, 5);
    assert.equal(results.filter(({ status }) => status === 429).length, 15);
  });

  it("two service instances on one store share the same quota", async () => {
    const store = await createStore();
    const first = setup(store);
    const second = setup(store);
    const { key } = await issue(first.service, { quotaLimit: 4 });
    const results = await Promise.all([
      ...Array.from({ length: 4 }, () => first.service.check(key, "ledger")),
      ...Array.from({ length: 4 }, () => second.service.check(key, "ledger")),
    ]);
    assert.equal(results.filter(({ ok }) => ok).length, 4);
  });

  it("drops old counters and keeps recent ones", async () => {
    const store = await createStore();
    const { service, time } = setup(store, { config: { usageRetentionDays: 1 } });
    const { key } = await issue(service, { quotaLimit: 1 });
    await service.check(key, "ledger");
    assert.equal(await service.prune(), 0, "recent counters stay");

    time.now = T0 + 2 * 86_400_000;
    assert.equal(await service.prune(), 1);
    // The old window is gone, so nothing lingers once the key is used again.
    assert.equal((await service.check(key, "ledger")).ok, true);
  });
});

describeEachBackend("api key rotation", () => {
  it("accepts both secrets during the grace period, then only the new one", async () => {
    const store = await createStore();
    const { service, time } = setup(store);
    const original = await issue(service, { quotaLimit: 100 });

    const rotated = await service.rotate(original.apiKey.id, { graceSeconds: 600 });
    assert.notEqual(rotated.key, original.key);
    assert.equal(parseApiKey(rotated.key).id, original.apiKey.id, "the key id (and its quota) stays");
    assert.equal(rotated.previousValidUntil, new Date(T0 + 600_000).toISOString());
    assert.equal(rotated.apiKey.hasPreviousSecret, true);
    assert.equal(JSON.stringify(rotated.apiKey).includes(parseApiKey(rotated.key).secret), false);

    time.now = T0 + 599_000;
    assert.equal((await service.check(original.key, "ledger")).ok, true);
    assert.equal((await service.check(rotated.key, "ledger")).ok, true);

    time.now = T0 + 600_000;
    assert.equal((await service.check(original.key, "ledger")).status, 401);
    assert.equal((await service.check(rotated.key, "ledger")).ok, true);
  });

  it("can cut the old secret off immediately", async () => {
    const store = await createStore();
    const { service } = setup(store);
    const original = await issue(service);
    const rotated = await service.rotate(original.apiKey.id, { graceSeconds: 0 });
    assert.equal(rotated.previousValidUntil, null);
    assert.equal(rotated.apiKey.hasPreviousSecret, false);
    assert.equal((await service.check(original.key, "ledger")).status, 401);
    assert.equal((await service.check(rotated.key, "ledger")).ok, true);
  });

  it("uses the configured grace by default and validates it", async () => {
    const store = await createStore();
    const { service } = setup(store, { config: { rotationGraceSeconds: 30 } });
    const original = await issue(service);
    const rotated = await service.rotate(original.apiKey.id);
    assert.equal(rotated.previousValidUntil, new Date(T0 + 30_000).toISOString());
    await assert.rejects(service.rotate(original.apiKey.id, { graceSeconds: -1 }), /graceSeconds must be/);
  });

  it("keeps one quota across a rotation and drops the oldest secret on a second rotation", async () => {
    const store = await createStore();
    const { service } = setup(store);
    const original = await issue(service, { quotaLimit: 2 });
    await service.check(original.key, "ledger");
    const first = await service.rotate(original.apiKey.id, { graceSeconds: 600 });
    assert.equal((await service.check(first.key, "ledger")).quota.remaining, 0, "usage carried over");

    const second = await service.rotate(original.apiKey.id, { graceSeconds: 600 });
    assert.equal((await service.check(original.key, "ledger")).status, 401, "only one previous secret is honoured");
    assert.equal((await service.check(first.key, "ledger")).status, 429, "the previous secret still authenticates (and is over quota)");
    assert.equal((await service.check(second.key, "ledger")).status, 429);
  });

  it("answers null for an unknown key", async () => {
    const store = await createStore();
    const { service } = setup(store);
    assert.equal(await service.rotate("0".repeat(16)), null);
  });

  it("revoking ends the grace period too", async () => {
    const store = await createStore();
    const { service } = setup(store);
    const original = await issue(service);
    await service.rotate(original.apiKey.id, { graceSeconds: 600 });
    await service.revoke(original.apiKey.id);
    assert.equal((await service.check(original.key, "ledger")).status, 401);
    assert.equal((await store.getApiKey(original.apiKey.id)).previousSecretHash, null);
  });
});

describeEachBackend("api key HTTP", () => {
  async function withApi(store, { enabled = true, adminToken = ADMIN } = {}, run) {
    const time = { now: T0 };
    const metrics = createIndexerMetrics();
    const apiKeys = createApiKeyService({ store, config, metrics, now: () => time.now });
    const readiness = createReadiness({ store });
    readiness.markSuccess();
    const api = createApi({
      store,
      readiness,
      metrics,
      startLedger: 1,
      finalityLag: 1,
      tokenAddresses: new Map([["XLM", "x"], ["USDC", "y"]]),
      webhookDashboard: { enabled: true, adminToken, pageSize: 50 },
      apiKeys,
      apiKeysEnabled: enabled,
    });
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${api.address().port}`;
    try {
      return await run({ base, apiKeys, time, metrics });
    } finally {
      await new Promise((resolve) => api.close(resolve));
    }
  }

  const get = (url, key, header = "authorization") =>
    fetch(url, { headers: key ? { [header]: header === "authorization" ? `Bearer ${key}` : key } : {} });
  const admin = (url, { method = "POST", body, token = ADMIN } = {}) =>
    fetch(url, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });

  it("leaves analytics reads open while keys are disabled", async () => {
    const store = await createStore();
    await withApi(store, { enabled: false }, async ({ base }) => {
      assert.equal((await get(`${base}/ledger`)).status, 200);
      assert.equal((await get(`${base}/events`)).status, 200);
    });
  });

  it("requires a key for analytics reads once enabled, but not for health or metrics", async () => {
    const store = await createStore();
    await withApi(store, {}, async ({ base }) => {
      for (const path of ["/ledger", "/events", "/reconciliation"]) {
        const response = await get(`${base}${path}`);
        assert.equal(response.status, 401, path);
        assert.match(response.headers.get("www-authenticate"), /Bearer/);
        await response.text();
      }
      for (const path of ["/healthz", "/readyz", "/metrics", "/health"]) {
        assert.equal((await get(`${base}${path}`)).status, 200, path);
      }
    });
  });

  it("serves a valid key with rate-limit headers, via either header, and never from the query string", async () => {
    const store = await createStore();
    await withApi(store, {}, async ({ base, apiKeys }) => {
      const { key } = await apiKeys.create({ name: "web", scopes: ["ledger"], quotaLimit: 5, quotaWindowSeconds: 3600 });

      const first = await get(`${base}/ledger`, key);
      assert.equal(first.status, 200);
      assert.equal(first.headers.get("x-ratelimit-limit"), "5");
      assert.equal(first.headers.get("x-ratelimit-remaining"), "4");
      assert.equal(first.headers.get("x-ratelimit-reset"), String(T0 / 1000 + 3600));
      await first.text();

      const second = await get(`${base}/ledger`, key, "x-api-key");
      assert.equal(second.status, 200);
      assert.equal(second.headers.get("x-ratelimit-remaining"), "3");
      await second.text();

      assert.equal((await fetch(`${base}/ledger?api_key=${key}`)).status, 401);
    });
  });

  it("refuses the wrong scope, then a spent quota, with the right headers", async () => {
    const store = await createStore();
    await withApi(store, {}, async ({ base, apiKeys }) => {
      const { key } = await apiKeys.create({ name: "web", scopes: ["ledger"], quotaLimit: 2, quotaWindowSeconds: 60 });
      const wrongScope = await get(`${base}/events`, key);
      assert.equal(wrongScope.status, 403);
      assert.match((await wrongScope.json()).error, /"events" scope/);

      assert.equal((await get(`${base}/ledger`, key)).status, 200);
      assert.equal((await get(`${base}/ledger`, key)).status, 200);
      const limited = await get(`${base}/ledger`, key);
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("retry-after"), "60");
      assert.equal(limited.headers.get("x-ratelimit-remaining"), "0");
      assert.equal((await limited.json()).error, "API key quota exceeded");
    });
  });

  it("stops serving a revoked key at once", async () => {
    const store = await createStore();
    await withApi(store, {}, async ({ base, apiKeys }) => {
      const { key, apiKey } = await apiKeys.create({ name: "web", scopes: "*" });
      assert.equal((await get(`${base}/reconciliation`, key)).status, 200);
      await apiKeys.revoke(apiKey.id);
      assert.equal((await get(`${base}/reconciliation`, key)).status, 401);
    });
  });

  it("keeps key management behind the admin token", async () => {
    const store = await createStore();
    await withApi(store, { adminToken: "" }, async ({ base }) => {
      const disabled = await admin(`${base}/admin/api-keys`, { body: { name: "x", scopes: ["ledger"] } });
      assert.equal(disabled.status, 403);
      assert.match((await disabled.json()).error, /API key management are disabled.*OPS_ADMIN_TOKEN/);
      assert.equal((await admin(`${base}/admin/api-keys`, { method: "GET" })).status, 403);
    });

    await withApi(store, {}, async ({ base }) => {
      for (const token of [null, "wrong-token-0123456789"]) {
        assert.equal((await admin(`${base}/admin/api-keys`, { body: { name: "x", scopes: ["ledger"] }, token })).status, 401);
        assert.equal((await admin(`${base}/admin/api-keys`, { method: "GET", token })).status, 401);
      }
      assert.equal((await fetch(`${base}/admin/api-keys?token=${ADMIN}`)).status, 401);
    });
    assert.equal((await store.listApiKeys({ limit: 10, offset: 0 })).length, 0, "nothing was created");
  });

  it("issues, lists, rotates and revokes keys over HTTP, and the issued key works", async () => {
    const store = await createStore();
    await withApi(store, {}, async ({ base }) => {
      const created = await admin(`${base}/admin/api-keys`, {
        body: { name: "partner", scopes: ["ledger", "events"], limit: 10, windowSeconds: 3600 },
      });
      assert.equal(created.status, 201);
      const { key, apiKey } = await created.json();
      assert.match(key, /^acck_/);
      assert.equal(apiKey.quotaLimit, 10);

      assert.equal((await get(`${base}/ledger`, key)).status, 200);

      const listed = await (await admin(`${base}/admin/api-keys`, { method: "GET" })).json();
      assert.deepEqual(listed.keys.map(({ id }) => id), [apiKey.id]);
      assert.equal(JSON.stringify(listed).includes(parseApiKey(key).secret), false);
      assert.equal((await (await admin(`${base}/admin/api-keys?status=revoked`, { method: "GET" })).json()).keys.length, 0);
      assert.equal((await (await admin(`${base}/admin/api-keys/${apiKey.id}`, { method: "GET" })).json()).apiKey.name, "partner");

      const rotated = await (await admin(`${base}/admin/api-keys/${apiKey.id}/rotate`, { body: { graceSeconds: 0 } })).json();
      assert.notEqual(rotated.key, key);
      assert.equal((await get(`${base}/ledger`, key)).status, 401);
      assert.equal((await get(`${base}/ledger`, rotated.key)).status, 200);

      const revoke = () => admin(`${base}/admin/api-keys/${apiKey.id}/revoke`).then((response) => response.json());
      assert.deepEqual(await revoke(), { revoked: true, changed: true });
      assert.deepEqual(await revoke(), { revoked: true, changed: false });
      assert.equal((await get(`${base}/ledger`, rotated.key)).status, 401);
    });
  });

  it("answers 404 for unknown keys and 400 for bad input", async () => {
    const store = await createStore();
    await withApi(store, {}, async ({ base }) => {
      const missing = "0".repeat(16);
      assert.equal((await admin(`${base}/admin/api-keys/${missing}`, { method: "GET" })).status, 404);
      assert.equal((await admin(`${base}/admin/api-keys/${missing}/rotate`, { body: {} })).status, 404);
      assert.equal((await admin(`${base}/admin/api-keys/${missing}/revoke`)).status, 404);

      assert.equal((await admin(`${base}/admin/api-keys`, { body: { name: "x", scopes: ["root"] } })).status, 400);
      assert.equal((await admin(`${base}/admin/api-keys`, { body: { name: "x", scopes: ["ledger"], limit: 0 } })).status, 400);
      assert.equal((await admin(`${base}/admin/api-keys`, { body: "{not json" })).status, 400);
      assert.equal((await admin(`${base}/admin/api-keys?status=bogus`, { method: "GET" })).status, 400);
    });
  });

  it("labels admin routes without key ids", () => {
    assert.equal(apiKeyOpsRouteLabel("/admin/api-keys"), "/admin/api-keys");
    assert.equal(apiKeyOpsRouteLabel(`/admin/api-keys/${"a".repeat(16)}`), "/admin/api-keys/:id");
    assert.equal(apiKeyOpsRouteLabel(`/admin/api-keys/${"a".repeat(16)}/rotate`), "/admin/api-keys/:id/rotate");
    assert.equal(apiKeyOpsRouteLabel("/admin/other"), null);
  });
});

describe("api key config", () => {
  it("is off by default with a modest quota", () => {
    assert.deepEqual(resolveApiKeysConfig({}), {
      enabled: false, defaultQuota: 1000, defaultWindowSeconds: 3600, rotationGraceSeconds: 86400, usageRetentionDays: 30,
    });
    assert.equal(loadIndexerConfig({}).apiKeys.enabled, false);
  });

  it("parses overrides and falls back on out-of-range values", () => {
    const parsed = resolveApiKeysConfig({
      API_KEYS_ENABLED: "true", API_KEYS_DEFAULT_QUOTA: "50", API_KEYS_DEFAULT_WINDOW_SECONDS: "60",
      API_KEYS_ROTATION_GRACE_SECONDS: "0", API_KEYS_USAGE_RETENTION_DAYS: "7",
    });
    assert.deepEqual(parsed, { enabled: true, defaultQuota: 50, defaultWindowSeconds: 60, rotationGraceSeconds: 0, usageRetentionDays: 7 });
    const bad = resolveApiKeysConfig({ API_KEYS_DEFAULT_QUOTA: "0", API_KEYS_DEFAULT_WINDOW_SECONDS: "-5", API_KEYS_ROTATION_GRACE_SECONDS: "x" });
    assert.equal(bad.defaultQuota, 1000);
    assert.equal(bad.defaultWindowSeconds, 3600);
    assert.equal(bad.rotationGraceSeconds, 86400);
  });

  it("ships a Postgres migration for keys and usage", () => {
    const migration = loadMigrations().find((entry) => entry.name === "0012_api_keys");
    assert.ok(migration);
    assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS api_keys/);
    assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS api_key_usage/);
    assert.match(migration.sql, /PRIMARY KEY \(key_id, window_start\)/);
  });
});
