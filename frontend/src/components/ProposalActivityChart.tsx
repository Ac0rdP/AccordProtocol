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
import {
  computeProposalActivity,
  type ProposalActivityPoint,
} from "../lib/analytics";
import type { AnalyticsGranularity, Proposal } from "../types/accord";

export type ProposalActivityChartProps = {
  proposals?: Proposal[];
  data?: ProposalActivityPoint[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  granularity?: AnalyticsGranularity;
  onGranularityChange?: (g: AnalyticsGranularity) => void;
};

export function ProposalActivityChart({
  proposals = [],
  data,
  loading = false,
  error = null,
  onRetry,
  granularity: controlledGranularity,
  onGranularityChange,
}: ProposalActivityChartProps) {
  const [internalGranularity, setInternalGranularity] =
    useState<AnalyticsGranularity>("day");

  const activeGranularity = controlledGranularity ?? internalGranularity;

  const handleGranularityChange = (newG: AnalyticsGranularity) => {
    setInternalGranularity(newG);
    onGranularityChange?.(newG);
  };

  const chartData = useMemo(() => {
    if (data) return data;
    return computeProposalActivity(proposals, activeGranularity);
  }, [data, proposals, activeGranularity]);

  const isEmpty = !loading && !error && chartData.length === 0;

  return (
    <div
      className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-6"
      data-testid="proposal-activity-chart-container"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h3 className="font-semibold text-sm">Proposal Activity</h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            Proposals created vs executed over time
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
              data-testid={`granularity-${g}`}
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
        emptyMessage="No proposal activity data available."
        onRetry={onRetry}
      >
        <div className="w-full h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(113, 113, 122, 0.3)"
              />
              <XAxis
                dataKey="period"
                stroke="#71717a"
                style={{ fontSize: "0.75rem" }}
              />
              <YAxis
                allowDecimals={false}
                stroke="#71717a"
                style={{ fontSize: "0.75rem" }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#18181b",
                  border: "1px solid #3f3f46",
                  borderRadius: "0.5rem",
                }}
                labelStyle={{ color: "#e4e4e7" }}
              />
              <Legend
                wrapperStyle={{ fontSize: "0.75rem", paddingTop: "0.5rem" }}
              />
              <Bar
                dataKey="created"
                name="Created"
                fill="#3b82f6"
                radius={[4, 4, 0, 0]}
              />
              <Bar
                dataKey="executed"
                name="Executed"
                fill="#10b981"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </AnalyticsSectionState>
    </div>
  );
}
