/**
 * SDK v1 → v2 migration guide, codemods and compatibility matrix.
 *
 * "SDK API v1" is integration code written against the legacy contract
 * surface: storage schema 0, event schema 0/1, count-based approvals, no
 * roles, and the direct `*_recurring_schedule` entrypoints. "SDK API v2" is
 * this package, which targets event schema 2, weighted governance and RBAC.
 * The guide is exported as data so tools (and the README) render the same
 * source of truth, and `runCodemods` applies the mechanical parts.
 *
 * Dependency-free (no `@stellar/stellar-sdk`, no `AccordClient` at runtime),
 * so it tree-shakes independently.
 */

import type { AccordClient } from "./client.js";
import { AccordValidationError, ContractError } from "./errors.js";

/** The SDK API generation implemented by this package. */
export const SDK_API_VERSION = 2;

export type MigrationArea = "events" | "governance" | "rbac" | "recurring" | "errors";

export interface BreakingChange {
  id: string;
  area: MigrationArea;
  title: string;
  description: string;
  before: string;
  after: string;
  /** Id of the codemod in `CODEMODS` that rewrites or flags this change. */
  codemod: string;
}

export const SDK_V2_BREAKING_CHANGES: readonly BreakingChange[] = [
  {
    id: "executed-event-transfers",
    area: "events",
    title: "`ProposalExecutedEvent` no longer carries `transfers`",
    description:
      "Event schema 2 dropped the transfer list from the executed event to keep large batches under the 16 KiB event limit. Read transfers from `ProposalCreatedEvent` or `getProposal(id).kind`.",
    before: `sub.on("proposal_executed", (e) => pay(e.data.transfers));`,
    after: `sub.on("proposal_executed", async (e) => {\n  const { kind } = await client.getProposal(BigInt(e.data.id as string));\n  if ("Transfer" in kind) pay(kind.Transfer);\n});`,
    codemod: "flag-executed-event-transfers",
  },
  {
    id: "weighted-quorum",
    area: "governance",
    title: "Quorum is measured in weight, snapshotted per proposal",
    description:
      "Approvals are weighted and each proposal snapshots `quorum_weight` at creation. Compare `approval_weight` with the proposal's own `quorum_weight` instead of the live `getThreshold()`.",
    before: `const ready = proposal.approvals >= (await client.getThreshold());`,
    after: `const ready = proposal.approval_weight >= proposal.quorum_weight;`,
    codemod: "weighted-quorum",
  },
  {
    id: "rbac-roles",
    area: "rbac",
    title: "Create, approve and execute require roles",
    description:
      "After `migrate_to_rbac`, callers need the Proposer, Approver or Executor role. Missing roles fail with `MissingRole` (52), not `Unauthorized` (3); check `hasRole` up front.",
    before: `if (err.errorCode === ContractError.Unauthorized) showNotOwner();`,
    after: `if (err.errorCode === ContractError.Unauthorized || err.errorCode === ContractError.MissingRole) showNoPermission();`,
    codemod: "flag-unauthorized-only",
  },
  {
    id: "governed-recurring",
    area: "recurring",
    title: "Recurring schedules are governed proposals",
    description:
      "`create_recurring_schedule`, `cancel_recurring_schedule` and `disburse_recurring_schedule` are superseded; `cancel_recurring_schedule` now always fails with `DeprecatedEntrypoint` (56). Use `createRecurringProposal`, `createCancelRecurringProposal` and `disburseRecurring`.",
    before: `await client.executeTransaction("cancel_recurring_schedule", args, owner);`,
    after: `await client.createCancelRecurringProposal(owner, scheduleId, "Stop payroll", deadline);`,
    codemod: "flag-legacy-recurring",
  },
  {
    id: "named-error-codes",
    area: "errors",
    title: "Compare against `ContractError` names, not numbers",
    description:
      "Weighted governance, RBAC and recovery added many codes (for example `MissingRole`, `DeprecatedEntrypoint`, `RecoveryActive`). Numeric literals hide which error is meant and are easy to get wrong; the codemod rewrites them to `ContractError` members.",
    before: `if (err.errorCode === 56) retryViaProposal();`,
    after: `if (err.errorCode === ContractError.DeprecatedEntrypoint) retryViaProposal();`,
    codemod: "named-error-codes",
  },
];

// ─── Compatibility matrix ────────────────────────────────────────────────────

export interface CompatibilityRow {
  sdkApi: number;
  status: "current" | "deprecated";
  /** Inclusive [min, max] ranges reported by the contract views. */
  contractVersion: [number, number];
  storageSchemaVersion: [number, number];
  eventSchemaVersion: [number, number];
  weightedGovernance: boolean;
  rbac: boolean;
  /** Supported `@stellar/stellar-sdk` peer range, where one is published. */
  stellarSdk?: string;
}

export const SDK_COMPATIBILITY_MATRIX: readonly CompatibilityRow[] = [
  {
    sdkApi: 1,
    status: "deprecated",
    contractVersion: [1, 1],
    storageSchemaVersion: [0, 0],
    eventSchemaVersion: [0, 1],
    weightedGovernance: false,
    rbac: false,
  },
  {
    sdkApi: 2,
    status: "current",
    contractVersion: [1, 1],
    storageSchemaVersion: [1, 1],
    eventSchemaVersion: [2, 2],
    weightedGovernance: true,
    rbac: true,
    stellarSdk: "^13.0.0 || ^14.0.0 || ^15.0.0",
  },
];

/** What a deployed contract reports about itself. */
export interface ContractSurface {
  contractVersion: number;
  storageVersion: number;
  roleVersion: number;
  governanceMigrated: boolean;
}

export type ContractMigration = "migrate_to_weighted_governance" | "migrate_to_rbac";

export interface CompatibilityReport {
  sdkApi: number;
  compatible: boolean;
  /** One-time contract migrations (owner co-signed) needed before this SDK fully works. */
  requiredMigrations: ContractMigration[];
  issues: string[];
}

function inRange(value: number, [min, max]: [number, number]): boolean {
  return value >= min && value <= max;
}

/** Reads the version views needed by `checkCompatibility`. */
export async function readContractSurface(
  client: Pick<AccordClient, "getVersion" | "getStorageVersion" | "getRoleVersion" | "isGovernanceMigrated">
): Promise<ContractSurface> {
  const [contractVersion, storageVersion, roleVersion, governanceMigrated] = await Promise.all([
    client.getVersion(),
    client.getStorageVersion(),
    client.getRoleVersion(),
    client.isGovernanceMigrated(),
  ]);
  return { contractVersion, storageVersion, roleVersion, governanceMigrated };
}

/**
 * Checks a deployed contract against a row of the compatibility matrix and
 * lists the contract migrations that would make it compatible.
 */
export function checkCompatibility(surface: ContractSurface, sdkApi = SDK_API_VERSION): CompatibilityReport {
  for (const field of ["contractVersion", "storageVersion", "roleVersion"] as const) {
    if (!Number.isInteger(surface[field]) || surface[field] < 0) {
      throw new AccordValidationError(field, "Expected a non-negative integer.");
    }
  }
  const row = SDK_COMPATIBILITY_MATRIX.find((r) => r.sdkApi === sdkApi);
  if (!row) {
    throw new AccordValidationError("sdkApi", `Unknown SDK API version ${sdkApi}.`);
  }

  const issues: string[] = [];
  const requiredMigrations: ContractMigration[] = [];

  if (!inRange(surface.contractVersion, row.contractVersion)) {
    issues.push(
      `Contract version ${surface.contractVersion} is outside ${row.contractVersion.join("–")}; upgrade the ${
        surface.contractVersion > row.contractVersion[1] ? "SDK" : "contract"
      }.`
    );
  }
  if (row.weightedGovernance && !surface.governanceMigrated) {
    requiredMigrations.push("migrate_to_weighted_governance");
  }
  if (row.rbac && surface.roleVersion === 0) {
    requiredMigrations.push("migrate_to_rbac");
  }
  // Each migration stamps the storage version, so only flag it when no pending migration explains it.
  if (!inRange(surface.storageVersion, row.storageSchemaVersion) && requiredMigrations.length === 0) {
    issues.push(`Storage schema ${surface.storageVersion} is outside ${row.storageSchemaVersion.join("–")}.`);
  }
  for (const m of requiredMigrations) issues.push(`Contract requires \`${m}\` before SDK API v${sdkApi} can be used.`);

  return { sdkApi, compatible: issues.length === 0, requiredMigrations, issues };
}

// ─── Codemods ────────────────────────────────────────────────────────────────

export interface Codemod {
  id: string;
  description: string;
  /** Mechanical rewrite. Absent for codemods that only flag lines for review. */
  transform?: (source: string) => string;
  /** Flags lines needing manual review. `context` limits flagging to files that match. */
  flag?: { pattern: RegExp; context?: RegExp; message: string };
}

// Right-hand side: `threshold`, `cfg.threshold`, `await client.getThreshold()`
// or `(await client.getThreshold())`; a closing paren is consumed only when opened here.
const THRESHOLD_COMPARISON =
  /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.approvals\s*>=\s*(?:\(\s*await\s+[\w$.]*[Tt]hreshold\(\)\s*\)|(?:await\s+)?[\w$.]*[Tt]hreshold\b(?:\(\))?)/g;
const NUMERIC_ERROR_CODE = /(\.errorCode\s*[!=]==?\s*)(\d+)\b/g;

export const CODEMODS: readonly Codemod[] = [
  {
    id: "weighted-quorum",
    description: "Rewrites `x.approvals >= threshold` to `x.approval_weight >= x.quorum_weight`.",
    transform: (source) => source.replace(THRESHOLD_COMPARISON, "$1.approval_weight >= $1.quorum_weight"),
  },
  {
    id: "named-error-codes",
    description: "Rewrites numeric `errorCode` comparisons to `ContractError` members.",
    transform: (source) =>
      source.replace(NUMERIC_ERROR_CODE, (match, lhs: string, code: string) => {
        const name = ContractError[Number(code)];
        return name ? `${lhs}ContractError.${name}` : match;
      }),
  },
  {
    id: "flag-executed-event-transfers",
    description: "Flags `.transfers` reads in code handling executed events.",
    flag: {
      pattern: /\.transfers\b/,
      context: /ProposalExecutedEvent|["'`]proposal_executed["'`]/,
      message: "`ProposalExecutedEvent.transfers` was removed in event schema 2; read the proposal's `kind` instead.",
    },
  },
  {
    id: "flag-unauthorized-only",
    description: "Flags `Unauthorized` checks that should also handle `MissingRole`.",
    flag: {
      pattern: /ContractError\.Unauthorized\b/,
      message: "Under RBAC, permission failures may be `ContractError.MissingRole`; handle both.",
    },
  },
  {
    id: "flag-legacy-recurring",
    description: "Flags calls to the deprecated direct recurring-schedule entrypoints.",
    flag: {
      pattern: /["'`](?:create|cancel|disburse)_recurring_schedule["'`]/,
      message: "Direct recurring-schedule entrypoints are superseded by governed recurring proposals.",
    },
  },
];

export interface CodemodChange {
  codemod: string;
  line: number;
  before: string;
  after: string;
}

export interface CodemodFinding {
  codemod: string;
  line: number;
  text: string;
  message: string;
}

export interface CodemodResult {
  output: string;
  changes: CodemodChange[];
  findings: CodemodFinding[];
}

export interface CodemodOptions {
  /** Restrict to these codemod ids (default: all). */
  only?: string[];
}

/**
 * Applies the v1 → v2 codemods to a source file. Rewrites are line-preserving,
 * so `changes` and `findings` line numbers refer to both input and output.
 */
export function runCodemods(source: string, options: CodemodOptions = {}): CodemodResult {
  if (typeof source !== "string") {
    throw new AccordValidationError("source", "Expected source text.");
  }
  const known = new Set(CODEMODS.map((c) => c.id));
  for (const id of options.only ?? []) {
    if (!known.has(id)) throw new AccordValidationError("only", `Unknown codemod '${id}'.`);
  }
  const selected = CODEMODS.filter((c) => !options.only || options.only.includes(c.id));

  const result: CodemodResult = { output: source, changes: [], findings: [] };
  for (const codemod of selected) {
    if (codemod.transform) {
      const before = result.output.split("\n");
      result.output = before.map(codemod.transform).join("\n");
      result.output.split("\n").forEach((after, i) => {
        if (after !== before[i]) result.changes.push({ codemod: codemod.id, line: i + 1, before: before[i], after });
      });
    }
    if (codemod.flag && (!codemod.flag.context || codemod.flag.context.test(result.output))) {
      result.output.split("\n").forEach((text, i) => {
        if (codemod.flag!.pattern.test(text)) {
          result.findings.push({ codemod: codemod.id, line: i + 1, text: text.trim(), message: codemod.flag!.message });
        }
      });
    }
  }
  return result;
}

/** Renders the guide and matrix as Markdown (used to keep docs in sync). */
export function renderMigrationGuide(): string {
  const lines = [
    `# Migrating from SDK API v1 to v${SDK_API_VERSION}`,
    "",
    "<!-- Generated by renderMigrationGuide() in src/migration.ts; edit that file, not this one. -->",
    "",
    "SDK API v1 is integration code written against the legacy contract surface (storage schema 0, count-based approvals, no roles, direct recurring-schedule entrypoints). v2 is this package. Run `checkCompatibility(await readContractSurface(client))` to see which contract migrations a deployment still needs, and `runCodemods(source)` to rewrite the mechanical changes below and list the rest for review.",
    "",
    "## Compatibility matrix",
    "",
    "| SDK API | Status | Contract | Storage schema | Event schema | Weighted governance | RBAC | @stellar/stellar-sdk |",
    "|---|---|---|---|---|---|---|---|",
    ...SDK_COMPATIBILITY_MATRIX.map(
      (r) =>
        `| v${r.sdkApi} | ${r.status} | ${r.contractVersion.join("–")} | ${r.storageSchemaVersion.join("–")} | ${r.eventSchemaVersion.join(
          "–"
        )} | ${r.weightedGovernance ? "yes" : "no"} | ${r.rbac ? "yes" : "no"} | ${r.stellarSdk?.replace(/\|/g, "\\|") ?? "—"} |`
    ),
    "",
    "## Breaking changes",
  ];
  for (const c of SDK_V2_BREAKING_CHANGES) {
    lines.push(
      "",
      `### ${c.title}`,
      "",
      `${c.description} Codemod: \`${c.codemod}\`.`,
      "",
      "```ts",
      "// v1",
      c.before,
      "// v2",
      c.after,
      "```"
    );
  }
  return `${lines.join("\n")}\n`;
}
