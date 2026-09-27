import { useEffect } from "react";
import { getContractEvents, getLatestLedger } from "../lib/contract";
import { startPolling } from "../lib/polling";

export function useEventPolling(
  refresh: () => void | Promise<void>,
  intervalMs: number,
) {
  useEffect(() => {
    let lastSeenLedger: number | null = null;
    const polling = startPolling(async (signal) => {
      if (lastSeenLedger === null) {
        lastSeenLedger = await getLatestLedger();
        return;
      }
      const latest = await getContractEvents(lastSeenLedger, { throwOnError: true });
      if (latest > lastSeenLedger && !signal.aborted) {
        await refresh();
        if (!signal.aborted) lastSeenLedger = latest;
      }
    }, intervalMs, (error) => console.error("Error during event polling", error));
    return polling.stop;
  }, [refresh, intervalMs]);
}
