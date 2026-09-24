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
