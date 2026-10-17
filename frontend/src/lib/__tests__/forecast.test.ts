import { describe, expect, it } from "vitest";
import {
  computeProjectedOutflowSeries,
  computeRunway,
  computeRecurringForecast,
} from "../forecast";
import type { RecurringSchedule } from "../../types/accord";

describe("forecast math & outflow projections", () => {
  const baseDate = new Date("2026-01-01T00:00:00Z");

  const sampleActiveSchedule: RecurringSchedule = {
    id: 1,
    recipient: "GBPLX2P3VWYKPQ7L5RI5OGXQ6T4G7QZMJ3HPQD7FZX5KJ3H2Z4YK5ABC",
    amount: "100",
    token: "XLM",
    interval: 30 * 24 * 3600, // Monthly
    totalDisbursed: "0",
    status: "active",
    nextDisbursementTs: new Date("2026-01-05T00:00:00Z").getTime(),
  };

  it("projects recurring outflows across requested months", () => {
    const points = computeProjectedOutflowSeries([sampleActiveSchedule], {
      months: 6,
      startDate: baseDate,
    });

    expect(points.length).toBe(6);
    expect(points[0].outflow).toBe(100);
    expect(points[0].cumulativeOutflow).toBe(100);
    expect(points[1].outflow).toBe(100);
    expect(points[1].cumulativeOutflow).toBe(200);
    expect(points[5].cumulativeOutflow).toBe(600);
  });

  it("respects schedule disbursement caps and ceases outflow once cap is reached", () => {
    const cappedSchedule: RecurringSchedule = {
      id: 2,
      recipient: "GBPLX2P3VWYKPQ7L5RI5OGXQ6T4G7QZMJ3HPQD7FZX5KJ3H2Z4YK5ABC",
      amount: "100",
      interval: 30 * 24 * 3600,
      totalDisbursed: "50",
      cap: "250", // Remaining cap = 200 (allows 2 payouts of 100)
      status: "active",
      nextDisbursementTs: new Date("2026-01-05T00:00:00Z").getTime(),
    };

    const points = computeProjectedOutflowSeries([cappedSchedule], {
      months: 5,
      startDate: baseDate,
    });

    expect(points[0].outflow).toBe(100);
    expect(points[1].outflow).toBe(100);
    expect(points[2].outflow).toBe(0); // Cap of 200 reached
    expect(points[3].outflow).toBe(0);
    expect(points[4].cumulativeOutflow).toBe(200);
  });

  it("handles partial payout when cap remainder is less than disbursement amount", () => {
    const partialCapSchedule: RecurringSchedule = {
      id: 3,
      recipient: "GBPLX2P3VWYKPQ7L5RI5OGXQ6T4G7QZMJ3HPQD7FZX5KJ3H2Z4YK5ABC",
      amount: "100",
      interval: 30 * 24 * 3600,
      totalDisbursed: "0",
      cap: "150", // Allows 100 in month 1, and 50 in month 2
      status: "active",
      nextDisbursementTs: new Date("2026-01-05T00:00:00Z").getTime(),
    };

    const points = computeProjectedOutflowSeries([partialCapSchedule], {
      months: 3,
      startDate: baseDate,
    });

    expect(points[0].outflow).toBe(100);
    expect(points[1].outflow).toBe(50);
    expect(points[2].outflow).toBe(0);
    expect(points[2].cumulativeOutflow).toBe(150);
  });

  it("respects end dates and ceases disbursements after expiration", () => {
    const expiringSchedule: RecurringSchedule = {
      id: 4,
      recipient: "GBPLX2P3VWYKPQ7L5RI5OGXQ6T4G7QZMJ3HPQD7FZX5KJ3H2Z4YK5ABC",
      amount: "100",
      interval: 30 * 24 * 3600,
      totalDisbursed: "0",
      // Expires after Feb 15, 2026
      endDate: Math.floor(new Date("2026-02-15T00:00:00Z").getTime() / 1000),
      status: "active",
      nextDisbursementTs: new Date("2026-01-05T00:00:00Z").getTime(),
    };

    const points = computeProjectedOutflowSeries([expiringSchedule], {
      months: 4,
      startDate: baseDate,
    });

    expect(points[0].outflow).toBe(100); // Jan
    expect(points[1].outflow).toBe(100); // Feb
    expect(points[2].outflow).toBe(0); // Mar (past endDate)
    expect(points[3].outflow).toBe(0); // Apr
  });

  it("ignores paused, completed, and cancelled schedules", () => {
    const inactiveSchedules: RecurringSchedule[] = [
      { ...sampleActiveSchedule, id: 10, status: "paused" },
      { ...sampleActiveSchedule, id: 11, status: "cancelled" },
      { ...sampleActiveSchedule, id: 12, status: "completed" },
    ];

    const points = computeProjectedOutflowSeries(inactiveSchedules, {
      months: 3,
      startDate: baseDate,
    });

    expect(points[0].outflow).toBe(0);
    expect(points[1].outflow).toBe(0);
    expect(points[2].cumulativeOutflow).toBe(0);
  });

  it("calculates runway against current balance correctly", () => {
    const points = computeProjectedOutflowSeries([sampleActiveSchedule], {
      months: 6,
      startDate: baseDate,
    });

    // 100/month with 250 balance -> 2.5 months runway
    const runway250 = computeRunway(250, 100, points);
    expect(runway250.runwayMonths).toBe(2.5);
    expect(runway250.isDepleted).toBe(false);

    // 0 balance -> 0 months (depleted)
    const runway0 = computeRunway(0, 100, points);
    expect(runway0.runwayMonths).toBe(0);
    expect(runway0.isDepleted).toBe(true);

    // 0 monthly outflow -> Infinite runway
    const runwayInfinite = computeRunway(1000, 0, []);
    expect(runwayInfinite.runwayMonths).toBeNull();
    expect(runwayInfinite.label).toContain("∞");
  });

  it("produces a comprehensive forecast summary", () => {
    const summary = computeRecurringForecast([sampleActiveSchedule], 500, 6, baseDate);
    expect(summary.totalProjectedOutflow).toBe(600);
    expect(summary.averageMonthlyOutflow).toBe(100);
    expect(summary.runway.runwayMonths).toBe(5);
  });
});
