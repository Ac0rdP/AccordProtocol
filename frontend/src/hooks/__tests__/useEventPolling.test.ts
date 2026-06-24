import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useEventPolling } from "../useEventPolling";
import * as contract from "../../lib/contract";

vi.mock("../../lib/contract", () => ({
  getLatestLedger: vi.fn(),
  getContractEvents: vi.fn(),
}));

describe("useEventPolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("starts polling on mount and calls refresh when ledger advances", async () => {
    const refresh = vi.fn();
    vi.mocked(contract.getLatestLedger).mockResolvedValueOnce(100);
    vi.mocked(contract.getContractEvents).mockResolvedValueOnce(105);

    renderHook(() => useEventPolling(refresh, 5000));

    // Allow initial getLatestLedger to resolve
    await vi.waitFor(() => {
      expect(contract.getLatestLedger).toHaveBeenCalledTimes(1);
    });

    // Advance by interval
    vi.advanceTimersByTime(5000);

    await vi.waitFor(() => {
      expect(contract.getContractEvents).toHaveBeenCalledWith(100);
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });

  test("does not refresh when no new events exist", async () => {
    const refresh = vi.fn();
    vi.mocked(contract.getLatestLedger).mockResolvedValueOnce(100);
    vi.mocked(contract.getContractEvents).mockResolvedValueOnce(100); // ledger did not advance

    renderHook(() => useEventPolling(refresh, 5000));

    await vi.waitFor(() => {
      expect(contract.getLatestLedger).toHaveBeenCalledTimes(1);
    });

    vi.advanceTimersByTime(5000);

    await vi.waitFor(() => {
      expect(contract.getContractEvents).toHaveBeenCalledWith(100);
    });

    expect(refresh).not.toHaveBeenCalled();
  });

  test("stops polling after unmount", async () => {
    const refresh = vi.fn();
    vi.mocked(contract.getLatestLedger).mockResolvedValueOnce(100);
    
    const { unmount } = renderHook(() => useEventPolling(refresh, 5000));

    await vi.waitFor(() => {
      expect(contract.getLatestLedger).toHaveBeenCalledTimes(1);
    });

    unmount();

    vi.advanceTimersByTime(5000);
    expect(contract.getContractEvents).not.toHaveBeenCalled();
  });
});
