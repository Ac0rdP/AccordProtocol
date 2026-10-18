import { describe, expect, it } from "vitest";
import {
  buildRangeQuery,
  clampDateRange,
  getDefaultRange,
  getPresetRange,
  parseDateOnly,
  suggestGranularity,
  toApiGranularity,
  validateDateRange,
} from "../analyticsRange";

const NOW = new Date("2026-09-25T15:30:00Z");

describe("getPresetRange", () => {
  it("computes N-day ranges inclusive of today", () => {
    expect(getPresetRange("7d", NOW)).toEqual({ startDate: "2026-09-19", endDate: "2026-09-25" });
    expect(getPresetRange("30d", NOW)).toEqual({ startDate: "2026-08-27", endDate: "2026-09-25" });
    expect(getPresetRange("90d", NOW)).toEqual({ startDate: "2026-06-28", endDate: "2026-09-25" });
  });

  it("computes year-to-date and all-time", () => {
    expect(getPresetRange("ytd", NOW)).toEqual({ startDate: "2026-01-01", endDate: "2026-09-25" });
    expect(getPresetRange("all", NOW)).toEqual({ startDate: "", endDate: "" });
  });

  it("uses UTC, not local time, for the current day", () => {
    const lateUtc = new Date("2026-01-01T00:00:01Z");
    expect(getPresetRange("7d", lateUtc).endDate).toBe("2026-01-01");
  });

  it("defaults to the last 30 days", () => {
    expect(getDefaultRange(NOW)).toEqual(getPresetRange("30d", NOW));
  });
});

describe("parseDateOnly / validateDateRange", () => {
  it("rejects malformed and impossible dates", () => {
    expect(parseDateOnly("2026-02-31")).toBeNull();
    expect(parseDateOnly("2026-2-1")).toBeNull();
    expect(parseDateOnly("nope")).toBeNull();
    expect(parseDateOnly("2026-02-28")).toBe(Date.UTC(2026, 1, 28));
  });

  it("accepts valid and open-ended ranges", () => {
    expect(validateDateRange({ startDate: "2026-01-01", endDate: "2026-01-31" }).valid).toBe(true);
    expect(validateDateRange({ startDate: "", endDate: "2026-01-31" }).valid).toBe(true);
    expect(validateDateRange({ startDate: "", endDate: "" }).valid).toBe(true);
  });

  it("rejects inverted and malformed ranges", () => {
    const inverted = validateDateRange({ startDate: "2026-02-01", endDate: "2026-01-01" });
    expect(inverted.valid).toBe(false);
    const bad = validateDateRange({ startDate: "2026-13-01", endDate: "" });
    expect(bad.valid).toBe(false);
  });
});

describe("clampDateRange", () => {
  it("swaps inverted bounds", () => {
    expect(clampDateRange({ startDate: "2026-02-01", endDate: "2026-01-01" })).toEqual({
      startDate: "2026-01-01",
      endDate: "2026-02-01",
    });
  });

  it("drops malformed bounds", () => {
    expect(clampDateRange({ startDate: "garbage", endDate: "2026-01-01" })).toEqual({
      startDate: "",
      endDate: "2026-01-01",
    });
  });

  it("clamps to min and max", () => {
    expect(
      clampDateRange(
        { startDate: "2020-01-01", endDate: "2030-01-01" },
        { min: "2025-01-01", max: "2026-09-25" },
      ),
    ).toEqual({ startDate: "2025-01-01", endDate: "2026-09-25" });
  });

  it("limits the span to maxDays by moving the start forward", () => {
    expect(
      clampDateRange({ startDate: "2026-01-01", endDate: "2026-12-31" }, { maxDays: 30 }),
    ).toEqual({ startDate: "2026-12-02", endDate: "2026-12-31" });
  });

  it("leaves a valid range untouched", () => {
    const range = { startDate: "2026-01-01", endDate: "2026-01-31" };
    expect(clampDateRange(range, { maxDays: 365 })).toEqual(range);
  });
});

describe("granularity helpers", () => {
  it("maps UI choices and aliases to API values", () => {
    expect(toApiGranularity("Daily")).toBe("day");
    expect(toApiGranularity("weekly")).toBe("week");
    expect(toApiGranularity(" Month ")).toBe("month");
    expect(toApiGranularity("hourly")).toBeUndefined();
  });

  it("suggests a granularity from the range span", () => {
    expect(suggestGranularity({ startDate: "2026-09-01", endDate: "2026-09-30" })).toBe("day");
    expect(suggestGranularity({ startDate: "2026-06-01", endDate: "2026-09-30" })).toBe("week");
    expect(suggestGranularity({ startDate: "2026-01-01", endDate: "2026-12-31" })).toBe("month");
    expect(suggestGranularity({ startDate: "", endDate: "" })).toBe("month");
  });

  it("builds a query omitting empty bounds and unknown granularity", () => {
    expect(buildRangeQuery({ startDate: "2026-01-01", endDate: "" }, "Weekly")).toEqual({
      startDate: "2026-01-01",
      granularity: "week",
    });
    expect(buildRangeQuery({ startDate: "", endDate: "" }, "bogus")).toEqual({});
  });
});
