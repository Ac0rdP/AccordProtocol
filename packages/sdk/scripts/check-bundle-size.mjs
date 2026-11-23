#!/usr/bin/env node
// Enforces per-entry-point bundle budgets for the SDK (see bundle-budgets.json).
//
// Each budget names exports imported from the built package root. The script
// bundles a virtual entry re-exporting just those names with esbuild (minified,
// tree-shaken, peer dependencies external), measures raw and gzip size, and
// fails when a size budget is exceeded or a forbidden module is pulled in.
//
//   npm run build && npm run size            # check
//   npm run size -- --json                   # machine-readable report
//   npm run size -- --config=other.json      # alternate budgets file

import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(root, "dist/esm/index.js");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const { evaluateBudgets, formatBudgetReport, validateBudgets } = await import(entry).catch((err) => {
  console.error(`Cannot load ${relative(root, entry)}; run \`npm run build\` first.\n${err.message}`);
  process.exit(2);
});

const configArg = process.argv.find((a) => a.startsWith("--config="));
const configPath = resolve(root, configArg ? configArg.slice("--config=".length) : "bundle-budgets.json");
const budgets = validateBudgets(JSON.parse(readFileSync(configPath, "utf8")));
const external = Object.keys(pkg.peerDependencies ?? {});

async function measure(budget) {
  const contents =
    budget.exports === "*"
      ? `export * from ${JSON.stringify(entry)};`
      : `export { ${budget.exports.join(", ")} } from ${JSON.stringify(entry)};`;
  const result = await build({
    stdin: { contents, resolveDir: root, loader: "js", sourcefile: `${budget.name}.entry.js` },
    bundle: true,
    write: false,
    minify: true,
    treeShaking: true,
    format: "esm",
    platform: "neutral",
    external,
    metafile: true,
    logLevel: "silent",
  });
  const code = result.outputFiles[0].contents;
  const output = Object.values(result.metafile.outputs)[0];
  return {
    name: budget.name,
    bytes: code.byteLength,
    gzipBytes: gzipSync(code, { level: 9 }).byteLength,
    modules: [
      ...new Set([
        ...Object.keys(output.inputs).map((p) => relative(root, resolve(root, p)).replace(/\\/g, "/")),
        ...output.imports.map((i) => i.path),
      ]),
    ],
  };
}

const measurements = await Promise.all(budgets.map(measure));
const report = evaluateBudgets(budgets, measurements);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ...report, measurements }, null, 2));
} else {
  console.log(formatBudgetReport(report));
}
process.exitCode = report.ok ? 0 : 1;
