import { describe, expect, it } from "vitest";
import { formatAge } from "./freshness";

describe("formatAge", () => {
  it("formats durations at a glance", () => {
    expect(formatAge(null)).toBe("never");
    expect(formatAge(45)).toBe("45s");
    expect(formatAge(720)).toBe("12m");
    expect(formatAge(11_100)).toBe("3h 5m");
    expect(formatAge(187_200)).toBe("2d 4h");
  });
});
