import { vi } from "vitest";
import { applyContractHarness, installContractCallHarness } from "../../test/harness";
import { HARNESS_ACCOUNT } from "../../test/contractFixtures";

vi.mock("../../lib/contract", (importOriginal) => applyContractHarness(importOriginal));

import { renderHook, waitFor } from "@testing-library/react";
import { useOwnerWeights } from "../useOwnerWeights";

const contract = installContractCallHarness();

beforeEach(() => contract.reset());

const OWNER = HARNESS_ACCOUNT.owner;
const SECOND_OWNER = HARNESS_ACCOUNT.secondOwner;

describe("useOwnerWeights", () => {
  test("fetches owner weights on mount", async () => {
    const { result } = renderHook(() => useOwnerWeights([OWNER, SECOND_OWNER]));

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(contract.callCount("getOwnerWeights")).toBe(1);
    expect(result.current.weights).toEqual({ [OWNER]: 6, [SECOND_OWNER]: 4 });
    expect(result.current.totalWeight).toBe(10);
    expect(result.current.error).toBeNull();
  });

  test("handles empty owner addresses without calling the contract", async () => {
    const { result } = renderHook(() => useOwnerWeights([]));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(contract.callCount("getOwnerWeights")).toBe(0);
    expect(result.current.weights).toEqual({});
    expect(result.current.totalWeight).toBe(0);
    expect(result.current.error).toBeNull();
  });

  test("surfaces a contract error", async () => {
    contract.read("getOwnerWeights").mockRejectedValueOnce(new Error("RPC unavailable"));

    const { result } = renderHook(() => useOwnerWeights([OWNER]));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("RPC unavailable");
    expect(result.current.weights).toEqual({});
    expect(result.current.totalWeight).toBe(0);
  });

  test("a single owner override changes the weight map", async () => {
    contract.set("getOwnerWeights", [{ address: OWNER, weight: 12 }]);

    const { result } = renderHook(() => useOwnerWeights([OWNER]));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.weights).toEqual({ [OWNER]: 12 });
    expect(result.current.totalWeight).toBe(12);
  });

  test("slow mode keeps the hook loading until the contract answers", async () => {
    contract.setMode("slow");

    const { result } = renderHook(() => useOwnerWeights([OWNER]));

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.totalWeight).toBe(10);
  });
});
