import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AnalyticsSectionState } from "./AnalyticsSectionState";
import { formatTimeSeriesLabel } from "../lib/soroban";
import type { AnalyticsGranularity, TreasuryFlowBucket } from "../types/accord";

export type TreasuryFlowChartPoint = {
  period: string;
  inflow: number;
  outflow: number;
};

export type TreasuryFlowChartProps = {
  /** Raw per-token, per-bucket data from the /treasury/flow API. */
  data: TreasuryFlowBucket[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Controlled granularity; when omitted the component manages its own state. */
  granularity?: AnalyticsGranularity;
  onGranularityChange?: (g: AnalyticsGranularity) => void;
};

/**
 * Merge per-token buckets that share the same timestamp into a single display
 * point by summing inflows and outflows across all tokens in the window.
 * Returns one entry per unique period label, sorted chronologically.
 */
function bucketsToBars(
  data: TreasuryFlowBucket[],
  granularity: AnalyticsGranularity,
): TreasuryFlowChartPoint[] {
  const byPeriod = new Map<string, { inflow: number; outflow: number; sortKey: string }>();

  for (const row of data) {
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

  return [...byPeriod.entries()]
    .sort(([, a], [, b]) => a.sortKey.localeCompare(b.sortKey))
    .map(([period, { inflow, outflow }]) => ({ period, inflow, outflow }));
}

export function TreasuryFlowChart({
  data,
  loading = false,
  error = null,
  onRetry,
  granularity: controlledGranularity,
  onGranularityChange,
}: TreasuryFlowChartProps) {
  const [internalGranularity, setInternalGranularity] =
    useState<AnalyticsGranularity>("month");

  const activeGranularity = controlledGranularity ?? internalGranularity;

  const handleGranularityChange = (newG: AnalyticsGranularity) => {
    setInternalGranularity(newG);
    onGranularityChange?.(newG);
  };

  const chartData = useMemo(
    () => bucketsToBars(data, activeGranularity),
    [data, activeGranularity],
  );

  const isEmpty = !loading && !error && chartData.length === 0;

  const totalInflow = chartData.reduce((sum, p) => sum + p.inflow, 0);
  const totalOutflow = chartData.reduce((sum, p) => sum + p.outflow, 0);

  return (
    <div
      className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-6"
      data-testid="treasury-flow-chart-container"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h3 className="font-semibold text-sm">Treasury Inflow vs Outflow</h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            Deposits and executed transfers per window
          </p>
        </div>
        <div
          className="flex items-center gap-1 bg-zinc-800/80 p-1 rounded-lg"
          role="group"
          aria-label="Granularity selection"
        >
          {(["day", "week", "month"] as const).map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => handleGranularityChange(g)}
              aria-pressed={activeGranularity === g}
              data-testid={`flow-granularity-${g}`}
              className={`text-xs px-2.5 py-1 rounded-md transition-colors capitalize ${
                activeGranularity === g
                  ? "bg-zinc-700 text-white font-medium"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {g === "day" ? "Daily" : g === "week" ? "Weekly" : "Monthly"}
            </button>
          ))}
        </div>
      </div>

      <AnalyticsSectionState
        loading={loading}
        error={error}
        empty={isEmpty}
        emptyMessage="No treasury flow data matches the selected filters."
        onRetry={onRetry}
      >
        <div
          className="w-full h-64"
          role="img"
          aria-label={`Treasury inflow vs outflow chart. ${chartData.length} data points shown.`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} barGap={2}>
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
                formatter={(value) =>
                  typeof value === "number" ? value.toFixed(2) : value
                }
              />
              <Legend
                wrapperStyle={{ fontSize: "0.75rem", paddingTop: "0.5rem" }}
              />
              <Bar
                dataKey="inflow"
                name="Inflow"
                fill="#10b981"
                radius={[4, 4, 0, 0]}
              />
              <Bar
                dataKey="outflow"
                name="Outflow"
                fill="#f43f5e"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="sr-only">
          {chartData.length
            ? `Total inflow: ${totalInflow.toFixed(2)}. Total outflow: ${totalOutflow.toFixed(2)}.`
            : "No treasury flow data is available."}
        </p>
      </AnalyticsSectionState>
    </div>
  );
}
