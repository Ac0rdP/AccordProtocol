import { describe, expect, it, vi } from "vitest";
import { AnalyticsRateLimitError, createRateLimiter, validateAnalyticsQuery } from "../analyticsSecurity";

describe("analytics security boundary", () => {
  it("rejects malformed and unbounded query input", () => {
    expect(() => validateAnalyticsQuery({ startDate: "not-a-date" })).toThrow(RangeError);
    expect(() => validateAnalyticsQuery({ startDate: "2026-10-02", endDate: "2026-10-01" })).toThrow("startDate");
    expect(() => validateAnalyticsQuery({ limit: 101 })).toThrow("limit");
    expect(() => validateAnalyticsQuery({ owner: "x".repeat(129) })).toThrow("owner");
  });

  it("allows bounded queries", () => {
    expect(validateAnalyticsQuery({ startDate: "2026-10-01", endDate: "2026-10-31", limit: 100, offset: 0 })).toBeTruthy();
  });

  it("enforces a per-window request limit", () => {
    let timestamp = 0;
    const consume = createRateLimiter(2, () => timestamp);
    consume();
    consume();
    expect(() => consume()).toThrow(AnalyticsRateLimitError);
    timestamp = 60_000;
    expect(() => consume()).not.toThrow();
  });
});
