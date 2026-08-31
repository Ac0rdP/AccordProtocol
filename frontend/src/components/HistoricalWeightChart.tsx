import { useEffect, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { WeightHistoryPoint } from "../lib/contract";
import {
  getHistoricalWeightChangeEvents,
  reconstructTotalWeightHistory,
} from "../lib/contract";

type HistoricalWeightChartProps = {
  currentTotalWeight: number;
  loading?: boolean;
};

export function HistoricalWeightChart({
  currentTotalWeight,
  loading = false,
}: HistoricalWeightChartProps) {
  const [history, setHistory] = useState<WeightHistoryPoint[]>([]);
  const [chartLoading, setChartLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadWeightHistory() {
      try {
        setChartLoading(true);
        setError(null);

        const events = await getHistoricalWeightChangeEvents();

        if (!active) return;

        const reconstructed = reconstructTotalWeightHistory(
          events,
          currentTotalWeight,
        );

        if (active) {
          setHistory(reconstructed);
        }
      } catch (err) {
        if (active) {
          console.error("Failed to load weight history:", err);
          setError("Failed to load weight history");
        }
      } finally {
        if (active) {
          setChartLoading(false);
        }
      }
    }

    loadWeightHistory();

    return () => {
      active = false;
    };
  }, [currentTotalWeight]);

  const displayLoading = loading || chartLoading;

  if (displayLoading) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-6">
        <h3 className="font-semibold text-sm mb-4">Voting Weight History</h3>
        <div className="h-64 flex items-center justify-center">
          <div className="text-zinc-500 text-sm">Loading chart...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-6">
        <h3 className="font-semibold text-sm mb-4">Voting Weight History</h3>
        <div className="h-64 flex items-center justify-center">
          <div className="text-red-400 text-sm">{error}</div>
        </div>
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-6">
        <h3 className="font-semibold text-sm mb-4">Voting Weight History</h3>
        <div className="h-64 flex items-center justify-center">
          <div className="text-zinc-500 text-sm">
            No weight history available yet
          </div>
        </div>
      </div>
    );
  }

  // Prepare data for the chart - include current total weight as last point if different
  const chartData = [...history];
  const lastHistoricalWeight =
    history.length > 0 ? history[history.length - 1].totalWeight : 0;

  // Add current weight as final data point if it differs from the last historical point
  if (currentTotalWeight !== lastHistoricalWeight) {
    chartData.push({
      timestamp: "Now",
      ledger: 0,
      totalWeight: currentTotalWeight,
      date: new Date(),
    });
  }

  // Format labels for x-axis - show dates or ledgers
  const formatXAxisLabel = (index: number) => {
    const point = chartData[index];
    if (!point) return "";

    // Show every nth label to avoid crowding
    const labelInterval = Math.max(1, Math.floor(chartData.length / 5));

    if (index % labelInterval === 0 || index === chartData.length - 1) {
      // Try to show date, fallback to ledger
      if (point.timestamp !== "Now") {
        const match = point.timestamp.match(/^(\w+ \d+)/);
        return match ? match[1] : `L${point.ledger}`;
      }
      return point.timestamp;
    }
    return "";
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-6">
      <div className="mb-4">
        <h3 className="font-semibold text-sm">Voting Weight History</h3>
        <p className="text-xs text-zinc-500 mt-1">
          Total voting weight over time based on owner weight changes
        </p>
      </div>

      <div className="w-full h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData}>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="rgba(113, 113, 122, 0.3)"
            />
            <XAxis
              dataKey="timestamp"
              stroke="#71717a"
              style={{ fontSize: "0.75rem" }}
              tickFormatter={(value, index) => formatXAxisLabel(index)}
            />
            <YAxis stroke="#71717a" style={{ fontSize: "0.75rem" }} />
            <Tooltip
              contentStyle={{
                backgroundColor: "#18181b",
                border: "1px solid #3f3f46",
                borderRadius: "0.5rem",
              }}
              labelStyle={{ color: "#e4e4e7" }}
              formatter={(value: number) => [value, "Total Weight"]}
              labelFormatter={(label: string) => `${label}`}
            />
            <Line
              type="monotone"
              dataKey="totalWeight"
              stroke="#10b981"
              strokeWidth={2}
              dot={{ fill: "#10b981", r: 4 }}
              activeDot={{ r: 6 }}
              isAnimationActive={true}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-4 flex items-center justify-between text-xs text-zinc-500">
        <span>
          {history.length > 0
            ? `${history.length} weight change${history.length !== 1 ? "s" : ""} recorded`
            : ""}
        </span>
        <span>Current: {currentTotalWeight} weight</span>
      </div>
    </div>
  );
}
