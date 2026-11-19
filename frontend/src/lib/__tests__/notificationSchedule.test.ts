import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NOTIFICATION_SCHEDULE,
  clearDigestQueue,
  enqueueDigestItem,
  getDeliveryMode,
  getDigestQueue,
  getNotificationSchedule,
  isWithinQuietHours,
  mostRecentDigestSlot,
  nextDigestAt,
  parseTime,
  quietHoursEndAfter,
  readNotificationSchedule,
  saveNotificationSchedule,
  subscribeToDigestQueue,
  summarizeDigest,
  takeDueDigest,
  validateSchedule,
  type NotificationSchedule,
} from "../notificationSchedule";

// All times below are local (the schedule uses the device time zone).
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo, d, h, mi);

function schedule(overrides: {
  quietHours?: Partial<NotificationSchedule["quietHours"]>;
  digest?: Partial<NotificationSchedule["digest"]>;
}): NotificationSchedule {
  return {
    quietHours: { ...DEFAULT_NOTIFICATION_SCHEDULE.quietHours, ...overrides.quietHours },
    digest: { ...DEFAULT_NOTIFICATION_SCHEDULE.digest, ...overrides.digest },
  };
}

beforeEach(() => localStorage.clear());

describe("parsing and validation", () => {
  it("parses HH:MM", () => {
    expect(parseTime("07:30")).toBe(450);
    expect(parseTime("24:00")).toBeNull();
    expect(parseTime("7:30")).toBeNull();
  });

  it("rejects equal quiet-hour bounds and malformed digest time", () => {
    expect(validateSchedule(DEFAULT_NOTIFICATION_SCHEDULE)).toBeNull();
    expect(
      validateSchedule(schedule({ quietHours: { enabled: true, start: "08:00", end: "08:00" } })),
    ).toMatch(/different times/);
    expect(validateSchedule(schedule({ digest: { frequency: "daily", time: "" } }))).toMatch(
      /HH:MM/,
    );
  });
});

describe("quiet hours", () => {
  const overnight = schedule({ quietHours: { enabled: true, start: "22:00", end: "07:00" } });
  const midday = schedule({ quietHours: { enabled: true, start: "13:00", end: "15:00" } });

  it("handles windows that wrap past midnight", () => {
    expect(isWithinQuietHours(overnight, at(2026, 10, 19, 23))).toBe(true);
    expect(isWithinQuietHours(overnight, at(2026, 10, 19, 6, 59))).toBe(true);
    expect(isWithinQuietHours(overnight, at(2026, 10, 19, 7))).toBe(false);
    expect(isWithinQuietHours(overnight, at(2026, 10, 19, 12))).toBe(false);
  });

  it("handles same-day windows and the disabled flag", () => {
    expect(isWithinQuietHours(midday, at(2026, 10, 19, 14))).toBe(true);
    expect(isWithinQuietHours(midday, at(2026, 10, 19, 16))).toBe(false);
    expect(isWithinQuietHours(DEFAULT_NOTIFICATION_SCHEDULE, at(2026, 10, 19, 23))).toBe(false);
  });

  it("computes when quiet hours end", () => {
    expect(quietHoursEndAfter(overnight, at(2026, 10, 19, 23))).toEqual(at(2026, 10, 20, 7));
    expect(quietHoursEndAfter(overnight, at(2026, 10, 19, 3))).toEqual(at(2026, 10, 19, 7));
    expect(quietHoursEndAfter(DEFAULT_NOTIFICATION_SCHEDULE, at(2026, 10, 19, 3))).toBeNull();
  });
});

describe("delivery mode", () => {
  it("is immediate by default, quiet during quiet hours, digest when batching", () => {
    const quiet = schedule({ quietHours: { enabled: true, start: "22:00", end: "07:00" } });
    expect(getDeliveryMode(DEFAULT_NOTIFICATION_SCHEDULE, at(2026, 10, 19, 23))).toBe("immediate");
    expect(getDeliveryMode(quiet, at(2026, 10, 19, 23))).toBe("quiet");
    expect(getDeliveryMode(quiet, at(2026, 10, 19, 12))).toBe("immediate");
    expect(getDeliveryMode(schedule({ digest: { frequency: "daily" } }), at(2026, 10, 19, 12))).toBe(
      "digest",
    );
  });
});

describe("digest slots", () => {
  // 2026-11-19 is a Thursday (weekday 4).
  const daily = schedule({ digest: { frequency: "daily", time: "09:00" } });
  const weekly = schedule({ digest: { frequency: "weekly", time: "09:00", weekday: 1 } });

  it("finds the next daily and weekly digest", () => {
    expect(nextDigestAt(daily, at(2026, 10, 19, 8))).toEqual(at(2026, 10, 19, 9));
    expect(nextDigestAt(daily, at(2026, 10, 19, 10))).toEqual(at(2026, 10, 20, 9));
    expect(nextDigestAt(weekly, at(2026, 10, 19, 10))).toEqual(at(2026, 10, 23, 9));
    expect(nextDigestAt(DEFAULT_NOTIFICATION_SCHEDULE, at(2026, 10, 19, 10))).toBeNull();
  });

  it("finds the most recent slot", () => {
    expect(mostRecentDigestSlot(daily, at(2026, 10, 19, 8))).toEqual(at(2026, 10, 18, 9));
    expect(mostRecentDigestSlot(weekly, at(2026, 10, 19, 8))).toEqual(at(2026, 10, 16, 9));
  });
});

describe("queue", () => {
  it("persists queued alerts and notifies subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToDigestQueue(listener);
    enqueueDigestItem({ type: "proposal_ready", title: "Proposal Ready", body: "#1", reason: "digest" });
    expect(getDigestQueue()).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(1);
    clearDigestQueue();
    expect(getDigestQueue()).toEqual([]);
    unsubscribe();
  });

  it("releases quiet-hour alerts once quiet hours end", () => {
    const quiet = schedule({ quietHours: { enabled: true, start: "22:00", end: "07:00" } });
    enqueueDigestItem(
      { type: "proposal_ready", title: "Proposal Ready", body: "#1", reason: "quiet" },
      at(2026, 10, 19, 23),
    );
    expect(takeDueDigest(quiet, at(2026, 10, 20, 3))).toBeNull();
    expect(takeDueDigest(quiet, at(2026, 10, 20, 7, 1))).toHaveLength(1);
    expect(getDigestQueue()).toEqual([]);
  });

  it("releases digest items queued before the latest slot and keeps newer ones", () => {
    const daily = schedule({ digest: { frequency: "daily", time: "09:00" } });
    enqueueDigestItem(
      { type: "proposal_approved", title: "Proposal Approved", body: "a", reason: "digest" },
      at(2026, 10, 19, 8),
    );
    enqueueDigestItem(
      { type: "proposal_approved", title: "Proposal Approved", body: "b", reason: "digest" },
      at(2026, 10, 19, 10),
    );
    expect(takeDueDigest(daily, at(2026, 10, 19, 8, 30))).toBeNull();

    const due = takeDueDigest(daily, at(2026, 10, 19, 11));
    expect(due?.map((d) => d.body)).toEqual(["a"]);
    expect(getDigestQueue().map((d) => d.body)).toEqual(["b"]);
  });

  it("summarizes a digest by title", () => {
    const summary = summarizeDigest([
      { id: "1", type: "proposal_approved", title: "Proposal Approved", body: "", createdAt: "", reason: "digest" },
      { id: "2", type: "proposal_approved", title: "Proposal Approved", body: "", createdAt: "", reason: "digest" },
      { id: "3", type: "proposal_ready", title: "Proposal Ready", body: "", createdAt: "", reason: "digest" },
    ]);
    expect(summary).toEqual({
      title: "Accord digest: 3 updates",
      body: "Proposal Approved ×2, Proposal Ready",
    });
  });
});

describe("storage", () => {
  it("round-trips a saved schedule and merges defaults", () => {
    const s = schedule({ digest: { frequency: "weekly", weekday: 5 } });
    saveNotificationSchedule(s);
    expect(readNotificationSchedule()).toEqual(s);
    localStorage.setItem("accord_notification_schedule", JSON.stringify({ digest: { frequency: "daily" } }));
    expect(readNotificationSchedule().quietHours).toEqual(DEFAULT_NOTIFICATION_SCHEDULE.quietHours);
  });

  it("throws on corrupt data, but the safe getter falls back to defaults", () => {
    localStorage.setItem("accord_notification_schedule", "{nope");
    expect(() => readNotificationSchedule()).toThrow();
    expect(getNotificationSchedule()).toEqual(DEFAULT_NOTIFICATION_SCHEDULE);
  });

  it("refuses to save an invalid schedule", () => {
    expect(() =>
      saveNotificationSchedule(schedule({ quietHours: { enabled: true, start: "x", end: "07:00" } })),
    ).toThrow(/HH:MM/);
  });
});
