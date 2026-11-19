import { describe, expect, it } from "vitest";
import { AccordValidationError } from "../errors.js";
import {
  CODEMODS,
  SDK_API_VERSION,
  SDK_COMPATIBILITY_MATRIX,
  SDK_V2_BREAKING_CHANGES,
  checkCompatibility,
  readContractSurface,
  renderMigrationGuide,
  runCodemods,
} from "../migration.js";

const current = { contractVersion: 1, storageVersion: 1, roleVersion: 1, governanceMigrated: true };

describe("migration guide data", () => {
  it("links every breaking change to a codemod", () => {
    const ids = new Set(CODEMODS.map((c) => c.id));
    for (const change of SDK_V2_BREAKING_CHANGES) expect(ids.has(change.codemod)).toBe(true);
  });

  it("marks exactly one current row, matching SDK_API_VERSION", () => {
    const currentRows = SDK_COMPATIBILITY_MATRIX.filter((r) => r.status === "current");
    expect(currentRows.map((r) => r.sdkApi)).toEqual([SDK_API_VERSION]);
  });

  it("renders the matrix and every change as Markdown", () => {
    const md = renderMigrationGuide();
    expect(md).toContain("| v2 | current | 1–1 | 1–1 | 2–2 | yes | yes |");
    for (const change of SDK_V2_BREAKING_CHANGES) expect(md).toContain(`### ${change.title}`);
  });
});

describe("checkCompatibility", () => {
  it("accepts a fully migrated contract", () => {
    expect(checkCompatibility(current)).toEqual({ sdkApi: 2, compatible: true, requiredMigrations: [], issues: [] });
  });

  it("lists the migrations a legacy contract needs", () => {
    const report = checkCompatibility({ contractVersion: 1, storageVersion: 0, roleVersion: 0, governanceMigrated: false });
    expect(report.compatible).toBe(false);
    expect(report.requiredMigrations).toEqual(["migrate_to_weighted_governance", "migrate_to_rbac"]);
    expect(checkCompatibility({ contractVersion: 1, storageVersion: 0, roleVersion: 0, governanceMigrated: false }, 1).compatible).toBe(
      true
    );
  });

  it("asks for an SDK upgrade when the contract is newer", () => {
    const report = checkCompatibility({ ...current, contractVersion: 2 });
    expect(report.issues).toEqual([expect.stringContaining("upgrade the SDK")]);
  });

  it("validates its input", () => {
    expect(() => checkCompatibility({ ...current, roleVersion: -1 })).toThrow(AccordValidationError);
    expect(() => checkCompatibility(current, 9)).toThrow(/Unknown SDK API version 9/);
  });

  it("reads the surface from the client's version views", async () => {
    const client = {
      getVersion: async () => 1,
      getStorageVersion: async () => 1,
      getRoleVersion: async () => 0,
      isGovernanceMigrated: async () => true,
    };
    const surface = await readContractSurface(client);
    expect(checkCompatibility(surface).requiredMigrations).toEqual(["migrate_to_rbac"]);
  });
});

describe("runCodemods", () => {
  const v1 = [
    `import { ContractError } from "@accord-protocol/sdk";`,
    `const ready = proposal.approvals >= (await client.getThreshold());`,
    `if (p.approvals >= threshold) execute();`,
    `if (err.errorCode === 56 || err.errorCode !== 999) retry();`,
    `if (err.errorCode === ContractError.Unauthorized) deny();`,
    `sub.on("proposal_executed", (e) => pay(e.data.transfers));`,
    `await client.executeTransaction("cancel_recurring_schedule", args, owner);`,
  ].join("\n");

  it("rewrites mechanical changes and keeps line numbers stable", () => {
    const { output, changes } = runCodemods(v1);
    const lines = output.split("\n");
    expect(lines).toHaveLength(7);
    expect(lines[1]).toBe("const ready = proposal.approval_weight >= proposal.quorum_weight;");
    expect(lines[2]).toBe("if (p.approval_weight >= p.quorum_weight) execute();");
    expect(lines[3]).toBe("if (err.errorCode === ContractError.DeprecatedEntrypoint || err.errorCode !== 999) retry();");
    expect(changes.map((c) => [c.codemod, c.line])).toEqual([
      ["weighted-quorum", 2],
      ["weighted-quorum", 3],
      ["named-error-codes", 4],
    ]);
  });

  it("flags changes that need a human", () => {
    const { findings } = runCodemods(v1);
    expect(findings.map((f) => [f.codemod, f.line])).toEqual([
      ["flag-executed-event-transfers", 6],
      ["flag-unauthorized-only", 5],
      ["flag-legacy-recurring", 7],
    ]);
  });

  it("only flags `.transfers` in files that handle executed events", () => {
    expect(runCodemods("const total = created.transfers.length;").findings).toEqual([]);
  });

  it("leaves v2 code untouched", () => {
    const v2 = "const ready = proposal.approval_weight >= proposal.quorum_weight;";
    expect(runCodemods(v2)).toEqual({ output: v2, changes: [], findings: [] });
  });

  it("supports selecting codemods and validates input", () => {
    expect(runCodemods(v1, { only: ["named-error-codes"] }).changes).toHaveLength(1);
    expect(() => runCodemods(v1, { only: ["nope"] })).toThrow(/Unknown codemod 'nope'/);
    expect(() => runCodemods(42 as unknown as string)).toThrow(AccordValidationError);
  });
});
