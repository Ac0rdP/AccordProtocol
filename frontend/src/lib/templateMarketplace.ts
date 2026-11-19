import type { ProposalCategory } from "../types/accord";
import {
  deleteProposalTemplate,
  getProposalTemplates,
  saveProposalTemplate,
  type ProposalTemplateFields,
} from "./proposalTemplates";

/**
 * A community proposal template published to the marketplace catalog.
 * Installing one copies its `fields` into the user's saved templates, so it
 * shows up in the New Proposal template picker like any template they saved.
 */
export type MarketplaceTemplate = {
  id: string;
  name: string;
  summary: string;
  description: string;
  category: ProposalCategory;
  /** Semantic version, e.g. "1.2.0". */
  version: string;
  author: string;
  /** ISO date of the latest published version. */
  updatedAt: string;
  tags: string[];
  fields: ProposalTemplateFields;
  /** What changed in this version. */
  changelog?: string;
};

export type InstalledMarketplaceTemplate = {
  marketplaceId: string;
  version: string;
  /** Id of the copy stored in the saved-templates list. */
  localTemplateId: string;
  installedAt: string;
};

export type InstallState = "not_installed" | "installed" | "update_available";

export const MARKETPLACE_CATEGORIES: ProposalCategory[] = [
  "Transfer",
  "Payroll",
  "Grant",
  "Ops",
  "Other",
];

const INSTALLS_KEY = "accord_marketplace_installs";

/**
 * Catalog bundled with the app. Used when no remote catalog URL is configured
 * (`VITE_TEMPLATE_MARKETPLACE_URL`), which is the case for the prototype.
 */
export const BUNDLED_MARKETPLACE_CATALOG: MarketplaceTemplate[] = [
  {
    id: "monthly-contributor-payroll",
    name: "Monthly contributor payroll",
    summary: "Recurring monthly USDC payment to a core contributor.",
    description:
      "Sets up a monthly payroll proposal for a contributor, paid in USDC. Fill in the recipient and adjust the amount before submitting.",
    category: "Payroll",
    version: "1.2.0",
    author: "Accord community",
    updatedAt: "2026-09-12",
    tags: ["payroll", "recurring", "usdc"],
    fields: {
      kind: "transfer",
      token: "USDC",
      amount: "2500",
      description: "Monthly contributor payroll",
      category: "Payroll",
      interval: "2592000",
    },
    changelog: "Defaults the interval to 30 days.",
  },
  {
    id: "ecosystem-grant-milestone",
    name: "Ecosystem grant milestone",
    summary: "Release a grant tranche after a milestone is delivered.",
    description:
      "Pays out a single grant milestone. Link the milestone report in the description so approvers can verify delivery.",
    category: "Grant",
    version: "2.0.1",
    author: "Grants working group",
    updatedAt: "2026-10-03",
    tags: ["grant", "milestone"],
    fields: {
      kind: "transfer",
      token: "XLM",
      amount: "10000",
      description: "Grant milestone payout — link report here",
      category: "Grant",
    },
    changelog: "Clarifies the description placeholder.",
  },
  {
    id: "infrastructure-invoice",
    name: "Infrastructure invoice",
    summary: "Pay a hosting or RPC provider invoice.",
    description:
      "One-off payment for infrastructure costs. Include the invoice number in the description.",
    category: "Ops",
    version: "1.0.0",
    author: "Ops guild",
    updatedAt: "2026-06-20",
    tags: ["ops", "invoice", "infrastructure"],
    fields: {
      kind: "transfer",
      token: "USDC",
      amount: "450",
      description: "Infrastructure invoice #",
      category: "Ops",
    },
  },
  {
    id: "treasury-rebalance",
    name: "Treasury rebalance transfer",
    summary: "Move funds between treasury wallets.",
    description:
      "Transfers funds from this multisig to another treasury-controlled address, for example a cold-storage wallet.",
    category: "Transfer",
    version: "1.1.0",
    author: "Accord community",
    updatedAt: "2026-08-01",
    tags: ["treasury", "rebalance"],
    fields: {
      kind: "transfer",
      token: "XLM",
      amount: "5000",
      description: "Treasury rebalance to cold storage",
      category: "Transfer",
    },
  },
  {
    id: "bug-bounty-payout",
    name: "Bug bounty payout",
    summary: "Reward a security researcher for a disclosed issue.",
    description:
      "Pays a bug bounty. Reference the advisory or report ID, never the vulnerability details.",
    category: "Grant",
    version: "1.0.3",
    author: "Security council",
    updatedAt: "2026-07-15",
    tags: ["security", "bounty"],
    fields: {
      kind: "transfer",
      token: "USDC",
      amount: "1000",
      description: "Bug bounty — advisory ID",
      category: "Grant",
    },
  },
  {
    id: "event-sponsorship",
    name: "Event sponsorship",
    summary: "Sponsor a community meetup or hackathon.",
    description: "One-off sponsorship payment for a community event.",
    category: "Other",
    version: "0.9.0",
    author: "Community team",
    updatedAt: "2026-05-02",
    tags: ["community", "events"],
    fields: {
      kind: "transfer",
      token: "XLM",
      amount: "750",
      description: "Event sponsorship",
      category: "Other",
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMarketplaceTemplate(value: unknown): value is MarketplaceTemplate {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.summary === "string" &&
    typeof value.description === "string" &&
    typeof value.version === "string" &&
    typeof value.author === "string" &&
    typeof value.updatedAt === "string" &&
    MARKETPLACE_CATEGORIES.includes(value.category as ProposalCategory) &&
    Array.isArray(value.tags) &&
    isRecord(value.fields)
  );
}

/**
 * Validates an untrusted catalog payload, dropping malformed entries.
 * Throws when the payload is not a list at all.
 */
export function parseCatalog(data: unknown): MarketplaceTemplate[] {
  const list = isRecord(data) && Array.isArray(data.templates) ? data.templates : data;
  if (!Array.isArray(list)) {
    throw new Error("Template catalog is malformed");
  }
  return list.filter(isMarketplaceTemplate);
}

export async function fetchMarketplaceTemplates(
  options: { url?: string; fetchImpl?: typeof fetch } = {},
): Promise<MarketplaceTemplate[]> {
  const url =
    options.url ??
    (import.meta.env.VITE_TEMPLATE_MARKETPLACE_URL as string | undefined);
  if (!url) {
    return BUNDLED_MARKETPLACE_CATALOG;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Template marketplace responded with ${response.status}`);
  }
  return parseCatalog(await response.json());
}

/** Numeric semver comparison: negative when a < b, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function getInstalledTemplates(): Record<string, InstalledMarketplaceTemplate> {
  try {
    const raw = localStorage.getItem(INSTALLS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return isRecord(parsed) ? (parsed as Record<string, InstalledMarketplaceTemplate>) : {};
  } catch {
    return {};
  }
}

function persistInstalls(installs: Record<string, InstalledMarketplaceTemplate>): void {
  try {
    localStorage.setItem(INSTALLS_KEY, JSON.stringify(installs));
  } catch {
    throw new Error("Could not save the template. Browser storage is unavailable.");
  }
}

/**
 * Drops install records whose saved-template copy the user has since deleted
 * from the template picker, so the marketplace offers to install them again.
 */
export function reconcileInstalls(): Record<string, InstalledMarketplaceTemplate> {
  const installs = getInstalledTemplates();
  const localIds = new Set(getProposalTemplates().map((t) => t.id));
  const live = Object.fromEntries(
    Object.entries(installs).filter(([, record]) => localIds.has(record.localTemplateId)),
  );
  if (Object.keys(live).length !== Object.keys(installs).length) {
    try {
      persistInstalls(live);
    } catch {
      // read-only storage — the in-memory view is still correct
    }
  }
  return live;
}

export function getInstallState(
  template: MarketplaceTemplate,
  installs: Record<string, InstalledMarketplaceTemplate>,
): InstallState {
  const record = installs[template.id];
  if (!record) return "not_installed";
  return compareVersions(template.version, record.version) > 0
    ? "update_available"
    : "installed";
}

/**
 * Installs (or updates) a marketplace template into the saved-templates list.
 * Updating replaces the previously installed copy rather than duplicating it.
 */
export function installMarketplaceTemplate(
  template: MarketplaceTemplate,
): InstalledMarketplaceTemplate {
  const installs = getInstalledTemplates();
  const previous = installs[template.id];
  if (previous) {
    deleteProposalTemplate(previous.localTemplateId);
  }

  const saved = saveProposalTemplate(template.name, {
    ...template.fields,
    category: template.fields.category ?? template.category,
  });
  if (!getProposalTemplates().some((t) => t.id === saved.id)) {
    throw new Error("Could not save the template. Browser storage is unavailable.");
  }

  const record: InstalledMarketplaceTemplate = {
    marketplaceId: template.id,
    version: template.version,
    localTemplateId: saved.id,
    installedAt: new Date().toISOString(),
  };
  persistInstalls({ ...installs, [template.id]: record });
  return record;
}

export function uninstallMarketplaceTemplate(marketplaceId: string): void {
  const installs = getInstalledTemplates();
  const record = installs[marketplaceId];
  if (!record) return;
  deleteProposalTemplate(record.localTemplateId);
  const rest = { ...installs };
  delete rest[marketplaceId];
  persistInstalls(rest);
}

export type MarketplaceFilter = {
  query: string;
  category: ProposalCategory | "all";
};

export function filterTemplates(
  templates: MarketplaceTemplate[],
  { query, category }: MarketplaceFilter,
): MarketplaceTemplate[] {
  const needle = query.trim().toLowerCase();
  return templates.filter((template) => {
    if (category !== "all" && template.category !== category) return false;
    if (!needle) return true;
    return [template.name, template.summary, template.author, ...template.tags]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });
}
