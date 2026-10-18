import { useMemo, useState } from "react";
import { jsPDF } from "jspdf";
import { StatCard } from "../components/StatCard";
import { SpendByCategoryChart } from "../components/SpendByCategoryChart";
import { SpendByOwnerChart } from "../components/SpendByOwnerChart";
import { TreasuryBalanceChart } from "../components/TreasuryBalanceChart";
import { ProposalActivityChart } from "../components/ProposalActivityChart";
import { TreasuryFlowChart } from "../components/TreasuryFlowChart";
import { useTreasuryAnalytics } from "../hooks/useTreasuryAnalytics";
import { formatCurrency, formatTimeSeriesLabel } from "../lib/soroban";
import {
  buildExportFilename,
  buildSpendCsv,
  buildTreasuryCsv,
  DEFAULT_ANALYTICS_FILTERS,
  downloadCsv,
  type AnalyticsFilters,
  type CategoryFilter,
  type SpendByCategoryRow,
  type SpendByOwner,
  type TreasuryFlowPoint,
} from "../lib/analytics";
import type {
  AnalyticsAmount,
  AnalyticsGranularity,
  AnalyticsQuery,
  CategorySpendBucket,
  OwnerSpendBucket,
  ProposalCategory,
  TreasuryFlowBucket,
} from "../types/accord";

const CATEGORY_OPTIONS: { key: CategoryFilter; label: string }[] = [
  { key: "all", label: "All Categories" },
  { key: "Transfer", label: "Transfer" },
  { key: "Payroll", label: "Payroll" },
  { key: "Grant", label: "Grant" },
  { key: "Ops", label: "Ops" },
  { key: "Other", label: "Other" },
];

function toQuery(filters: AnalyticsFilters): AnalyticsQuery {
  return {
    ...(filters.startDate ? { startDate: filters.startDate } : {}),
    ...(filters.endDate ? { endDate: filters.endDate } : {}),
    ...(filters.category !== "all" ? { category: filters.category as ProposalCategory } : {}),
    ...(filters.owner ? { owner: filters.owner } : {}),
    granularity: "month",
  };
}

function formatTotals(totals: Record<string, AnalyticsAmount>): string {
  const entries = Object.entries(totals).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return entries.length
    ? entries.map(([token, amount]) => formatCurrency(amount, token)).join(" · ")
    : "—";
}

function toSpendByCategory(rows: CategorySpendBucket[]): SpendByCategoryRow[] {
  return rows.map((row) => ({
    category: row.category,
    total: Number(row.total) || 0,
    count: row.count,
    share: row.share,
  }));
}

function toSpendByOwner(rows: OwnerSpendBucket[]): SpendByOwner[] {
  return rows.map((row) => ({
    owner: row.owner,
    shortOwner:
      row.owner.length > 10
        ? `${row.owner.slice(0, 6)}...${row.owner.slice(-4)}`
        : row.owner,
    total: Number(row.total) || 0,
    count: row.count,
  }));
}

/**
 * Convert raw TreasuryFlowBucket[] (per-token per-window rows from the API)
 * into chart-ready TreasuryFlowPoint[] for the legacy export helper.
 *
 * Buckets with the same period label are merged by summing outflows.
 * The running cumulative is computed in chronological order.
 */
export function toTreasuryFlowChart(
  rows: TreasuryFlowBucket[],
  granularity: AnalyticsGranularity = "month",
): TreasuryFlowPoint[] {
  const byPeriod = new Map<
    string,
    { inflow: number; outflow: number; sortKey: string }
  >();

  for (const row of rows) {
    const label = formatTimeSeriesLabel(row.timestamp, granularity);
    const existing = byPeriod.get(label);
    const inflow = Number(row.inflow) || 0;
    const outflow = Number(row.outflow) || 0;
    if (existing) {
      existing.inflow += inflow;
      existing.outflow += outflow;
    } else {
      byPeriod.set(label, { inflow, outflow, sortKey: row.timestamp });
    }
  }

  let cumulative = 0;
  return [...byPeriod.entries()]
    .sort(([, a], [, b]) => a.sortKey.localeCompare(b.sortKey))
    .map(([period, { inflow, outflow }]) => {
      cumulative += outflow;
      return { period, inflow, outflow, cumulative };
    });
}

export function AnalyticsPage() {
  const [filters, setFilters] = useState<AnalyticsFilters>(
    DEFAULT_ANALYTICS_FILTERS,
  );
  const query = useMemo(() => toQuery(filters), [filters]);
  const { data, loading, error, refresh } = useTreasuryAnalytics(query);

  const spendByCategory = useMemo(
    () => toSpendByCategory(data?.spendByCategory ?? []),
    [data?.spendByCategory],
  );
  const spendByOwner = useMemo(
    () => toSpendByOwner(data?.spendByOwner ?? []),
    [data?.spendByOwner],
  );
  // Flat TreasuryFlowPoint[] used by CSV export; TreasuryFlowChart consumes
  // raw data?.flow directly so it can re-bucket on granularity change.
  const treasuryFlow = useMemo(
    () => toTreasuryFlowChart(data?.flow ?? []),
    [data?.flow],
  );
  // Balance time-series from the hook (may be undefined when not requested yet)
  const balanceHistory = useMemo(() => {
    const ts = data?.balance?.timeSeries;
    if (!ts) return [];
    return ts.map((point) => ({
      timestamp: point.timestamp,
      ...Object.fromEntries(
        Object.entries(point.values).map(([k, v]) => [k.toLowerCase(), Number(v) || 0]),
      ),
    }));
  }, [data?.balance?.timeSeries]);

  const hasExportData = spendByCategory.length > 0 || treasuryFlow.length > 0;

  const handleExportSpendCsv = () =>
    downloadCsv(
      `${buildExportFilename("spend", filters)}.csv`,
      buildSpendCsv(spendByCategory),
    );
  const handleExportTreasuryCsv = () =>
    downloadCsv(
      `${buildExportFilename("treasury", filters)}.csv`,
      buildTreasuryCsv(treasuryFlow),
    );
  const handleDownloadStatement = () => {
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text("Accord Treasury Statement", 14, 20);
    doc.setFontSize(10);
    doc.text(
      `Total disbursed: ${formatTotals(data?.summary.totalDisbursed ?? {})}`,
      14,
      34,
    );
    doc.text(
      `Total inflows: ${formatTotals(data?.summary.totalInflows ?? {})}`,
      14,
      40,
    );
    doc.text(`Active proposals: ${data?.summary.activeProposals ?? 0}`, 14, 46);
    doc.save(`${buildExportFilename("statement", filters)}.pdf`);
  };

  return (
    <>
      {/* ── Page header + export actions ─────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h2 className="font-semibold">Analytics</h2>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleExportSpendCsv}
            disabled={!hasExportData}
            aria-label="Export spend CSV for the current analytics filters"
            className="text-xs px-3 py-1 bg-zinc-800 text-zinc-200 hover:bg-zinc-700 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed rounded-md transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none"
          >
            Export Spend CSV
          </button>
          <button
            type="button"
            onClick={handleExportTreasuryCsv}
            disabled={!hasExportData}
            aria-label="Export treasury CSV for the current analytics filters"
            className="text-xs px-3 py-1 bg-zinc-800 text-zinc-200 hover:bg-zinc-700 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed rounded-md transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none"
          >
            Export Treasury CSV
          </button>
          <button
            type="button"
            onClick={handleDownloadStatement}
            disabled={!data}
            aria-label="Download PDF treasury statement for the current analytics filters"
            className="text-xs px-3 py-1 bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-md transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none"
          >
            Download Statement (PDF)
          </button>
        </div>
      </div>

      {/* ── Filters ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <label className="block text-xs text-zinc-500">
          From
          <input
            type="date"
            aria-label="Filter start date"
            value={filters.startDate}
            onChange={(event) =>
              setFilters((previous) => ({
                ...previous,
                startDate: event.target.value,
              }))
            }
            className="mt-1 w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-white text-sm focus:ring-2 focus:ring-zinc-400 focus:outline-none"
          />
        </label>
        <label className="block text-xs text-zinc-500">
          To
          <input
            type="date"
            aria-label="Filter end date"
            value={filters.endDate}
            onChange={(event) =>
              setFilters((previous) => ({
                ...previous,
                endDate: event.target.value,
              }))
            }
            className="mt-1 w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-white text-sm focus:ring-2 focus:ring-zinc-400 focus:outline-none"
          />
        </label>
        <label className="block text-xs text-zinc-500">
          Category
          <select
            aria-label="Filter by category"
            value={filters.category}
            onChange={(event) =>
              setFilters((previous) => ({
                ...previous,
                category: event.target.value as ProposalCategory | "all",
              }))
            }
            className="mt-1 w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-white text-sm focus:ring-2 focus:ring-zinc-400 focus:outline-none"
          >
            {CATEGORY_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-zinc-500">
          Owner
          <input
            type="text"
            aria-label="Filter by owner"
            value={filters.owner}
            onChange={(event) =>
              setFilters((previous) => ({
                ...previous,
                owner: event.target.value,
              }))
            }
            placeholder="Filter by proposer…"
            className="mt-1 w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-white text-sm placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none"
          />
        </label>
      </div>

      {/* ── Summary stat cards ────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6" aria-live="polite">
        <StatCard
          label="Total Disbursed"
          value={loading ? "…" : formatTotals(data?.summary.totalDisbursed ?? {})}
          sub="from executed transfers"
        />
        <StatCard
          label="Total Inflows"
          value={loading ? "…" : formatTotals(data?.summary.totalInflows ?? {})}
          sub="into the treasury"
        />
        <StatCard
          label="Active Proposals"
          value={loading ? "…" : String(data?.summary.activeProposals ?? 0)}
          sub="pending or ready"
        />
      </div>

      {/* ── Charts ────────────────────────────────────────────────── */}
      <SpendByCategoryChart
        data={spendByCategory}
        loading={loading}
        error={error}
        onRetry={refresh}
      />
      <SpendByOwnerChart
        data={spendByOwner}
        loading={loading}
        error={error}
        onRetry={refresh}
      />
      <TreasuryFlowChart
        data={data?.flow ?? []}
        loading={loading}
        error={error}
        onRetry={refresh}
      />
      <ProposalActivityChart
        loading={loading}
        error={error}
        onRetry={refresh}
      />
      <TreasuryBalanceChart
        data={balanceHistory}
        loading={loading}
        error={error}
        onRetry={refresh}
      />
    </>
  );
}
