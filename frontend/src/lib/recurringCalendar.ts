import type { RecurringSchedule } from "../types/accord";

export type CalendarView = "month" | "week";
export type CalendarEventState = "due" | "paused" | "completed";

export type CalendarEvent = {
  scheduleId: number;
  date: Date;
  amount: string;
  token?: string;
  state: CalendarEventState;
};

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** Days shown for the given view: a 6x7 month grid or a 7-day week, both starting on Sunday. */
export function getVisibleDays(anchor: Date, view: CalendarView): Date[] {
  const start =
    view === "month"
      ? new Date(anchor.getFullYear(), anchor.getMonth(), 1)
      : startOfDay(anchor);
  start.setDate(start.getDate() - start.getDay());
  const count = view === "month" ? 42 : 7;
  return Array.from(
    { length: count },
    (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i),
  );
}

export function shiftAnchor(anchor: Date, view: CalendarView, step: number): Date {
  return view === "month"
    ? new Date(anchor.getFullYear(), anchor.getMonth() + step, 1)
    : new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + step * 7);
}

/**
 * Projects schedule occurrences into [from, to). Active schedules are "due",
 * paused schedules show their next date as "paused", completed schedules show
 * their last known date as "completed". Cancelled schedules are hidden.
 */
export function buildCalendarEvents(
  schedules: RecurringSchedule[],
  from: Date,
  to: Date,
): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  const fromMs = from.getTime();
  const toMs = to.getTime();

  for (const s of schedules) {
    if (s.status === "cancelled" || s.nextDisbursementTs === undefined) continue;
    const base = { scheduleId: s.id, amount: s.amount, token: s.token };
    const intervalMs = (s.interval ?? 0) * 1000;

    if (s.status !== "active" || intervalMs <= 0) {
      const ts = s.nextDisbursementTs;
      if (ts >= fromMs && ts < toMs) {
        events.push({
          ...base,
          date: new Date(ts),
          state: s.status === "active" ? "due" : (s.status as CalendarEventState),
        });
      }
      continue;
    }

    let ts = s.nextDisbursementTs;
    if (ts < fromMs) ts += Math.ceil((fromMs - ts) / intervalMs) * intervalMs;
    for (; ts < toMs; ts += intervalMs) {
      events.push({ ...base, date: new Date(ts), state: "due" });
    }
  }

  return events.sort((a, b) => a.date.getTime() - b.date.getTime());
}

export function groupByDay(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    const key = dayKey(e.date);
    map.set(key, [...(map.get(key) ?? []), e]);
  }
  return map;
}
