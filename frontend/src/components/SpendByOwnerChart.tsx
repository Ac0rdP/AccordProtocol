import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AnalyticsSectionState } from "./AnalyticsSectionState";
import type { SpendByOwner } from "../lib/analytics";

const PALETTE = [
  "#3b82f6", // blue
  "#10b981", // emerald
  "#8b5cf6", // violet
  "#f59e0b", // amber
  "#ec4899", // pink
  "#06b6d4", // cyan
];

function barColour(index: number): string {
  return PALETTE[index % PALETTE.length];
}

type TooltipPayloadEntry = {
  payload?: SpendByOwner;
  value?: number;
};

function OwnerTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
}) {
  if (!active || !payload?.[0]?.payload) return null;
  const row = payload[0].payload;
  return (
    <div
      style={{
        backgroundColor: "#18181b",
        border: "1px solid #3f3f46",
        borderRadius: "0.5rem",
        padding: "0.5rem 0.75rem",
        fontSize: "0.75rem",
        color: "#e4e4e7",
      }}
    >
      <p style={{ fontWeight: 600, marginBottom: 4, fontFamily: "monospace" }}>
        {row.owner}
      </p>
      <p>Spend Total: {row.total.toFixed(2)}</p>
      <p>Transactions: {row.count}</p>
    </div>
  );
}

type SpendByOwnerChartProps = {
  data: SpendByOwner[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
};

export function SpendByOwnerChart({
  data,
  loading = false,
  error = null,
  onRetry,
}: SpendByOwnerChartProps) {
  const isEmpty = !loading && !error && data.length === 0;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-6">
      <div className="mb-4">
        <h3 className="font-semibold text-sm">Spend by Proposing Owner</h3>
        <p className="text-xs text-zinc-500 mt-0.5">
          Treasury activity and total spend driven per owner address
        </p>
      </div>

      <AnalyticsSectionState
        loading={loading}
        error={error}
        empty={isEmpty}
        emptyMessage="No spend data available by proposing owner for the selected filters."
        onRetry={onRetry}
      >
        <div className="w-full h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(113,113,122,0.3)"
                vertical={false}
              />
              <XAxis
                dataKey="shortOwner"
                stroke="#71717a"
                style={{ fontSize: "0.7rem" }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                stroke="#71717a"
                style={{ fontSize: "0.7rem" }}
                tickLine={false}
                axisLine={false}
                width={48}
              />
              <Tooltip
                content={<OwnerTooltip />}
                cursor={{ fill: "rgba(255,255,255,0.04)" }}
              />
              <Bar dataKey="total" radius={[4, 4, 0, 0]}>
                {data.map((_, index) => (
                  <Cell key={index} fill={barColour(index)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <ul className="mt-4 space-y-1 divide-y divide-zinc-800/40">
          {data.map((row, i) => (
            <li
              key={row.owner}
              className="flex items-center gap-2 pt-1 text-xs"
            >
              <span
                className="inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0"
                style={{ backgroundColor: barColour(i) }}
              />
              <span
                className="text-zinc-300 font-mono flex-1 truncate"
                title={row.owner}
              >
                {row.shortOwner}
              </span>
              <span className="text-zinc-400 tabular-nums">
                {row.total.toFixed(2)}
              </span>
              <span className="text-zinc-500 text-[11px] tabular-nums ml-2">
                ({row.count} tx)
              </span>
            </li>
          ))}
        </ul>
      </AnalyticsSectionState>
    </div>
  );
}
