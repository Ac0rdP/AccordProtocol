import { useCallback, useEffect, useRef, useState } from "react";
import type { AlertRule, AlertRulesClient } from "../lib/alertRules";

const PAGE_SIZE = 100;
/** A safety stop; the API allows at most 200 managed rules plus the configured ones. */
const MAX_PAGES = 10;

/** Loads every alert rule (configured and managed), paging through the API. */
export function useAlertRules(client: AlertRulesClient) {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const reload = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const all: AlertRule[] = [];
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await client.list({ limit: PAGE_SIZE, offset: page * PAGE_SIZE });
        all.push(...result.items);
        if (all.length >= result.total || result.items.length === 0) break;
      }
      // Ignore a response that a newer reload has already superseded.
      if (id !== requestId.current) return;
      setRules(all);
      setError(null);
    } catch (err) {
      if (id !== requestId.current) return;
      setError(err instanceof Error ? err.message : "Could not load alert rules");
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void Promise.resolve().then(reload);
    return () => {
      // Invalidate in-flight loads when the page unmounts or the client changes.
      requestId.current += 1;
    };
  }, [reload]);

  return { rules, loading, error, reload };
}
