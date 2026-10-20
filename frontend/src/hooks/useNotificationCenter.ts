import { useCallback, useEffect, useState } from "react";
import {
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  subscribeToNotifications,
  type NotificationRecord,
} from "../lib/notificationCenter";

export function useNotificationCenter() {
  const [notifications, setNotifications] = useState<NotificationRecord[]>(() => getNotifications());

  useEffect(() => subscribeToNotifications(() => setNotifications(getNotifications())), []);

  const markRead = useCallback((id: string) => markNotificationRead(id), []);
  const markAllRead = useCallback(() => markAllNotificationsRead(), []);

  const unreadCount = notifications.filter((n) => !n.read).length;

  return { notifications, unreadCount, markRead, markAllRead };
}
