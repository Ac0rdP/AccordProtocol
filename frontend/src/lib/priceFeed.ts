export type PriceQuote = {
  /** USD price per token unit. */
  usd: number;
  /** Unix ms timestamp of the quote. */
  updatedAt: number;
};

export type PriceMap = Record<string, PriceQuote>;

/** CoinGecko ids for tokens the vault commonly holds. */
const COINGECKO_IDS: Record<string, string> = {
  XLM: "stellar",
  USDC: "usd-coin",
  EURC: "euro-coin",
  BTC: "bitcoin",
  ETH: "ethereum",
};

const DEFAULT_FEED_URL = "https://api.coingecko.com/api/v3/simple/price";

function feedUrl(): string {
  return import.meta.env.VITE_PRICE_FEED_URL || DEFAULT_FEED_URL;
}

export function supportsFiat(token: string): boolean {
  return token.toUpperCase() in COINGECKO_IDS;
}

/** Fetches USD prices for the given token symbols. Unknown tokens are skipped. */
export async function fetchUsdPrices(
  tokens: string[],
  fetcher: typeof fetch = fetch,
): Promise<PriceMap> {
  const symbols = [...new Set(tokens.map((t) => t.toUpperCase()))].filter(supportsFiat);
  if (symbols.length === 0) return {};

  const ids = symbols.map((s) => COINGECKO_IDS[s]).join(",");
  const res = await fetcher(
    `${feedUrl()}?ids=${ids}&vs_currencies=usd&include_last_updated_at=true`,
  );
  if (!res.ok) throw new Error(`Price feed returned ${res.status}`);
  const body = (await res.json()) as Record<string, { usd?: number; last_updated_at?: number }>;

  const prices: PriceMap = {};
  for (const symbol of symbols) {
    const entry = body[COINGECKO_IDS[symbol]];
    if (typeof entry?.usd === "number") {
      prices[symbol] = {
        usd: entry.usd,
        updatedAt: (entry.last_updated_at ?? Math.floor(Date.now() / 1000)) * 1000,
      };
    }
  }
  return prices;
}

export function toFiat(amount: string, quote: PriceQuote): number | null {
  const n = Number.parseFloat(amount.replace(/,/g, ""));
  return Number.isFinite(n) ? n * quote.usd : null;
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
}

export function formatFreshness(updatedAt: number, now: number = Date.now()): string {
  const mins = Math.max(0, Math.round((now - updatedAt) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)} h ago`;
}
