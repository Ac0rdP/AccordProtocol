import type { NotificationEventType } from "./notificationPreferences";

/**
 * Delivery schedule for browser alerts. The in-app notification center always
 * logs every event; this only decides whether the OS-level alert fires now,
 * waits for quiet hours to end, or is batched into a digest.
 *
 * Times are "HH:MM" strings in the device's local time zone.
 */
export type DigestFrequency = "off" | "daily" | "weekly";

export type NotificationSchedule = {
  quietHours: { enabled: boolean; start: string; end: string };
  digest: {
    frequency: DigestFrequency;
    time: string;
    /** 0 = Sunday … 6 = Saturday; used when frequency is "weekly". */
    weekday: number;
  };
};

export type DeliveryMode = "immediate" | "quiet" | "digest";

export type DigestItem = {
  id: string;
  type: NotificationEventType;
  title: string;
  body: string;
  createdAt: string;
  /** Why the alert was held back. */
  reason: Exclude<DeliveryMode, "immediate">;
};

export const DEFAULT_NOTIFICATION_SCHEDULE: NotificationSchedule = {
  quietHours: { enabled: false, start: "22:00", end: "07:00" },
  digest: { frequency: "off", time: "09:00", weekday: 1 },
};

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const SCHEDULE_KEY = "accord_notification_schedule";
const QUEUE_KEY = "accord_notification_digest_queue";
const MAX_QUEUE = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

const listeners = new Set<() => void>();

/** Subscribes to digest-queue changes; returns an unsubscribe function. */
export function subscribeToDigestQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitQueueChange(): void {
  for (const listener of listeners) listener();
}

/** Minutes since midnight for an "HH:MM" string, or null when malformed. */
export function parseTime(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function validateSchedule(schedule: NotificationSchedule): string | null {
  const { quietHours, digest } = schedule;
  if (quietHours.enabled) {
    const start = parseTime(quietHours.start);
    const end = parseTime(quietHours.end);
    if (start === null || end === null) return "Enter quiet hours as HH:MM";
    if (start === end) return "Quiet hours must start and end at different times";
  }
  if (!["off", "daily", "weekly"].includes(digest.frequency)) return "Choose a digest frequency";
  if (digest.frequency !== "off" && parseTime(digest.time) === null) {
    return "Enter the digest time as HH:MM";
  }
  if (!Number.isInteger(digest.weekday) || digest.weekday < 0 || digest.weekday > 6) {
    return "Choose a weekday for the weekly digest";
  }
  return null;
}

function defaultSchedule(): NotificationSchedule {
  return {
    quietHours: { ...DEFAULT_NOTIFICATION_SCHEDULE.quietHours },
    digest: { ...DEFAULT_NOTIFICATION_SCHEDULE.digest },
  };
}

function mergeWithDefaults(value: unknown): NotificationSchedule {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Saved notification schedule is corrupted");
  }
  const partial = value as Partial<NotificationSchedule>;
  return {
    quietHours: { ...DEFAULT_NOTIFICATION_SCHEDULE.quietHours, ...partial.quietHours },
    digest: { ...DEFAULT_NOTIFICATION_SCHEDULE.digest, ...partial.digest },
  };
}

/** Reads the saved schedule. Throws when storage is unreadable or corrupt. */
export function readNotificationSchedule(): NotificationSchedule {
  const raw = localStorage.getItem(SCHEDULE_KEY);
  if (!raw) return defaultSchedule();
  return mergeWithDefaults(JSON.parse(raw));
}

/** Like `readNotificationSchedule`, but falls back to defaults instead of throwing. */
export function getNotificationSchedule(): NotificationSchedule {
  try {
    return readNotificationSchedule();
  } catch {
    return defaultSchedule();
  }
}

export function saveNotificationSchedule(schedule: NotificationSchedule): NotificationSchedule {
  const problem = validateSchedule(schedule);
  if (problem) throw new Error(problem);
  try {
    localStorage.setItem(SCHEDULE_KEY, JSON.stringify(schedule));
  } catch {
    throw new Error("Could not save your schedule. Browser storage is unavailable.");
  }
  return schedule;
}

export function resetNotificationSchedule(): void {
  try {
    localStorage.removeItem(SCHEDULE_KEY);
  } catch {
    // reads will keep failing and surface the error
  }
}

function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function atLocalMinutes(date: Date, minutes: number): Date {
  const d = new Date(date);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return d;
}

export function isWithinQuietHours(schedule: NotificationSchedule, at: Date): boolean {
  const { enabled, start, end } = schedule.quietHours;
  if (!enabled) return false;
  const s = parseTime(start);
  const e = parseTime(end);
  if (s === null || e === null || s === e) return false;
  const m = minutesOfDay(at);
  // Same-day window (13:00–15:00) or one that wraps past midnight (22:00–07:00).
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/** The moment the current (or next) quiet period ends, or null when disabled. */
export function quietHoursEndAfter(schedule: NotificationSchedule, from: Date): Date | null {
  const e = parseTime(schedule.quietHours.end);
  if (!schedule.quietHours.enabled || e === null) return null;
  const today = atLocalMinutes(from, e);
  return today.getTime() > from.getTime() ? today : new Date(today.getTime() + DAY_MS);
}

export function getDeliveryMode(schedule: NotificationSchedule, at: Date): DeliveryMode {
  if (schedule.digest.frequency !== "off") return "digest";
  if (isWithinQuietHours(schedule, at)) return "quiet";
  return "immediate";
}

function isDigestDay(schedule: NotificationSchedule, date: Date): boolean {
  return schedule.digest.frequency === "daily" || date.getDay() === schedule.digest.weekday;
}

/** The latest scheduled digest time at or before `now`. */
export function mostRecentDigestSlot(schedule: NotificationSchedule, now: Date): Date | null {
  const minutes = parseTime(schedule.digest.time);
  if (schedule.digest.frequency === "off" || minutes === null) return null;
  for (let back = 0; back <= 7; back += 1) {
    const candidate = atLocalMinutes(new Date(now.getTime() - back * DAY_MS), minutes);
    if (candidate.getTime() <= now.getTime() && isDigestDay(schedule, candidate)) {
      return candidate;
    }
  }
  return null;
}

/** The next scheduled digest time strictly after `now`. */
export function nextDigestAt(schedule: NotificationSchedule, now: Date): Date | null {
  const minutes = parseTime(schedule.digest.time);
  if (schedule.digest.frequency === "off" || minutes === null) return null;
  for (let ahead = 0; ahead <= 7; ahead += 1) {
    const candidate = atLocalMinutes(new Date(now.getTime() + ahead * DAY_MS), minutes);
    if (candidate.getTime() > now.getTime() && isDigestDay(schedule, candidate)) {
      return candidate;
    }
  }
  return null;
}

export function getDigestQueue(): DigestItem[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as DigestItem[]) : [];
  } catch {
    return [];
  }
}

function persistQueue(items: DigestItem[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(items.slice(-MAX_QUEUE)));
  } catch {
    // storage unavailable — the in-app notification log still has the entry
  }
  emitQueueChange();
}

export function enqueueDigestItem(
  entry: Omit<DigestItem, "id" | "createdAt">,
  now: Date = new Date(),
): DigestItem {
  const item: DigestItem = {
    ...entry,
    id: `digest-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now.toISOString(),
  };
  persistQueue([...getDigestQueue(), item]);
  return item;
}

export function clearDigestQueue(): void {
  persistQueue([]);
}

/**
 * Removes and returns the queued alerts that are due for delivery now, or
 * null when nothing is due. Nothing is delivered during quiet hours. With
 * digests off, alerts held by quiet hours are released once they end; with
 * digests on, alerts queued before the most recent digest slot are released.
 */
export function takeDueDigest(schedule: NotificationSchedule, now: Date): DigestItem[] | null {
  const queue = getDigestQueue();
  if (queue.length === 0 || isWithinQuietHours(schedule, now)) return null;

  let due: DigestItem[];
  if (schedule.digest.frequency === "off") {
    due = queue;
  } else {
    const slot = mostRecentDigestSlot(schedule, now);
    if (!slot) return null;
    due = queue.filter((item) => new Date(item.createdAt).getTime() <= slot.getTime());
  }
  if (due.length === 0) return null;

  const dueIds = new Set(due.map((item) => item.id));
  persistQueue(queue.filter((item) => !dueIds.has(item.id)));
  return due;
}

export function summarizeDigest(items: DigestItem[]): { title: string; body: string } {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.title, (counts.get(item.title) ?? 0) + 1);
  const body = [...counts.entries()]
    .map(([title, count]) => (count > 1 ? `${title} ×${count}` : title))
    .join(", ");
  return {
    title: `Accord digest: ${items.length} update${items.length === 1 ? "" : "s"}`,
    body,
  };
}
