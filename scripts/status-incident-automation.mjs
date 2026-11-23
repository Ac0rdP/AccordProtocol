#!/usr/bin/env node

/**
 * status-incident-automation.mjs — Automated status-page incident lifecycle
 * management driven by Indexer and Analytics API health checks.
 *
 * Features:
 *   - Treats `indexer` and `analytics-api` as independent components.
 *   - Retries transient probe failures before counting a failure (guards against runner hiccups).
 *   - Requires `failureThreshold` (default 3) consecutive failures before opening an incident.
 *   - Requires `recoveryThreshold` (default 2) consecutive healthy checks before resolving.
 *   - Looks up open incidents by a stable `automationMarker` (`accord-auto:<componentId>`)
 *     so repeated runs never create duplicate incidents.
 *   - Supports the built-in repo status page (`docs/status/incidents.json`) and a clearly
 *     marked external provider adapter boundary that fails loudly when unconfigured.
 *   - Never prints raw health URLs, API tokens, or credentials to stdout/stderr.
 *
 * Usage:
 *   node scripts/status-incident-automation.mjs run [--dry-run] [--provider=repo-status-page|external] [--out=report.json]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_FAILURE_THRESHOLD = 3;
export const DEFAULT_RECOVERY_THRESHOLD = 2;
export const DEFAULT_PROBE_RETRIES = 2;
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
export const DEFAULT_RETRY_DELAY_MS = 500;

export const COMPONENTS = [
  {
    id: "indexer",
    name: "Indexer",
    urlEnv: "INDEXER_STATUS_URL",
    impact: "On-chain event indexing may be delayed or unavailable.",
  },
  {
    id: "analytics-api",
    name: "Analytics API",
    urlEnv: "ANALYTICS_API_STATUS_URL",
    impact: "Treasury analytics and proposal metrics endpoints may be degraded or unavailable.",
  },
];

export function automationMarkerFor(componentId) {
  return `accord-auto:${componentId}`;
}

/**
 * Evaluates a single HTTP `/status` response for a component.
 * Never embeds URLs or credentials in returned detail strings.
 */
export function classifyHealthResponse(componentId, { httpStatus = 0, body = null, error = null } = {}) {
  if (error) {
    return {
      componentId,
      healthy: false,
      severity: "outage",
      reason: `Health check failed (${error}).`,
    };
  }

  if (httpStatus !== 200) {
    return {
      componentId,
      healthy: false,
      severity: httpStatus >= 500 || httpStatus === 0 ? "outage" : "degraded",
      reason: `Health endpoint returned HTTP ${httpStatus}.`,
    };
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      componentId,
      healthy: false,
      severity: "outage",
      reason: "Health endpoint returned malformed JSON (expected object).",
    };
  }

  if (body.status === "operational") {
    const checks = body.checks && typeof body.checks === "object" ? Object.entries(body.checks) : [];
    const failingCheck = checks.find(([, v]) => {
      if (v && typeof v === "object") return !v.ok;
      return v !== true && v !== "ok";
    });
    if (failingCheck) {
      return {
        componentId,
        healthy: false,
        severity: "degraded",
        reason: `Dependency check "${failingCheck[0]}" reported unhealthy.`,
      };
    }
    return {
      componentId,
      healthy: true,
      severity: "operational",
      reason: "All health checks operational.",
    };
  }

  if (body.status === "degraded" || body.status === "outage") {
    return {
      componentId,
      healthy: false,
      severity: body.status,
      reason: `Service reported status "${body.status}".`,
    };
  }

  return {
    componentId,
    healthy: false,
    severity: "outage",
    reason: `Unrecognized health status "${String(body.status ?? "missing")}".`,
  };
}

/**
 * Probes `<baseUrl>/status` with timeout and retry support to avoid false positives
 * from transient runner-side network glitches. Redacts URLs from all error output.
 */
export async function probeComponentWithRetry(
  component,
  baseUrl,
  {
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    retries = DEFAULT_PROBE_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    fetchImpl = fetch,
  } = {},
) {
  if (!baseUrl || typeof baseUrl !== "string") {
    throw new Error(`Missing configured health URL for component "${component.id}" (${component.urlEnv}).`);
  }

  const target = `${baseUrl.replace(/\/+$/, "")}/status`;
  let lastResult = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
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
      lastResult = classifyHealthResponse(component.id, { httpStatus: res.status, body });
    } catch (err) {
      const reason =
        err?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : "network error";
      lastResult = classifyHealthResponse(component.id, { error: reason });
    } finally {
      clearTimeout(timer);
    }

    if (lastResult.healthy) {
      return { ...lastResult, attempts: attempt + 1 };
    }
    if (attempt < retries && retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  return { ...lastResult, attempts: retries + 1 };
}

/**
 * Finds an open automated incident for a component using its stable marker.
 */
export function findOpenAutomatedIncident(incidents, componentId) {
  const marker = automationMarkerFor(componentId);
  return (
    incidents.find(
      (inc) =>
        inc &&
        inc.status !== "resolved" &&
        (inc.automationMarker === marker ||
          (inc.service === componentId && String(inc.id ?? "").includes(marker))),
    ) ?? null
  );
}

/**
 * Pure state-machine decision function for a single component.
 *
 * Returns:
 *   {
 *     componentId,
 *     action: "noop" | "pending" | "open" | "update" | "recovering" | "resolve",
 *     nextState: { consecutiveFailures, consecutiveSuccesses, lastCheckedAt, lastHealthy },
 *     incidentId: string | null,
 *     reason: string,
 *   }
 */
export function decideIncidentTransition({
  component,
  probeResult,
  componentState = {},
  openIncident = null,
  failureThreshold = DEFAULT_FAILURE_THRESHOLD,
  recoveryThreshold = DEFAULT_RECOVERY_THRESHOLD,
  nowIso = new Date().toISOString(),
}) {
  const prevFailures = Number(componentState.consecutiveFailures ?? 0);
  const prevSuccesses = Number(componentState.consecutiveSuccesses ?? 0);

  if (probeResult.healthy) {
    const consecutiveSuccesses = prevSuccesses + 1;
    const nextState = {
      consecutiveFailures: 0,
      consecutiveSuccesses,
      lastCheckedAt: nowIso,
      lastHealthy: true,
    };

    if (!openIncident) {
      return {
        componentId: component.id,
        action: "noop",
        nextState,
        incidentId: null,
        reason: "Component is healthy and no automated incident is open.",
      };
    }

    if (consecutiveSuccesses >= recoveryThreshold) {
      return {
        componentId: component.id,
        action: "resolve",
        nextState,
        incidentId: openIncident.id,
        reason: `Component recovered for ${consecutiveSuccesses}/${recoveryThreshold} consecutive checks.`,
      };
    }

    return {
      componentId: component.id,
      action: "recovering",
      nextState,
      incidentId: openIncident.id,
      reason: `Component healthy (${consecutiveSuccesses}/${recoveryThreshold} before resolving).`,
    };
  }

  // Unhealthy probe
  const consecutiveFailures = prevFailures + 1;
  const nextState = {
    consecutiveFailures,
    consecutiveSuccesses: 0,
    lastCheckedAt: nowIso,
    lastHealthy: false,
  };

  if (openIncident) {
    return {
      componentId: component.id,
      action: "update",
      nextState,
      incidentId: openIncident.id,
      reason: `Component still unhealthy (${probeResult.reason}); updating existing incident.`,
    };
  }

  if (consecutiveFailures >= failureThreshold) {
    const datePrefix = nowIso.slice(0, 10);
    const incidentId = `${datePrefix}-${automationMarkerFor(component.id)}`;
    return {
      componentId: component.id,
      action: "open",
      nextState,
      incidentId,
      reason: `Failure threshold reached (${consecutiveFailures}/${failureThreshold}): ${probeResult.reason}`,
    };
  }

  return {
    componentId: component.id,
    action: "pending",
    nextState,
    incidentId: null,
    reason: `Failure ${consecutiveFailures}/${failureThreshold} (${probeResult.reason}); waiting before opening incident.`,
  };
}

/**
 * Applies a decision to the repository's `docs/status/incidents.json` structure
 * (matching docs/STATUS.md schema) without mutating the input array.
 */
export function applyDecisionToIncidents(incidents, { component, decision, probeResult, nowIso }) {
  const next = incidents.map((inc) => ({
    ...inc,
    updates: Array.isArray(inc.updates) ? [...inc.updates] : [],
  }));

  if (decision.action === "open") {
    next.unshift({
      id: decision.incidentId,
      automationMarker: automationMarkerFor(component.id),
      service: component.id,
      title: `${component.name} health check ${probeResult.severity === "outage" ? "outage" : "degradation"}`,
      status: "investigating",
      startedAt: nowIso,
      resolvedAt: null,
      impact: component.impact,
      updates: [
        {
          at: nowIso,
          status: "investigating",
          note: `Automated health monitor opened incident: ${probeResult.reason}`,
        },
      ],
    });
    return { incidents: next, changed: true };
  }

  if (decision.action === "update") {
    const target = next.find((inc) => inc.id === decision.incidentId);
    if (target) {
      target.updates.push({
        at: nowIso,
        status: target.status || "investigating",
        note: `Automated health monitor: issue persists (${probeResult.reason}).`,
      });
      return { incidents: next, changed: true };
    }
  }

  if (decision.action === "resolve") {
    const target = next.find((inc) => inc.id === decision.incidentId);
    if (target) {
      target.status = "resolved";
      target.resolvedAt = nowIso;
      target.updates.push({
        at: nowIso,
        status: "resolved",
        note: `Automated health monitor resolved incident: ${decision.reason}`,
      });
      return { incidents: next, changed: true };
    }
  }

  return { incidents: next, changed: false };
}

/**
 * External status-page provider adapter boundary.
 * No third-party provider is configured in this repository; fails loudly unless
 * explicitly implemented and configured so we never guess or silently no-op.
 */
export function createExternalProviderAdapter({ providerName, apiToken, pageId } = {}) {
  return {
    name: providerName || "unconfigured-external",
    async apply(_decision) {
      if (!providerName || !apiToken || !pageId) {
        throw new Error(
          `External status-page provider adapter is not configured (missing STATUS_PAGE_PROVIDER, STATUS_PAGE_API_TOKEN, or STATUS_PAGE_ID). Configure a provider adapter or use --provider=repo-status-page.`,
        );
      }
      throw new Error(
        `No API adapter is implemented for external provider "${providerName}". Implement the provider client before disabling --dry-run.`,
      );
    },
  };
}

/**
 * Runs a full evaluation cycle across all components against an incident list and state store.
 */
export function evaluateAllComponents({
  components = COMPONENTS,
  probeResultsByComponent,
  incidents = [],
  state = { version: 1, components: {} },
  failureThreshold = DEFAULT_FAILURE_THRESHOLD,
  recoveryThreshold = DEFAULT_RECOVERY_THRESHOLD,
  nowIso = new Date().toISOString(),
}) {
  let currentIncidents = incidents;
  let anyIncidentChanged = false;
  const nextState = {
    version: 1,
    updatedAt: nowIso,
    components: { ...(state.components ?? {}) },
  };
  const decisions = [];

  for (const component of components) {
    const probeResult = probeResultsByComponent[component.id];
    if (!probeResult) {
      throw new Error(`Missing probe result for component "${component.id}".`);
    }
    const openIncident = findOpenAutomatedIncident(currentIncidents, component.id);
    const decision = decideIncidentTransition({
      component,
      probeResult,
      componentState: nextState.components[component.id] ?? {},
      openIncident,
      failureThreshold,
      recoveryThreshold,
      nowIso,
    });
    nextState.components[component.id] = decision.nextState;
    decisions.push(decision);

    const applied = applyDecisionToIncidents(currentIncidents, {
      component,
      decision,
      probeResult,
      nowIso,
    });
    currentIncidents = applied.incidents;
    if (applied.changed) anyIncidentChanged = true;
  }

  return {
    decisions,
    incidents: currentIncidents,
    incidentsChanged: anyIncidentChanged,
    nextState,
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
  if (command !== "run") {
    throw new Error("Usage: node scripts/status-incident-automation.mjs run [--dry-run] [--provider=repo-status-page|external] [--out=report.json]");
  }

  const flags = parseFlags(rest);
  const dryRun = Boolean(flags["dry-run"]) || process.env.DRY_RUN === "true";
  const provider = flags.provider || process.env.STATUS_PAGE_PROVIDER || "repo-status-page";
  const outDir = flags["out-dir"] || "docs/status";
  const failureThreshold = Number(process.env.INCIDENT_FAILURE_THRESHOLD || DEFAULT_FAILURE_THRESHOLD);
  const recoveryThreshold = Number(process.env.INCIDENT_RECOVERY_THRESHOLD || DEFAULT_RECOVERY_THRESHOLD);

  const incidentsPath = path.join(outDir, "incidents.json");
  const statePath = path.join(outDir, "incident-automation-state.json");

  const incidentsDoc = fs.existsSync(incidentsPath)
    ? JSON.parse(fs.readFileSync(incidentsPath, "utf8"))
    : { version: 1, incidents: [] };
  const stateDoc = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, "utf8"))
    : { version: 1, components: {} };

  const probeResultsByComponent = {};
  if (dryRun) {
    for (const component of COMPONENTS) {
      probeResultsByComponent[component.id] = classifyHealthResponse(component.id, {
        httpStatus: 200,
        body: { status: "operational", checks: { primary: { ok: true } } },
      });
    }
  } else {
    for (const component of COMPONENTS) {
      const url = process.env[component.urlEnv];
      probeResultsByComponent[component.id] = await probeComponentWithRetry(component, url);
    }
  }

  const nowIso = new Date().toISOString();
  const result = evaluateAllComponents({
    components: COMPONENTS,
    probeResultsByComponent,
    incidents: incidentsDoc.incidents ?? [],
    state: stateDoc,
    failureThreshold,
    recoveryThreshold,
    nowIso,
  });

  if (provider !== "repo-status-page") {
    const adapter = createExternalProviderAdapter({
      providerName: provider === "external" ? "" : provider,
      apiToken: process.env.STATUS_PAGE_API_TOKEN,
      pageId: process.env.STATUS_PAGE_ID,
    });
    if (!dryRun) {
      for (const d of result.decisions) {
        if (d.action === "open" || d.action === "update" || d.action === "resolve") {
          await adapter.apply(d);
        }
      }
    }
  } else if (!dryRun) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(result.nextState, null, 2)}\n`, "utf8");
    if (result.incidentsChanged) {
      fs.writeFileSync(
        incidentsPath,
        `${JSON.stringify({ version: 1, incidents: result.incidents }, null, 2)}\n`,
        "utf8",
      );
    }
  }

  const report = {
    dryRun,
    provider,
    evaluatedAt: nowIso,
    incidentsChanged: result.incidentsChanged,
    decisions: result.decisions,
  };

  if (flags.out) {
    fs.mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
    fs.writeFileSync(flags.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(report, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`Status incident automation error: ${err.message}`);
    process.exit(1);
  });
}
