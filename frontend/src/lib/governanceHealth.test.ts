import { describe, expect, it } from "vitest";
import { calculateGovernanceHealth } from "./governanceHealth";

describe("calculateGovernanceHealth", () => {
  it("returns critical risk for empty owners or zero total weight", () => {
    const result = calculateGovernanceHealth({
      weights: {},
      totalWeight: 0,
      threshold: 1,
      totalOwners: 0,
    });

    expect(result.score).toBe(0);
    expect(result.rating).toBe("Critical Risk");
    expect(result.explanation).toContain("No active multisig owners");
  });

  it("calculates a healthy score for well-distributed weights and reasonable quorum", () => {
    // 4 owners, 25% each, threshold 2 of 4 (50%)
    const result = calculateGovernanceHealth({
      weights: {
        owner1: 25,
        owner2: 25,
        owner3: 25,
        owner4: 25,
      },
      totalWeight: 100,
      threshold: 50,
      totalOwners: 4,
    });

    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.rating).toBe("Healthy");
    expect(result.dominantSharePct).toBe(25);
    expect(result.flaggedRisks).toHaveLength(0);
  });

  it("flags dominant owner when a single owner exceeds 50% power", () => {
    const result = calculateGovernanceHealth({
      weights: {
        whale: 60,
        other1: 20,
        other2: 20,
      },
      totalWeight: 100,
      threshold: 60,
      totalOwners: 3,
    });

    expect(result.rating).not.toBe("Healthy");
    expect(result.dominantSharePct).toBe(60);
    expect(result.dominantAddress).toBe("whale");
    expect(
      result.flaggedRisks.some((r) => r.includes("Dominant owner controls")),
    ).toBe(true);
    expect(
      result.flaggedRisks.some((r) => r.includes("pass proposals unilaterally")),
    ).toBe(true);
  });

  it("flags unreachable quorum when threshold exceeds total weight", () => {
    const result = calculateGovernanceHealth({
      weights: {
        owner1: 10,
        owner2: 10,
      },
      totalWeight: 20,
      threshold: 30, // impossible quorum
      totalOwners: 2,
    });

    expect(result.rating).toBe("Critical Risk");
    expect(
      result.flaggedRisks.some((r) => r.includes("exceeds total voting weight")),
    ).toBe(true);
  });

  it("flags gridlock risk when quorum requirement is excessively high", () => {
    const result = calculateGovernanceHealth({
      weights: {
        owner1: 10,
        owner2: 10,
        owner3: 10,
      },
      totalWeight: 30,
      threshold: 28, // > 90%
      totalOwners: 3,
    });

    expect(
      result.flaggedRisks.some((r) => r.includes("High quorum requirement")),
    ).toBe(true);
  });

  it("flags single owner redundancy risk", () => {
    const result = calculateGovernanceHealth({
      weights: {
        solo: 100,
      },
      totalWeight: 100,
      threshold: 100,
      totalOwners: 1,
    });

    expect(result.rating).toBe("Critical Risk");
    expect(
      result.flaggedRisks.some((r) => r.includes("Only 1 owner configured")),
    ).toBe(true);
  });
});
