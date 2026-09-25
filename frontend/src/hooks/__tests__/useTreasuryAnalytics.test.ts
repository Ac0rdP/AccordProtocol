import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTreasuryAnalytics } from "../useTreasuryAnalytics";
import { analyticsClient } from "../../lib/analyticsClient";

vi.mock("../../lib/analyticsClient", () => ({ analyticsClient: {
  getSummary: vi.fn(), getBalance: vi.fn(), getSpendByCategory: vi.fn(), getSpendByOwner: vi.fn(), getFlow: vi.fn(),
} }));
const summary = { totalDisbursed: { XLM: "100" }, activeProposals: 2, ownerCount: 3, largestOutflow: null };
async function advance(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.mocked(analyticsClient.getSummary).mockResolvedValue(summary);
  vi.mocked(analyticsClient.getBalance).mockResolvedValue({ balances: { XLM: "50" }, timeSeries: [] });
  vi.mocked(analyticsClient.getSpendByCategory).mockResolvedValue([]);
  vi.mocked(analyticsClient.getSpendByOwner).mockResolvedValue([]);
  vi.mocked(analyticsClient.getFlow).mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

describe("useTreasuryAnalytics", () => {
  it("fetches all datasets, reports loading, and polls at the configured interval", async () => {
    const { result } = renderHook(() => useTreasuryAnalytics({ token: "XLM" }, 1000));
    expect(result.current.loading).toBe(true);
    await advance();
    expect(result.current.data?.summary).toEqual(summary);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(analyticsClient.getBalance).toHaveBeenCalledWith({ token: "XLM", timeSeries: true }, expect.any(AbortSignal));
    await advance(1000);
    expect(analyticsClient.getSummary).toHaveBeenCalledTimes(2);
  });
  it("backs off after errors, retains the last data and resets after recovery", async () => {
    const { result } = renderHook(() => useTreasuryAnalytics({}, 1000));
    await advance();
    vi.mocked(analyticsClient.getSummary).mockRejectedValueOnce(new Error("Offline"));
    await advance(1000);
    expect(result.current.error).toBe("Offline");
    expect(result.current.data?.summary).toEqual(summary);
    expect(result.current.loading).toBe(false);
    await advance(1999);
    expect(analyticsClient.getSummary).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(result.current.error).toBeNull();
    await advance(1000);
    expect(analyticsClient.getSummary).toHaveBeenCalledTimes(4);
  });
  it("refreshes immediately during backoff and does not duplicate the timer", async () => {
    vi.mocked(analyticsClient.getSummary).mockRejectedValueOnce(new Error("Offline"));
    const { result } = renderHook(() => useTreasuryAnalytics({}, 1000));
    await advance();
    await act(async () => { await result.current.refresh(); });
    expect(result.current.error).toBeNull();
    expect(analyticsClient.getSummary).toHaveBeenCalledTimes(2);
    await advance(1000);
    expect(analyticsClient.getSummary).toHaveBeenCalledTimes(3);
  });
  it("does not overlap a slow request or manual refresh", async () => {
    let resolve!: (value: typeof summary) => void;
    vi.mocked(analyticsClient.getSummary).mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const { result } = renderHook(() => useTreasuryAnalytics({}, 1000));
    await advance(5000);
    act(() => { void result.current.refresh(); });
    expect(analyticsClient.getSummary).toHaveBeenCalledTimes(1);
    await act(async () => resolve(summary));
    await advance(1000);
    expect(analyticsClient.getSummary).toHaveBeenCalledTimes(2);
  });
  it("ignores old filter responses and aborts on changes and unmount", async () => {
    let resolve!: (value: typeof summary) => void;
    vi.mocked(analyticsClient.getSummary).mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const { result, rerender, unmount } = renderHook(({ owner }) => useTreasuryAnalytics({ owner }, 1000), { initialProps: { owner: "A" } });
    await advance();
    const oldSignal = vi.mocked(analyticsClient.getSummary).mock.calls[0][1]!;
    rerender({ owner: "B" });
    await advance();
    expect(oldSignal.aborted).toBe(true);
    await act(async () => resolve({ ...summary, ownerCount: 999 }));
    expect(result.current.data?.summary.ownerCount).toBe(3);
    rerender({ owner: "B" });
    await advance();
    expect(analyticsClient.getSummary).toHaveBeenCalledTimes(2);
    const signal = vi.mocked(analyticsClient.getSummary).mock.calls[1][1]!;
    unmount();
    expect(signal.aborted).toBe(true);
    await advance(60_000);
    expect(analyticsClient.getSummary).toHaveBeenCalledTimes(2);
  });
});
