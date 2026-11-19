import { describe, expect, it } from "vitest";
import type { RecurringSchedule } from "../types/accord";
import { buildCalendarEvents, getVisibleDays, shiftAnchor } from "./recurringCalendar";

const DAY = 86_400_000;
const base = (overrides: Partial<RecurringSchedule>): RecurringSchedule => ({
  id: 1,
  recipient: "GABC",
  amount: "100",
  token: "XLM",
  totalDisbursed: "0",
  status: "active",
  interval: 7 * 86_400,
  nextDisbursementTs: new Date(2026, 5, 3).getTime(),
  ...overrides,
});

describe("recurringCalendar", () => {
  it("builds a 6-week month grid and a 7-day week starting on Sunday", () => {
    const month = getVisibleDays(new Date(2026, 5, 15), "month");
    expect(month).toHaveLength(42);
    expect(month[0].getDay()).toBe(0);
    const week = getVisibleDays(new Date(2026, 5, 17), "week");
    expect(week).toHaveLength(7);
    expect(week[0].getDate()).toBe(14);
  });

  it("shifts by month or week", () => {
    expect(shiftAnchor(new Date(2026, 5, 15), "month", 1).getMonth()).toBe(6);
    expect(shiftAnchor(new Date(2026, 5, 15), "week", -1).getDate()).toBe(8);
  });

  it("repeats active schedules and marks paused/completed once", () => {
    const from = new Date(2026, 5, 1);
    const to = new Date(from.getTime() + 30 * DAY);
    const events = buildCalendarEvents(
      [
        base({ id: 1 }),
        base({ id: 2, status: "paused" }),
        base({ id: 3, status: "completed" }),
        base({ id: 4, status: "cancelled" }),
      ],
      from,
      to,
    );
    expect(events.filter((e) => e.scheduleId === 1)).toHaveLength(4);
    expect(events.find((e) => e.scheduleId === 2)?.state).toBe("paused");
    expect(events.find((e) => e.scheduleId === 3)?.state).toBe("completed");
    expect(events.some((e) => e.scheduleId === 4)).toBe(false);
  });
});
