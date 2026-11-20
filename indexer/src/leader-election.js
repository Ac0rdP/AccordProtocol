/**
 * Lease-based leader election for running redundant indexers across regions.
 *
 * Every instance points at the same store and competes for one named lease.
 * The holder renews it on a fixed cadence; if it stops (crash, partition, a
 * dead region) the lease lapses after `ttlMs` and a standby takes over. Only the
 * leader ingests events and runs the outbound workers; standbys keep serving the
 * read API from the shared store.
 *
 * Safety does not depend on the election being perfect. Ingestion is idempotent
 * (event dedupe keys) and checkpoints only ever resume from a point that was
 * already covered, so a brief overlap between an old and a new leader re-writes
 * rows that are already there. The fencing token lets callers tell the two apart.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

export const DEFAULT_LEASE_NAME = "indexer-leader";

/** A readable, unique-per-process holder id, e.g. `us-east-1:host-4242-1a2b3c4d`. */
export function createHolderId({ region = "", host = hostname(), pid = process.pid } = {}) {
  const base = `${host}-${pid}-${randomUUID().slice(0, 8)}`;
  return region ? `${region}:${base}` : base;
}

/**
 * @param {object} options
 * @param {object} options.store    store exposing acquireLease/getLease/releaseLease
 * @param {string} options.holderId unique id of this instance
 * @param {string} [options.region] label shown in status output
 * @param {string} [options.name]   lease name (default `indexer-leader`)
 * @param {number} [options.ttlMs]  how long a lease lives without renewal
 * @param {number} [options.renewIntervalMs] how often to renew / contend
 * @param {() => number} [options.now] clock, injectable for tests
 * @param {(change: object) => any} [options.onElected]  runs when this instance becomes leader
 * @param {(change: object) => any} [options.onDemoted]  runs when it stops being leader
 */
export function createLeaderElection({
  store,
  holderId,
  region = "",
  name = DEFAULT_LEASE_NAME,
  ttlMs = 15_000,
  renewIntervalMs = 5_000,
  now = () => Date.now(),
  metrics = null,
  onElected = null,
  onDemoted = null,
  logger = console,
}) {
  if (!store?.acquireLease) throw new Error("leader election needs a store with lease support");
  if (!holderId) throw new Error("leader election needs a holderId");
  if (!(renewIntervalMs * 2 <= ttlMs)) throw new Error("renewIntervalMs must be at most half of ttlMs");

  let leader = false;
  // Our own view of when the lease we last renewed runs out. A leader that cannot
  // reach the store stops acting as leader at this point, before anyone else can
  // possibly have taken over.
  let localExpiresAt = 0;
  let fencingToken = null;
  let currentLease = null;
  let lastError = null;
  let timer = null;
  let ticking = null;
  let transitions = 0;

  function setLeader(next, lease) {
    if (next === leader) return null;
    leader = next;
    transitions += 1;
    metrics?.leaderTransitions?.inc({ to: next ? "leader" : "standby" });
    return { holderId, region, lease, fencingToken };
  }

  function publishMetrics() {
    metrics?.isLeader?.set(leader ? 1 : 0);
  }

  /** One election round: renew when leading, contend when standing by. */
  async function tick() {
    if (ticking) return ticking;
    ticking = (async () => {
      const startedAt = now();
      let change = null;
      let promoted = false;
      try {
        const result = await store.acquireLease({
          name,
          holderId,
          region,
          ttlMs,
          now: new Date(startedAt).toISOString(),
        });
        currentLease = result.lease;
        lastError = null;
        if (result.acquired) {
          localExpiresAt = startedAt + ttlMs;
          fencingToken = result.lease.fencingToken;
          change = setLeader(true, result.lease);
          promoted = Boolean(change);
        } else {
          localExpiresAt = 0;
          change = setLeader(false, result.lease);
        }
      } catch (error) {
        lastError = String(error?.message ?? error);
        metrics?.errors?.inc?.({ stage: "leader_election" });
        // Keep leading while our last renewal is still valid; step down once it is not.
        if (leader && now() >= localExpiresAt) change = setLeader(false, currentLease);
      }
      publishMetrics();
      if (change) {
        try {
          if (promoted) await onElected?.(change);
          else await onDemoted?.(change);
        } catch (error) {
          logger.error?.("Leader election callback failed:", error);
        }
      }
    })().finally(() => {
      ticking = null;
    });
    return ticking;
  }

  return {
    tick,
    /** True only while this instance holds an unexpired lease by its own clock. */
    isLeader: () => leader && now() < localExpiresAt,
    get fencingToken() {
      return fencingToken;
    },
    status() {
      const active = leader && now() < localExpiresAt;
      return {
        enabled: true,
        role: active ? "leader" : "standby",
        holderId,
        region,
        leaseName: name,
        fencingToken,
        leader: currentLease
          ? { holderId: currentLease.holderId, region: currentLease.region, expiresAt: currentLease.expiresAt }
          : null,
        transitions,
        lastError,
      };
    },
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), renewIntervalMs);
      timer.unref?.();
    },
    /** Stops contending and hands the lease over immediately so a standby need not wait for the TTL. */
    async stop() {
      clearInterval(timer);
      timer = null;
      await ticking;
      if (leader) {
        const change = setLeader(false, currentLease);
        localExpiresAt = 0;
        try {
          await store.releaseLease({ name, holderId, now: new Date(now()).toISOString() });
        } catch (error) {
          lastError = String(error?.message ?? error);
        }
        publishMetrics();
        try {
          await onDemoted?.(change);
        } catch (error) {
          logger.error?.("Leader election callback failed:", error);
        }
      }
    },
  };
}

/** The election used when failover is off: this instance is always the leader. */
export function createStaticLeader({ holderId = "standalone", region = "" } = {}) {
  return {
    tick: async () => {},
    isLeader: () => true,
    fencingToken: null,
    status: () => ({ enabled: false, role: "leader", holderId, region, leaseName: null, fencingToken: null, leader: null, transitions: 0, lastError: null }),
    start() {},
    async stop() {},
  };
}
