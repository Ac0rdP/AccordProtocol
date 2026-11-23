import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  buildQueryMixSchedule,
  computePercentiles,
  evaluateLoadBudget,
  loadBudgets,
  loadRegressionFixture,
  redactLoadSecrets,
  runCiGate,
  runLiveHttpSmokeLoad,
  simulate10kRpsWorkload,
  validateQueryMixConfig,
} from "./analytics-load-test.mjs";

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("analytics API 10k RPS load testing and budget gate", () => {
  describe("success cases", () => {
    it("validates query mix weights and verifies every route against docs/analytics-api.openapi.json", () => {
      const budgets = loadBudgets();
      const validation = validateQueryMixConfig(budgets);
      assert.equal(validation.ok, true, validation.errors.join("; "));
      assert.equal(budgets.throughputBudget.targetRps, 10000);
      assert.equal(budgets.throughputBudget.minSustainedRps, 10000);
    });

    it("meets 10k RPS throughput, latency (p50/p95/p99), and error budgets across the realistic query mix", () => {
      const budgets = loadBudgets();
      const report = simulate10kRpsWorkload({
        budgets,
        durationSeconds: 2,
        seed: 20261048,
      });

      assert.equal(report.achievedRps, 10000);
      assert.equal(report.totalRequests, 20000);

      const evaluation = evaluateLoadBudget(report, budgets);
      assert.equal(
        evaluation.ok,
        true,
        `Unexpected budget violations: ${JSON.stringify(evaluation.violations)}`,
      );
      assert.equal(evaluation.violations.length, 0);
    });

    it("executes a live in-process HTTP query-mix load run and writes CI artifacts", async () => {
      const reportDir = mkdtempSync(join(tmpdir(), "accord-analytics-load-"));
      tempDirs.push(reportDir);

      const result = await runCiGate({ reportDir });
      assert.equal(result.ok, true);
      assert.equal(result.httpSmoke.totalRequests, 120);
      assert.equal(result.httpSmoke.statusCounts[200], 120);

      assert.ok(existsSync(join(reportDir, "report.json")));
      assert.ok(existsSync(join(reportDir, "report.md")));
      const md = readFileSync(join(reportDir, "report.md"), "utf8");
      assert.match(md, /# Analytics API 10k RPS Load Test & Budget Report/);
      assert.match(md, /\*\*Gate Result:\*\* \*\*PASSED\*\*/);
    });
  });

  describe("boundary cases", () => {
    it("passes when metrics sit exactly on 10k RPS, latency, and error boundaries and fails 1 unit past", () => {
      const budgets = loadBudgets();
      const baseline = simulate10kRpsWorkload({ budgets, durationSeconds: 1 });

      // Construct a report sitting right on the exact overall and route boundaries
      const exactBoundaryReport = {
        ...baseline,
        achievedRps: budgets.throughputBudget.minSustainedRps,
        overall: {
          p50Ms: budgets.latencyBudgetMs.p50Ms,
          p95Ms: budgets.latencyBudgetMs.p95Ms,
          p99Ms: budgets.latencyBudgetMs.p99Ms,
          error5xxRate: budgets.errorBudget.max5xxRate,
          unexpectedErrorRate: budgets.errorBudget.maxUnexpectedErrorRate,
        },
        routes: Object.fromEntries(
          budgets.queryMix.map((r) => [
            r.id,
            {
              requests: 100,
              p50Ms: r.latencyBudgetMs.p50Ms,
              p95Ms: r.latencyBudgetMs.p95Ms,
              p99Ms: r.latencyBudgetMs.p99Ms,
              errorRate: r.maxErrorRate,
            },
          ]),
        ),
      };

      const atBoundaryEval = evaluateLoadBudget(exactBoundaryReport, budgets);
      assert.equal(
        atBoundaryEval.ok,
        true,
        `Exact boundary values must pass: ${JSON.stringify(atBoundaryEval.violations)}`,
      );

      // Step 1 RPS below throughput floor and 0.01ms above p99 latency ceiling
      const justOverBoundary = {
        ...exactBoundaryReport,
        achievedRps: budgets.throughputBudget.minSustainedRps - 1,
        overall: {
          ...exactBoundaryReport.overall,
          p99Ms: Number((budgets.latencyBudgetMs.p99Ms + 0.01).toFixed(2)),
        },
      };

      const overEval = evaluateLoadBudget(justOverBoundary, budgets);
      assert.equal(overEval.ok, false);
      assert.ok(
        overEval.violations.some(
          (v) =>
            v.code === "THROUGHPUT_BELOW_BUDGET" &&
            v.caseId === "overall_throughput",
        ),
      );
      assert.ok(
        overEval.violations.some(
          (v) =>
            v.code === "OVERALL_LATENCY_P99_EXCEEDED" &&
            v.caseId === "overall_p99Ms",
        ),
      );
    });

    it("produces deterministic route distributions and exact percentiles for edge-case sample arrays", () => {
      const budgets = loadBudgets();
      const first = buildQueryMixSchedule(budgets, 1000, 42);
      const second = buildQueryMixSchedule(budgets, 1000, 42);
      assert.deepEqual(first.routeCounts, second.routeCounts);
      assert.deepEqual(first.schedule, second.schedule);

      assert.deepEqual(computePercentiles([]), {
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        maxMs: 0,
        meanMs: 0,
      });
      const single = computePercentiles([7.5]);
      assert.equal(single.p50Ms, 7.5);
      assert.equal(single.p99Ms, 7.5);
    });
  });

  describe("failure cases and secret redaction", () => {
    it("identifies offending routes on GraphQL p99 spikes, 5xx surges, and rate-limit bursts", () => {
      const budgets = loadBudgets();
      const faultReport = simulate10kRpsWorkload({
        budgets,
        durationSeconds: 1,
        faultInjection: {
          achievedRps: 7200,
          latencyMultiplierByRoute: { graphql_proposals: 12 },
          error5xxRateByRoute: { proposals_list: 0.05 },
        },
      });

      const evaluation = evaluateLoadBudget(faultReport, budgets);
      assert.equal(evaluation.ok, false);

      assert.ok(
        evaluation.violations.some(
          (v) => v.code === "THROUGHPUT_BELOW_BUDGET",
        ),
      );
      assert.ok(
        evaluation.violations.some(
          (v) =>
            v.code === "ROUTE_LATENCY_P99_EXCEEDED" &&
            v.caseId === "graphql_proposals",
        ),
      );
      assert.ok(
        evaluation.violations.some(
          (v) =>
            v.code === "ROUTE_ERROR_BUDGET_EXCEEDED" &&
            v.caseId === "proposals_list",
        ),
      );
    });

    it("redacts secrets from offending route diagnostics and failure messages", () => {
      const budgets = loadBudgets();
      const syntheticApiKey = ["accord", "secret", "key", "998877665544"].join(
        "_",
      );
      const syntheticBearer = `Bearer ${["tok", "abcdef0123456789xyz"].join("_")}`;
      const syntheticPg = [
        "postgres://accord:",
        "db_super_secret_pw",
        "@db.internal:5432/accord",
      ].join("");

      const customBudgets = {
        ...budgets,
        queryMix: [
          {
            ...budgets.queryMix[0],
            path: `/proposals?api_key=${syntheticApiKey}&limit=20`,
          },
        ],
      };

      const failingReport = {
        achievedRps: 10000,
        overall: {
          p50Ms: 5,
          p95Ms: 20,
          p99Ms: 50,
          error5xxRate: 0,
          unexpectedErrorRate: 0,
        },
        routes: {
          proposals_list: {
            requests: 100,
            p50Ms: 5,
            p95Ms: 20,
            p99Ms: 250,
            errorRate: 0,
          },
        },
      };

      const evaluation = evaluateLoadBudget(failingReport, customBudgets);
      assert.equal(evaluation.ok, false);
      const serialized = JSON.stringify(evaluation);
      assert.ok(
        !serialized.includes(syntheticApiKey),
        "Violation report must never expose query-string API key",
      );
      assert.ok(serialized.includes("api_key=[REDACTED]"));

      const redactedLog = redactLoadSecrets(
        `Request failed with auth=${syntheticBearer} against ${syntheticPg}`,
      );
      assert.ok(!redactedLog.includes("abcdef0123456789xyz"));
      assert.ok(!redactedLog.includes("db_super_secret_pw"));
    });
  });

  describe("regression fixture verification", () => {
    it("catches the committed spend-by-category cache-stampede regression fixture", () => {
      const budgets = loadBudgets();
      const fixture = loadRegressionFixture();
      assert.equal(
        fixture.fixtureId,
        "regression-2026-10-spend-by-category-cache-stampede",
      );

      const evaluation = evaluateLoadBudget(fixture.report, budgets);
      assert.equal(
        evaluation.ok,
        false,
        "Regression fixture must fail the load budget gate",
      );

      for (const expectedCode of fixture.expectedViolationCodes) {
        assert.ok(
          evaluation.violations.some((v) => v.code === expectedCode),
          `Expected regression fixture to trigger ${expectedCode}`,
        );
      }

      const spendP99Violation = evaluation.violations.find(
        (v) =>
          v.code === "ROUTE_LATENCY_P99_EXCEEDED" &&
          v.caseId === "spend_by_category",
      );
      assert.ok(
        spendP99Violation,
        "Must pinpoint spend_by_category as the p99 latency offender",
      );
    });
  });
});
