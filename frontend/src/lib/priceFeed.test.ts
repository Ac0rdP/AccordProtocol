import { describe, expect, it, vi } from "vitest";
import { fetchUsdPrices, formatFreshness, formatUsd, toFiat } from "./priceFeed";

describe("priceFeed", () => {
  it("maps token symbols to USD quotes and skips unknown tokens", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ stellar: { usd: 0.12, last_updated_at: 1_700_000_000 } }),
    });
    const prices = await fetchUsdPrices(["xlm", "FOO"], fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("ids=stellar&"));
    expect(prices).toEqual({ XLM: { usd: 0.12, updatedAt: 1_700_000_000_000 } });
  });

  it("throws on a failed response and skips the request for unknown tokens", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    await expect(fetchUsdPrices(["XLM"], fetcher as unknown as typeof fetch)).rejects.toThrow("429");
    await expect(fetchUsdPrices(["FOO"], fetcher as unknown as typeof fetch)).resolves.toEqual({});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("formats values and freshness", () => {
    expect(toFiat("1,000", { usd: 0.5, updatedAt: 0 })).toBe(500);
    expect(formatUsd(500)).toBe("$500.00");
    expect(formatFreshness(0, 5 * 60_000)).toBe("5 min ago");
    expect(formatFreshness(0, 10_000)).toBe("just now");
  });
});
