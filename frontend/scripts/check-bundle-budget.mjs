#!/usr/bin/env node
// Measures the production bundle produced by `vite build` and fails when it
// exceeds the budgets in bundle-budget.json.
//
// Usage:
//   node scripts/check-bundle-budget.mjs                # check dist/
//   node scripts/check-bundle-budget.mjs --dist out     # custom build dir
//   node scripts/check-bundle-budget.mjs --update-baseline
//
// The script writes bundle-report.json (uploaded by CI as an artifact) and,
// when running in GitHub Actions, appends a Markdown summary to the job.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { appendFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = resolve(HERE, "..");

const args = process.argv.slice(2);
const updateBaseline = args.includes("--update-baseline");
const distFlagIndex = args.indexOf("--dist");
const DIST_DIR = resolve(
  FRONTEND_DIR,
  distFlagIndex !== -1 && args[distFlagIndex + 1] ? args[distFlagIndex + 1] : "dist",
);
const BUDGET_PATH = join(FRONTEND_DIR, "bundle-budget.json");
const BASELINE_PATH = join(FRONTEND_DIR, "bundle-baseline.json");
const REPORT_PATH = join(FRONTEND_DIR, "bundle-report.json");

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

function gzipSize(path) {
  return gzipSync(readFileSync(path), { level: 9 }).length;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDelta(current, baseline) {
  if (baseline === null || baseline === undefined) return "n/a";
  const delta = current - baseline;
  const sign = delta > 0 ? "+" : "";
  const pct = baseline === 0 ? "n/a" : `${sign}${((delta / baseline) * 100).toFixed(1)}%`;
  return `${sign}${formatBytes(Math.abs(delta))} (${pct})`;
}

if (!existsSync(DIST_DIR)) {
  console.error(`Build output not found at ${DIST_DIR}. Run "npm run build" first.`);
  process.exit(1);
}

const budget = JSON.parse(readFileSync(BUDGET_PATH, "utf8"));
const baseline = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
  : {};

const assets = walk(DIST_DIR).filter((file) => !file.endsWith(".map"));
const measure = (file) => gzipSize(file);

const jsAssets = assets.filter((file) => extname(file) === ".js");
const cssAssets = assets.filter((file) => extname(file) === ".css");

const js = jsAssets.map((file) => ({ file: relative(DIST_DIR, file), gzip: measure(file) }));
const css = cssAssets.map((file) => ({ file: relative(DIST_DIR, file), gzip: measure(file) }));

const totalJsGzipBytes = js.reduce((sum, asset) => sum + asset.gzip, 0);
const totalCssGzipBytes = css.reduce((sum, asset) => sum + asset.gzip, 0);
const largestChunkGzipBytes = js.reduce((max, asset) => Math.max(max, asset.gzip), 0);
const maxChunks = js.length;

const checks = [
  {
    key: "totalJsGzipBytes",
    label: "Total JavaScript (gzip)",
    actual: totalJsGzipBytes,
    budget: budget.totalJsGzipBytes,
  },
  {
    key: "totalCssGzipBytes",
    label: "Total CSS (gzip)",
    actual: totalCssGzipBytes,
    budget: budget.totalCssGzipBytes,
  },
  {
    key: "largestChunkGzipBytes",
    label: "Largest JS chunk (gzip)",
    actual: largestChunkGzipBytes,
    budget: budget.largestChunkGzipBytes,
  },
  {
    key: "maxChunks",
    label: "JavaScript chunk count",
    actual: maxChunks,
    budget: budget.maxChunks,
    raw: true,
  },
];

const failures = checks.filter((check) => check.actual > check.budget);

const report = {
  generatedAt: new Date().toISOString(),
  distDir: relative(FRONTEND_DIR, DIST_DIR) || ".",
  totals: { totalJsGzipBytes, totalCssGzipBytes, largestChunkGzipBytes, maxChunks },
  deltas: {
    totalJsGzipBytes: formatDelta(totalJsGzipBytes, baseline.totalJsGzipBytes),
    totalCssGzipBytes: formatDelta(totalCssGzipBytes, baseline.totalCssGzipBytes),
    largestChunkGzipBytes: formatDelta(largestChunkGzipBytes, baseline.largestChunkGzipBytes),
  },
  checks,
  largestJsAssets: [...js].sort((a, b) => b.gzip - a.gzip).slice(0, 10),
  passed: failures.length === 0,
};

writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);

const rows = checks.map((check) => {
  const value = check.raw ? String(check.actual) : formatBytes(check.actual);
  const limit = check.raw ? String(check.budget) : formatBytes(check.budget);
  const status = check.actual > check.budget ? "❌ over" : "✅ within";
  return `| ${check.label} | ${value} | ${limit} | ${status} |`;
});

const summary = [
  "## Frontend bundle budget",
  "",
  "| Metric | Current | Budget | Status |",
  "| --- | --- | --- | --- |",
  ...rows,
  "",
  "### Size change vs baseline",
  "",
  `- JavaScript: ${report.deltas.totalJsGzipBytes}`,
  `- CSS: ${report.deltas.totalCssGzipBytes}`,
  `- Largest chunk: ${report.deltas.largestChunkGzipBytes}`,
  "",
];

console.log(summary.join("\n"));
console.log("Largest JavaScript assets:");
for (const asset of report.largestJsAssets) {
  console.log(`  ${formatBytes(asset.gzip).padStart(9)}  ${asset.file}`);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`);
}

if (updateBaseline) {
  const next = {
    ...baseline,
    totalJsGzipBytes,
    totalCssGzipBytes,
    largestChunkGzipBytes,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Baseline updated at ${relative(FRONTEND_DIR, BASELINE_PATH)}.`);
}

if (failures.length > 0) {
  console.error("");
  console.error("Bundle budget exceeded:");
  for (const failure of failures) {
    console.error(
      `  - ${failure.label}: ${failure.raw ? failure.actual : formatBytes(failure.actual)} > ${
        failure.raw ? failure.budget : formatBytes(failure.budget)
      }`,
    );
  }
  console.error("");
  console.error(
    "If the increase is intentional, raise the budget in frontend/bundle-budget.json in a dedicated, reviewed commit. See frontend/docs/performance-budgets.md.",
  );
  process.exit(1);
}

console.log("Bundle budget OK.");
