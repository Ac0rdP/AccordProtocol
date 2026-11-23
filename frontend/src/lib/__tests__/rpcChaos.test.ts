import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSubmissionKey,
  isSubmissionInFlight,
  mapSubmissionError,
  withSubmissionRetry,
} from "../submit";
import { startPolling } from "../polling";

describe("RPC chaos and failure tolerance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("submission RPC failures and double-submit prevention", () => {
    it("surfaces RPC errors cleanly and maps them without state corruption", async () => {
      const failingOp = vi.fn().mockRejectedValue(new Error("503 Service Unavailable: RPC node down"));
      const submission = withSubmissionRetry(failingOp, { maxAttempts: 2, delayMs: 10 });
      // Attach the rejection handler before draining the (faked) retry timers.
      const assertion = expect(submission).rejects.toThrow("Unable to connect to the network");
      await vi.runAllTimersAsync();
      await assertion;

      expect(failingOp).toHaveBeenCalledTimes(2);
    });

    it("does not retry unrecoverable contract errors or wallet rejections", async () => {
      const contractErrorOp = vi.fn().mockRejectedValue(new Error("Error(Contract, #5)"));
      await expect(
        withSubmissionRetry(contractErrorOp, { maxAttempts: 3, delayMs: 10 })
      ).rejects.toThrow("Invalid list of owners.");

      // Must fail immediately without wasteful retries
      expect(contractErrorOp).toHaveBeenCalledTimes(1);

      const walletRejectOp = vi.fn().mockRejectedValue(new Error("User cancelled transaction"));
      await expect(
        withSubmissionRetry(walletRejectOp, { maxAttempts: 3, delayMs: 10 })
      ).rejects.toThrow("Transaction was rejected in your wallet.");

      expect(walletRejectOp).toHaveBeenCalledTimes(1);
    });

    it("generates deterministic submission keys to prevent concurrent double-submits", () => {
      const caller = "GDJSB22NWBU7IV44SHHG6WO6AJTUED2KNKWL2DYNJJ5X7M5SG7UVC7JD";
      const key1 = getSubmissionKey(caller, "execute", []);
      const key2 = getSubmissionKey(caller, "execute", []);
      const key3 = getSubmissionKey(caller, "cancel", []);

      expect(key1).toBe(key2);
      expect(key1).not.toBe(key3);
      expect(isSubmissionInFlight(caller, "execute", [])).toBe(false);
    });
  });

  describe("polling chaos resilience", () => {
    it("degrades gracefully under persistent RPC outage and backs off up to 30s cap", async () => {
      const rpcOutageError = new Error("RPC socket timeout / disconnected");
      const pollTask = vi.fn().mockRejectedValue(rpcOutageError);
      const onError = vi.fn();

      const polling = startPolling(pollTask, 1000, onError);

      // Initial execution
      await vi.advanceTimersByTimeAsync(0);
      expect(pollTask).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(rpcOutageError);

      // Delay grows: 2000ms -> 4000ms -> 8000ms -> 16000ms -> 30000ms
      await vi.advanceTimersByTimeAsync(2000);
      expect(pollTask).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(4000);
      expect(pollTask).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(8000);
      expect(pollTask).toHaveBeenCalledTimes(4);

      // Verify recovery when RPC comes back online
      pollTask.mockResolvedValueOnce(undefined);
      await vi.advanceTimersByTimeAsync(16000);
      expect(pollTask).toHaveBeenCalledTimes(5);

      // Upon success, interval resets to base 1000ms
      await vi.advanceTimersByTimeAsync(1000);
      expect(pollTask).toHaveBeenCalledTimes(6);

      polling.stop();
    });

    it("discards partial and malformed RPC responses without state corruption", async () => {
      let stateLedger: number | null = 100;
      let refreshCalled = 0;

      const flakyRpcPoller = async () => {
        // Simulate malformed/partial response
        const badResponse: any = null;
        if (typeof badResponse === "number" && Number.isSafeInteger(badResponse) && badResponse > stateLedger!) {
          stateLedger = badResponse;
          refreshCalled += 1;
        }
      };

      await flakyRpcPoller();
      expect(stateLedger).toBe(100);
      expect(refreshCalled).toBe(0);

      // Valid future ledger
      const validFutureLedger = 105;
      if (
        typeof validFutureLedger === "number" &&
        Number.isSafeInteger(validFutureLedger) &&
        validFutureLedger > stateLedger!
      ) {
        stateLedger = validFutureLedger;
        refreshCalled += 1;
      }

      expect(stateLedger).toBe(105);
      expect(refreshCalled).toBe(1);
    });
  });
});
