import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AnalyticsSectionState } from "./AnalyticsSectionState";
import type { TreasuryBalancePoint } from "../lib/analytics";

type TreasuryBalanceChartProps = {
  data: TreasuryBalancePoint[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
};

export function TreasuryBalanceChart({
  data,
  loading = false,
  error = null,
  onRetry,
}: TreasuryBalanceChartProps) {
  const isEmpty = !loading && !error && data.length === 0;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-semibold text-sm">Treasury Balance Over Time</h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            Historical XLM and USDC treasury holdings over time
          </p>
        </div>
      </div>

      <AnalyticsSectionState
        loading={loading}
        error={error}
        empty={isEmpty}
        emptyMessage="No treasury balance time-series data available."
        onRetry={onRetry}
      >
        <div className="w-full h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(113, 113, 122, 0.3)"
              />
              <XAxis
                dataKey="timestamp"
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
              <Legend
                wrapperStyle={{ fontSize: "0.75rem", paddingTop: "0.5rem" }}
              />
              <Line
                type="monotone"
                dataKey="xlm"
                name="XLM"
                stroke="#10b981"
                strokeWidth={2}
                dot={{ fill: "#10b981", r: 4 }}
                activeDot={{ r: 6 }}
              />
              <Line
                type="monotone"
                dataKey="usdc"
                name="USDC"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={{ fill: "#3b82f6", r: 4 }}
                activeDot={{ r: 6 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </AnalyticsSectionState>
    </div>
  );
}
