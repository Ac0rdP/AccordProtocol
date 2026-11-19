import { useCallback, useEffect, useState } from "react";
import { fetchUsdPrices, type PriceMap } from "../lib/priceFeed";

const EMPTY: PriceMap = {};

type FiatPricesState = {
  prices: PriceMap;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

/** Loads USD prices for the given tokens; re-fetches when the token list changes. */
export function useFiatPrices(tokens: string[]): FiatPricesState {
  const key = [...new Set(tokens.map((t) => t.toUpperCase()))].sort().join(",");
  const [nonce, setNonce] = useState(0);
  const requestKey = `${key}#${nonce}`;
  const [result, setResult] = useState<{ key: string; prices: PriceMap; error: string | null } | null>(null);

  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => fetchUsdPrices(key ? key.split(",") : []))
      .then((prices) => {
        if (active) setResult({ key: requestKey, prices, error: null });
      })
      .catch(() => {
        if (active) setResult({ key: requestKey, prices: {}, error: "Price feed unavailable" });
      });
    return () => {
      active = false;
    };
  }, [key, requestKey]);

  const current = result?.key === requestKey ? result : null;
  const prices = current?.prices ?? EMPTY;
  const loading = current === null;
  const error = current?.error ?? null;

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { prices, loading, error, refresh };
}
