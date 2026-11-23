#!/usr/bin/env node

/**
 * canary-release-gate.mjs — Canary contract release gate, invariant evaluator,
 * artifact hash verifier, and rollback artifact selector.
 *
 * Usage:
 *   node scripts/canary-release-gate.mjs gate \
 *     --built-hash=<64-hex> \
 *     --deployed-hash=<64-hex> \
 *     [--indexer-url=https://...] \
 *     [--api-url=https://...] \
 *     [--invariants-file=invariants.json] \
 *     [--max-age-seconds=300] \
 *     [--dry-run] \
 *     [--out=canary-gate-report.json]
 *
 *   node scripts/canary-release-gate.mjs rollback-plan \
 *     --history=release-history.json \
 *     --failed-hash=<64-hex> \
 *     --contract-id=<C...> \
 *     [--network=mainnet] \
 *     [--out=rollback-plan.json]
 *
 * Zero external dependencies. Never accepts or prints private keys or secrets.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_OWNERS = 20;
export const MAX_ACTIVE_PROPOSALS = 50;
export const DEFAULT_MAX_HEALTH_AGE_SECONDS = 300;
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

const HEX_64_RE = /^[0-9a-f]{64}$/i;

/**
 * Verifies that the deployed WASM hash matches the reproducibly built artifact hash.
 */
export function verifyArtifactHash({ builtHash, deployedHash }) {
  const b = String(builtHash ?? "").trim().toLowerCase();
  const d = String(deployedHash ?? "").trim().toLowerCase();

  if (!HEX_64_RE.test(b)) {
    return { ok: false, reason: "Invalid or missing built WASM SHA-256 hash." };
  }
  if (!HEX_64_RE.test(d)) {
    return { ok: false, reason: "Invalid or missing deployed WASM SHA-256 hash." };
  }
  if (b !== d) {
    return {
      ok: false,
      reason: `WASM hash mismatch: built=${b} != deployed=${d}. Promotion blocked.`,
    };
  }
  return { ok: true, wasmHash: b };
}

/**
 * Evaluates a single service `/status` response for operational health and freshness.
 * Rejects stale endpoints (`updatedAt` older than `maxAgeSeconds`) to prevent
 * passing a canary gate against a frozen or cached status payload.
 */
export function evaluateHealthResponse(
  serviceId,
  response,
  { nowMs = Date.now(), maxAgeSeconds = DEFAULT_MAX_HEALTH_AGE_SECONDS } = {},
) {
  if (!response || response.error) {
    return {
      serviceId,
      ok: false,
      reason: `${serviceId} health probe failed: ${response?.error ?? "no response"}`,
    };
  }

  if (response.httpStatus !== 200) {
    return {
      serviceId,
      ok: false,
      reason: `${serviceId} returned HTTP ${response.httpStatus} (expected 200).`,
    };
  }

  const body = response.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      serviceId,
      ok: false,
      reason: `${serviceId} returned a malformed non-object JSON payload.`,
    };
  }

  if (body.status !== "operational") {
    return {
      serviceId,
      ok: false,
      reason: `${serviceId} status is "${body.status ?? "missing"}" (expected "operational").`,
    };
  }

  const checks = body.checks;
  if (!checks || typeof checks !== "object" || Object.keys(checks).length === 0) {
    return {
      serviceId,
      ok: false,
      reason: `${serviceId} did not report any dependency checks.`,
    };
  }

  for (const [name, check] of Object.entries(checks)) {
    const passed = typeof check === "object" && check !== null ? Boolean(check.ok) : check === true || check === "ok";
    if (!passed) {
      return {
        serviceId,
        ok: false,
        reason: `${serviceId} dependency check "${name}" is unhealthy.`,
      };
    }
  }

  const updatedAtMs = Date.parse(String(body.updatedAt ?? ""));
  if (Number.isNaN(updatedAtMs)) {
    return {
      serviceId,
      ok: false,
      reason: `${serviceId} health response is missing a valid ISO-8601 updatedAt timestamp.`,
    };
  }

  const ageSeconds = Math.max(0, Math.round((nowMs - updatedAtMs) / 1000));
  if (ageSeconds > maxAgeSeconds) {
    return {
      serviceId,
      ok: false,
      reason: `${serviceId} health payload is stale (${ageSeconds}s old > max ${maxAgeSeconds}s).`,
    };
  }

  return {
    serviceId,
    ok: true,
    ageSeconds,
    updatedAt: body.updatedAt,
  };
}

/**
 * Probes `<baseUrl>/status` with an explicit timeout.
 * Redacts the raw URL from error messages so internal hostnames/tokens never leak.
 */
export async function probeHealthEndpoint(
  serviceId,
  baseUrl,
  {
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    fetchImpl = fetch,
    nowMs = Date.now(),
    maxAgeSeconds = DEFAULT_MAX_HEALTH_AGE_SECONDS,
  } = {},
) {
  if (!baseUrl || typeof baseUrl !== "string") {
    return evaluateHealthResponse(serviceId, { error: "endpoint URL not configured" }, { nowMs, maxAgeSeconds });
  }

  const target = `${baseUrl.replace(/\/+$/, "")}/status`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(target, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return evaluateHealthResponse(
      serviceId,
      { httpStatus: res.status, body },
      { nowMs, maxAgeSeconds },
    );
  } catch (err) {
    const reason = err?.name === "AbortError" ? `request timed out after ${timeoutMs}ms` : err?.message || "network error";
    return evaluateHealthResponse(serviceId, { error: reason }, { nowMs, maxAgeSeconds });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verifies core Accord contract invariants from docs/INVARIANTS.md against a
 * snapshot of on-chain view calls (`get_owners`, `get_owner_weights`,
 * `get_threshold`, `get_total_weight`, `get_version`, `get_storage_version`).
 */
export function evaluateInvariants(state) {
  const failures = [];
  if (!state || typeof state !== "object") {
    return { ok: false, failures: ["Missing contract invariant state snapshot."] };
  }

  const owners = Array.isArray(state.owners) ? state.owners : null;
  const ownerWeights = Array.isArray(state.ownerWeights) ? state.ownerWeights : null;

  // INV-03: 1 <= owner count <= MAX_OWNERS (20)
  if (!owners || owners.length < 1 || owners.length > MAX_OWNERS) {
    failures.push(
      `INV-03 violated: owner count must be in 1..=${MAX_OWNERS} (got ${owners ? owners.length : "invalid"}).`,
    );
  } else {
    const uniqueOwners = new Set(owners);
    if (uniqueOwners.size !== owners.length) {
      failures.push("INV-03 violated: duplicate owner addresses detected.");
    }
  }

  // INV-01: total_weight == sum(owner weights), every owner weight >= 1
  if (!ownerWeights || (owners && ownerWeights.length !== owners.length)) {
    failures.push("INV-01 violated: ownerWeights missing or length does not match owners.");
  } else {
    let sumWeight = 0;
    for (const entry of ownerWeights) {
      const w = typeof entry === "number" ? entry : entry?.weight;
      if (!Number.isInteger(w) || w < 1) {
        failures.push(`INV-01 violated: every owner weight must be an integer >= 1 (got ${w}).`);
      } else {
        sumWeight += w;
      }
    }
    if (!Number.isInteger(state.totalWeight) || sumWeight !== state.totalWeight) {
      failures.push(
        `INV-01 violated: totalWeight (${state.totalWeight}) != sum(owner weights) (${sumWeight}).`,
      );
    }
  }

  // INV-02: 1 <= threshold <= total_weight
  if (
    !Number.isInteger(state.threshold) ||
    !Number.isInteger(state.totalWeight) ||
    state.threshold < 1 ||
    state.threshold > state.totalWeight
  ) {
    failures.push(
      `INV-02 violated: threshold (${state.threshold}) must satisfy 1 <= threshold <= totalWeight (${state.totalWeight}).`,
    );
  }

  // INV-08: At most MAX_ACTIVE_PROPOSALS (50) live proposals
  if (
    state.activeProposals !== undefined &&
    (!Number.isInteger(state.activeProposals) ||
      state.activeProposals < 0 ||
      state.activeProposals > MAX_ACTIVE_PROPOSALS)
  ) {
    failures.push(
      `INV-08 violated: activeProposals (${state.activeProposals}) must be in 0..=${MAX_ACTIVE_PROPOSALS}.`,
    );
  }

  // Contract & storage version sanity
  if (!Number.isInteger(state.version) || state.version < 1) {
    failures.push(`Version check failed: get_version() must be >= 1 (got ${state.version}).`);
  }
  if (!Number.isInteger(state.storageVersion) || state.storageVersion < 1) {
    failures.push(
      `Storage version check failed: get_storage_version() must be >= 1 (got ${state.storageVersion}).`,
    );
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Evaluates the complete canary promotion gate:
 *   1. Built WASM hash == deployed canary WASM hash
 *   2. Indexer & Analytics API health checks pass and are fresh
 *   3. Contract invariants (INV-01, INV-02, INV-03, INV-08, versions) hold
 */
export function evaluateCanaryGate({
  builtHash,
  deployedHash,
  healthResults = [],
  invariantState,
}) {
  const reasons = [];

  const hashCheck = verifyArtifactHash({ builtHash, deployedHash });
  if (!hashCheck.ok) reasons.push(hashCheck.reason);

  const requiredServices = ["indexer", "analytics-api"];
  for (const svc of requiredServices) {
    const found = healthResults.find((r) => r.serviceId === svc);
    if (!found) {
      reasons.push(`Missing health probe result for required service "${svc}".`);
    } else if (!found.ok) {
      reasons.push(found.reason);
    }
  }

  const invariantCheck = evaluateInvariants(invariantState);
  if (!invariantCheck.ok) {
    reasons.push(...invariantCheck.failures);
  }

  return {
    passed: reasons.length === 0,
    checkedAt: new Date().toISOString(),
    wasmHash: hashCheck.ok ? hashCheck.wasmHash : null,
    health: healthResults,
    invariants: invariantCheck,
    reasons,
  };
}

/**
 * Selects the most recent verified previous WASM artifact for manual in-place rollback.
 * Accord supports in-place `upgrade(approvers, new_wasm_hash)` (state & contract ID preserved).
 * Never auto-executes rollback; generates an unsigned plan for HSM/MPC owner co-signing.
 */
export function selectRollbackArtifact(
  releaseHistory,
  { failedHash, contractId, network = "mainnet" } = {},
) {
  if (!Array.isArray(releaseHistory) || releaseHistory.length === 0) {
    throw new Error("Release history is empty; cannot select a previous artifact for rollback.");
  }
  const normalizedFailed = String(failedHash ?? "").trim().toLowerCase();
  if (!HEX_64_RE.test(normalizedFailed)) {
    throw new Error("Invalid failedHash: expected a 64-character hex SHA-256 WASM hash.");
  }

  const candidate = releaseHistory.find((entry) => {
    const hash = String(entry?.wasm_hash ?? "").trim().toLowerCase();
    return (
      entry &&
      entry.status === "verified" &&
      HEX_64_RE.test(hash) &&
      hash !== normalizedFailed
    );
  });

  if (!candidate) {
    throw new Error(
      "No verified previous WASM artifact found in release history that differs from the failed hash.",
    );
  }

  const targetHash = candidate.wasm_hash.trim().toLowerCase();
  const targetContract = contractId || "<CONTRACT_ID>";

  return {
    mode: "manual-in-place-upgrade-rollback",
    network,
    contractId: targetContract,
    failedWasmHash: normalizedFailed,
    rollbackTarget: {
      tag: candidate.tag ?? "unknown",
      commitSha: candidate.commit_sha ?? "unknown",
      wasmHash: targetHash,
    },
    notes: [
      "Accord supports in-place WASM rollback via upgrade(approvers, new_wasm_hash); state and contract ID are preserved.",
      "If the flawed release altered persistent storage schema, STOP and follow docs/runbooks/UPGRADE_ROLLBACK.md Step 4.2 before reverting.",
      "Signing must be performed out-of-band by multisig owners using HSM/MPC signers (see docs/OPERATIONS.md).",
    ],
    commands: {
      optionalFreeze: `stellar contract invoke --network ${network} --source-account <GUARDIAN_IDENTITY> --id ${targetContract} -- freeze --guardian <GUARDIAN_ADDRESS>`,
      ensureWasmUploaded: `stellar contract upload --network ${network} --source-account <FEE_PAYER> --wasm <RETAINED_PREVIOUS_WASM>`,
      buildUnsignedRollback: `stellar contract invoke --build-only --network ${network} --source-account <FEE_PAYER> --id ${targetContract} -- upgrade --approvers '["<OWNER_1>","<OWNER_2>"]' --new_wasm_hash ${targetHash}`,
    },
  };
}

function parseFlags(args) {
  const flags = {};
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) flags[arg.slice(2)] = true;
    else flags[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return flags;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  if (command === "gate") {
    const maxAgeSeconds = Number(flags["max-age-seconds"] ?? DEFAULT_MAX_HEALTH_AGE_SECONDS);
    let healthResults;
    let invariantState;

    if (flags["dry-run"]) {
      const nowIso = new Date().toISOString();
      healthResults = [
        evaluateHealthResponse("indexer", {
          httpStatus: 200,
          body: { status: "operational", checks: { store: { ok: true }, indexing: { ok: true } }, updatedAt: nowIso },
        }),
        evaluateHealthResponse("analytics-api", {
          httpStatus: 200,
          body: { status: "operational", checks: { database: { ok: true } }, updatedAt: nowIso },
        }),
      ];
      invariantState = {
        owners: ["GDRYRUN1", "GDRYRUN2", "GDRYRUN3"],
        ownerWeights: [1, 1, 1],
        totalWeight: 3,
        threshold: 2,
        activeProposals: 0,
        version: 1,
        storageVersion: 1,
      };
    } else {
      const indexerUrl = flags["indexer-url"] || process.env.CANARY_INDEXER_STATUS_URL || "";
      const apiUrl = flags["api-url"] || process.env.CANARY_ANALYTICS_API_STATUS_URL || "";
      healthResults = await Promise.all([
        probeHealthEndpoint("indexer", indexerUrl, { maxAgeSeconds }),
        probeHealthEndpoint("analytics-api", apiUrl, { maxAgeSeconds }),
      ]);
      if (!flags["invariants-file"]) {
        throw new Error("--invariants-file is required outside --dry-run mode.");
      }
      invariantState = JSON.parse(fs.readFileSync(flags["invariants-file"], "utf8"));
    }

    const report = evaluateCanaryGate({
      builtHash: flags["built-hash"],
      deployedHash: flags["deployed-hash"],
      healthResults,
      invariantState,
    });
    report.dryRun = Boolean(flags["dry-run"]);

    if (flags.out) {
      fs.mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
      fs.writeFileSync(flags.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exit(1);
    return;
  }

  if (command === "rollback-plan") {
    if (!flags.history || !flags["failed-hash"]) {
      throw new Error("Usage: rollback-plan --history=<path> --failed-hash=<64-hex> [--contract-id=C...] [--network=mainnet]");
    }
    const history = JSON.parse(fs.readFileSync(flags.history, "utf8"));
    const plan = selectRollbackArtifact(history, {
      failedHash: flags["failed-hash"],
      contractId: flags["contract-id"],
      network: flags.network || "mainnet",
    });
    if (flags.out) {
      fs.mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
      fs.writeFileSync(flags.out, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    }
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  throw new Error("Unknown command. Use `gate` or `rollback-plan`.");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`Canary release gate error: ${err.message}`);
    process.exit(1);
  });
}
