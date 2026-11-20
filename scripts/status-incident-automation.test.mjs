import assert from "node:assert/strict";
import test from "node:test";

import {
  automationMarkerFor,
  classifyHealthResponse,
  COMPONENTS,
  createExternalProviderAdapter,
  evaluateAllComponents,
  probeComponentWithRetry,
} from "./status-incident-automation.mjs";

const INDEXER = COMPONENTS.find((c) => c.id === "indexer");
const API = COMPONENTS.find((c) => c.id === "analytics-api");

function healthy(componentId) {
  return classifyHealthResponse(componentId, {
    httpStatus: 200,
    body: { status: "operational", checks: { primary: { ok: true } } },
  });
}

function outage(componentId, reason = "timeout after 10000ms") {
  return classifyHealthResponse(componentId, { error: reason });
}

test("healthy and no incident produces noop with zero incident changes", () => {
  const res = evaluateAllComponents({
    probeResultsByComponent: {
      indexer: healthy("indexer"),
      "analytics-api": healthy("analytics-api"),
    },
    incidents: [],
    state: { version: 1, components: {} },
    nowIso: "2026-11-20T00:00:00.000Z",
  });

  assert.equal(res.incidentsChanged, false);
  assert.equal(res.incidents.length, 0);
  assert.deepEqual(
    res.decisions.map((d) => d.action),
    ["noop", "noop"],
  );
});

test("first failure does not open an incident yet; threshold (3) opens exactly once; subsequent failures update without duplicates", () => {
  let state = { version: 1, components: {} };
  let incidents = [];

  // Failure 1 -> pending
  let res = evaluateAllComponents({
    probeResultsByComponent: { indexer: outage("indexer"), "analytics-api": healthy("analytics-api") },
    incidents,
    state,
    nowIso: "2026-11-20T00:00:00.000Z",
  });
  assert.equal(res.decisions[0].action, "pending");
  assert.equal(res.incidents.length, 0);
  state = res.nextState;

  // Failure 2 -> pending
  res = evaluateAllComponents({
    probeResultsByComponent: { indexer: outage("indexer"), "analytics-api": healthy("analytics-api") },
    incidents,
    state,
    nowIso: "2026-11-20T00:15:00.000Z",
  });
  assert.equal(res.decisions[0].action, "pending");
  assert.equal(res.incidents.length, 0);
  state = res.nextState;

  // Failure 3 -> open (partial outage: only indexer, analytics-api remains noop)
  res = evaluateAllComponents({
    probeResultsByComponent: { indexer: outage("indexer"), "analytics-api": healthy("analytics-api") },
    incidents,
    state,
    nowIso: "2026-11-20T00:30:00.000Z",
  });
  assert.equal(res.decisions[0].action, "open");
  assert.equal(res.decisions[1].action, "noop");
  assert.equal(res.incidentsChanged, true);
  assert.equal(res.incidents.length, 1);
  assert.equal(res.incidents[0].service, "indexer");
  assert.equal(res.incidents[0].automationMarker, automationMarkerFor("indexer"));
  incidents = res.incidents;
  state = res.nextState;

  // Failure 4 -> update existing incident, NO duplicate created
  res = evaluateAllComponents({
    probeResultsByComponent: { indexer: outage("indexer"), "analytics-api": healthy("analytics-api") },
    incidents,
    state,
    nowIso: "2026-11-20T00:45:00.000Z",
  });
  assert.equal(res.decisions[0].action, "update");
  assert.equal(res.incidents.length, 1);
  assert.equal(res.incidents[0].updates.length, 2);
});

test("recovery threshold (2 consecutive successes) resolves open incident cleanly", () => {
  const openIncidents = [
    {
      id: "2026-11-20-accord-auto:indexer",
      automationMarker: automationMarkerFor("indexer"),
      service: "indexer",
      title: "Indexer health check outage",
      status: "investigating",
      startedAt: "2026-11-20T00:30:00.000Z",
      resolvedAt: null,
      impact: INDEXER.impact,
      updates: [{ at: "2026-11-20T00:30:00.000Z", status: "investigating", note: "opened" }],
    },
  ];
  let state = {
    version: 1,
    components: {
      indexer: { consecutiveFailures: 3, consecutiveSuccesses: 0 },
    },
  };

  // Recovery check 1 -> recovering (not resolved yet)
  let res = evaluateAllComponents({
    probeResultsByComponent: { indexer: healthy("indexer"), "analytics-api": healthy("analytics-api") },
    incidents: openIncidents,
    state,
    nowIso: "2026-11-20T01:00:00.000Z",
  });
  assert.equal(res.decisions[0].action, "recovering");
  assert.equal(res.incidents[0].status, "investigating");
  state = res.nextState;

  // Recovery check 2 -> resolve
  res = evaluateAllComponents({
    probeResultsByComponent: { indexer: healthy("indexer"), "analytics-api": healthy("analytics-api") },
    incidents: res.incidents,
    state,
    nowIso: "2026-11-20T01:15:00.000Z",
  });
  assert.equal(res.decisions[0].action, "resolve");
  assert.equal(res.incidentsChanged, true);
  assert.equal(res.incidents[0].status, "resolved");
  assert.equal(res.incidents[0].resolvedAt, "2026-11-20T01:15:00.000Z");
});

test("flapping service resets consecutive failure count and never opens noisy incidents", () => {
  let state = { version: 1, components: {} };
  const sequence = [false, false, true, false, false, true];

  for (const [idx, isUp] of sequence.entries()) {
    const res = evaluateAllComponents({
      probeResultsByComponent: {
        indexer: isUp ? healthy("indexer") : outage("indexer"),
        "analytics-api": healthy("analytics-api"),
      },
      incidents: [],
      state,
      nowIso: `2026-11-20T0${idx}:00:00.000Z`,
    });
    assert.equal(res.incidents.length, 0, `Flapping sequence should not open incident at step ${idx}`);
    state = res.nextState;
  }
});

test("probeComponentWithRetry retries transient failures, handles timeouts & malformed responses, and never leaks URLs", async () => {
  let calls = 0;
  const flakyFetch = async () => {
    calls++;
    if (calls < 2) throw new Error("ECONNRESET");
    return {
      status: 200,
      json: async () => ({ status: "operational", checks: { store: { ok: true } } }),
    };
  };

  const recovered = await probeComponentWithRetry(INDEXER, "https://secret-indexer.internal?token=abc123", {
    retries: 2,
    retryDelayMs: 1,
    fetchImpl: flakyFetch,
  });
  assert.equal(recovered.healthy, true);
  assert.equal(recovered.attempts, 2);

  // Timeout scenario
  const hangingFetch = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  const timedOut = await probeComponentWithRetry(API, "https://secret-api.internal?token=xyz999", {
    timeoutMs: 10,
    retries: 1,
    retryDelayMs: 1,
    fetchImpl: hangingFetch,
  });
  assert.equal(timedOut.healthy, false);
  assert.match(timedOut.reason, /timeout/i);
  assert.ok(!timedOut.reason.includes("secret-api.internal"), "URL must not leak in reason");
  assert.ok(!timedOut.reason.includes("xyz999"), "Token must not leak in reason");

  // Malformed JSON response
  const malformed = await probeComponentWithRetry(API, "https://api.example", {
    retries: 0,
    fetchImpl: async () => ({
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    }),
  });
  assert.equal(malformed.healthy, false);
  assert.match(malformed.reason, /malformed/i);
});

test("external provider adapter fails loudly when unconfigured", async () => {
  const adapter = createExternalProviderAdapter({});
  await assert.rejects(
    () => adapter.apply({ action: "open", componentId: "indexer" }),
    /External status-page provider adapter is not configured/i,
  );
});
