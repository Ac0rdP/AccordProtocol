import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateCanaryGate,
  evaluateHealthResponse,
  evaluateInvariants,
  probeHealthEndpoint,
  selectRollbackArtifact,
  verifyArtifactHash,
} from "./canary-release-gate.mjs";

const HASH_V2 = "a".repeat(64);
const HASH_V1 = "b".repeat(64);
const HASH_OTHER = "c".repeat(64);

function validInvariantState(overrides = {}) {
  return {
    owners: ["GOWNER1", "GOWNER2", "GOWNER3"],
    ownerWeights: [1, 1, 1],
    totalWeight: 3,
    threshold: 2,
    activeProposals: 4,
    version: 2,
    storageVersion: 2,
    ...overrides,
  };
}

function healthyResults(nowIso = "2026-11-20T00:00:00.000Z") {
  const nowMs = Date.parse(nowIso);
  return [
    evaluateHealthResponse(
      "indexer",
      {
        httpStatus: 200,
        body: {
          status: "operational",
          checks: { store: { ok: true }, indexing: { ok: true } },
          updatedAt: nowIso,
        },
      },
      { nowMs },
    ),
    evaluateHealthResponse(
      "analytics-api",
      {
        httpStatus: 200,
        body: {
          status: "operational",
          checks: { database: { ok: true }, checkpoint: { ok: true } },
          updatedAt: nowIso,
        },
      },
      { nowMs },
    ),
  ];
}

test("gate passes when artifact hash matches, health is fresh/operational, and invariants hold", () => {
  const report = evaluateCanaryGate({
    builtHash: HASH_V2,
    deployedHash: HASH_V2,
    healthResults: healthyResults(),
    invariantState: validInvariantState(),
  });
  assert.equal(report.passed, true);
  assert.equal(report.wasmHash, HASH_V2);
  assert.deepEqual(report.reasons, []);
});

test("gate fails on health check outage, degraded status, or stale updatedAt", () => {
  const nowMs = Date.parse("2026-11-20T01:00:00.000Z");
  const staleIso = "2026-11-20T00:00:00.000Z"; // 1 hour old > 300s

  const stale = evaluateHealthResponse(
    "indexer",
    {
      httpStatus: 200,
      body: {
        status: "operational",
        checks: { store: { ok: true } },
        updatedAt: staleIso,
      },
    },
    { nowMs, maxAgeSeconds: 300 },
  );
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /stale/i);

  const degraded = evaluateHealthResponse(
    "analytics-api",
    {
      httpStatus: 200,
      body: {
        status: "degraded",
        checks: { database: { ok: true }, checkpoint: { ok: false } },
        updatedAt: "2026-11-20T00:59:50.000Z",
      },
    },
    { nowMs },
  );
  assert.equal(degraded.ok, false);

  const report = evaluateCanaryGate({
    builtHash: HASH_V2,
    deployedHash: HASH_V2,
    healthResults: [stale, degraded],
    invariantState: validInvariantState(),
  });
  assert.equal(report.passed, false);
  assert.equal(report.reasons.length, 2);
});

test("gate fails when contract invariants INV-01, INV-02, INV-03, or INV-08 are violated", () => {
  const inv01 = evaluateInvariants(validInvariantState({ totalWeight: 99 }));
  assert.equal(inv01.ok, false);
  assert.ok(inv01.failures.some((f) => f.includes("INV-01")));

  const inv02 = evaluateInvariants(validInvariantState({ threshold: 5 }));
  assert.equal(inv02.ok, false);
  assert.ok(inv02.failures.some((f) => f.includes("INV-02")));

  const inv03 = evaluateInvariants(validInvariantState({ owners: [], ownerWeights: [], totalWeight: 0 }));
  assert.equal(inv03.ok, false);
  assert.ok(inv03.failures.some((f) => f.includes("INV-03")));

  const inv08 = evaluateInvariants(validInvariantState({ activeProposals: 51 }));
  assert.equal(inv08.ok, false);
  assert.ok(inv08.failures.some((f) => f.includes("INV-08")));

  const report = evaluateCanaryGate({
    builtHash: HASH_V2,
    deployedHash: HASH_V2,
    healthResults: healthyResults(),
    invariantState: validInvariantState({ threshold: 5 }),
  });
  assert.equal(report.passed, false);
  assert.ok(report.reasons.some((r) => r.includes("INV-02")));
});

test("gate fails on WASM artifact hash mismatch", () => {
  const hashCheck = verifyArtifactHash({ builtHash: HASH_V2, deployedHash: HASH_OTHER });
  assert.equal(hashCheck.ok, false);
  assert.match(hashCheck.reason, /mismatch/i);

  const report = evaluateCanaryGate({
    builtHash: HASH_V2,
    deployedHash: HASH_OTHER,
    healthResults: healthyResults(),
    invariantState: validInvariantState(),
  });
  assert.equal(report.passed, false);
  assert.ok(report.reasons.some((r) => /mismatch/i.test(r)));
});

test("probeHealthEndpoint fails closed on timeout and malformed JSON", async () => {
  const hangingFetch = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });

  const timedOut = await probeHealthEndpoint("indexer", "https://indexer.example", {
    timeoutMs: 15,
    fetchImpl: hangingFetch,
  });
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.reason, /timed out/i);

  const malformedFetch = async () => ({
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token");
    },
  });
  const malformed = await probeHealthEndpoint("analytics-api", "https://api.example", {
    fetchImpl: malformedFetch,
  });
  assert.equal(malformed.ok, false);
  assert.match(malformed.reason, /malformed/i);
});

test("rollback selects the previous verified artifact and skips failed/unverified entries", () => {
  const history = [
    { tag: "v0.3.0", commit_sha: "3333333", wasm_hash: HASH_V2, status: "verified" },
    { tag: "v0.2.1-rc.1", commit_sha: "2222222", wasm_hash: HASH_OTHER, status: "unverified" },
    { tag: "v0.2.0", commit_sha: "1111111", wasm_hash: HASH_V1, status: "verified" },
  ];

  const plan = selectRollbackArtifact(history, {
    failedHash: HASH_V2,
    contractId: "CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS",
    network: "mainnet",
  });

  assert.equal(plan.mode, "manual-in-place-upgrade-rollback");
  assert.equal(plan.rollbackTarget.tag, "v0.2.0");
  assert.equal(plan.rollbackTarget.wasmHash, HASH_V1);
  assert.match(plan.commands.buildUnsignedRollback, new RegExp(HASH_V1));
  assert.match(plan.commands.buildUnsignedRollback, /--build-only/);

  // Fails closed if no previous verified artifact exists
  assert.throws(
    () =>
      selectRollbackArtifact([{ tag: "v0.3.0", wasm_hash: HASH_V2, status: "verified" }], {
        failedHash: HASH_V2,
      }),
    /No verified previous WASM artifact/i,
  );
});
