import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { jsPDF } from "jspdf";
import { StatCard } from "../components/StatCard";
import { AnalyticsSectionState } from "../components/AnalyticsSectionState";
import { SpendByCategoryChart } from "../components/SpendByCategoryChart";
import { SpendByOwnerChart } from "../components/SpendByOwnerChart";
import { useTreasuryAnalytics } from "../hooks/useTreasuryAnalytics";
import { formatCurrency } from "../lib/soroban";
import { TreasuryBalanceChart } from "../components/TreasuryBalanceChart";
import { ProposalActivityChart } from "../components/ProposalActivityChart";
import {
  getContractUsdcBalance,
  getContractXlmBalance,
  getProposalsPaged,
  getThreshold,
  getTotalProposals,
  mapProposal,
} from "../lib/contract";
import {
  buildExportFilename,
  buildSpendCsv,
  buildTreasuryCsv,
  DEFAULT_ANALYTICS_FILTERS,
  downloadCsv,
  enrichWithShares,
  fetchTreasuryBalanceHistory,
  filterExecutedTransfers,
  type AnalyticsFilters,
  type CategoryFilter,
  type SpendByCategoryRow,
  type SpendByOwner,
  type TreasuryFlowPoint,
} from "../lib/analytics";
import type {
  AnalyticsAmount,
  AnalyticsQuery,
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
    ...(filters.category !== "all" ? { category: filters.category } : {}),
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

function toSpendByCategory(
  rows: { category: ProposalCategory; total: string; count: number; share: number }[],
): SpendByCategoryRow[] {
  return rows.map((row) => ({
    category: row.category,
    total: Number(row.total) || 0,
    count: row.count,
    share: row.share,
  }));
}

function toSpendByOwner(
  rows: { owner: string; total: string; count: number }[],
): SpendByOwner[] {
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

function toTreasuryFlow(rows: TreasuryFlowBucket[]): TreasuryFlowPoint[] {
  const byPeriod = new Map<string, number>();
  for (const row of rows) {
    const period = row.timestamp.slice(0, 7);
    byPeriod.set(period, (byPeriod.get(period) ?? 0) + (Number(row.outflow) || 0));
  }
  let cumulative = 0;
  return [...byPeriod.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([period, outflow]) => {
      cumulative += outflow;
      return { period, outflow, cumulative };
    });
}

export function AnalyticsPage() {
  const [filters, setFilters] = useState<AnalyticsFilters>(
    DEFAULT_ANALYTICS_FILTERS,
  );
  const query = useMemo(() => toQuery(filters), [filters]);
  const { data, loading, error, refresh } = useTreasuryAnalytics(query);

  const fetchData = useCallback(() => {
    let active = true;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    loadAnalyticsData()
      .then((data) => {
        if (active) setState({ ...data, loading: false, error: null });
      })
      .catch((err) => {
        if (active)
          setState((prev) => ({
            ...prev,
            loading: false,
            error:
              err instanceof Error
                ? err.message
                : "Failed to load analytics data",
          }));
      })
      .finally(() => {
        if (!active) return;
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    return fetchData();
  }, [fetchData]);

  const filteredTransfers = useMemo(
    () => filterExecutedTransfers(state.proposals, filters),
    [state.proposals, filters],
  );

  const spendByCategory = useMemo(
    () => toSpendByCategory(data?.spendByCategory ?? []),
    [data?.spendByCategory],
  );
  const spendByOwner = useMemo(
    () => toSpendByOwner(data?.spendByOwner ?? []),
    [data?.spendByOwner],
  );
  const treasuryFlow = useMemo(
    () => toTreasuryFlow(data?.flow ?? []),
    [data?.flow],
  );
  const isEmpty = !loading && !error && !data;
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
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h2 className="font-semibold">Analytics</h2>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={handleExportSpendCsv} disabled={!hasExportData} aria-label="Export spend CSV for the current analytics filters" className="text-xs px-3 py-1 bg-zinc-800 text-zinc-200 hover:bg-zinc-700 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed rounded-md transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none">Export Spend CSV</button>
          <button type="button" onClick={handleExportTreasuryCsv} disabled={!hasExportData} aria-label="Export treasury CSV for the current analytics filters" className="text-xs px-3 py-1 bg-zinc-800 text-zinc-200 hover:bg-zinc-700 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed rounded-md transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none">Export Treasury CSV</button>
          <button type="button" onClick={handleDownloadStatement} disabled={!data} aria-label="Download PDF treasury statement for the current analytics filters" className="text-xs px-3 py-1 bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-md transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none">Download Statement (PDF)</button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <label className="block text-xs text-zinc-500">From<input type="date" aria-label="Filter start date" value={filters.startDate} onChange={(event) => setFilters((previous) => ({ ...previous, startDate: event.target.value }))} className="mt-1 w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-white text-sm focus:ring-2 focus:ring-zinc-400 focus:outline-none" /></label>
        <label className="block text-xs text-zinc-500">To<input type="date" aria-label="Filter end date" value={filters.endDate} onChange={(event) => setFilters((previous) => ({ ...previous, endDate: event.target.value }))} className="mt-1 w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-white text-sm focus:ring-2 focus:ring-zinc-400 focus:outline-none" /></label>
        <label className="block text-xs text-zinc-500">Category<select aria-label="Filter by category" value={filters.category} onChange={(event) => setFilters((previous) => ({ ...previous, category: event.target.value as ProposalCategory | "all" }))} className="mt-1 w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-white text-sm focus:ring-2 focus:ring-zinc-400 focus:outline-none">{CATEGORY_OPTIONS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
        <label className="block text-xs text-zinc-500">Owner<input type="text" aria-label="Filter by owner" value={filters.owner} onChange={(event) => setFilters((previous) => ({ ...previous, owner: event.target.value }))} placeholder="Filter by proposer…" className="mt-1 w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-white text-sm placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none" /></label>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6" aria-live="polite">
        <StatCard label="Total Disbursed" value={loading ? "…" : formatTotals(data?.summary.totalDisbursed ?? {})} sub="from executed transfers" />
        <StatCard label="Total Inflows" value={loading ? "…" : formatTotals(data?.summary.totalInflows ?? {})} sub="into the treasury" />
        <StatCard label="Active Proposals" value={loading ? "…" : String(data?.summary.activeProposals ?? 0)} sub="pending or ready" />
      </div>
      <SpendByCategoryChart
        data={spendByCategory}
        loading={state.loading}
        error={state.error}
        onRetry={fetchData}
      />

      <ProposalActivityChart
        proposals={state.proposals}
        loading={state.loading}
        error={state.error}
        onRetry={fetchData}
      />

      <TreasuryBalanceChart
        data={state.balanceHistory}
        loading={state.loading}
        error={state.error}
        onRetry={fetchData}
      />

      <SpendByCategoryChart data={spendByCategory} loading={loading} error={error} onRetry={refresh} />
      <SpendByOwnerChart data={spendByOwner} loading={loading} error={error} onRetry={refresh} />
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-6">
        <h3 className="font-semibold text-sm mb-1">Treasury Outflow Over Time</h3>
        <p className="text-xs text-zinc-500 mb-4">Cumulative treasury outflow over the selected period.</p>
        <AnalyticsSectionState loading={loading} error={error} empty={isEmpty || treasuryFlow.length === 0} emptyMessage="No treasury flow data matches the selected filters." onRetry={refresh}>
          <div className="w-full h-64" role="img" aria-label={`Treasury outflow over time chart. ${treasuryFlow.length} data points shown.`}>
            <ResponsiveContainer width="100%" height="100%"><LineChart data={treasuryFlow}><CartesianGrid strokeDasharray="3 3" stroke="rgba(113, 113, 122, 0.3)" /><XAxis dataKey="period" stroke="#71717a" /><YAxis stroke="#71717a" /><Tooltip /><Line type="monotone" dataKey="cumulative" stroke="#10b981" strokeWidth={2} /></LineChart></ResponsiveContainer>
          </div>
          <p className="sr-only">{treasuryFlow.length ? `Cumulative outflow ends at ${treasuryFlow[treasuryFlow.length - 1].cumulative.toFixed(2)}.` : "No treasury outflow data is available."}</p>
        </AnalyticsSectionState>
      </div>
    </>
  );
}
