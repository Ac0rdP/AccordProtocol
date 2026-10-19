import { vi, describe, it, expect, beforeEach } from "vitest";
import {
  estimateCreateProposalFee,
  mapSubmissionError,
  withSubmissionRetry,
} from "./submit";

// Mock the stellar-sdk to avoid real network calls
vi.mock("@stellar/stellar-sdk", async () => {
  const original = await vi.importActual("@stellar/stellar-sdk") as any;
  return {
    ...original,
    nativeToScVal: vi.fn().mockReturnValue({}),
    rpc: {
      ...original.rpc,
      Server: vi.fn().mockImplementation(() => ({
        getAccount: vi.fn().mockResolvedValue({ sequence: "123" }),
        simulateTransaction: vi.fn().mockResolvedValue({
          _type: "success",
          minResourceFee: "50000",
        }),
        sendTransaction: vi.fn().mockRejectedValue(new Error("Should not broadcast")),
      })),
      Api: {
        isSimulationSuccess: vi.fn().mockReturnValue(true),
      },
    },
    Contract: vi.fn().mockImplementation(() => ({
      call: vi.fn().mockReturnValue({}),
    })),
    TransactionBuilder: vi.fn().mockImplementation(() => {
      const builder = {
        addOperation: vi.fn().mockReturnThis(),
        setTimeout: vi.fn().mockReturnThis(),
        build: vi.fn().mockReturnValue({}),
      };
      return builder;
    }),
  };
});

describe("submit utils", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("estimateCreateProposalFee", () => {
    it("returns calculated fee in XLM", async () => {
      const fee = await estimateCreateProposalFee(
        "GXXXX",
        "GYYYY",
        "GZZZZ",
        100n,
        "Test proposal",
        1234567890n
      );

      // (100000 baseFee + 50000 minResourceFee) / 10000000 = 0.015
      expect(fee).toBe(0.015);
    });

    it("uses simulation result but does not broadcast transaction", async () => {
      const fee = await estimateCreateProposalFee(
        "GXXXX",
        "GYYYY",
        "GZZZZ",
        100n,
        "Test proposal",
        1234567890n
      );

      expect(fee).toBe(0.015);
    });
  });

  describe("mapSubmissionError", () => {
    it.each([
      ["Error(Contract, #5)", "Invalid list of owners."],
      [new Error("User rejected the transaction"), "Transaction was rejected in your wallet."],
      ["Network request failed", "Unable to connect to the network. Check your connection and try again."],
      ["Transaction failed on-chain", "The transaction failed on-chain. Please review the proposal and try again."],
      [new Error("unexpected failure"), "Something went wrong while processing the transaction. Please try again."],
      [undefined, "Something went wrong while processing the transaction. Please try again."],
    ])("maps %p to a user-facing message", (error, expected) => {
      expect(mapSubmissionError(error)).toBe(expected);
    });
  });

  describe("withSubmissionRetry", () => {
    it("retries a network failure and returns the eventual success", async () => {
      const operation = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error("network unavailable"))
        .mockResolvedValue("submitted");

      await expect(
        withSubmissionRetry(operation, { delayMs: 0 }),
      ).resolves.toBe("submitted");
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it("gives up after the configured attempts with a mapped message", async () => {
      const operation = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("timeout"));

      await expect(
        withSubmissionRetry(operation, { maxAttempts: 3, delayMs: 0 }),
      ).rejects.toThrow("Unable to connect to the network.");
      expect(operation).toHaveBeenCalledTimes(3);
    });

    it("does not retry wallet rejection errors", async () => {
      const operation = vi
        .fn<() => Promise<void>>()
        .mockRejectedValue(new Error("User denied request"));

      await expect(withSubmissionRetry(operation, { delayMs: 0 })).rejects.toThrow(
        "Transaction was rejected in your wallet.",
      );
      expect(operation).toHaveBeenCalledTimes(1);
    });
  });
});
