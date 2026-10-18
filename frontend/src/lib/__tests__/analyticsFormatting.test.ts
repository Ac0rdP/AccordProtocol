import { describe, expect, it } from "vitest";
import { formatCurrency, formatPercent, formatTimeSeriesLabel, formatAnalyticsDate } from "../soroban";

describe("analytics formatting", () => {
  it("formats Stellar token units and preserves large decimal strings", () => {
    expect(formatCurrency("1234.5678901", "XLM")).toBe("1,234.5678901 XLM");
    expect(formatCurrency(123456789n, "USDC")).toBe("12.3456789 USDC");
    expect(formatCurrency("9007199254740993.0000001", "XLM")).toBe("9,007,199,254,740,993.0000001 XLM");
    expect(formatCurrency(0, "USDC")).toBe("0.00 USDC");
    expect(formatCurrency(-1n, "XLM")).toBe("-0.0000001 XLM");
    expect(formatCurrency("-0.000", "XLM")).toBe("0.00 XLM");
    expect(formatCurrency("9.99999999", "XLM")).toBe("10.00 XLM");
    expect(formatCurrency(1234567n, "USDC", 6)).toBe("1.234567 USDC");
    expect(formatCurrency(12n, "TOKEN", 0)).toBe("12 TOKEN");
    expect(formatCurrency(0.0000001, "XLM")).toBe("0.0000001 XLM");
  });
  it("handles invalid amounts and decimal precision", () => {
    for (const value of [NaN, Infinity, "", "abc", "1,000"]) expect(formatCurrency(value, "XLM")).toBe("—");
    expect(formatCurrency(1, "XLM", -1)).toBe("—");
  });
  it("formats percentage points consistently", () => {
    expect(formatPercent(100 / 3)).toBe("33.3%");
    expect(formatPercent(100)).toBe("100.0%");
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(-0.001)).toBe("0.0%");
    expect(formatPercent(12.345, 2)).toBe("12.35%");
    expect(formatPercent(Infinity)).toBe("—");
    expect(formatPercent(1, -1)).toBe("—");
  });
  it("formats day, week, month and tooltip dates in UTC", () => {
    expect(formatTimeSeriesLabel("2026-09-25T23:00:00-04:00")).toBe("Sep 26");
    expect(formatTimeSeriesLabel("2026-09-25", "week")).toBe("Sep 25");
    expect(formatTimeSeriesLabel("2026-09-25", "month")).toBe("Sep 2026");
    expect(formatTimeSeriesLabel(0)).toBe("Jan 1");
    expect(formatAnalyticsDate(new Date("2026-09-25"))).toBe("Sep 25, 2026");
    expect(formatAnalyticsDate(0)).toBe("Jan 1, 1970");
    expect(formatTimeSeriesLabel("bad date")).toBe("—");
    expect(formatAnalyticsDate(NaN)).toBe("—");
  });
});
