import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNotifications } from "../useNotifications";
import {
  DEFAULT_NOTIFICATION_SCHEDULE,
  enqueueDigestItem,
  getDigestQueue,
  saveNotificationSchedule,
} from "../../lib/notificationSchedule";
import { getNotifications } from "../../lib/notificationCenter";
import { baseProposal } from "../../stories/fixtures";

vi.mock("../../lib/contract", () => ({
  getOwnerWeightChangeEvents: vi.fn().mockResolvedValue([]),
}));

const WALLET = "GWALLET";
const NotificationMock = vi.fn();

beforeEach(() => {
  localStorage.clear();
  NotificationMock.mockClear();
  vi.stubGlobal(
    "Notification",
    Object.assign(NotificationMock, {
      permission: "granted",
      requestPermission: vi.fn().mockResolvedValue("granted"),
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Renders the hook, then flips a proposal to "ready" to trigger an alert. */
function triggerReadyAlert() {
  const pending = baseProposal({ id: 4, status: "pending", approvals: 1 });
  const { rerender } = renderHook(({ proposals }) => useNotifications(WALLET, proposals), {
    initialProps: { proposals: [pending] },
  });
  NotificationMock.mockClear(); // ignore the initial "pending approval" alert
  rerender({ proposals: [{ ...pending, status: "ready", approvals: 2 }] });
}

describe("useNotifications with a notification schedule", () => {
  it("alerts immediately with the default schedule", () => {
    triggerReadyAlert();
    expect(NotificationMock).toHaveBeenCalledWith("Proposal Ready", expect.anything());
    expect(getDigestQueue()).toEqual([]);
  });

  it("holds alerts during quiet hours but still logs them in the notification center", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 19, 23, 30));
    saveNotificationSchedule({
      ...DEFAULT_NOTIFICATION_SCHEDULE,
      quietHours: { enabled: true, start: "22:00", end: "07:00" },
    });

    triggerReadyAlert();

    expect(NotificationMock).not.toHaveBeenCalledWith("Proposal Ready", expect.anything());
    const queue = getDigestQueue();
    expect(queue).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Proposal Ready", reason: "quiet" })]),
    );
    expect(queue.every((item) => item.reason === "quiet")).toBe(true);
    expect(getNotifications().some((n) => n.title === "Proposal Ready")).toBe(true);
  });

  it("queues alerts for the digest when batching is on", () => {
    saveNotificationSchedule({
      ...DEFAULT_NOTIFICATION_SCHEDULE,
      digest: { frequency: "daily", time: "09:00", weekday: 1 },
    });
    triggerReadyAlert();
    expect(NotificationMock).not.toHaveBeenCalledWith("Proposal Ready", expect.anything());
    const queue = getDigestQueue();
    expect(queue).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Proposal Ready", reason: "digest" })]),
    );
    expect(queue.every((item) => item.reason === "digest")).toBe(true);
  });

  it("delivers a due digest as one summary alert", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 19, 10));
    saveNotificationSchedule({
      ...DEFAULT_NOTIFICATION_SCHEDULE,
      digest: { frequency: "daily", time: "09:00", weekday: 1 },
    });
    const queuedAt = new Date(2026, 10, 19, 8);
    enqueueDigestItem({ type: "proposal_ready", title: "Proposal Ready", body: "a", reason: "digest" }, queuedAt);
    enqueueDigestItem({ type: "proposal_approved", title: "Proposal Approved", body: "b", reason: "digest" }, queuedAt);

    renderHook(() => useNotifications(WALLET, []));

    expect(NotificationMock).toHaveBeenCalledWith("Accord digest: 2 updates", {
      body: "Proposal Ready, Proposal Approved",
    });
    expect(getDigestQueue()).toEqual([]);
  });

  it("does not queue anything when browser notifications are not permitted", () => {
    vi.stubGlobal(
      "Notification",
      Object.assign(NotificationMock, {
        permission: "denied",
        requestPermission: vi.fn(),
      }),
    );
    saveNotificationSchedule({
      ...DEFAULT_NOTIFICATION_SCHEDULE,
      digest: { frequency: "daily", time: "09:00", weekday: 1 },
    });
    triggerReadyAlert();
    expect(getDigestQueue()).toEqual([]);
    expect(getNotifications().some((n) => n.title === "Proposal Ready")).toBe(true);
  });
});
