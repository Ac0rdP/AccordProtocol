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
import { formatShare, type SpendByCategoryRow } from "../lib/analytics";

/* -------------------------------------------------------------------------- */
/*  Colour palette — one distinct hue per slot, wraps for >6 categories       */
/* -------------------------------------------------------------------------- */
const PALETTE = [
  "#10b981", // emerald
  "#3b82f6", // blue
  "#f59e0b", // amber
  "#ec4899", // pink
  "#8b5cf6", // violet
  "#06b6d4", // cyan
];

function barColour(index: number): string {
  return PALETTE[index % PALETTE.length];
}

/* -------------------------------------------------------------------------- */
/*  Custom tooltip                                                              */
/* -------------------------------------------------------------------------- */
type TooltipPayloadEntry = {
  payload?: SpendByCategoryRow;
  value?: number;
};

function CategoryTooltip({
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
      <p style={{ fontWeight: 600, marginBottom: 4 }}>{row.category}</p>
      <p>Amount: {row.total.toFixed(2)}</p>
      <p>Share: {formatShare(row.share)}</p>
      <p>Transactions: {row.count}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Share legend row                                                            */
/* -------------------------------------------------------------------------- */
function CategoryLegend({ rows }: { rows: SpendByCategoryRow[] }) {
  return (
    <ul className="mt-4 space-y-1">
      {rows.map((row, i) => (
        <li key={`${row.category}-${i}`} className="flex items-center gap-2 text-xs">
          <span
            className="inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0"
            style={{ backgroundColor: barColour(i) }}
          />
          <span className="text-zinc-300 flex-1 truncate">{row.category}</span>
          <span className="text-zinc-400 tabular-nums">
            {row.total.toFixed(2)}
          </span>
          <span
            className="text-zinc-500 tabular-nums w-12 text-right"
          >
            {formatShare(row.share)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/*  Main component                                                              */
/* -------------------------------------------------------------------------- */
type SpendByCategoryChartProps = {
  data: SpendByCategoryRow[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
};

export function SpendByCategoryChart({
  data,
  loading = false,
  error = null,
  onRetry,
}: SpendByCategoryChartProps) {
  const isEmpty = !loading && !error && data.length === 0;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-6">
      <div className="mb-4">
        <h3 className="font-semibold text-sm">Spend by Category</h3>
        <p className="text-xs text-zinc-500 mt-0.5">
          Total outflow and share per proposal category
        </p>
        <p className="sr-only">
          {data.length
            ? `Category spend chart with ${data.length} categories. ${data.map((row) => `${row.category}: ${row.total.toFixed(2)} (${formatShare(row.share)})`).join("; ")}.`
            : "No category spend data is available."}
        </p>
      </div>

      <AnalyticsSectionState
        loading={loading}
        error={error}
        empty={isEmpty}
        emptyMessage="No spend data available for the selected filters."
        onRetry={onRetry}
      >
        <div
          className="w-full h-56"
          role="img"
          aria-label={`Spend by category chart with ${data.length} categories`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(113,113,122,0.3)"
                vertical={false}
              />
              <XAxis
                dataKey="category"
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
              <Tooltip content={<CategoryTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
              <Bar dataKey="total" radius={[4, 4, 0, 0]}>
                {data.map((_, index) => (
                  <Cell key={index} fill={barColour(index)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <CategoryLegend rows={data} />
      </AnalyticsSectionState>
    </div>
  );
}
