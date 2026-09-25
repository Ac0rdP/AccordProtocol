import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalyticsApiError, buildAnalyticsQuery, createAnalyticsClient } from "../analyticsClient";

const client = createAnalyticsClient("https://analytics.example/api///");
afterEach(() => vi.unstubAllGlobals());

describe("analytics client", () => {
  it("serializes ranges, filters and pagination without losing zero or false", () => {
    const params = new URLSearchParams(buildAnalyticsQuery({ startDate: "2026-09-01", endDate: "", owner: "G+ /?", offset: 0, limit: 20, timeSeries: false, granularity: "week", sort: "amount", order: "desc", category: "Grant", status: "executed" }));
    expect(Object.fromEntries(params)).toEqual({ startDate: "2026-09-01", owner: "G+ /?", offset: "0", limit: "20", timeSeries: "false", granularity: "week", sort: "amount", order: "desc", category: "Grant", status: "executed" });
    expect(buildAnalyticsQuery({ owner: "G", offset: 0 })).toBe(buildAnalyticsQuery({ offset: 0, owner: "G" }));
  });
  it("calls every data endpoint and forwards cancellation", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ fixture: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;
    const calls = [
      ["/proposals", () => client.getProposals({}, signal)],
      ["/proposals/a%2Fb", () => client.getProposal("a/b", signal)],
      ["/spend/by-category", () => client.getSpendByCategory({}, signal)],
      ["/spend/by-owner", () => client.getSpendByOwner({}, signal)],
      ["/treasury/balance", () => client.getBalance({}, signal)],
      ["/treasury/flow", () => client.getFlow({}, signal)],
      ["/stats/summary", () => client.getSummary({}, signal)],
    ] as const;
    for (const [path, call] of calls) {
      expect(await call()).toEqual({ fixture: true });
      expect(fetchMock).toHaveBeenLastCalledWith(`https://analytics.example/api${path}`, { headers: { Accept: "application/json" }, signal });
    }
  });
  it("supports same-origin URLs and preserves amount strings", async () => {
    const body = { balances: { XLM: "9007199254740993.0000001" }, timeSeries: [] };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal("fetch", fetchMock);
    expect(await createAnalyticsClient("").getBalance({ timeSeries: true, offset: 0 })).toEqual(body);
    expect(fetchMock.mock.calls[0][0]).toBe("/treasury/balance?offset=0&timeSeries=true");
  });
  it.each([{ error: { message: "Invalid range" } }, { message: "Invalid range" }, { error: "Invalid range" }])("surfaces structured errors", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => body }));
    await expect(client.getSummary()).rejects.toMatchObject({ name: "AnalyticsApiError", message: "Invalid range", status: 400, body });
  });
  it("reports non-JSON failures and invalid successful JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => { throw new SyntaxError(); } });
    vi.stubGlobal("fetch", fetchMock);
    await expect(client.getSummary()).rejects.toMatchObject({ message: "Analytics request failed (503)", status: 503 });
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError(); } });
    await expect(client.getSummary()).rejects.toBeInstanceOf(AnalyticsApiError);
    await expect(client.getSummary()).rejects.toThrow("Invalid JSON from /stats/summary");
  });
  it("propagates network errors and aborts", async () => {
    const error = new DOMException("Aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
    await expect(client.getSummary()).rejects.toBe(error);
  });
});
