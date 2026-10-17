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
    vi.mocked(contract.getLatestLedger).mockResolvedValue(100);

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
    expect(contract.getContractEvents).not.toHaveBeenCalled();
  });

  test("falls back to polling when push channel connection fails", async () => {
    const refresh = vi.fn();
    vi.mocked(contract.getLatestLedger).mockResolvedValue(100);
    vi.mocked(contract.getContractEvents).mockResolvedValue(105);

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
      expect(contract.getLatestLedger).toHaveBeenCalled();
    });

    await vi.advanceTimersByTimeAsync(2000);

    await vi.waitFor(() => {
      expect(contract.getContractEvents).toHaveBeenCalled();
      expect(refresh).toHaveBeenCalled();
    });
  });

  test("reconnects push channel after disconnection and resumes push updates", async () => {
    const refresh = vi.fn();
    vi.mocked(contract.getLatestLedger).mockResolvedValue(100);

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

