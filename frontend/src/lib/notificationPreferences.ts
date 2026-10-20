export type NotificationEventType =
  | "proposal_created"
  | "proposal_approved"
  | "proposal_ready"
  | "proposal_executed"
  | "owner_weight_changed";

export type NotificationPreferences = Record<NotificationEventType, boolean>;

const PREFERENCES_KEY = "accord_notification_preferences";

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  proposal_created: true,
  proposal_approved: true,
  proposal_ready: true,
  proposal_executed: true,
  owner_weight_changed: true,
};

export function getNotificationPreferences(): NotificationPreferences {
  try {
    const raw = localStorage.getItem(PREFERENCES_KEY);
    if (!raw) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_NOTIFICATION_PREFERENCES, ...parsed };
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  }
}

export function setNotificationPreference(
  type: NotificationEventType,
  enabled: boolean,
): NotificationPreferences {
  const preferences = { ...getNotificationPreferences(), [type]: enabled };
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // localStorage might be unavailable or throw in restricted environments
  }
  return preferences;
}

export function isNotificationEnabled(type: NotificationEventType): boolean {
  return getNotificationPreferences()[type] ?? true;
}
