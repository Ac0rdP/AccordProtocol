import type { Proposal, ProposalCategory } from "../types/accord";

export type CategoryFilter = "all" | ProposalCategory;

export type AnalyticsFilters = {
  /** yyyy-mm-dd (inclusive), "" = no lower bound */
  startDate: string;
  /** yyyy-mm-dd (inclusive), "" = no upper bound */
  endDate: string;
  category: CategoryFilter;
  /** Substring match against the proposer address, "" = all owners */
  owner: string;
};

export const DEFAULT_ANALYTICS_FILTERS: AnalyticsFilters = {
  startDate: "",
  endDate: "",
  category: "all",
  owner: "",
};

const MS_PER_DAY = 86_400_000;

/**
 * Executed transfer proposals are the only proposals with a real monetary
 * amount attached (governance actions like add_owner/change_threshold use
 * "-"/"—" placeholders) - this is the source dataset for every analytics
 * chart, card, and export.
 */
export function filterExecutedTransfers(
  proposals: Proposal[],
  filters: AnalyticsFilters,
): Proposal[] {
  return proposals.filter((p) => {
    if (p.status !== "executed" || p.kind !== "transfer") return false;

    const category = p.category ?? "Other";
    if (filters.category !== "all" && category !== filters.category)
      return false;

    if (
      filters.owner &&
      !p.proposer.toLowerCase().includes(filters.owner.toLowerCase())
    ) {
      return false;
    }

    if (filters.startDate || filters.endDate) {
      const ts = p.deadlineTs * 1000;
      if (filters.startDate && ts < new Date(filters.startDate).getTime())
        return false;
      if (
        filters.endDate &&
        ts > new Date(filters.endDate).getTime() + MS_PER_DAY - 1
      )
        return false;
    }

    return true;
  });
}

export type SpendByCategory = {
  category: string;
  total: number;
  count: number;
};

export function computeSpendByCategory(
  proposals: Proposal[],
): SpendByCategory[] {
  const totals = new Map<string, { total: number; count: number }>();
  for (const p of proposals) {
    const category = p.category ?? "Other";
    const amount = parseFloat(p.amount) || 0;
    const entry = totals.get(category) ?? { total: 0, count: 0 };
    entry.total += amount;
    entry.count += 1;
    totals.set(category, entry);
  }
  return [...totals.entries()]
    .map(([category, { total, count }]) => ({ category, total, count }))
    .sort((a, b) => b.total - a.total);
}

export type TreasuryFlowPoint = {
  period: string;
  outflow: number;
  cumulative: number;
};

function periodKey(deadlineTs: number): string {
  const d = new Date(deadlineTs * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function computeTreasuryFlow(
  proposals: Proposal[],
): TreasuryFlowPoint[] {
  const byPeriod = new Map<string, number>();
  for (const p of proposals) {
    const period = periodKey(p.deadlineTs);
    const amount = parseFloat(p.amount) || 0;
    byPeriod.set(period, (byPeriod.get(period) ?? 0) + amount);
  }

  let cumulative = 0;
  return [...byPeriod.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([period, outflow]) => {
      cumulative += outflow;
      return { period, outflow, cumulative };
    });
}

function filterRangeLabel(filters: AnalyticsFilters): string {
  if (!filters.startDate && !filters.endDate) return "all-time";
  return `${filters.startDate || "start"}_to_${filters.endDate || "now"}`;
}

export function buildExportFilename(
  dataset: string,
  filters: AnalyticsFilters,
): string {
  return `accord-analytics-${dataset}-${filterRangeLabel(filters)}`;
}

export function buildSpendCsv(rows: SpendByCategory[]): string {
  const headers = ["Category", "Total", "Transaction Count"];
  const lines = rows.map(
    (r) => `"${r.category}","${r.total.toFixed(2)}",${r.count}`,
  );
  return [headers.join(","), ...lines].join("\n");
}

export function buildTreasuryCsv(rows: TreasuryFlowPoint[]): string {
  const headers = ["Period", "Outflow", "Cumulative Outflow"];
  const lines = rows.map(
    (r) =>
      `"${r.period}","${r.outflow.toFixed(2)}","${r.cumulative.toFixed(2)}"`,
  );
  return [headers.join(","), ...lines].join("\n");
}

export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export type TreasuryBalancePoint = {
  timestamp: string;
  xlm: number;
  usdc: number;
};

export async function fetchTreasuryBalanceHistory(): Promise<
  TreasuryBalancePoint[]
> {
  const apiBase = import.meta.env.VITE_API_BASE_URL || "";
  const url = apiBase ? `${apiBase}/treasury/balance` : "/treasury/balance";
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as unknown;
    if (Array.isArray(data)) {
      return data.map((item: Record<string, unknown>) => ({
        timestamp: String(item.timestamp ?? item.date ?? item.period ?? ""),
        xlm:
          typeof item.xlm === "number"
            ? item.xlm
            : parseFloat(String(item.xlm || "0")),
        usdc:
          typeof item.usdc === "number"
            ? item.usdc
            : parseFloat(String(item.usdc || "0")),
      }));
    }
    return [];
export type SpendByOwner = {
  owner: string;
  shortOwner: string;
  total: number;
  count: number;
};

function formatShortOwner(addr: string): string {
  if (!addr || addr.length < 10) return addr || "Unknown";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function computeSpendByOwner(proposals: Proposal[]): SpendByOwner[] {
  const totals = new Map<string, { total: number; count: number }>();
  for (const p of proposals) {
    const owner = p.proposer || "Unknown";
    const amount = parseFloat(p.amount) || 0;
    const entry = totals.get(owner) ?? { total: 0, count: 0 };
    entry.total += amount;
    entry.count += 1;
    totals.set(owner, entry);
  }
  return [...totals.entries()]
    .map(([owner, { total, count }]) => ({
      owner,
      shortOwner: formatShortOwner(owner),
      total,
      count,
    }))
    .sort((a, b) => b.total - a.total);
}

/**
 * Fetch spend-by-owner data from GET /spend/by-owner endpoint.
 * Returns an array of SpendByOwner objects or [] on error.
 */
export async function fetchSpendByOwner(): Promise<SpendByOwner[]> {
  const apiBase = import.meta.env.VITE_API_BASE_URL || "";
  const url = apiBase ? `${apiBase}/spend/by-owner` : "/spend/by-owner";
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) return [];
    return data
      .map((item: Record<string, unknown>) => {
        const owner = String(item.owner ?? item.address ?? item.proposer ?? "Unknown");
        const total =
          typeof item.total === "number"
            ? item.total
            : parseFloat(String(item.total || "0")) || 0;
        const count =
          typeof item.count === "number"
            ? item.count
            : parseInt(String(item.count || "0"), 10) || 0;
        return {
          owner,
          shortOwner: formatShortOwner(owner),
          total,
          count,
        };
      })
      .sort((a, b) => b.total - a.total);
  } catch {
    return [];
  }
}

// TODO: Add tests confirming the analytics aggregations compute the correct totals
