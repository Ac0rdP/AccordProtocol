import { useEffect, useState, useMemo } from "react";
import type { RecurringSchedule, RecurringScheduleStatus } from "../types/accord";
import { RecurringPaymentCard } from "../components/RecurringPaymentCard";
import {
  getRecurringPaymentsPaged,
  getTotalRecurringPayments,
} from "../lib/contract";

type StatusFilter = "all" | RecurringScheduleStatus;

const TABS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "paused", label: "Paused" },
  { key: "completed", label: "Completed" },
  { key: "cancelled", label: "Cancelled" },
];

const PAGE_SIZE = 20;
const TIMELINE_HORIZON_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

type TimelineEntry = {
  date: Date;
  dateLabel: string;
  scheduleId: number;
  amount: string;
  token?: string;
  recipient: string;
};

function buildTimeline(schedules: RecurringSchedule[]): TimelineEntry[] {
  const now = Date.now();
  const horizon = now + TIMELINE_HORIZON_MS;
  const entries: TimelineEntry[] = [];

  for (const s of schedules) {
    if (s.status !== "active") continue;
    if (s.nextDisbursementTs === undefined || s.interval === undefined) continue;

    let ts = s.nextDisbursementTs;
    while (ts <= horizon) {
      if (ts >= now) {
        const d = new Date(ts);
        entries.push({
          date: d,
          dateLabel: d.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          }),
          scheduleId: s.id,
          amount: s.amount,
          token: s.token,
          recipient: s.recipient,
        });
      }
      ts += s.interval * 1000;
    }
  }

  entries.sort((a, b) => a.date.getTime() - b.date.getTime());
  return entries;
}

function DisbursementTimeline({ schedules }: { schedules: RecurringSchedule[] }) {
  const entries = useMemo(() => buildTimeline(schedules), [schedules]);

  if (entries.length === 0) return null;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 mb-4">
      <h3 className="text-sm font-semibold text-zinc-300 mb-3">Upcoming Disbursements</h3>
      <div className="relative">
        <div className="absolute left-3 top-0 bottom-0 w-px bg-zinc-800" />
        <div className="space-y-3">
          {entries.slice(0, 20).map((entry, i) => (
            <div key={`${entry.scheduleId}-${i}`} className="flex items-start gap-3 pl-1">
              <div className="relative z-10 mt-1.5">
                <div className="h-2 w-2 rounded-full bg-emerald-500" />
              </div>
              <div className="flex-1 min-w-0 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="text-xs text-zinc-400">{entry.dateLabel}</span>
                  <span className="text-xs text-zinc-600 mx-1.5">·</span>
                  <span className="text-xs text-zinc-500">Schedule #{entry.scheduleId}</span>
                </div>
                <div className="text-xs text-zinc-300 shrink-0">
                  {entry.amount} {entry.token ?? ""}
                </div>
              </div>
            </div>
          ))}
        </div>
        {entries.length > 20 && (
          <p className="text-xs text-zinc-600 mt-2 pl-6">
            + {entries.length - 20} more upcoming disbursements
          </p>
        )}
      </div>
    </div>
  );
}

export function RecurringPage({
  walletAddress,
}: {
  walletAddress?: string | null;
}) {
  const [activeTab, setActiveTab] = useState<StatusFilter>("all");
  const [schedules, setSchedules] = useState<RecurringSchedule[]>([]);
  const [offset, setOffset] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = true;
    setLoading(true);

    (async () => {
      try {
        const total = await getTotalRecurringPayments();
        if (cancelled) return;
        setTotalCount(total);

        if (total > 0) {
          const initial = await getRecurringPaymentsPaged(0, Math.min(total, PAGE_SIZE));
          if (!cancelled) {
            setSchedules(initial);
            setOffset(initial.length);
          }
        }
      } catch {
        // noop
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, []);

  const hasMore = offset < totalCount;

  const handleLoadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const next = await getRecurringPaymentsPaged(offset, PAGE_SIZE);
      setSchedules((prev) => [...prev, ...next]);
      setOffset((prev) => prev + next.length);
    } catch {
      // noop
    } finally {
      setLoadingMore(false);
    }
  };

  const filtered = activeTab === "all"
    ? schedules
    : schedules.filter((s) => s.status === activeTab);

  const activeSchedules = schedules.filter((s) => s.status === "active");

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold">Recurring Schedules</h2>
        <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-1 rounded-lg">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              aria-label={`Filter by ${tab.label} status`}
              aria-pressed={activeTab === tab.key}
              className={`text-xs px-3 py-1 rounded-md capitalize transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none ${
                activeTab === tab.key
                  ? "bg-zinc-700 text-white"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {!loading && activeSchedules.length > 0 && (
        <DisbursementTimeline schedules={activeSchedules} />
      )}

      <div className="space-y-3">
        {loading ? (
          <>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 animate-pulse h-32" />
            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 animate-pulse h-32" />
          </>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-zinc-500 text-sm">
            <p className="font-semibold mb-2">No schedules found</p>
            <p>
              {activeTab === "all"
                ? "No recurring schedules have been created yet."
                : `No ${activeTab} schedules found.`}
            </p>
          </div>
        ) : (
          filtered.map((schedule) => (
            <RecurringPaymentCard
              key={schedule.id}
              schedule={schedule}
              walletAddress={walletAddress}
            />
          ))
        )}
      </div>

      {hasMore && (
        <div className="flex justify-center mt-6">
          <button
            type="button"
            onClick={handleLoadMore}
            disabled={loadingMore}
            aria-label="Load more schedules"
            className="w-full py-3 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-sm font-medium text-zinc-300 hover:text-white transition-all flex items-center justify-center gap-2 focus:ring-2 focus:ring-zinc-400 focus:outline-none"
          >
            {loadingMore ? (
              <>
                <svg className="animate-spin h-4 w-4 text-zinc-400" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <span>Loading schedules...</span>
              </>
            ) : (
              "Load More"
            )}
          </button>
        </div>
      )}
    </>
  );
}
