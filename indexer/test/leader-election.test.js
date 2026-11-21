import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { loadIndexerConfig, resolveLeaderElectionConfig } from "../src/config.js";
import { createReadiness } from "../src/health.js";
import { indexEventBatch } from "../src/indexing.js";
import { createLeaderElection, createStaticLeader } from "../src/leader-election.js";
import { createIndexerMetrics } from "../src/metrics.js";
import { loadMigrations } from "../src/store/migrations.js";
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

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const lease = (store, holderId, now) =>
  store.acquireLease({ name: "indexer-leader", holderId, region: "r", ttlMs: 15_000, now: iso(now) });

/** A controllable clock shared by every election in a scenario. */
function clock(start = T0) {
  const state = { now: start };
  return { now: () => state.now, advance: (ms) => (state.now += ms) };
}

function elect(store, holderId, time, options = {}) {
  const events = [];
  const election = createLeaderElection({
    store,
    holderId,
    region: "r",
    ttlMs: 15_000,
    renewIntervalMs: 5_000,
    now: time.now,
    onElected: () => events.push(`${holderId}:elected`),
    onDemoted: () => events.push(`${holderId}:demoted`),
    logger: { error() {} },
    ...options,
  });
  return { election, events };
}

describeEachBackend("lease store", () => {
  it("grants a free lease and records the holder", async () => {
    const store = await createStore();
    const result = await lease(store, "a", T0);
    assert.equal(result.acquired, true);
    assert.equal(result.lease.holderId, "a");
    assert.equal(result.lease.fencingToken, 1);
    assert.equal(result.lease.expiresAt, iso(T0 + 15_000));
  });

  it("keeps the holder until the lease expires and refuses a contender", async () => {
    const store = await createStore();
    await lease(store, "a", T0);
    const contender = await lease(store, "b", T0 + 14_999);
    assert.equal(contender.acquired, false);
    assert.equal(contender.lease.holderId, "a");
    assert.equal((await lease(store, "b", T0 + 15_000)).acquired, true, "free exactly at expiry");
  });

  it("renews without moving the fencing token", async () => {
    const store = await createStore();
    await lease(store, "a", T0);
    const renewed = await lease(store, "a", T0 + 5_000);
    assert.equal(renewed.acquired, true);
    assert.equal(renewed.lease.fencingToken, 1);
    assert.equal(renewed.lease.acquiredAt, iso(T0));
    assert.equal(renewed.lease.expiresAt, iso(T0 + 20_000));
  });

  it("bumps the fencing token on takeover and when a lapsed lease is re-taken", async () => {
    const store = await createStore();
    await lease(store, "a", T0);
    assert.equal((await lease(store, "b", T0 + 16_000)).lease.fencingToken, 2);
    // The deposed holder cannot renew over the new leader.
    const stale = await lease(store, "a", T0 + 17_000);
    assert.equal(stale.acquired, false);
    assert.equal(stale.lease.holderId, "b");
    // A holder that let its own lease lapse gets a fresh token on return.
    assert.equal((await lease(store, "b", T0 + 40_000)).lease.fencingToken, 3);
  });

  it("releases early only for the current holder", async () => {
    const store = await createStore();
    await lease(store, "a", T0);
    assert.equal(await store.releaseLease({ name: "indexer-leader", holderId: "b", now: iso(T0 + 1) }), false);
    assert.equal(await store.releaseLease({ name: "indexer-leader", holderId: "a", now: iso(T0 + 1) }), true);
    assert.equal((await lease(store, "b", T0 + 2)).acquired, true);
  });

  it("serializes concurrent contenders into exactly one winner", async () => {
    const store = await createStore();
    const results = await Promise.all(["a", "b", "c", "d"].map((id) => lease(store, id, T0)));
    assert.equal(results.filter((result) => result.acquired).length, 1);
    assert.equal(new Set(results.map((result) => result.lease.holderId)).size, 1);
  });

  it("keeps separate leases independent", async () => {
    const store = await createStore();
    await lease(store, "a", T0);
    const other = await store.acquireLease({ name: "other", holderId: "b", ttlMs: 1000, now: iso(T0) });
    assert.equal(other.acquired, true);
    assert.equal(await store.getLease("missing"), null);
  });
});

describeEachBackend("leader election", () => {
  it("elects one leader and keeps the other on standby", async () => {
    const store = await createStore();
    const time = clock();
    const a = elect(store, "a", time);
    const b = elect(store, "b", time);
    await a.election.tick();
    await b.election.tick();

    assert.equal(a.election.isLeader(), true);
    assert.equal(b.election.isLeader(), false);
    assert.deepEqual(a.events, ["a:elected"]);
    assert.deepEqual(b.events, []);
    assert.equal(b.election.status().role, "standby");
    assert.equal(b.election.status().leader.holderId, "a");
  });

  it("fails over to the standby once the leader stops renewing", async () => {
    const store = await createStore();
    const time = clock();
    const a = elect(store, "a", time);
    const b = elect(store, "b", time);
    await a.election.tick();
    await b.election.tick();

    // Region A goes dark: it never renews again.
    time.advance(10_000);
    await b.election.tick();
    assert.equal(b.election.isLeader(), false, "lease still valid");
    time.advance(5_001);
    await b.election.tick();

    assert.equal(b.election.isLeader(), true);
    assert.equal(b.election.fencingToken, 2);
    assert.deepEqual(b.events, ["b:elected"]);
    // The old leader's own clock tells it to stop even before it can reach the store.
    assert.equal(a.election.isLeader(), false);
  });

  it("demotes a leader that finds the lease taken", async () => {
    const store = await createStore();
    const time = clock();
    const a = elect(store, "a", time);
    const b = elect(store, "b", time);
    await a.election.tick();
    time.advance(16_000);
    await b.election.tick();
    await a.election.tick();

    assert.equal(a.election.isLeader(), false);
    assert.deepEqual(a.events, ["a:elected", "a:demoted"]);
    assert.equal(a.election.status().leader.holderId, "b");
  });

  it("hands over immediately on a graceful stop", async () => {
    const store = await createStore();
    const time = clock();
    const a = elect(store, "a", time);
    const b = elect(store, "b", time);
    await a.election.tick();
    await a.election.stop();
    assert.deepEqual(a.events, ["a:elected", "a:demoted"]);

    time.advance(1);
    await b.election.tick();
    assert.equal(b.election.isLeader(), true, "no need to wait out the TTL");
  });

  it("rides out a short store outage, then steps down when its lease would have lapsed", async () => {
    const store = await createStore();
    const time = clock();
    const metrics = createIndexerMetrics();
    let down = false;
    const flaky = {
      acquireLease: (args) => (down ? Promise.reject(new Error("db down")) : store.acquireLease(args)),
      releaseLease: (args) => store.releaseLease(args),
    };
    const a = elect(flaky, "a", time, { metrics });
    await a.election.tick();
    down = true;

    time.advance(5_000);
    await a.election.tick();
    assert.equal(a.election.isLeader(), true, "lease is still valid by its own clock");
    assert.equal(a.election.status().lastError, "db down");

    time.advance(10_000);
    await a.election.tick();
    assert.equal(a.election.isLeader(), false);
    assert.deepEqual(a.events, ["a:elected", "a:demoted"]);
    assert.match(metrics.render(), /accord_indexer_errors_total\{stage="leader_election"\} 2/);
    assert.match(metrics.render(), /accord_indexer_is_leader 0/);
  });

  it("reports leadership metrics", async () => {
    const store = await createStore();
    const time = clock();
    const metrics = createIndexerMetrics();
    const a = elect(store, "a", time, { metrics });
    await a.election.tick();
    const text = metrics.render();
    assert.match(text, /accord_indexer_is_leader 1/);
    assert.match(text, /accord_indexer_leader_transitions_total\{to="leader"\} 1/);
  });

  it("rejects a renewal cadence that would let a healthy leader lapse", () => {
    assert.throws(
      () => createLeaderElection({ store: { acquireLease() {} }, holderId: "a", ttlMs: 10_000, renewIntervalMs: 6_000 }),
      /at most half/
    );
  });
});

describeEachBackend("failover ingestion", () => {
  const tokens = [{ name: "USDC", address: tokenAddresses.USDC }];
  const chain = (first, last) =>
    Array.from({ length: last - first + 1 }, (_, i) => makeEvent({ id: `e${first + i}`, ledger: first + i, amount: 10n }));
  const batch = (store, rpc) =>
    indexEventBatch({ stellar: rpc, store, tokens, treasuryAddress: treasury, startLedger: 10, finalityLag: 0 });

  it("the new leader resumes from the shared checkpoint without losing or duplicating events", async () => {
    const store = await createStore();
    const events = chain(10, 29);
    const rpc = createMockRpc({ events: events.slice(0, 10), latestLedger: 19 });
    const time = clock();
    const a = elect(store, "a", time);
    const b = elect(store, "b", time);
    await a.election.tick();
    await b.election.tick();

    assert.equal(a.election.isLeader() && (await batch(store, rpc)).indexed, 10);
    assert.equal(b.election.isLeader(), false, "standby does not ingest");

    // Region A dies; the chain keeps moving; B takes over.
    rpc.state.events = events;
    rpc.setChainHead(29);
    time.advance(16_000);
    await b.election.tick();
    assert.equal(b.election.isLeader(), true);
    assert.equal((await batch(store, rpc)).indexed, 10);

    assert.equal(await store.getBalance("USDC"), expectedBalances(events).USDC);
    assert.equal((await store.getEntries({ limit: 1000, offset: 0 })).length, 20);
  });

  it("a deposed leader that keeps writing is harmless: replay from any checkpoint is idempotent", async () => {
    const store = await createStore();
    const events = chain(10, 24);
    const rpc = createMockRpc({ events, latestLedger: 24 });
    await batch(store, rpc);
    const before = await store.getEntries({ limit: 1000, offset: 0 });

    // The old leader still believes the checkpoint is ledger 10 and re-walks everything.
    await store.setState("next_ledger", "10");
    await store.setState("event_cursor", "");
    const replayed = await batch(store, rpc);

    assert.equal(replayed.indexed, 0);
    assert.deepEqual(await store.getEntries({ limit: 1000, offset: 0 }), before);
    assert.equal(await store.getBalance("USDC"), expectedBalances(events).USDC);
  });

  it("two instances racing the same window still index each event once", async () => {
    const store = await createStore();
    const events = chain(10, 24);
    const rpc = createMockRpc({ events, latestLedger: 24 });
    const [x, y] = await Promise.all([batch(store, rpc), batch(store, rpc)]);

    assert.equal(x.indexed + y.indexed, 15);
    assert.equal((await store.getEntries({ limit: 1000, offset: 0 })).length, 15);
  });
});

describe("standby readiness", () => {
  it("is ready while on standby even though it never ingests, and reports the leader", async () => {
    const readiness = createReadiness({ store: { ping: async () => {} } });
    assert.equal((await readiness.check()).ready, false, "an instance that should ingest and has not is not ready");

    readiness.markStandby({ holderId: "a", region: "r" });
    const standby = await readiness.check();
    assert.equal(standby.ready, true);
    assert.deepEqual(standby.checks.indexing, { ok: true, role: "standby", leader: { holderId: "a", region: "r" } });

    readiness.clearStandby();
    assert.equal((await readiness.check()).ready, false, "promoted, but no batch has completed yet");
  });

  it("still fails readiness when the store is down", async () => {
    const readiness = createReadiness({ store: { ping: async () => Promise.reject(new Error("down")) } });
    readiness.markStandby(null);
    assert.equal((await readiness.check()).ready, false);
  });
});

describe("leader election config", () => {
  it("is off by default and always leads", () => {
    assert.deepEqual(resolveLeaderElectionConfig({}), {
      enabled: false,
      region: "",
      instanceId: "",
      leaseName: "indexer-leader",
      leaseTtlMs: 15000,
      renewIntervalMs: 5000,
    });
    assert.equal(loadIndexerConfig({}).leader.enabled, false);
    assert.equal(createStaticLeader().isLeader(), true);
    assert.equal(createStaticLeader().status().enabled, false);
  });

  it("parses overrides and falls back on out-of-range values", () => {
    const config = resolveLeaderElectionConfig({
      INDEXER_LEADER_ELECTION_ENABLED: "true",
      INDEXER_REGION: " eu-west-1 ",
      INDEXER_LEASE_TTL_MS: "30000",
      INDEXER_LEASE_RENEW_MS: "10000",
    });
    assert.equal(config.enabled, true);
    assert.equal(config.region, "eu-west-1");
    assert.equal(config.leaseTtlMs, 30000);
    assert.equal(config.renewIntervalMs, 10000);
    assert.equal(resolveLeaderElectionConfig({ INDEXER_LEASE_TTL_MS: "5" }).leaseTtlMs, 15000);
  });

  it("never lets the renewal cadence exceed half the TTL", () => {
    const config = resolveLeaderElectionConfig({ INDEXER_LEASE_TTL_MS: "6000", INDEXER_LEASE_RENEW_MS: "5000" });
    assert.equal(config.renewIntervalMs, 2000);
  });
});

describe("lease migration", () => {
  it("ships a Postgres migration for the lease table", () => {
    const migration = loadMigrations().find((entry) => entry.name === "0009_indexer_leases");
    assert.ok(migration);
    assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS indexer_leases/);
  });
});
