import { useFiatPrices } from "../hooks/useFiatPrices";
import { formatFreshness, formatUsd, supportsFiat, toFiat } from "../lib/priceFeed";

type FiatValueProps = {
  amount: string;
  token: string;
  className?: string;
};

/** Approximate USD value of a token amount with a freshness timestamp. */
export function FiatValue({ amount, token, className = "" }: FiatValueProps) {
  const { prices, loading, error, refresh } = useFiatPrices([token]);
  const base = `text-xs text-zinc-500 dark:text-zinc-400 ${className}`;

  if (!supportsFiat(token)) return null;

  if (loading) {
    return (
      <p role="status" aria-busy="true" className={base}>
        Loading USD value…
      </p>
    );
  }

  const quote = prices[token.toUpperCase()];
  const value = quote ? toFiat(amount, quote) : null;

  if (error || value === null || !quote) {
    return (
      <p role="alert" className={base}>
        USD value unavailable.{" "}
        <button
          type="button"
          onClick={refresh}
          className="underline hover:text-zinc-300 focus:outline-none focus:ring-2 focus:ring-zinc-400 rounded"
        >
          Retry
        </button>
      </p>
    );
  }

  const updated = new Date(quote.updatedAt);
  return (
    <p className={base}>
      ≈ {formatUsd(value)}{" "}
      <time dateTime={updated.toISOString()} title={updated.toLocaleString()}>
        · price updated {formatFreshness(quote.updatedAt)}
      </time>
    </p>
  );
}
