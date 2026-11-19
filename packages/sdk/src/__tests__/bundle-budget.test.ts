import { describe, expect, it } from "vitest";
import {
  evaluateBudgets,
  formatBudgetReport,
  formatBytes,
  matchesImportPattern,
  parseByteSize,
  validateBudgets,
} from "../bundle-budget.js";
import type { BundleMeasurement } from "../bundle-budget.js";
import { AccordValidationError } from "../errors.js";
import * as sdk from "../index.js";

const budgets = validateBudgets({
  budgets: [
    { name: "errors", exports: ["parseContractError"], maxGzipBytes: "2 KB", forbiddenImports: ["@stellar/stellar-sdk", "dist/esm/client.js"] },
    { name: "full", exports: "*", maxBytes: 50_000 },
  ],
});

const light: BundleMeasurement = { name: "errors", bytes: 4000, gzipBytes: 1500, modules: ["dist/esm/errors.js", "dist/esm/index.js"] };

describe("parseByteSize", () => {
  it("parses bytes and binary units", () => {
    expect(parseByteSize(512)).toBe(512);
    expect(parseByteSize("1.5 KB")).toBe(1536);
    expect(parseByteSize("2KiB")).toBe(2048);
    expect(parseByteSize("1 MB")).toBe(1048576);
    expect(formatBytes(1536)).toBe("1.50 KB");
  });

  it("rejects invalid sizes", () => {
    expect(() => parseByteSize("ten KB")).toThrow(AccordValidationError);
    expect(() => parseByteSize("5 GB")).toThrow(/Invalid size/);
    expect(() => parseByteSize(0)).toThrow(/positive/);
  });
});

describe("validateBudgets", () => {
  it("rejects malformed configs", () => {
    expect(() => validateBudgets([])).toThrow(/non-empty array/);
    expect(() => validateBudgets([{ name: "a", exports: [] , maxBytes: 1 }])).toThrow(/exports/);
    expect(() => validateBudgets([{ name: "a", exports: "*" }])).toThrow(/must set/);
    expect(() => validateBudgets([{ name: "a", exports: "*", maxBytes: "huge" }])).toThrow(/maxBytes/);
    expect(() =>
      validateBudgets([
        { name: "a", exports: "*", maxBytes: 1 },
        { name: "a", exports: "*", maxBytes: 1 },
      ])
    ).toThrow(/Duplicate budget 'a'/);
  });
});

describe("evaluateBudgets", () => {
  it("passes when every entry is within budget", () => {
    const report = evaluateBudgets(budgets, [light, { name: "full", bytes: 40_000, gzipBytes: 9_000, modules: [] }]);
    expect(report.ok).toBe(true);
    expect(report.entries.map((e) => e.ok)).toEqual([true, true]);
    expect(formatBudgetReport(report)).toContain("PASS  errors");
  });

  it("reports size, gzip, forbidden-import and missing-measurement violations", () => {
    const heavy: BundleMeasurement = {
      name: "errors",
      bytes: 90_000,
      gzipBytes: 30_000,
      modules: ["dist/esm/errors.js", "dist/esm/client.js", "@stellar/stellar-sdk"],
    };
    const report = evaluateBudgets(budgets, [heavy]);
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => v.kind)).toEqual(["gzip", "forbidden-import", "forbidden-import", "missing-measurement"]);
    expect(report.violations[0]).toMatchObject({ actual: 30_000, limit: 2048 });
    expect(formatBudgetReport(report)).toContain("✗ errors: bundle includes forbidden module 'dist/esm/client.js'");
  });

  it("matches glob and substring patterns", () => {
    expect(matchesImportPattern("node_modules/@stellar/stellar-sdk/lib/index.js", "@stellar/stellar-sdk")).toBe(true);
    expect(matchesImportPattern("dist\\esm\\client.js", "*/client.js")).toBe(true);
    expect(matchesImportPattern("dist/esm/codegen.js", "*/client.js")).toBe(false);
  });

  it("is exported from the package root", () => {
    expect(sdk.evaluateBudgets).toBe(evaluateBudgets);
  });
});
