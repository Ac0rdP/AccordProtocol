import { describe, expect, it } from "vitest";
import {
  isNearQuota,
  isValidBillingEmail,
  nextUpgradeTier,
  usagePercent,
} from "./billing";

describe("billing helpers", () => {
  it("computes usage percentages and quota warnings", () => {
    expect(usagePercent(8_000, 10_000)).toBe(80);
    expect(usagePercent(12_000, 10_000)).toBe(100);
    expect(isNearQuota(8_000, 10_000)).toBe(true);
    expect(isNearQuota(2_000, 10_000)).toBe(false);
  });

  it("determines the next upgrade tier and validates billing email", () => {
    expect(nextUpgradeTier("free")).toBe("pro");
    expect(nextUpgradeTier("pro")).toBe("enterprise");
    expect(nextUpgradeTier("enterprise")).toBeNull();

    expect(isValidBillingEmail("ops@acme.org")).toBe(true);
    expect(isValidBillingEmail("invalid-email")).toBe(false);
  });
});
