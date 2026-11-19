import { useId, useMemo, useState, type FormEvent } from "react";
import type { Owner, Proposal } from "../types/accord";
import { useDialogFocus } from "../hooks/useDialogFocus";
import {
  DAY_NAMES,
  DEFAULT_WINDOWS,
  WEEK_DAY_ORDER,
  addDays,
  addWeeks,
  buildRotation,
  formatHour,
  formatRelative,
  hasCustomAvailability,
  isTimeSensitive,
  ownerKey,
  startOfWeekUTC,
  suggestCoverage,
  validateWindows,
  windowsFor,
  type AvailabilityMap,
  type AvailabilityWindow,
} from "../lib/ownerAvailability";
import { EmptyState } from "./EmptyState";

const FOCUS_RING =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950";

const ROTATION_WEEKS = 4;

function formatDay(date: Date, options: Intl.DateTimeFormatOptions): string {
  return date.toLocaleDateString(undefined, { ...options, timeZone: "UTC" });
}

function formatDateTime(date: Date): string {
  return `${date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  })} UTC`;
}

function sameUTCDate(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

export type OwnerAvailabilityCalendarProps = {
  owners: Owner[];
  proposals: Proposal[];
  availability: AvailabilityMap;
  /** Persists an owner's weekly windows. May throw a user-facing error. */
  onSaveAvailability: (address: string, windows: AvailabilityWindow[]) => void;
  /** Current time in ms; injectable for deterministic tests and stories. */
  now: number;
};

/**
 * Weekly availability calendar for multisig owners with an approval rotation
 * and coverage suggestions for proposals that expire soon.
 */
export function OwnerAvailabilityCalendar({
  owners,
  proposals,
  availability,
  onSaveAvailability,
  now,
}: OwnerAvailabilityCalendarProps) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [editing, setEditing] = useState<Owner | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const today = new Date(now);
  const weekStart = addWeeks(startOfWeekUTC(today), weekOffset);
  const days = WEEK_DAY_ORDER.map((_, i) => addDays(weekStart, i));
  const ownerLabels = new Map(owners.map((o) => [ownerKey(o), o.label || o.address]));
  const labelFor = (key: string | null) => (key ? (ownerLabels.get(key) ?? key) : "—");

  const rotation = buildRotation(owners.map(ownerKey), weekStart, ROTATION_WEEKS);
  const thisWeekRotation = rotation[0];

  const coverage = useMemo(
    () =>
      proposals
        .filter((p) => isTimeSensitive(p, now))
        .sort((a, b) => a.deadlineTs - b.deadlineTs)
        .map((p) => ({ proposal: p, plan: suggestCoverage(p, owners, availability, now) })),
    [proposals, owners, availability, now],
  );

  const weekLabel = `${formatDay(days[0], { month: "short", day: "numeric" })} – ${formatDay(
    days[6],
    { month: "short", day: "numeric", year: "numeric" },
  )}`;

  return (
    <div className="space-y-6">
      <section aria-labelledby="availability-week-heading">
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 id="availability-week-heading" className="text-base font-semibold text-zinc-100">
            Week of {weekLabel} <span className="text-xs font-normal text-zinc-400">(UTC)</span>
          </h2>
          <div className="flex gap-2" role="group" aria-label="Change week">
            <button
              type="button"
              onClick={() => setWeekOffset((w) => w - 1)}
              aria-label="Previous week"
              className={`min-h-11 min-w-11 flex-1 rounded-lg bg-zinc-800 px-3 text-sm text-zinc-200 hover:bg-zinc-700 sm:flex-none ${FOCUS_RING}`}
            >
              ‹ Prev
            </button>
            <button
              type="button"
              onClick={() => setWeekOffset(0)}
              disabled={weekOffset === 0}
              className={`min-h-11 flex-1 rounded-lg bg-zinc-800 px-3 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-50 sm:flex-none ${FOCUS_RING}`}
            >
              This week
            </button>
            <button
              type="button"
              onClick={() => setWeekOffset((w) => w + 1)}
              aria-label="Next week"
              className={`min-h-11 min-w-11 flex-1 rounded-lg bg-zinc-800 px-3 text-sm text-zinc-200 hover:bg-zinc-700 sm:flex-none ${FOCUS_RING}`}
            >
              Next ›
            </button>
          </div>
        </div>

        <div aria-live="polite">
          {notice && (
            <p
              role="status"
              className="mb-3 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300"
            >
              {notice}
            </p>
          )}
        </div>

        <ul className="space-y-3">
          {owners.map((owner) => {
            const key = ownerKey(owner);
            const windows = windowsFor(availability, key);
            const name = owner.label || owner.address;
            const isPrimary = thisWeekRotation?.primary === key;
            const isBackup = thisWeekRotation?.backup === key;
            return (
              <li key={key} className="rounded-xl border border-zinc-800 bg-zinc-900 p-3 sm:p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-zinc-100">
                      {name}
                      {isPrimary && (
                        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300">
                          On rotation
                        </span>
                      )}
                      {isBackup && (
                        <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-xs text-sky-300">
                          Backup
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-zinc-400">
                      Weight {owner.weight ?? 1}
                      {!hasCustomAvailability(availability, key) && " · default hours"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditing(owner)}
                    aria-label={`Edit availability for ${name}`}
                    className={`min-h-11 rounded-lg bg-zinc-800 px-3 text-sm text-zinc-200 hover:bg-zinc-700 ${FOCUS_RING}`}
                  >
                    Edit hours
                  </button>
                </div>
                <ul className="grid grid-cols-7 gap-1" aria-label={`${name} availability this week`}>
                  {days.map((date) => {
                    const window = windows.find((w) => w.day === date.getUTCDay());
                    const isToday = sameUTCDate(date, today);
                    return (
                      <li
                        key={date.toISOString()}
                        className={`flex min-w-0 flex-col items-center rounded-md px-0.5 py-1.5 text-center ${
                          window ? "bg-emerald-500/10 text-emerald-200" : "bg-zinc-800/60 text-zinc-500"
                        } ${isToday ? "ring-1 ring-emerald-400" : ""}`}
                      >
                        <span className="sr-only">
                          {formatDay(date, { weekday: "long", month: "long", day: "numeric" })}
                          {isToday ? " (today)" : ""}:{" "}
                          {window
                            ? `available ${formatHour(window.start)} to ${formatHour(window.end)} UTC`
                            : "unavailable"}
                        </span>
                        <span aria-hidden="true" className="text-[10px] uppercase text-zinc-400 sm:text-xs">
                          {formatDay(date, { weekday: "short" })}
                        </span>
                        <span aria-hidden="true" className="text-xs font-medium">
                          {date.getUTCDate()}
                        </span>
                        <span aria-hidden="true" className="mt-0.5 text-[10px] leading-tight sm:text-xs">
                          {window ? (
                            <>
                              {String(window.start).padStart(2, "0")}
                              <span className="hidden sm:inline">:00</span>–
                              {String(window.end).padStart(2, "0")}
                              <span className="hidden sm:inline">:00</span>
                            </>
                          ) : (
                            "Off"
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      </section>

      <section
        aria-labelledby="rotation-heading"
        className="rounded-xl border border-zinc-800 bg-zinc-900 p-4"
      >
        <h2 id="rotation-heading" className="mb-1 text-base font-semibold text-zinc-100">
          Approval rotation
        </h2>
        <p className="mb-3 text-sm text-zinc-400">
          The primary owner watches the approval queue for the week; the backup covers gaps.
        </p>
        <ol className="divide-y divide-zinc-800">
          {rotation.map((week) => (
            <li
              key={week.weekStart.toISOString()}
              className="flex flex-col gap-1 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
            >
              <span className="text-zinc-400">
                Week of {formatDay(week.weekStart, { month: "short", day: "numeric" })}
              </span>
              <span className="text-zinc-100">
                Primary: <strong className="font-medium">{labelFor(week.primary)}</strong>
                {week.backup && (
                  <>
                    {" "}
                    · Backup: <span className="text-zinc-300">{labelFor(week.backup)}</span>
                  </>
                )}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section
        aria-labelledby="coverage-heading"
        className="rounded-xl border border-zinc-800 bg-zinc-900 p-4"
      >
        <h2 id="coverage-heading" className="mb-1 text-base font-semibold text-zinc-100">
          Coverage for time-sensitive proposals
        </h2>
        <p className="mb-3 text-sm text-zinc-400">
          Pending proposals expiring within 72 hours, with owners available to approve before the
          deadline.
        </p>
        {coverage.length === 0 ? (
          <EmptyState
            variant="section"
            title="No time-sensitive proposals"
            description="Nothing pending expires in the next 72 hours."
          />
        ) : (
          <ul className="space-y-3">
            {coverage.map(({ proposal, plan }) => (
              <li key={proposal.id} className="rounded-lg border border-zinc-800 p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 wrap-break-word text-sm font-medium text-zinc-100">
                    #{proposal.id} · {proposal.description || "Untitled proposal"}
                  </p>
                  <span className="text-xs text-amber-300">
                    Expires {formatRelative(plan.deadline, now)} ({formatDateTime(plan.deadline)})
                  </span>
                </div>
                <p className="mb-2 text-xs text-zinc-400">
                  {plan.remainingWeight === 0
                    ? "Quorum already reached."
                    : `Needs ${plan.remainingWeight} more approval weight.`}
                </p>
                {plan.suggestions.length > 0 && (
                  <ul className="flex flex-wrap gap-2" aria-label={`Suggested approvers for proposal ${proposal.id}`}>
                    {plan.suggestions.map((s) => (
                      <li
                        key={s.address}
                        className="rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-200"
                      >
                        {s.label} · weight {s.weight} · available {formatRelative(s.availableAt, now)}
                      </li>
                    ))}
                  </ul>
                )}
                {!plan.covered && (
                  <p role="alert" className="mt-2 text-xs text-red-300">
                    Not enough owners are available before the deadline to reach quorum.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing && (
        <AvailabilityEditorDialog
          ownerName={editing.label || editing.address}
          initial={windowsFor(availability, ownerKey(editing))}
          onCancel={() => setEditing(null)}
          onSave={(windows) => {
            onSaveAvailability(ownerKey(editing), windows);
            setNotice(`Saved availability for ${editing.label || editing.address}.`);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

type DayDraft = { enabled: boolean; start: number; end: number };

type AvailabilityEditorDialogProps = {
  ownerName: string;
  initial: AvailabilityWindow[];
  /** May throw a user-facing error, which is shown in the dialog. */
  onSave: (windows: AvailabilityWindow[]) => void;
  onCancel: () => void;
};

function toDraft(windows: AvailabilityWindow[]): Record<number, DayDraft> {
  const draft: Record<number, DayDraft> = {};
  for (let day = 0; day < 7; day += 1) {
    const w = windows.find((x) => x.day === day);
    draft[day] = w ? { enabled: true, start: w.start, end: w.end } : { enabled: false, start: 9, end: 17 };
  }
  return draft;
}

export function AvailabilityEditorDialog({
  ownerName,
  initial,
  onSave,
  onCancel,
}: AvailabilityEditorDialogProps) {
  const { dialogRef, onKeyDown } = useDialogFocus(onCancel);
  const [draft, setDraft] = useState(() => toDraft(initial));
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const hours = Array.from({ length: 25 }, (_, h) => h);

  function update(day: number, patch: Partial<DayDraft>) {
    setDraft((d) => ({ ...d, [day]: { ...d[day], ...patch } }));
    setError(null);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const windows = Object.entries(draft)
      .filter(([, d]) => d.enabled)
      .map(([day, d]) => ({ day: Number(day), start: d.start, end: d.end }));
    const problem = validateWindows(windows);
    if (problem) {
      setError(problem);
      return;
    }
    try {
      onSave(windows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save availability");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="max-h-[90vh] w-full overflow-y-auto rounded-t-2xl border border-zinc-700 bg-zinc-900 p-4 text-zinc-100 sm:max-w-md sm:rounded-2xl sm:p-6"
      >
        <h2 id={titleId} className="mb-1 text-lg font-semibold">
          Availability for {ownerName}
        </h2>
        <p className="mb-4 text-xs text-zinc-400">Weekly hours in UTC. End time is exclusive.</p>

        <form onSubmit={handleSubmit}>
          <fieldset>
            <legend className="sr-only">Available days and hours</legend>
            <ul className="mb-4 space-y-2">
              {WEEK_DAY_ORDER.map((day) => {
                const d = draft[day];
                const dayName = DAY_NAMES[day];
                return (
                  <li key={day} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2">
                    <label className="flex min-h-11 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={d.enabled}
                        onChange={(e) => update(day, { enabled: e.target.checked })}
                        className="h-4 w-4 accent-emerald-500"
                      />
                      {dayName}
                    </label>
                    <select
                      aria-label={`${dayName} start time`}
                      value={d.start}
                      disabled={!d.enabled}
                      onChange={(e) => update(day, { start: Number(e.target.value) })}
                      className={`min-h-11 rounded-lg border border-zinc-700 bg-zinc-950 px-2 text-sm disabled:opacity-40 ${FOCUS_RING}`}
                    >
                      {hours.slice(0, 24).map((h) => (
                        <option key={h} value={h}>
                          {formatHour(h)}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label={`${dayName} end time`}
                      value={d.end}
                      disabled={!d.enabled}
                      onChange={(e) => update(day, { end: Number(e.target.value) })}
                      className={`min-h-11 rounded-lg border border-zinc-700 bg-zinc-950 px-2 text-sm disabled:opacity-40 ${FOCUS_RING}`}
                    >
                      {hours.slice(1).map((h) => (
                        <option key={h} value={h}>
                          {formatHour(h)}
                        </option>
                      ))}
                    </select>
                  </li>
                );
              })}
            </ul>
          </fieldset>

          {error && (
            <p role="alert" className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </p>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            <button
              type="button"
              onClick={() => {
                setDraft(toDraft(DEFAULT_WINDOWS));
                setError(null);
              }}
              className={`min-h-11 rounded-lg px-3 text-sm text-zinc-400 hover:text-zinc-200 ${FOCUS_RING}`}
            >
              Use default hours
            </button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <button
                type="button"
                onClick={onCancel}
                className={`min-h-11 rounded-lg bg-zinc-800 px-4 text-sm text-zinc-200 hover:bg-zinc-700 ${FOCUS_RING}`}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={`min-h-11 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-500 ${FOCUS_RING}`}
              >
                Save hours
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
