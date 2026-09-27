import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getContractEvents } from "../contract";

const { getEvents } = vi.hoisted(() => ({ getEvents: vi.fn() }));
vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return { ...actual, rpc: { ...actual.rpc, Server: class { getEvents = getEvents; } } };
});
beforeEach(() => {
  getEvents.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("contract polling error propagation", () => {
  it("preserves the default fallback for existing callers", async () => {
    getEvents.mockRejectedValue(new Error("RPC unavailable"));
    expect(await getContractEvents(100)).toBe(100);
  });
  it("exposes RPC failures to the backoff scheduler when requested", async () => {
    getEvents.mockRejectedValue(new Error("RPC unavailable"));
    await expect(getContractEvents(100, { throwOnError: true })).rejects.toThrow("RPC unavailable");
  });
  it("returns the latest ledger after recovery", async () => {
    getEvents.mockResolvedValue({ latestLedger: 105 });
    expect(await getContractEvents(100, { throwOnError: true })).toBe(105);
    expect(getEvents).toHaveBeenCalledWith(expect.objectContaining({ startLedger: 100 }));
  });
});
