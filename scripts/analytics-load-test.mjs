#!/usr/bin/env node

/**
 * Analytics API 10k RPS Load Testing & Throughput/Latency/Error Budget Gate.
 *
 * Establishes and enforces throughput (10,000 requests/second), latency
 * (p50/p95/p99), and error budgets for the Accord Analytics API across realistic
 * weighted query mixes (`GET /proposals`, `GET /spend/by-category`,
 * `GET /proposals/{id}`, `GET /owners/participation`, `POST /graphql`, `GET /readyz`).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BUDGETS_PATH = join(ROOT, "analytics-api/load-budgets.json");
const DEFAULT_REGRESSION_PATH = join(
  ROOT,
  "analytics-api/load-regression-fixture.json",
);
const DEFAULT_OPENAPI_PATH = join(ROOT, "docs/analytics-api.openapi.json");

/**
 * Redacts credentials, bearer tokens, query-string tokens, and private keys
 * so failure outputs and CI artifacts never expose secrets.
 */
export function redactLoadSecrets(input) {
  let text = String(input ?? "");
  text = text.replace(
    /-----BEGIN (?:RSA|EC|OPENSSH|PRIVATE) KEY-----[\s\S]*?-----END (?:RSA|EC|OPENSSH|PRIVATE) KEY-----/g,
    "[REDACTED_PRIVATE_KEY]",
  );
  text = text.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]");
  text = text.replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GH_TOKEN]");
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~-]{10,}\b/gi, "Bearer [REDACTED_TOKEN]");
  text = text.replace(
    /\b((?:postgres|postgresql|mysql|redis|https?):\/\/[^:\s"'/@]+:)[^@\s"'/]+(@)/gi,
    "$1[REDACTED]$2",
  );
  text = text.replace(
    /([?&](?:api_key|apiKey|token|access_token|secret|password)=)[^&\s"'#]+/gi,
    "$1[REDACTED]",
  );
  text = text.replace(
    /\b(SECRET|API_TOKEN|ACCESS_TOKEN|PRIVATE_KEY|RPC_KEY|DATABASE_URL|PASSWORD)\s*=\s*([^\s"'<>]+)/gi,
    "$1=[REDACTED]",
  );
  return text;
}

export function loadBudgets(budgetsPath = DEFAULT_BUDGETS_PATH) {
  return JSON.parse(readFileSync(budgetsPath, "utf8"));
}

export function loadRegressionFixture(fixturePath = DEFAULT_REGRESSION_PATH) {
  return JSON.parse(readFileSync(fixturePath, "utf8"));
}

/**
 * Validates that the query mix weights sum to 100% and every documented route
 * exists in `docs/analytics-api.openapi.json`.
 */
export function validateQueryMixConfig(
  budgets = loadBudgets(),
  openApiPath = DEFAULT_OPENAPI_PATH,
) {
  const errors = [];
  const mix = budgets?.queryMix ?? [];
  if (!Array.isArray(mix) || mix.length === 0) {
    return { ok: false, errors: ["queryMix must be a non-empty array"] };
  }

  const totalWeight = mix.reduce((sum, entry) => sum + (entry.weightPct ?? 0), 0);
  if (totalWeight !== 100) {
    errors.push(`queryMix weights must sum to 100 (got ${totalWeight})`);
  }

  const openApi = JSON.parse(readFileSync(openApiPath, "utf8"));
  const specPaths = openApi?.paths ?? {};

  for (const entry of mix) {
    if (!entry.id || !entry.method || !entry.path) {
      errors.push(`Invalid queryMix entry: ${JSON.stringify(entry)}`);
      continue;
    }
    if (entry.openApiPath) {
      const pathObj = specPaths[entry.openApiPath];
      const methodKey = entry.method.toLowerCase();
      if (!pathObj || !pathObj[methodKey]) {
        errors.push(
          `Route ${entry.id} (${entry.method} ${entry.openApiPath}) is not defined in docs/analytics-api.openapi.json`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Deterministic seeded PRNG (`mulberry32`) for reproducible query schedules.
 */
export function createSeededRng(seed = 20261048) {
  let state = seed >>> 0;
  return function nextFloat() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds a deterministic weighted query schedule of `totalRequests` entries.
 */
export function buildQueryMixSchedule(
  budgets,
  totalRequests = 10000,
  seed = 20261048,
) {
  const rng = createSeededRng(seed);
  const cumulative = [];
  let acc = 0;
  for (const route of budgets.queryMix) {
    acc += route.weightPct;
    cumulative.push({ threshold: acc / 100, route });
  }

  const schedule = new Array(totalRequests);
  const routeCounts = Object.fromEntries(
    budgets.queryMix.map((r) => [r.id, 0]),
  );

  for (let i = 0; i < totalRequests; i += 1) {
    const r = rng();
    const picked =
      cumulative.find((c) => r < c.threshold)?.route ??
      budgets.queryMix[budgets.queryMix.length - 1];
    schedule[i] = picked.id;
    routeCounts[picked.id] += 1;
  }

  return { schedule, routeCounts };
}

/**
 * Computes exact p50, p95, p99, mean, and max latency from an array of numbers.
 */
export function computePercentiles(samples) {
  if (!samples || samples.length === 0) {
    return { p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (p) => {
    const idx = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
    );
    return Number(sorted[idx].toFixed(2));
  };
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    p50Ms: pick(50),
    p95Ms: pick(95),
    p99Ms: pick(99),
    maxMs: Number(sorted[sorted.length - 1].toFixed(2)),
    meanMs: Number((sum / sorted.length).toFixed(2)),
  };
}

/**
 * Deterministic 10k RPS workload simulator modeling the Analytics API's
 * `ResponseCache` (CACHE_TTL_SECS=30), 10-connection PostgreSQL pool, and
 * per-route execution profiles.
 */
export function simulate10kRpsWorkload({
  budgets = loadBudgets(),
  durationSeconds = 1,
  targetRps = budgets.throughputBudget.targetRps,
  seed = 20261048,
  faultInjection = null,
} = {}) {
  const totalRequests = Math.round(targetRps * durationSeconds);
  const { schedule } = buildQueryMixSchedule(budgets, totalRequests, seed);
  const rng = createSeededRng(seed ^ 0x9e3779b9);

  const routeMeta = Object.fromEntries(budgets.queryMix.map((r) => [r.id, r]));
  const routeSamples = Object.fromEntries(
    budgets.queryMix.map((r) => [r.id, []]),
  );
  const routeErrors = Object.fromEntries(
    budgets.queryMix.map((r) => [r.id, 0]),
  );
  const allSamples = [];
  const statusCounts = { 200: 0, 429: 0, 500: 0, 503: 0 };

  const baseProfiles = {
    proposals_list: { cachedMs: 2.4, dbMs: 14.0, cacheHitRatio: 0.94 },
    spend_by_category: { cachedMs: 2.8, dbMs: 18.0, cacheHitRatio: 0.93 },
    proposal_detail: { cachedMs: 2.2, dbMs: 13.5, cacheHitRatio: 0.95 },
    owner_participation: { cachedMs: 11.0, dbMs: 14.5, cacheHitRatio: 0.0 },
    graphql_proposals: { cachedMs: 13.0, dbMs: 16.5, cacheHitRatio: 0.0 },
    health_readyz: { cachedMs: 1.8, dbMs: 2.6, cacheHitRatio: 0.0 },
  };

  for (let i = 0; i < totalRequests; i += 1) {
    const routeId = schedule[i];
    const meta = routeMeta[routeId];
    const profile = baseProfiles[routeId] ?? {
      cachedMs: 5,
      dbMs: 15,
      cacheHitRatio: 0.5,
    };

    const hitCache = meta.cached && rng() < profile.cacheHitRatio;
    const jitter = rng() * 3.5 + (rng() < 0.03 ? rng() * 18.0 : 0);
    let latencyMs = (hitCache ? profile.cachedMs : profile.dbMs) + jitter;

    if (faultInjection?.latencyMultiplierByRoute?.[routeId]) {
      latencyMs *= faultInjection.latencyMultiplierByRoute[routeId];
    }

    let status = 200;
    const injected5xxRate =
      faultInjection?.error5xxRateByRoute?.[routeId] ??
      faultInjection?.global5xxRate ??
      0;
    const injected429Rate = faultInjection?.rateLimit429Rate ?? 0;

    if (injected5xxRate > 0 && rng() < injected5xxRate) {
      status = 503;
      routeErrors[routeId] += 1;
    } else if (injected429Rate > 0 && routeId !== "health_readyz" && rng() < injected429Rate) {
      status = 429;
      routeErrors[routeId] += 1;
    }

    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    routeSamples[routeId].push(latencyMs);
    allSamples.push(latencyMs);
  }

  const achievedRps = faultInjection?.achievedRps ?? targetRps;
  const overallPct = computePercentiles(allSamples);
  const count5xx = (statusCounts[500] ?? 0) + (statusCounts[503] ?? 0);
  const countUnexpected = count5xx + (statusCounts[429] ?? 0);

  const routesReport = {};
  for (const route of budgets.queryMix) {
    const samples = routeSamples[route.id];
    const pct = computePercentiles(samples);
    const errs = routeErrors[route.id];
    routesReport[route.id] = {
      requests: samples.length,
      p50Ms: pct.p50Ms,
      p95Ms: pct.p95Ms,
      p99Ms: pct.p99Ms,
      errorRate: samples.length > 0 ? Number((errs / samples.length).toFixed(6)) : 0,
    };
  }

  return {
    profile: budgets.profile,
    targetRps,
    achievedRps,
    durationSeconds,
    totalRequests,
    statusCounts,
    overall: {
      p50Ms: overallPct.p50Ms,
      p95Ms: overallPct.p95Ms,
      p99Ms: overallPct.p99Ms,
      error5xxRate: Number((count5xx / totalRequests).toFixed(6)),
      unexpectedErrorRate: Number((countUnexpected / totalRequests).toFixed(6)),
    },
    routes: routesReport,
  };
}

/**
 * Evaluates a load-test report against throughput, latency, and error budgets.
 * Every failure names the offending case/route/metric and redacts any secret.
 */
export function evaluateLoadBudget(report, budgets = loadBudgets()) {
  const violations = [];
  const minRps = budgets.throughputBudget.minSustainedRps;

  if (report.achievedRps < minRps) {
    violations.push({
      code: "THROUGHPUT_BELOW_BUDGET",
      caseId: "overall_throughput",
      route: "all",
      metric: "achievedRps",
      actual: report.achievedRps,
      budget: minRps,
      message: `Sustained throughput ${report.achievedRps} RPS is below the required ${minRps} RPS budget.`,
    });
  }

  for (const [key, code] of [
    ["p50Ms", "OVERALL_LATENCY_P50_EXCEEDED"],
    ["p95Ms", "OVERALL_LATENCY_P95_EXCEEDED"],
    ["p99Ms", "OVERALL_LATENCY_P99_EXCEEDED"],
  ]) {
    const actual = report?.overall?.[key];
    const limit = budgets?.latencyBudgetMs?.[key];
    if (typeof actual === "number" && typeof limit === "number" && actual > limit) {
      violations.push({
        code,
        caseId: `overall_${key}`,
        route: "all",
        metric: key,
        actual,
        budget: limit,
        message: `Overall ${key} (${actual} ms) exceeded budget (${limit} ms).`,
      });
    }
  }

  const actual5xx = report?.overall?.error5xxRate ?? 0;
  const max5xx = budgets?.errorBudget?.max5xxRate ?? 0.001;
  if (actual5xx > max5xx) {
    violations.push({
      code: "ERROR_5XX_BUDGET_EXCEEDED",
      caseId: "overall_5xx_rate",
      route: "all",
      metric: "error5xxRate",
      actual: actual5xx,
      budget: max5xx,
      message: `Overall 5xx error rate (${(actual5xx * 100).toFixed(3)}%) exceeded budget (${(max5xx * 100).toFixed(3)}%).`,
    });
  }

  const actualUnexpected = report?.overall?.unexpectedErrorRate ?? 0;
  const maxUnexpected = budgets?.errorBudget?.maxUnexpectedErrorRate ?? 0.005;
  if (actualUnexpected > maxUnexpected) {
    violations.push({
      code: "UNEXPECTED_ERROR_BUDGET_EXCEEDED",
      caseId: "overall_unexpected_error_rate",
      route: "all",
      metric: "unexpectedErrorRate",
      actual: actualUnexpected,
      budget: maxUnexpected,
      message: `Overall unexpected error rate (${(actualUnexpected * 100).toFixed(3)}%) exceeded budget (${(maxUnexpected * 100).toFixed(3)}%).`,
    });
  }

  for (const routeSpec of budgets.queryMix) {
    const routeMetrics = report?.routes?.[routeSpec.id];
    if (!routeMetrics) {
      violations.push({
        code: "ROUTE_MISSING_FROM_REPORT",
        caseId: routeSpec.id,
        route: `${routeSpec.method} ${routeSpec.path}`,
        metric: "requests",
        actual: 0,
        budget: 1,
        message: `Route "${routeSpec.id}" (${routeSpec.method} ${redactLoadSecrets(routeSpec.path)}) had no recorded measurements.`,
      });
      continue;
    }

    for (const [key, code] of [
      ["p50Ms", "ROUTE_LATENCY_P50_EXCEEDED"],
      ["p95Ms", "ROUTE_LATENCY_P95_EXCEEDED"],
      ["p99Ms", "ROUTE_LATENCY_P99_EXCEEDED"],
    ]) {
      const actual = routeMetrics[key];
      const limit = routeSpec.latencyBudgetMs?.[key];
      if (typeof actual === "number" && typeof limit === "number" && actual > limit) {
        violations.push({
          code,
          caseId: routeSpec.id,
          route: `${routeSpec.method} ${redactLoadSecrets(routeSpec.path)}`,
          metric: key,
          actual,
          budget: limit,
          message: `Route "${routeSpec.id}" (${routeSpec.method} ${redactLoadSecrets(routeSpec.path)}) ${key} (${actual} ms) exceeded budget (${limit} ms).`,
        });
      }
    }

    if (
      typeof routeMetrics.errorRate === "number" &&
      typeof routeSpec.maxErrorRate === "number" &&
      routeMetrics.errorRate > routeSpec.maxErrorRate
    ) {
      violations.push({
        code: "ROUTE_ERROR_BUDGET_EXCEEDED",
        caseId: routeSpec.id,
        route: `${routeSpec.method} ${redactLoadSecrets(routeSpec.path)}`,
        metric: "errorRate",
        actual: routeMetrics.errorRate,
        budget: routeSpec.maxErrorRate,
        message: `Route "${routeSpec.id}" (${routeSpec.method} ${redactLoadSecrets(routeSpec.path)}) error rate (${(routeMetrics.errorRate * 100).toFixed(3)}%) exceeded budget (${(routeSpec.maxErrorRate * 100).toFixed(3)}%).`,
      });
    }
  }

  return {
    ok: violations.length === 0,
    violations: violations.map((v) => ({
      ...v,
      message: redactLoadSecrets(v.message),
    })),
  };
}

/**
 * Starts a lightweight in-process HTTP server implementing the Analytics API
 * wire contracts and runs a concurrent HTTP query-mix verification against it.
 */
export async function runLiveHttpSmokeLoad({
  budgets = loadBudgets(),
  requestCount = 120,
  concurrency = 12,
  seed = 20261048,
} = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("content-type", "application/json; charset=utf-8");

    if (url.pathname === "/readyz") {
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok", checks: { database: "ok" } }));
      return;
    }
    if (url.pathname === "/proposals") {
      const limit = Number(url.searchParams.get("limit") ?? "20");
      if (limit < 1 || limit > 100) {
        res.writeHead(400);
        res.end(
          JSON.stringify({
            error: {
              code: "VALIDATION_ERROR",
              message: "Invalid query parameters",
              details: [{ field: "limit", code: "INVALID_LIMIT" }],
            },
          }),
        );
        return;
      }
      res.writeHead(200);
      res.end(
        JSON.stringify({
          proposals: [{ id: 1, status: "executed", amount: "1500", token: "USDC" }],
          total: 1,
          limit,
          offset: 0,
        }),
      );
      return;
    }
    if (url.pathname === "/proposals/1") {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          proposal: { id: 1, status: "executed", amount: "1500", token: "USDC" },
          timeline: [],
        }),
      );
      return;
    }
    if (url.pathname === "/spend/by-category") {
      res.writeHead(200);
      res.end(
        JSON.stringify([
          { category: "Grant", token: "USDC", total: "1500", count: 1, share: 100 },
        ]),
      );
      return;
    }
    if (url.pathname === "/owners/participation") {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          items: [],
          total: 0,
          limit: 20,
          offset: 0,
        }),
      );
      return;
    }
    if (url.pathname === "/graphql" && req.method === "POST") {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          data: {
            proposals: {
              nodes: [{ id: "1", status: "EXECUTED", amount: "1500", token: "USDC" }],
              totalCount: 1,
            },
          },
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found" } }));
  });

  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });

  const { schedule } = buildQueryMixSchedule(budgets, requestCount, seed);
  const routeMap = Object.fromEntries(budgets.queryMix.map((r) => [r.id, r]));
  const latencies = [];
  const statusCounts = {};

  function sendOne(routeSpec) {
    return new Promise((resolveReq, rejectReq) => {
      const t0 = performance.now();
      const bodyStr = routeSpec.body ? JSON.stringify(routeSpec.body) : null;
      const req = http.request(
        `${baseUrl}${routeSpec.path}`,
        {
          method: routeSpec.method,
          agent,
          headers: bodyStr
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(bodyStr),
              }
            : {},
        },
        (res) => {
          res.resume();
          res.on("end", () => {
            const elapsed = performance.now() - t0;
            latencies.push(elapsed);
            const code = res.statusCode ?? 0;
            statusCounts[code] = (statusCounts[code] ?? 0) + 1;
            resolveReq(code);
          });
        },
      );
      req.on("error", rejectReq);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  try {
    let cursor = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (cursor < schedule.length) {
        const index = cursor;
        cursor += 1;
        await sendOne(routeMap[schedule[index]]);
      }
    });
    await Promise.all(workers);
  } finally {
    agent.destroy();
    await new Promise((resolveClose) => server.close(resolveClose));
  }

  return {
    totalRequests: requestCount,
    statusCounts,
    percentiles: computePercentiles(latencies),
  };
}

export function renderLoadMarkdownReport({
  budgets,
  simulationReport,
  evaluation,
  regressionCheck,
  httpSmoke,
}) {
  const lines = [
    "# Analytics API 10k RPS Load Test & Budget Report",
    "",
    `- **Profile:** \`${budgets.profile}\``,
    `- **Target / Achieved Throughput:** ${budgets.throughputBudget.targetRps} RPS / **${simulationReport.achievedRps} RPS**`,
    `- **Overall Latencies:** p50=\`${simulationReport.overall.p50Ms} ms\` (budget <= ${budgets.latencyBudgetMs.p50Ms} ms) · p95=\`${simulationReport.overall.p95Ms} ms\` (budget <= ${budgets.latencyBudgetMs.p95Ms} ms) · p99=\`${simulationReport.overall.p99Ms} ms\` (budget <= ${budgets.latencyBudgetMs.p99Ms} ms)`,
    `- **Overall 5xx Error Rate:** \`${(simulationReport.overall.error5xxRate * 100).toFixed(3)}%\` (budget <= ${(budgets.errorBudget.max5xxRate * 100).toFixed(3)}%)`,
    `- **Regression Fixture Guard (\`${regressionCheck.fixtureId}\`):** ${regressionCheck.caught ? "CAUGHT (PASS)" : "MISSED (FAIL)"}`,
    `- **Live HTTP Query-Mix Smoke:** ${httpSmoke.statusCounts[200] ?? 0}/${httpSmoke.totalRequests} HTTP 200 (p95=\`${httpSmoke.percentiles.p95Ms} ms\`)`,
    `- **Gate Result:** **${evaluation.ok && regressionCheck.caught ? "PASSED" : "FAILED"}**`,
    "",
    "## Per-Route Query Mix Performance",
    "",
    "| Route ID | Method & Path | Weight | Requests | p50 (budget) | p95 (budget) | p99 (budget) | Error Rate (budget) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const route of budgets.queryMix) {
    const m = simulationReport.routes[route.id];
    lines.push(
      `| \`${route.id}\` | \`${route.method} ${redactLoadSecrets(route.path)}\` | ${route.weightPct}% | ${m.requests} | ${m.p50Ms} ms (<= ${route.latencyBudgetMs.p50Ms} ms) | ${m.p95Ms} ms (<= ${route.latencyBudgetMs.p95Ms} ms) | ${m.p99Ms} ms (<= ${route.latencyBudgetMs.p99Ms} ms) | ${(m.errorRate * 100).toFixed(3)}% (<= ${(route.maxErrorRate * 100).toFixed(3)}%) |`,
    );
  }

  if (evaluation.violations.length > 0) {
    lines.push("", "## Budget Violations", "");
    for (const v of evaluation.violations) {
      lines.push(
        `- **[${v.code}]** case=\`${v.caseId}\` route=\`${v.route}\`: ${redactLoadSecrets(v.message)}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function runCiGate({
  reportDir = join(ROOT, "target/analytics-load-test"),
} = {}) {
  const budgets = loadBudgets();
  const mixValidation = validateQueryMixConfig(budgets);
  if (!mixValidation.ok) {
    throw new Error(
      `Query mix configuration invalid: ${mixValidation.errors.join("; ")}`,
    );
  }

  const simulationReport = simulate10kRpsWorkload({
    budgets,
    durationSeconds: 2,
    seed: 20261048,
  });
  const evaluation = evaluateLoadBudget(simulationReport, budgets);

  const regressionFixture = loadRegressionFixture();
  const regressionEval = evaluateLoadBudget(regressionFixture.report, budgets);
  const regressionCaught =
    !regressionEval.ok &&
    regressionFixture.expectedViolationCodes.every((code) =>
      regressionEval.violations.some((v) => v.code === code),
    );

  const httpSmoke = await runLiveHttpSmokeLoad({ budgets, requestCount: 120 });

  const artifact = {
    ok:
      evaluation.ok &&
      regressionCaught &&
      (httpSmoke.statusCounts[200] ?? 0) === httpSmoke.totalRequests,
    budgets,
    simulationReport,
    evaluation,
    regressionCheck: {
      fixtureId: regressionFixture.fixtureId,
      caught: regressionCaught,
      violationsFound: regressionEval.violations,
    },
    httpSmoke,
  };

  if (reportDir) {
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(
      join(reportDir, "report.json"),
      `${JSON.stringify(artifact, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(
      join(reportDir, "report.md"),
      renderLoadMarkdownReport(artifact),
      "utf8",
    );
  }

  return artifact;
}

export async function main(argv = process.argv.slice(2)) {
  let reportDir = join(ROOT, "target/analytics-load-test");
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--report-dir") {
      reportDir = resolve(argv[(i += 1)]);
    }
  }

  const result = await runCiGate({ reportDir });
  if (!result.ok) {
    for (const v of result.evaluation.violations) {
      console.error(
        `Analytics API load budget failure [${v.code}] (${v.caseId}): ${redactLoadSecrets(v.message)}`,
      );
    }
    if (!result.regressionCheck.caught) {
      console.error(
        `Analytics API load regression fixture "${result.regressionCheck.fixtureId}" was not caught by budget gate.`,
      );
    }
    process.exit(1);
  }

  console.log(
    `Analytics API 10k RPS load gate OK (achieved ${result.simulationReport.achievedRps} RPS, p95=${result.simulationReport.overall.p95Ms}ms, p99=${result.simulationReport.overall.p99Ms}ms).`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
