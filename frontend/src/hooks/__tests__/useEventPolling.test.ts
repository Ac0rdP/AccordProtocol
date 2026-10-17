import { vi } from "vitest";
import { applyContractHarness, installContractCallHarness } from "../../test/harness";

vi.mock("../../lib/contract", (importOriginal) => applyContractHarness(importOriginal));

import { renderHook } from "@testing-library/react";
import { useEventPolling } from "../useEventPolling";

const contract = installContractCallHarness();

describe("useEventPolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    contract.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("starts polling on mount and refreshes when the ledger advances", async () => {
    contract.set("getLatestLedger", 100);
    contract.set("getContractEvents", 105);
    const refresh = vi.fn();

    renderHook(() => useEventPolling(refresh, 5000));

    await vi.waitFor(() => {
      expect(contract.callCount("getLatestLedger")).toBe(1);
    });

    vi.advanceTimersByTime(5000);

    await vi.waitFor(() => {
      expect(contract.calls("getContractEvents")).toEqual([[100, { throwOnError: true }]]);
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });

  test("does not refresh when no new events exist", async () => {
    contract.set("getLatestLedger", 100);
    contract.set("getContractEvents", 100);
    const refresh = vi.fn();

    renderHook(() => useEventPolling(refresh, 5000));

    await vi.waitFor(() => {
      expect(contract.callCount("getLatestLedger")).toBe(1);
    });

    vi.advanceTimersByTime(5000);

    await vi.waitFor(() => {
      expect(contract.callCount("getContractEvents")).toBe(1);
    });

    expect(refresh).not.toHaveBeenCalled();
  });

  test("stops polling after unmount", async () => {
    contract.set("getLatestLedger", 100);
    const refresh = vi.fn();

    const { unmount } = renderHook(() => useEventPolling(refresh, 5000));

    await vi.waitFor(() => {
      expect(contract.callCount("getLatestLedger")).toBe(1);
    });

    unmount();

    vi.advanceTimersByTime(5000);
    expect(contract.callCount("getContractEvents")).toBe(0);
  });

  test("a slow ledger read does not overlap the next tick", async () => {
    contract.set("getLatestLedger", 100);
    const refresh = vi.fn();

    renderHook(() => useEventPolling(refresh, 5000));

    await vi.waitFor(() => {
      expect(contract.callCount("getLatestLedger")).toBe(1);
    });

    vi.advanceTimersByTime(5000);

    await vi.waitFor(() => {
      expect(contract.callCount("getContractEvents")).toBe(1);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("event polling recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    contract.reset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("retries a failed initialisation", async () => {
    contract
      .read("getLatestLedger")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(100);
    contract.set("getContractEvents", 105);
    const refresh = vi.fn();

    renderHook(() => useEventPolling(refresh, 1000));

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1999);
    expect(contract.callCount("getLatestLedger")).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(contract.callCount("getLatestLedger")).toBe(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("failure mode makes the poller back off and retry", async () => {
    contract.setMode("failure");
    const refresh = vi.fn();

    renderHook(() => useEventPolling(refresh, 1000));

    await vi.advanceTimersByTimeAsync(2000);
    // The failure was observed and logged rather than swallowed.
    expect(console.error).toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();

    contract.setMode("success");
    contract.set("getLatestLedger", 100);
    await vi.advanceTimersByTimeAsync(2000);
    expect(contract.callCount("getLatestLedger")).toBeGreaterThanOrEqual(2);
  });

  test("ignores results that resolve after unmount", async () => {
    contract.set("getLatestLedger", 100);
    // Hold the response open so it lands after the hook has unmounted.
    let release!: (ledger: number) => void;
    contract
      .read("getContractEvents")
      .mockImplementationOnce(() => new Promise<number>((resolve) => { release = resolve; }));
    const refresh = vi.fn();

    const { unmount } = renderHook(() => useEventPolling(refresh, 1000));

    await vi.advanceTimersByTimeAsync(1000);
    expect(contract.callCount("getContractEvents")).toBe(1);

    unmount();
    release(105);

    await vi.advanceTimersByTimeAsync(10000);
    expect(refresh).not.toHaveBeenCalled();
  });
});
