import { useEffect, useState } from "react";
import { NotificationScheduleForm } from "../components/NotificationScheduleForm";
import { PageState } from "../components/PageState";
import { useNotificationSchedule } from "../hooks/useNotificationSchedule";

type NotificationSchedulePageProps = {
  /** Injectable clock for tests; defaults to the current time, updated each minute. */
  now?: number;
};

/** Quiet hours and digest scheduling for browser notifications. */
export function NotificationSchedulePage({ now }: NotificationSchedulePageProps = {}) {
  const { schedule, loading, error, retry, reset, save, queue, clearQueue } =
    useNotificationSchedule();
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => {
    if (now !== undefined) return;
    const timer = setInterval(() => setClock(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [now]);

  let body;
  if (loading) {
    body = <PageState status="loading" title="Loading notification schedule…" />;
  } else if (error || !schedule) {
    body = (
      <div>
        <PageState
          status="error"
          title="Could not load notification schedule"
          description={error ?? undefined}
          onRetry={retry}
        />
        <div className="flex justify-center pb-6">
          <button
            type="button"
            onClick={reset}
            className="min-h-11 rounded-lg px-4 text-sm text-zinc-400 underline hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            Reset to default schedule
          </button>
        </div>
      </div>
    );
  } else {
    body = (
      <NotificationScheduleForm
        schedule={schedule}
        onSave={save}
        queue={queue}
        onClearQueue={clearQueue}
        now={now ?? clock}
      />
    );
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-white">Notification schedule</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Silence alerts during quiet hours and batch them into daily or weekly digests.
        </p>
      </header>
      {body}
    </div>
  );
}
