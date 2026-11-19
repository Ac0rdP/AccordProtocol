import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  clearDigestQueue,
  getDigestQueue,
  readNotificationSchedule,
  resetNotificationSchedule,
  saveNotificationSchedule,
  subscribeToDigestQueue,
  type DigestItem,
  type NotificationSchedule,
} from "../lib/notificationSchedule";

// useSyncExternalStore needs a referentially stable snapshot between changes.
let cachedQueueRaw: string | null = null;
let cachedQueue: DigestItem[] = [];
function queueSnapshot(): DigestItem[] {
  const next = getDigestQueue();
  const raw = JSON.stringify(next);
  if (raw !== cachedQueueRaw) {
    cachedQueueRaw = raw;
    cachedQueue = next;
  }
  return cachedQueue;
}

export function useNotificationSchedule(
  read: () => NotificationSchedule = readNotificationSchedule,
) {
  const [schedule, setSchedule] = useState<NotificationSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const queue = useSyncExternalStore(subscribeToDigestQueue, queueSnapshot, queueSnapshot);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(read)
      .then((loaded) => {
        if (cancelled) return;
        setSchedule(loaded);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not read your notification schedule");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [read, attempt]);

  const retry = useCallback(() => {
    setLoading(true);
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  const reset = useCallback(() => {
    resetNotificationSchedule();
    setLoading(true);
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  /** Validates and persists. Throws a user-facing error on failure. */
  const save = useCallback((next: NotificationSchedule) => {
    setSchedule(saveNotificationSchedule(next));
  }, []);

  return { schedule, loading, error, retry, reset, save, queue, clearQueue: clearDigestQueue };
}
