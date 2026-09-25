import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
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
      expect(contract.getContractEvents).toHaveBeenCalledWith(100, { throwOnError: true });
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
      expect(contract.getContractEvents).toHaveBeenCalledWith(100, { throwOnError: true });
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


describe("event polling recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("retries failed initialization with backoff", async () => {
    vi.mocked(contract.getLatestLedger).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(100);
    vi.mocked(contract.getContractEvents).mockResolvedValue(105);
    const refresh = vi.fn();
    renderHook(() => useEventPolling(refresh, 1000));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1999);
    expect(contract.getLatestLedger).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(contract.getLatestLedger).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("keeps the checkpoint when refresh fails", async () => {
    vi.mocked(contract.getLatestLedger).mockResolvedValue(100);
    vi.mocked(contract.getContractEvents).mockResolvedValue(105);
    const refresh = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    renderHook(() => useEventPolling(refresh, 1000));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(contract.getContractEvents).toHaveBeenNthCalledWith(2, 100, { throwOnError: true });
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(contract.getContractEvents).toHaveBeenNthCalledWith(3, 105, { throwOnError: true });
  });

  test("ignores events that resolve after unmount", async () => {
    vi.mocked(contract.getLatestLedger).mockResolvedValue(100);
    let resolve!: (ledger: number) => void;
    vi.mocked(contract.getContractEvents).mockReturnValue(new Promise((r) => { resolve = r; }));
    const refresh = vi.fn();
    const { unmount } = renderHook(() => useEventPolling(refresh, 1000));
    await vi.advanceTimersByTimeAsync(1000);
    unmount();
    resolve(105);
    await vi.advanceTimersByTimeAsync(10000);
    expect(refresh).not.toHaveBeenCalled();
    expect(contract.getContractEvents).toHaveBeenCalledTimes(1);
  });
});
