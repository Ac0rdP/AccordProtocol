import type { NotificationEventType } from "./notificationPreferences";

export type NotificationRecord = {
  id: string;
  type: NotificationEventType;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
};

const LOG_KEY = "accord_notification_log";
const MAX_ENTRIES = 100;

const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) listener();
}

/** Subscribes to changes in the notification log; returns an unsubscribe function. */
export function subscribeToNotifications(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getNotifications(): NotificationRecord[] {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function persist(records: NotificationRecord[]): void {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(records.slice(0, MAX_ENTRIES)));
  } catch {
    // localStorage might be unavailable or throw in restricted environments
  }
  emitChange();
}

export function addNotification(entry: {
  type: NotificationEventType;
  title: string;
  body: string;
}): NotificationRecord {
  const record: NotificationRecord = {
    ...entry,
    id: `${entry.type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    read: false,
  };
  persist([record, ...getNotifications()]);
  return record;
}

export function markNotificationRead(id: string): void {
  persist(getNotifications().map((n) => (n.id === id ? { ...n, read: true } : n)));
}

export function markAllNotificationsRead(): void {
  persist(getNotifications().map((n) => ({ ...n, read: true })));
}

export function clearNotifications(): void {
  persist([]);
}
