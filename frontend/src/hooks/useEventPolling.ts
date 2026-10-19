import { useEffect } from "react";
import { getContractEvents, getLatestLedger } from "../lib/contract";
import { startPolling } from "../lib/polling";
import { startEventPush, type EventPushConnection } from "../lib/eventPush";

export type EventPollingOptions = {
  pushUrl?: string;
  useSSE?: boolean;
  disablePush?: boolean;
  reconnectIntervalMs?: number;
};

export function useEventPolling(
  refresh: () => void | Promise<void>,
  intervalMs: number,
  options: EventPollingOptions = {},
) {
  useEffect(() => {
    let lastSeenLedger: number | null = null;
    let pushActive = false;

    const polling = startPolling(
      async (signal) => {
        if (pushActive) return;

        if (lastSeenLedger === null) {
          const initial = await getLatestLedger();
          if (typeof initial === "number" && Number.isSafeInteger(initial) && initial > 0) {
            lastSeenLedger = initial;
          }
          return;
        }
        const latest = await getContractEvents(lastSeenLedger, { throwOnError: true });
        if (
          typeof latest === "number" &&
          Number.isSafeInteger(latest) &&
          latest > lastSeenLedger &&
          !signal.aborted
        ) {
          await refresh();
          if (!signal.aborted) lastSeenLedger = latest;
        }
      },
      intervalMs,
      (error) => console.error("Error during event polling", error),
    );

    let pushConn: EventPushConnection | null = null;

    if (!options.disablePush) {
      pushConn = startEventPush(
        async () => {
          await refresh();
        },
        {
          url: options.pushUrl,
          useSSE: options.useSSE,
          reconnectIntervalMs: options.reconnectIntervalMs,
          onStatusChange: (status) => {
            pushActive = status === "connected";
            if (status === "fallback" || status === "disconnected") {
              void polling.refresh();
            }
          },
        },
      );
    }

    return () => {
      polling.stop();
      pushConn?.close();
    };
  }, [
    refresh,
    intervalMs,
    options.pushUrl,
    options.useSSE,
    options.disablePush,
    options.reconnectIntervalMs,
  ]);
}
