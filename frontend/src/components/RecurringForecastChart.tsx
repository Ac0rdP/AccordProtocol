import { useMemo, useState } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { RecurringSchedule } from "../types/accord";
import { computeRecurringForecast } from "../lib/forecast";

export type RecurringForecastChartProps = {
  schedules: RecurringSchedule[];
  treasuryBalance?: number;
  loading?: boolean;
};

export function RecurringForecastChart({
  schedules,
  treasuryBalance = 10000,
  loading = false,
}: RecurringForecastChartProps) {
  const [horizonMonths, setHorizonMonths] = useState<number>(6);

  const forecast = useMemo(
    () => computeRecurringForecast(schedules, treasuryBalance, horizonMonths),
    [schedules, treasuryBalance, horizonMonths],
  );

  const hasActiveSchedules = schedules.some((s) => s.status === "active");

  if (loading) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 mb-6 animate-pulse">
        <div className="h-4 w-48 bg-zinc-800 rounded mb-4" />
        <div className="h-64 bg-zinc-800/50 rounded" />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 sm:p-6 mb-6">
      {/* Header and Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h3 className="font-semibold text-sm sm:text-base text-zinc-100">
            Projected Recurring Outflow & Runway
          </h3>
          <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">
            Forward-looking forecast based on active recurring payment schedules, caps, and end dates
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Horizon Selector */}
          <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-950 p-1">
            {[3, 6, 12].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setHorizonMonths(m)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  horizonMonths === m
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {m}m
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        {/* Runway Metric */}
        <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-3.5">
          <p className="text-xs text-zinc-400 font-sans">Estimated Runway</p>
          <div className="mt-1 flex items-baseline gap-2">
            <span
              className={`text-lg font-semibold font-mono ${
                forecast.runway.isDepleted
                  ? "text-red-400"
                  : forecast.runway.runwayMonths !== null && forecast.runway.runwayMonths < 3
                  ? "text-amber-400"
                  : "text-emerald-400"
              }`}
            >
              {forecast.runway.runwayMonths !== null
                ? `${forecast.runway.runwayMonths} mo`
                : "∞ (No outflow)"}
            </span>
            <span className="text-[11px] text-zinc-600 dark:text-zinc-400">
              at current treasury balance
            </span>
          </div>
        </div>

        {/* Average Monthly Outflow */}
        <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-3.5">
          <p className="text-xs text-zinc-400 font-sans">Avg Monthly Outflow</p>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-lg font-semibold font-mono text-white">
              ~{forecast.averageMonthlyOutflow.toLocaleString()} XLM
            </span>
            <span className="text-[11px] text-zinc-600 dark:text-zinc-400">per month</span>
          </div>
        </div>

        {/* Total Projected Outflow */}
        <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-3.5">
          <p className="text-xs text-zinc-400 font-sans">
            Total {horizonMonths}-Month Projection
          </p>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-lg font-semibold font-mono text-white">
              {forecast.totalProjectedOutflow.toLocaleString()} XLM
            </span>
            <span className="text-[11px] text-zinc-600 dark:text-zinc-400">committed</span>
          </div>
        </div>
      </div>

      {/* Chart or Empty State */}
      {!hasActiveSchedules ? (
        <div className="text-center py-12 rounded-lg border border-dashed border-zinc-800 bg-zinc-950/30">
          <p className="text-sm font-medium text-zinc-400 mb-1">
            No active recurring schedules
          </p>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            Create or activate recurring payment schedules to view treasury outflow projections and runway modeling.
          </p>
        </div>
      ) : (
        <div className="w-full h-64 sm:h-72">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={forecast.points} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis dataKey="label" stroke="#71717a" tick={{ fontSize: 11 }} />
              <YAxis stroke="#71717a" tick={{ fontSize: 11 }} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#18181b",
                  border: "1px solid #3f3f46",
                  borderRadius: "0.5rem",
                  fontSize: "0.75rem",
                  color: "#f4f4f5",
                }}
              />
              <Legend wrapperStyle={{ fontSize: "0.75rem", paddingTop: "0.5rem" }} />
              <Bar
                name="Monthly Outflow"
                dataKey="outflow"
                fill="#10b981"
                radius={[4, 4, 0, 0]}
              />
              <Line
                name="Cumulative Outflow"
                type="monotone"
                dataKey="cumulativeOutflow"
                stroke="#38bdf8"
                strokeWidth={2}
                dot={{ r: 3 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
