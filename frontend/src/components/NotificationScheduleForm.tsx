import { useId, useState, type FormEvent } from "react";
import {
  WEEKDAY_NAMES,
  nextDigestAt,
  validateSchedule,
  type DigestFrequency,
  type DigestItem,
  type NotificationSchedule,
} from "../lib/notificationSchedule";
import { EmptyState } from "./EmptyState";

const FOCUS_RING =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950";

const INPUT =
  "min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 disabled:opacity-40";

const FREQUENCIES: { value: DigestFrequency; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "Send each alert as it happens" },
  { value: "daily", label: "Daily", hint: "One summary per day" },
  { value: "weekly", label: "Weekly", hint: "One summary per week" },
];

function formatWhen(date: Date): string {
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  } catch {
    return "local time";
  }
}

export type NotificationScheduleFormProps = {
  schedule: NotificationSchedule;
  /** Persists the schedule. May throw a user-facing error. */
  onSave: (schedule: NotificationSchedule) => void;
  queue: DigestItem[];
  onClearQueue: () => void;
  /** Current time in ms; injectable for deterministic tests and stories. */
  now: number;
};

/** Quiet hours and digest settings plus a view of alerts waiting to be sent. */
export function NotificationScheduleForm({
  schedule,
  onSave,
  queue,
  onClearQueue,
  now,
}: NotificationScheduleFormProps) {
  const [draft, setDraft] = useState<NotificationSchedule>(schedule);
  const [status, setStatus] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const ids = {
    quietToggle: useId(),
    quietStart: useId(),
    quietEnd: useId(),
    digestTime: useId(),
    digestDay: useId(),
  };

  const quiet = draft.quietHours;
  const digest = draft.digest;
  const dirty = JSON.stringify(draft) !== JSON.stringify(schedule);
  const next = nextDigestAt(draft, new Date(now));

  function patchQuiet(patch: Partial<NotificationSchedule["quietHours"]>) {
    setDraft((d) => ({ ...d, quietHours: { ...d.quietHours, ...patch } }));
    setStatus(null);
  }

  function patchDigest(patch: Partial<NotificationSchedule["digest"]>) {
    setDraft((d) => ({ ...d, digest: { ...d.digest, ...patch } }));
    setStatus(null);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const problem = validateSchedule(draft);
    if (problem) {
      setStatus({ tone: "error", text: problem });
      return;
    }
    try {
      onSave(draft);
      setStatus({ tone: "success", text: "Notification schedule saved." });
    } catch (err) {
      setStatus({
        tone: "error",
        text: err instanceof Error ? err.message : "Could not save your schedule.",
      });
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="space-y-6" noValidate>
        <fieldset className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <legend className="px-1 text-base font-semibold text-zinc-100">Quiet hours</legend>
          <p className="mb-3 text-sm text-zinc-400">
            Browser alerts are held during quiet hours and delivered together when they end.
            Times use your device&apos;s time zone ({localTimeZone()}).
          </p>
          <label htmlFor={ids.quietToggle} className="mb-3 flex min-h-11 items-center gap-3 text-sm text-zinc-200">
            <input
              id={ids.quietToggle}
              type="checkbox"
              checked={quiet.enabled}
              onChange={(e) => patchQuiet({ enabled: e.target.checked })}
              className="h-4 w-4 accent-emerald-500"
            />
            Enable quiet hours
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={ids.quietStart} className="mb-1 block text-xs text-zinc-400">
                Start
              </label>
              <input
                id={ids.quietStart}
                type="time"
                value={quiet.start}
                disabled={!quiet.enabled}
                onChange={(e) => patchQuiet({ start: e.target.value })}
                className={`${INPUT} ${FOCUS_RING}`}
              />
            </div>
            <div>
              <label htmlFor={ids.quietEnd} className="mb-1 block text-xs text-zinc-400">
                End
              </label>
              <input
                id={ids.quietEnd}
                type="time"
                value={quiet.end}
                disabled={!quiet.enabled}
                onChange={(e) => patchQuiet({ end: e.target.value })}
                className={`${INPUT} ${FOCUS_RING}`}
              />
            </div>
          </div>
        </fieldset>

        <fieldset className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <legend className="px-1 text-base font-semibold text-zinc-100">Digest</legend>
          <p className="mb-3 text-sm text-zinc-400">
            Batch browser alerts into one summary instead of sending each as it happens. Every
            event is still recorded in the notification center.
          </p>
          <div role="radiogroup" aria-label="Digest frequency" className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
            {FREQUENCIES.map((option) => (
              <label
                key={option.value}
                className={`flex min-h-11 cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm has-focus-visible:ring-2 has-focus-visible:ring-emerald-400 ${
                  digest.frequency === option.value
                    ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-100"
                    : "border-zinc-700 text-zinc-300"
                }`}
              >
                <input
                  type="radio"
                  name="digest-frequency"
                  value={option.value}
                  checked={digest.frequency === option.value}
                  onChange={() => patchDigest({ frequency: option.value })}
                  className="mt-1 accent-emerald-500"
                />
                <span>
                  <span className="block font-medium">{option.label}</span>
                  <span className="block text-xs text-zinc-400">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={ids.digestTime} className="mb-1 block text-xs text-zinc-400">
                Delivery time
              </label>
              <input
                id={ids.digestTime}
                type="time"
                value={digest.time}
                disabled={digest.frequency === "off"}
                onChange={(e) => patchDigest({ time: e.target.value })}
                className={`${INPUT} ${FOCUS_RING}`}
              />
            </div>
            <div>
              <label htmlFor={ids.digestDay} className="mb-1 block text-xs text-zinc-400">
                Weekly on
              </label>
              <select
                id={ids.digestDay}
                value={digest.weekday}
                disabled={digest.frequency !== "weekly"}
                onChange={(e) => patchDigest({ weekday: Number(e.target.value) })}
                className={`${INPUT} ${FOCUS_RING}`}
              >
                {WEEKDAY_NAMES.map((name, index) => (
                  <option key={name} value={index}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {next && (
            <p className="mt-3 text-sm text-zinc-300">
              Next digest: <strong className="font-medium">{formatWhen(next)}</strong>
              {quiet.enabled && " (delayed until quiet hours end if it falls inside them)"}
            </p>
          )}
        </fieldset>

        <div aria-live="polite">
          {status && (
            <p
              role={status.tone === "error" ? "alert" : "status"}
              className={`rounded-lg border px-3 py-2 text-sm ${
                status.tone === "error"
                  ? "border-red-500/20 bg-red-500/10 text-red-300"
                  : "border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
              }`}
            >
              {status.text}
            </p>
          )}
        </div>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            disabled={!dirty}
            onClick={() => {
              setDraft(schedule);
              setStatus(null);
            }}
            className={`min-h-11 rounded-lg bg-zinc-800 px-4 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-50 ${FOCUS_RING}`}
          >
            Discard changes
          </button>
          <button
            type="submit"
            disabled={!dirty}
            className={`min-h-11 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50 ${FOCUS_RING}`}
          >
            Save schedule
          </button>
        </div>
      </form>

      <section
        aria-labelledby="digest-queue-heading"
        className="rounded-xl border border-zinc-800 bg-zinc-900 p-4"
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="digest-queue-heading" className="text-base font-semibold text-zinc-100">
            Waiting to be sent ({queue.length})
          </h2>
          {queue.length > 0 && (
            <button
              type="button"
              onClick={onClearQueue}
              className={`min-h-11 rounded-lg bg-zinc-800 px-3 text-sm text-zinc-200 hover:bg-zinc-700 ${FOCUS_RING}`}
            >
              Discard queued alerts
            </button>
          )}
        </div>
        {queue.length === 0 ? (
          <EmptyState
            variant="section"
            title="No alerts waiting"
            description="Alerts held for quiet hours or a digest will appear here."
          />
        ) : (
          <ul className="divide-y divide-zinc-800">
            {queue
              .slice()
              .reverse()
              .map((item) => (
                <li key={item.id} className="py-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-zinc-100">{item.title}</span>
                    <span className="text-xs text-zinc-400">
                      {item.reason === "quiet" ? "Held for quiet hours" : "In next digest"} ·{" "}
                      {formatWhen(new Date(item.createdAt))}
                    </span>
                  </div>
                  <p className="text-zinc-400">{item.body}</p>
                </li>
              ))}
          </ul>
        )}
      </section>
    </div>
  );
}
