import { beforeEach, describe, expect, test, vi } from "vitest";

// Mock the heavy Stellar SDK globally to avoid high memory overhead during test execution
vi.mock("@stellar/stellar-sdk", () => ({}));
vi.mock("../../lib/contract", () => ({
  getOwnerWeights: vi.fn(),
}));

import { renderHook, waitFor } from "@testing-library/react";
import * as contract from "../../lib/contract";
import { useOwnerWeights } from "../useOwnerWeights";

const initialWeights = [
  { address: "GOWNER111", weight: 4 },
  { address: "GOWNER222", weight: 6 },
];

describe("useOwnerWeights", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("fetches owner weights on mount", async () => {
    vi.mocked(contract.getOwnerWeights).mockResolvedValueOnce(initialWeights);

    const { result } = renderHook(() => useOwnerWeights(["GOWNER111", "GOWNER222"]));

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(contract.getOwnerWeights).toHaveBeenCalledTimes(1);
    expect(result.current.weights).toEqual({
      GOWNER111: 4,
      GOWNER222: 6,
    });
    expect(result.current.totalWeight).toBe(10);
    expect(result.current.error).toBeNull();
  });

  test("handles empty ownerAddresses", async () => {
    const { result } = renderHook(() => useOwnerWeights([]));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(contract.getOwnerWeights).not.toHaveBeenCalled();
    expect(result.current.weights).toEqual({});
    expect(result.current.totalWeight).toBe(0);
    expect(result.current.error).toBeNull();
  });

  test("handles error on fetch", async () => {
    const fetchError = new Error("RPC unavailable");
    vi.mocked(contract.getOwnerWeights).mockRejectedValueOnce(fetchError);

    const { result } = renderHook(() => useOwnerWeights(["GOWNER111"]));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("RPC unavailable");
    expect(result.current.weights).toEqual({});
    expect(result.current.totalWeight).toBe(0);
  });
});
