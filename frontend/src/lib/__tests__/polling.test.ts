import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPolling } from "../polling";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("shared polling", () => {
  it("doubles failures to the cap, then resets on success", async () => {
    const task = vi.fn().mockRejectedValue(new Error("Offline"));
    const onError = vi.fn();
    const polling = startPolling(task, 1000, onError);
    await vi.advanceTimersByTimeAsync(0);
    for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) {
      const count = task.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(task).toHaveBeenCalledTimes(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(task).toHaveBeenCalledTimes(count + 1);
    }
    expect(onError).toHaveBeenCalledTimes(7);
    task.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(30000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(9);
    polling.stop();
  });
  it("does not start a cancelled initial task or restart after cleanup", async () => {
    const task = vi.fn();
    const polling = startPolling(task, 1000);
    polling.stop();
    await vi.advanceTimersByTimeAsync(60000);
    await polling.refresh();
    expect(task).not.toHaveBeenCalled();
  });
  it.each([0, -1, NaN, Infinity])("rejects invalid interval %s", (interval) => {
    expect(() => startPolling(vi.fn(), interval)).toThrow(RangeError);
  });
});
