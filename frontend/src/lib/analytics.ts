import type {
  AnalyticsAmount,
  AnalyticsGranularity,
  AnalyticsQuery,
  Proposal,
  ProposalCategory,
  TreasurySummary,
} from "../types/accord";

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

/**
 * A single row from the spend-by-category endpoint or computed locally.
 * `share` is always expressed as a percentage string, e.g. "34.5%".
 */
export type SpendByCategoryRow = {
  category: string;
  total: number;
  count: number;
  /** Percentage share of total spend, e.g. 34.5 */
  share: number;
};

/**
 * Normalise a raw SpendByCategory array (without share) into
 * SpendByCategoryRow[] by computing each category's percentage share.
 */
export function enrichWithShares(rows: SpendByCategory[]): SpendByCategoryRow[] {
  const grandTotal = rows.reduce((s, r) => s + r.total, 0);
  return rows.map((r) => ({
    ...r,
    share: grandTotal > 0 ? (r.total / grandTotal) * 100 : 0,
  }));
}

/**
 * Format a share value as a consistently rounded percentage string.
 * Always shows exactly one decimal place, e.g. "34.5%".
 */
export function formatShare(share: number): string {
  return `${share.toFixed(1)}%`;
}

/**
 * Fetch spend-by-category data from the backend time-series endpoint
 * GET /spend/by-category. Falls back to an empty array on any error so
 * callers can continue to render the page with local data.
 */
export async function fetchSpendByCategory(): Promise<SpendByCategoryRow[]> {
  const apiBase = import.meta.env.VITE_API_BASE_URL || "";
  const url = apiBase
    ? `${apiBase}/spend/by-category`
    : "/spend/by-category";
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) return [];
    const rows: SpendByCategory[] = data.map(
      (item: Record<string, unknown>) => ({
        category: String(item.category ?? item.name ?? "Other"),
        total:
          typeof item.total === "number"
            ? item.total
            : parseFloat(String(item.total || "0")),
        count:
          typeof item.count === "number"
            ? item.count
            : parseInt(String(item.count || "0"), 10),
      }),
    );
    return enrichWithShares(rows);
  } catch {
    return [];
  }
}

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

/**
 * Compute the treasury summary aggregation matching the GET /stats/summary shape.
 * Aggregates executed transfer disbursements per token, counts active proposals,
 * counts owners, and locates the single largest outflow within the optional date range.
 */
export function computeTreasurySummary(
  proposals: Proposal[],
  ownerCount: number,
  filters?: AnalyticsQuery,
): TreasurySummary {
  const activeProposals = proposals.filter((p) =>
    ["pending", "ready"].includes(p.status),
  ).length;

  const executedTransfers = proposals.filter((p) => {
    if (p.status !== "executed" || p.kind !== "transfer") return false;

    if (filters?.token && p.token !== filters.token) return false;

    if (filters?.startDate || filters?.endDate) {
      const ts = p.deadlineTs * 1000;
      if (filters.startDate && ts < new Date(filters.startDate).getTime()) {
        return false;
      }
      if (
        filters.endDate &&
        ts > new Date(filters.endDate).getTime() + MS_PER_DAY - 1
      ) {
        return false;
      }
    }

    return true;
  });

  const totalsByToken = new Map<string, number>();
  let largestOutflow: { token: string; amount: AnalyticsAmount } | null = null;
  let maxAmount = -1;

  for (const p of executedTransfers) {
    const token = p.token || "XLM";
    const amount = parseFloat(p.amount) || 0;
    const current = totalsByToken.get(token) ?? 0;
    totalsByToken.set(token, current + amount);

    if (amount > maxAmount) {
      maxAmount = amount;
      largestOutflow = {
        token,
        amount: String(amount),
      };
    }
  }

  const totalDisbursed: Record<string, AnalyticsAmount> = {};
  for (const [token, total] of totalsByToken.entries()) {
    totalDisbursed[token] = String(total);
  }

  return {
    totalDisbursed,
    activeProposals,
    ownerCount,
    largestOutflow,
  };
}

/**
 * Fetch treasury summary from GET /stats/summary.
 * Returns TreasurySummary or null on failure.
 */
export async function fetchTreasurySummary(
  query?: AnalyticsQuery,
): Promise<TreasurySummary | null> {
  const apiBase = import.meta.env.VITE_API_BASE_URL || "";
  const params = new URLSearchParams();
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        params.set(key, String(value));
      }
    }
  }
  const search = params.toString();
  const url = `${apiBase ? `${apiBase}/stats/summary` : "/stats/summary"}${search ? `?${search}` : ""}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as TreasurySummary;
    return data;
  } catch {
    return null;
  }
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
  } catch {
    return [];
  }
}

export type ProposalActivityPoint = {
  period: string;
  created: number;
  executed: number;
};

function parseProposalDate(
  val: string | number | undefined | null,
): number | null {
  if (val === undefined || val === null || val === "") return null;
  if (typeof val === "number") {
    return val < 1e11 ? val * 1000 : val;
  }
  const numeric = Number(val);
  if (!isNaN(numeric) && isFinite(numeric) && numeric > 0) {
    return numeric < 1e11 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(val);
  if (!isNaN(parsed)) return parsed;
  return null;
}

function activityBucketKey(
  ms: number,
  granularity: AnalyticsGranularity,
): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  if (granularity === "month") {
    return `${y}-${String(m + 1).padStart(2, "0")}`;
  }
  if (granularity === "day") {
    return `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  // week: start of week (Monday)
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  const mondayMs = Date.UTC(y, m, day) - sinceMonday * 86_400_000;
  const mon = new Date(mondayMs);
  return `${mon.getUTCFullYear()}-${String(mon.getUTCMonth() + 1).padStart(2, "0")}-${String(mon.getUTCDate()).padStart(2, "0")}`;
}

export function computeProposalActivity(
  proposals: Proposal[],
  granularity: AnalyticsGranularity = "day",
): ProposalActivityPoint[] {
  const buckets = new Map<string, { created: number; executed: number }>();

  for (const p of proposals) {
    // Created
    const createdMs =
      parseProposalDate(p.createdAt) ??
      (p.deadlineTs ? p.deadlineTs * 1000 : null);
    if (createdMs !== null) {
      const key = activityBucketKey(createdMs, granularity);
      const entry = buckets.get(key) ?? { created: 0, executed: 0 };
      entry.created += 1;
      buckets.set(key, entry);
    }

    // Executed
    if (p.status === "executed") {
      const executedMs =
        parseProposalDate(p.executedAt) ??
        (p.deadlineTs ? p.deadlineTs * 1000 : null);
      if (executedMs !== null) {
        const key = activityBucketKey(executedMs, granularity);
        const entry = buckets.get(key) ?? { created: 0, executed: 0 };
        entry.executed += 1;
        buckets.set(key, entry);
      }
    }
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, { created, executed }]) => ({
      period,
      created,
      executed,
    }));
}

