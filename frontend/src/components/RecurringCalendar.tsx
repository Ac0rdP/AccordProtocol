import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { RecurringSchedule } from "../types/accord";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { LoadingState } from "./LoadingState";
import {
  buildCalendarEvents,
  dayKey,
  getVisibleDays,
  groupByDay,
  shiftAnchor,
  startOfDay,
  type CalendarEventState,
  type CalendarView,
} from "../lib/recurringCalendar";

type RecurringCalendarProps = {
  schedules: RecurringSchedule[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Initial date shown; defaults to today. */
  initialDate?: Date;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const STATE_STYLES: Record<CalendarEventState, string> = {
  due: "bg-emerald-500/15 text-emerald-300",
  paused: "bg-amber-500/15 text-amber-300",
  completed: "bg-zinc-700/60 text-zinc-300",
};

const KEY_STEPS: Record<string, number> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -7,
  ArrowDown: 7,
};

export function RecurringCalendar({
  schedules,
  loading = false,
  error = null,
  onRetry,
  initialDate,
}: RecurringCalendarProps) {
  const [view, setView] = useState<CalendarView>("month");
  const [selected, setSelected] = useState(() => startOfDay(initialDate ?? new Date()));
  const gridRef = useRef<HTMLDivElement>(null);

  const days = useMemo(() => getVisibleDays(selected, view), [selected, view]);
  const eventsByDay = useMemo(() => {
    const end = days[days.length - 1];
    const to = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
    return groupByDay(buildCalendarEvents(schedules, days[0], to));
  }, [schedules, days]);

  const selectedEvents = eventsByDay.get(dayKey(selected)) ?? [];
  const title = selected.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const focusDay = (date: Date) => {
    setSelected(date);
    requestAnimationFrame(() => {
      gridRef.current
        ?.querySelector<HTMLButtonElement>(`[data-day="${dayKey(date)}"]`)
        ?.focus();
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = KEY_STEPS[e.key];
    if (step === undefined) return;
    e.preventDefault();
    focusDay(new Date(selected.getFullYear(), selected.getMonth(), selected.getDate() + step));
  };

  const navButton =
    "rounded-md px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-zinc-400";

  return (
    <section
      aria-labelledby="recurring-calendar-heading"
      className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 id="recurring-calendar-heading" className="text-sm font-semibold text-zinc-300">
          Payment Calendar · {title}
        </h3>
        <div className="flex items-center gap-1">
          <button type="button" className={navButton} aria-label={`Previous ${view}`}
            onClick={() => setSelected(shiftAnchor(selected, view, -1))}>
            ‹
          </button>
          <button type="button" className={navButton}
            onClick={() => setSelected(startOfDay(new Date()))}>
            Today
          </button>
          <button type="button" className={navButton} aria-label={`Next ${view}`}
            onClick={() => setSelected(shiftAnchor(selected, view, 1))}>
            ›
          </button>
          <div className="ml-2 flex gap-1 rounded-lg border border-zinc-800 p-1">
            {(["month", "week"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className={`rounded-md px-2 py-0.5 text-xs capitalize focus:outline-none focus:ring-2 focus:ring-zinc-400 ${
                  view === v ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <LoadingState message="Loading calendar…" variant="section" />
      ) : error ? (
        <ErrorState message={error} onRetry={onRetry} variant="section" />
      ) : schedules.length === 0 ? (
        <EmptyState
          variant="section"
          title="Nothing scheduled"
          description="Recurring payments will appear on the calendar once created."
        />
      ) : (
        <>
          <div
            ref={gridRef}
            role="grid"
            aria-label={`${view === "month" ? "Month" : "Week"} of recurring payments`}
            onKeyDown={onKeyDown}
            className="grid grid-cols-7 gap-px overflow-hidden rounded-lg bg-zinc-800 text-xs"
          >
            {WEEKDAYS.map((d) => (
              <div key={d} role="columnheader" className="bg-zinc-900 py-1 text-center text-zinc-500">
                {d}
              </div>
            ))}
            {days.map((day) => {
              const key = dayKey(day);
              const events = eventsByDay.get(key) ?? [];
              const isSelected = key === dayKey(selected);
              const outside = view === "month" && day.getMonth() !== selected.getMonth();
              return (
                <button
                  key={key}
                  type="button"
                  role="gridcell"
                  data-day={key}
                  tabIndex={isSelected ? 0 : -1}
                  aria-selected={isSelected}
                  aria-label={`${day.toDateString()}, ${events.length} payment${events.length === 1 ? "" : "s"}`}
                  onClick={() => setSelected(day)}
                  className={`flex min-h-14 flex-col items-start gap-1 bg-zinc-900 p-1 text-left focus:outline-none focus:ring-2 focus:ring-inset focus:ring-zinc-400 sm:min-h-20 ${
                    isSelected ? "bg-zinc-800" : ""
                  } ${outside ? "text-zinc-600" : "text-zinc-300"}`}
                >
                  <span>{day.getDate()}</span>
                  {events.slice(0, 2).map((e) => (
                    <span
                      key={`${e.scheduleId}-${e.date.getTime()}`}
                      className={`hidden w-full truncate rounded px-1 sm:block ${STATE_STYLES[e.state]}`}
                    >
                      #{e.scheduleId} {e.amount}
                    </span>
                  ))}
                  {events.length > 0 && (
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 sm:hidden" aria-hidden="true" />
                  )}
                  {events.length > 2 && (
                    <span className="hidden text-zinc-500 sm:block">+{events.length - 2}</span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="mt-3" aria-live="polite">
            <p className="mb-1 text-xs text-zinc-400">{selected.toDateString()}</p>
            {selectedEvents.length === 0 ? (
              <p className="text-xs text-zinc-500">No payments on this day.</p>
            ) : (
              <ul className="space-y-1">
                {selectedEvents.map((e) => (
                  <li
                    key={`${e.scheduleId}-${e.date.getTime()}`}
                    className="flex items-center justify-between gap-2 text-xs text-zinc-300"
                  >
                    <span>Schedule #{e.scheduleId}</span>
                    <span className="flex items-center gap-2">
                      {e.amount} {e.token ?? ""}
                      <span className={`rounded px-1.5 py-0.5 capitalize ${STATE_STYLES[e.state]}`}>
                        {e.state}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
