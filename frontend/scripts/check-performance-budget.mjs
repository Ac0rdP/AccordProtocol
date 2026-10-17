#!/usr/bin/env node
// Measures load performance for a key page against a running `vite preview`
// server and fails when the budgets in performance-budget.json are exceeded.
//
// Usage:
//   npm run preview -- --port 4173 &
//   node scripts/check-performance-budget.mjs
//
// CI runs this after `vite build`, using the Playwright Chromium that the E2E
// job already installs.

import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = resolve(HERE, "..");
const BUDGET_PATH = join(FRONTEND_DIR, "performance-budget.json");

const budget = JSON.parse(readFileSync(BUDGET_PATH, "utf8"));
const baseUrl = process.env.PERF_BASE_URL ?? "http://localhost:4173";
const url = new URL(budget.url ?? "/", baseUrl).toString();
const runs = Number(budget.runs ?? 3);

async function measureOnce(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "load" });

  const metrics = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0];
    const paint = performance.getEntriesByType("paint");
    const fcp = paint.find((entry) => entry.name === "first-contentful-paint");
    return {
      firstContentfulPaintMs: fcp ? fcp.startTime : 0,
      domContentLoadedMs: navigation ? navigation.domContentLoadedEventEnd : 0,
      loadEventMs: navigation ? navigation.loadEventEnd : 0,
    };
  });

  await context.close();
  return metrics;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

const browser = await chromium.launch();
const samples = [];
try {
  for (let run = 0; run < runs; run += 1) {
    samples.push(await measureOnce(browser));
  }
} finally {
  await browser.close();
}

const measured = {
  firstContentfulPaintMs: Math.round(median(samples.map((s) => s.firstContentfulPaintMs))),
  domContentLoadedMs: Math.round(median(samples.map((s) => s.domContentLoadedMs))),
  loadEventMs: Math.round(median(samples.map((s) => s.loadEventMs))),
};

const checks = Object.entries(budget.budgets ?? {}).map(([key, limit]) => ({
  key,
  label: key,
  actual: measured[key] ?? 0,
  budget: Number(limit),
}));

const failures = checks.filter((check) => check.actual > check.budget);

const rows = checks.map((check) => {
  const status = check.actual > check.budget ? "❌ over" : "✅ within";
  return `| ${check.label} | ${check.actual} ms | ${check.budget} ms | ${status} |`;
});

const summary = [
  "## Frontend load-performance budget",
  "",
  `Page: \`${url}\` (median of ${runs} runs)`,
  "",
  "| Metric | Measured | Budget | Status |",
  "| --- | --- | --- | --- |",
  ...rows,
  "",
];

console.log(summary.join("\n"));

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`);
}

if (failures.length > 0) {
  console.error("Load-performance budget exceeded.");
  console.error(
    "If the regression is intentional, raise the budget in frontend/performance-budget.json in a dedicated, reviewed commit. See frontend/docs/performance-budgets.md.",
  );
  process.exit(1);
}

console.log("Load-performance budget OK.");
