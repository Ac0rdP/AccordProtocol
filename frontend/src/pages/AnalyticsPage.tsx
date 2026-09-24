import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Proposal, ProposalCategory } from "../types/accord";
import { StatCard } from "../components/StatCard";
import { AnalyticsSectionState } from "../components/AnalyticsSectionState";
import {
  getContractUsdcBalance,
  getContractXlmBalance,
  getProposalsPaged,
  getThreshold,
  getTotalProposals,
  mapProposal,
} from "../lib/contract";
import {
  computeSpendByCategory,
  computeTreasuryFlow,
  DEFAULT_ANALYTICS_FILTERS,
  filterExecutedTransfers,
  type AnalyticsFilters,
  type CategoryFilter,
} from "../lib/analytics";

const CATEGORY_OPTIONS: { key: CategoryFilter; label: string }[] = [
  { key: "all", label: "All Categories" },
  { key: "Transfer", label: "Transfer" },
  { key: "Payroll", label: "Payroll" },
  { key: "Grant", label: "Grant" },
  { key: "Ops", label: "Ops" },
  { key: "Other", label: "Other" },
];

type LoadState = {
  proposals: Proposal[];
  xlmBalance: string | null;
  usdcBalance: string | null;
  loading: boolean;
  error: string | null;
};

async function loadAnalyticsData(): Promise<
  Omit<LoadState, "loading" | "error">
> {
  const [threshold, total] = await Promise.all([
    getThreshold(),
    getTotalProposals(),
  ]);
  const raw = total > 0 ? await getProposalsPaged(0, total) : [];
  const proposals = raw.map((p) => mapProposal(p, threshold));

  const [xlmBalance, usdcBalance] = await Promise.all([
    getContractXlmBalance().catch(() => null),
    getContractUsdcBalance().catch(() => null),
  ]);

  return { proposals, xlmBalance, usdcBalance };
}

export function AnalyticsPage() {
  const [state, setState] = useState<LoadState>({
    proposals: [],
    xlmBalance: null,
    usdcBalance: null,
    loading: true,
    error: null,
  });
  // Filters start at DEFAULT_ANALYTICS_FILTERS and are never persisted
  // (e.g. to localStorage or the URL), so navigating away and back to this
  // page always remounts it with a clean filter state.
  const [filters, setFilters] = useState<AnalyticsFilters>(
    DEFAULT_ANALYTICS_FILTERS,
  );

  const fetchData = () => {
    let active = true;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    loadAnalyticsData()
      .then((data) => {
        if (active) {
          setState({ ...data, loading: false, error: null });
        }
      })
      .catch((err) => {
        if (active) {
          setState((prev) => ({
            ...prev,
            loading: false,
            error:
              err instanceof Error
                ? err.message
                : "Failed to load analytics data",
          }));
        }
      });

    return () => {
      active = false;
    };
  };

  useEffect(fetchData, []);

  const filteredTransfers = useMemo(
    () => filterExecutedTransfers(state.proposals, filters),
    [state.proposals, filters],
  );

  const spendByCategory = useMemo(
    () => computeSpendByCategory(filteredTransfers),
    [filteredTransfers],
  );

  const treasuryFlow = useMemo(
    () => computeTreasuryFlow(filteredTransfers),
    [filteredTransfers],
  );

  const totalSpend = filteredTransfers.reduce(
    (sum, p) => sum + (parseFloat(p.amount) || 0),
    0,
  );
  const isEmpty =
    !state.loading && !state.error && filteredTransfers.length === 0;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h2 className="font-semibold">Analytics</h2>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <div>
          <label
            htmlFor="analytics-start-date"
            className="block text-xs text-zinc-500 mb-1"
          >
            From
          </label>
          <input
            id="analytics-start-date"
            type="date"
            value={filters.startDate}
            onChange={(e) =>
              setFilters((prev) => ({ ...prev, startDate: e.target.value }))
            }
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-white text-sm focus:ring-2 focus:ring-zinc-400 focus:outline-none"
          />
        </div>
        <div>
          <label
            htmlFor="analytics-end-date"
            className="block text-xs text-zinc-500 mb-1"
          >
            To
          </label>
          <input
            id="analytics-end-date"
            type="date"
            value={filters.endDate}
            onChange={(e) =>
              setFilters((prev) => ({ ...prev, endDate: e.target.value }))
            }
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-white text-sm focus:ring-2 focus:ring-zinc-400 focus:outline-none"
          />
        </div>
        <div>
          <label
            htmlFor="analytics-category"
            className="block text-xs text-zinc-500 mb-1"
          >
            Category
          </label>
          <select
            id="analytics-category"
            value={filters.category}
            onChange={(e) =>
              setFilters((prev) => ({
                ...prev,
                category: e.target.value as ProposalCategory | "all",
              }))
            }
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-white text-sm capitalize focus:ring-2 focus:ring-zinc-400 focus:outline-none"
          >
            {CATEGORY_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            htmlFor="analytics-owner"
            className="block text-xs text-zinc-500 mb-1"
          >
            Owner
          </label>
          <input
            id="analytics-owner"
            type="text"
            value={filters.owner}
            onChange={(e) =>
              setFilters((prev) => ({ ...prev, owner: e.target.value }))
            }
            placeholder="Filter by proposer…"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-white text-sm placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <StatCard
          label="Total Outflow"
          value={state.loading ? "…" : totalSpend.toFixed(2)}
          sub="in selected period"
        />
        <StatCard
          label="Transactions"
          value={state.loading ? "…" : String(filteredTransfers.length)}
          sub="executed transfers"
        />
        <StatCard
          label="XLM Balance"
          value={state.loading ? "…" : (state.xlmBalance ?? "N/A")}
          sub="current treasury"
        />
        <StatCard
          label="USDC Balance"
          value={state.loading ? "…" : (state.usdcBalance ?? "N/A")}
          sub="current treasury"
        />
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-6">
        <h3 className="font-semibold text-sm mb-4">Spend by Category</h3>
        <AnalyticsSectionState
          loading={state.loading}
          error={state.error}
          empty={isEmpty}
          emptyMessage="No spend data matches the selected filters."
          onRetry={fetchData}
        >
          <div className="w-full h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={spendByCategory}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="rgba(113, 113, 122, 0.3)"
                />
                <XAxis
                  dataKey="category"
                  stroke="#71717a"
                  style={{ fontSize: "0.75rem" }}
                />
                <YAxis stroke="#71717a" style={{ fontSize: "0.75rem" }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#18181b",
                    border: "1px solid #3f3f46",
                    borderRadius: "0.5rem",
                  }}
                  labelStyle={{ color: "#e4e4e7" }}
                />
                <Bar dataKey="total" fill="#10b981" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </AnalyticsSectionState>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-6">
        <h3 className="font-semibold text-sm mb-4">
          Treasury Outflow Over Time
        </h3>
        <AnalyticsSectionState
          loading={state.loading}
          error={state.error}
          empty={isEmpty}
          emptyMessage="No treasury flow data matches the selected filters."
          onRetry={fetchData}
        >
          <div className="w-full h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={treasuryFlow}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="rgba(113, 113, 122, 0.3)"
                />
                <XAxis
                  dataKey="period"
                  stroke="#71717a"
                  style={{ fontSize: "0.75rem" }}
                />
                <YAxis stroke="#71717a" style={{ fontSize: "0.75rem" }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#18181b",
                    border: "1px solid #3f3f46",
                    borderRadius: "0.5rem",
                  }}
                  labelStyle={{ color: "#e4e4e7" }}
                />
                <Line
                  type="monotone"
                  dataKey="cumulative"
                  stroke="#10b981"
                  strokeWidth={2}
                  dot={{ fill: "#10b981", r: 4 }}
                  activeDot={{ r: 6 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </AnalyticsSectionState>
      </div>
    </>
  );
}
