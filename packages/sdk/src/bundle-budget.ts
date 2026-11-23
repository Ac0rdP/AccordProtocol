/**
 * Bundle-size Budgets for @accord-protocol/sdk
 * Validates per-entry-point size budgets and forbidden-import rules against
 * bundle measurements. `scripts/check-bundle-size.mjs` produces the
 * measurements with esbuild (tree-shaken, minified, gzip) and fails CI when a
 * budget is exceeded or a light entry point accidentally pulls in a heavy
 * module such as `@stellar/stellar-sdk` or `AccordClient`.
 */

import { AccordValidationError } from "./errors.js";

export type ByteSize = number | string;

export interface BundleBudget {
  /** Unique name for the entry point, e.g. `errors-only`. */
  name: string;
  /** Named exports imported from the package root, or `"*"` for the full surface. */
  exports: string[] | "*";
  /** Maximum minified size, e.g. `12 KB` or `12288`. */
  maxBytes?: ByteSize;
  /** Maximum minified + gzip size. */
  maxGzipBytes?: ByteSize;
  /**
   * Module path patterns that must not appear in this entry's bundle (bundled
   * inputs or external imports). `*` matches any run of characters; patterns
   * without `*` match as substrings.
   */
  forbiddenImports?: string[];
}

export interface BundleMeasurement {
  name: string;
  bytes: number;
  gzipBytes: number;
  /** Bundled input paths plus external import specifiers. */
  modules: string[];
}

export type BudgetViolationKind = "size" | "gzip" | "forbidden-import" | "missing-measurement";

export interface BudgetViolation {
  name: string;
  kind: BudgetViolationKind;
  message: string;
  actual?: number;
  limit?: number;
  module?: string;
}

export interface BudgetEntryResult {
  name: string;
  bytes: number | null;
  gzipBytes: number | null;
  maxBytes: number | null;
  maxGzipBytes: number | null;
  ok: boolean;
}

export interface BudgetReport {
  ok: boolean;
  entries: BudgetEntryResult[];
  violations: BudgetViolation[];
}

const UNITS: Record<string, number> = { b: 1, kb: 1024, kib: 1024, mb: 1024 ** 2, mib: 1024 ** 2 };

/**
 * Converts a size such as `1536`, `"1.5 KB"` or `"2MiB"` to bytes. `KB`/`KiB`
 * and `MB`/`MiB` are binary (1024-based) units.
 */
export function parseByteSize(value: ByteSize, field = "size"): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw new AccordValidationError(field, "Size must be a positive number of bytes.");
    }
    return Math.floor(value);
  }
  const match = typeof value === "string" ? value.trim().match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/) : null;
  const unit = match ? UNITS[(match[2] || "b").toLowerCase()] : undefined;
  if (!match || unit === undefined || Number(match[1]) <= 0) {
    throw new AccordValidationError(field, `Invalid size '${String(value)}'. Use bytes or B/KB/KiB/MB/MiB.`);
  }
  return Math.floor(Number(match[1]) * unit);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

/** Validates a budgets config (e.g. the parsed `bundle-budgets.json`). */
export function validateBudgets(config: unknown): BundleBudget[] {
  const raw = (config as { budgets?: unknown } | null)?.budgets ?? config;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AccordValidationError("budgets", "Expected a non-empty array of budgets.");
  }

  const seen = new Set<string>();
  return raw.map((b, i) => {
    const field = `budgets[${i}]`;
    if (typeof b !== "object" || b === null) throw new AccordValidationError(field, "Expected an object.");
    const budget = b as BundleBudget;

    if (typeof budget.name !== "string" || !budget.name.trim()) {
      throw new AccordValidationError(`${field}.name`, "Name is required.");
    }
    if (seen.has(budget.name)) throw new AccordValidationError(`${field}.name`, `Duplicate budget '${budget.name}'.`);
    seen.add(budget.name);

    const exportsOk =
      budget.exports === "*" ||
      (Array.isArray(budget.exports) &&
        budget.exports.length > 0 &&
        budget.exports.every((e) => typeof e === "string" && /^[A-Za-z_$][\w$]*$/.test(e)));
    if (!exportsOk) {
      throw new AccordValidationError(`${field}.exports`, `Expected "*" or a non-empty list of export names.`);
    }

    if (budget.maxBytes === undefined && budget.maxGzipBytes === undefined && !budget.forbiddenImports?.length) {
      throw new AccordValidationError(field, "Budget must set maxBytes, maxGzipBytes, or forbiddenImports.");
    }
    if (budget.maxBytes !== undefined) parseByteSize(budget.maxBytes, `${field}.maxBytes`);
    if (budget.maxGzipBytes !== undefined) parseByteSize(budget.maxGzipBytes, `${field}.maxGzipBytes`);
    if (
      budget.forbiddenImports !== undefined &&
      (!Array.isArray(budget.forbiddenImports) || !budget.forbiddenImports.every((p) => typeof p === "string" && p))
    ) {
      throw new AccordValidationError(`${field}.forbiddenImports`, "Expected a list of non-empty patterns.");
    }
    return budget;
  });
}

/** Returns true when `modulePath` matches a forbidden-import `pattern`. */
export function matchesImportPattern(modulePath: string, pattern: string): boolean {
  const path = modulePath.replace(/\\/g, "/");
  if (!pattern.includes("*")) return path.includes(pattern);
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(path);
}

/** Compares measurements against budgets and reports every violation. */
export function evaluateBudgets(budgets: readonly BundleBudget[], measurements: readonly BundleMeasurement[]): BudgetReport {
  const byName = new Map(measurements.map((m) => [m.name, m]));
  const violations: BudgetViolation[] = [];
  const entries: BudgetEntryResult[] = [];

  for (const budget of budgets) {
    const m = byName.get(budget.name);
    const maxBytes = budget.maxBytes === undefined ? null : parseByteSize(budget.maxBytes);
    const maxGzipBytes = budget.maxGzipBytes === undefined ? null : parseByteSize(budget.maxGzipBytes);
    const before = violations.length;

    if (!m) {
      violations.push({ name: budget.name, kind: "missing-measurement", message: `${budget.name}: no measurement was produced.` });
    } else {
      if (maxBytes !== null && m.bytes > maxBytes) {
        violations.push({
          name: budget.name,
          kind: "size",
          actual: m.bytes,
          limit: maxBytes,
          message: `${budget.name}: ${formatBytes(m.bytes)} exceeds budget of ${formatBytes(maxBytes)}.`,
        });
      }
      if (maxGzipBytes !== null && m.gzipBytes > maxGzipBytes) {
        violations.push({
          name: budget.name,
          kind: "gzip",
          actual: m.gzipBytes,
          limit: maxGzipBytes,
          message: `${budget.name}: ${formatBytes(m.gzipBytes)} gzip exceeds budget of ${formatBytes(maxGzipBytes)}.`,
        });
      }
      for (const pattern of budget.forbiddenImports ?? []) {
        for (const mod of m.modules.filter((p) => matchesImportPattern(p, pattern))) {
          violations.push({
            name: budget.name,
            kind: "forbidden-import",
            module: mod,
            message: `${budget.name}: bundle includes forbidden module '${mod}' (rule '${pattern}').`,
          });
        }
      }
    }

    entries.push({
      name: budget.name,
      bytes: m?.bytes ?? null,
      gzipBytes: m?.gzipBytes ?? null,
      maxBytes,
      maxGzipBytes,
      ok: violations.length === before,
    });
  }

  return { ok: violations.length === 0, entries, violations };
}

/** Renders a report as a plain-text table followed by any violations. */
export function formatBudgetReport(report: BudgetReport): string {
  const cell = (actual: number | null, limit: number | null) =>
    actual === null ? "-" : limit === null ? formatBytes(actual) : `${formatBytes(actual)} / ${formatBytes(limit)}`;
  const rows = report.entries.map(
    (e) => `${e.ok ? "PASS" : "FAIL"}  ${e.name.padEnd(20)} ${cell(e.bytes, e.maxBytes).padEnd(24)} ${cell(e.gzipBytes, e.maxGzipBytes)}`
  );
  const lines = [`      ${"entry".padEnd(20)} ${"min".padEnd(24)} gzip`, ...rows];
  if (report.violations.length) lines.push("", ...report.violations.map((v) => `✗ ${v.message}`));
  return lines.join("\n");
}
