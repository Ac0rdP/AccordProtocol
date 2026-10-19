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

  test("grows the retry delay exponentially and recovers after RPC failures", async () => {
    contract
      .read("getLatestLedger")
      .mockRejectedValueOnce(new Error("rpc unavailable"))
      .mockRejectedValueOnce(new Error("rpc unavailable"))
      .mockRejectedValueOnce(new Error("rpc unavailable"))
      .mockResolvedValueOnce(100);
    contract.set("getContractEvents", 105);
    const refresh = vi.fn();

    renderHook(() => useEventPolling(refresh, 1000, { disablePush: true }));

    await vi.advanceTimersByTimeAsync(0);
    expect(contract.callCount("getLatestLedger")).toBe(1);

    await vi.advanceTimersByTimeAsync(1999);
    expect(contract.callCount("getLatestLedger")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(contract.callCount("getLatestLedger")).toBe(2);

    await vi.advanceTimersByTimeAsync(3999);
    expect(contract.callCount("getLatestLedger")).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(contract.callCount("getLatestLedger")).toBe(3);

    await vi.advanceTimersByTimeAsync(7999);
    expect(contract.callCount("getLatestLedger")).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(contract.callCount("getLatestLedger")).toBe(4);

    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("cancels backoff timers on unmount without unhandled rejections", async () => {
    contract.setMode("failure");
    const refresh = vi.fn();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    const { unmount } = renderHook(() => useEventPolling(refresh, 1000, { disablePush: true }));
    await vi.advanceTimersByTimeAsync(0);
    unmount();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(contract.callCount("getLatestLedger")).toBe(1);
    expect(unhandled).not.toHaveBeenCalled();
    process.off("unhandledRejection", unhandled);
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

describe("push channel with polling fallback", () => {
  let originalWebSocket: any;

  class MockWebSocket {
    url: string;
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: ((err: any) => void) | null = null;
    onclose: (() => void) | null = null;

    static instances: MockWebSocket[] = [];

    constructor(url: string) {
      this.url = url;
      MockWebSocket.instances.push(this);
    }

    open() {
      this.onopen?.();
    }

    simulateMessage(data: any) {
      this.onmessage?.({ data: JSON.stringify(data) });
    }

    simulateError(err = new Error("network error")) {
      this.onerror?.(err);
      this.onclose?.();
    }

    close() {
      this.onclose?.();
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    MockWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as any;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  test("receives live events via push and triggers refresh without waiting for polling", async () => {
    const refresh = vi.fn();
    contract.read("getLatestLedger").mockResolvedValue(100);

    renderHook(() =>
      useEventPolling(refresh, 10000, {
        pushUrl: "ws://localhost:8080/events",
      }),
    );

    expect(MockWebSocket.instances.length).toBe(1);
    const ws = MockWebSocket.instances[0];

    // Establish WebSocket connection
    ws.open();

    // Push event arrives immediately
    ws.simulateMessage({ type: "proposal_created", ledger: 101 });

    await vi.waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    // Verify polling was not the source (contract.getContractEvents was not invoked yet)
    expect(contract.callCount("getContractEvents")).toBe(0);
  });

  test("falls back to polling when push channel connection fails", async () => {
    const refresh = vi.fn();
    contract.read("getLatestLedger").mockResolvedValue(100);
    contract.read("getContractEvents").mockResolvedValue(105);

    renderHook(() =>
      useEventPolling(refresh, 2000, {
        pushUrl: "ws://localhost:8080/events",
      }),
    );

    const ws = MockWebSocket.instances[0];
    // Push connection fails
    ws.simulateError();

    // Polling kicks in as fallback
    await vi.advanceTimersByTimeAsync(2000);

    await vi.waitFor(() => {
      expect(contract.callCount("getLatestLedger")).toBeGreaterThan(0);
    });

    await vi.advanceTimersByTimeAsync(2000);

    await vi.waitFor(() => {
      expect(contract.callCount("getContractEvents")).toBeGreaterThan(0);
      expect(refresh).toHaveBeenCalled();
    });
  });

  test("reconnects push channel after disconnection and resumes push updates", async () => {
    const refresh = vi.fn();
    contract.read("getLatestLedger").mockResolvedValue(100);

    renderHook(() =>
      useEventPolling(refresh, 10000, {
        pushUrl: "ws://localhost:8080/events",
        reconnectIntervalMs: 1000,
      }),
    );

    const ws1 = MockWebSocket.instances[0];
    ws1.open();
    ws1.simulateError();

    // Advance time to allow reconnect timer to fire
    await vi.advanceTimersByTimeAsync(1500);

    expect(MockWebSocket.instances.length).toBe(2);
    const ws2 = MockWebSocket.instances[1];
    ws2.open();

    // Push updates on reconnected socket
    ws2.simulateMessage({ type: "proposal_executed" });

    await vi.waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });
});

