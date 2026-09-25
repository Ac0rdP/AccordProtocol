import { useCallback, useEffect, useRef, useState } from "react";
import { analyticsClient } from "../lib/analyticsClient";
import { startPolling } from "../lib/polling";
import type { AnalyticsQuery, TreasuryAnalytics } from "../types/accord";

/** Poll indexed data directly: the indexer can catch up after RPC events arrive. */
export function useTreasuryAnalytics(query: AnalyticsQuery = {}, intervalMs = 30_000) {
  const [data, setData] = useState<TreasuryAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof startPolling> | null>(null);
  const queryKey = JSON.stringify(Object.fromEntries(
    Object.entries(query).sort(([a], [b]) => a.localeCompare(b)),
  ));

  useEffect(() => {
    // Reconstruct from the stable key so equal inline filter objects don't restart polling.
    const filters = JSON.parse(queryKey) as AnalyticsQuery;
    let initial = true;
    const polling = startPolling(async (signal) => {
      if (initial) {
        setData(null);
        setError(null);
        initial = false;
      }
      setLoading(true);
      try {
        const requests = [
          analyticsClient.getSummary(filters, signal),
          analyticsClient.getBalance({ ...filters, timeSeries: true }, signal),
          analyticsClient.getSpendByCategory(filters, signal),
          analyticsClient.getSpendByOwner(filters, signal),
          analyticsClient.getFlow(filters, signal),
        ] as const;
        // Wait for the entire batch before retrying, even if one endpoint fails.
        const outcomes = await Promise.allSettled(requests);
        const failure = outcomes.find((outcome) => outcome.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        const [summary, balance, spendByCategory, spendByOwner, flow] = await Promise.all(requests);
        if (!signal.aborted) {
          setData({ summary, balance, spendByCategory, spendByOwner, flow });
          setError(null);
        }
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    }, intervalMs, (err) => setError(err instanceof Error ? err.message : "Failed to load treasury analytics"));
    pollingRef.current = polling;
    return () => {
      polling.stop();
      pollingRef.current = null;
    };
  }, [queryKey, intervalMs]);

  const refresh = useCallback(() => pollingRef.current?.refresh() ?? Promise.resolve(), []);
  return { data, loading, error, refresh };
}
