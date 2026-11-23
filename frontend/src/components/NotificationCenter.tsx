import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNotificationCenter } from "../hooks/useNotificationCenter";
import {
  getNotificationPreferences,
  setNotificationPreference,
  type NotificationEventType,
} from "../lib/notificationPreferences";

const EVENT_TYPES: NotificationEventType[] = [
  "proposal_created",
  "proposal_approved",
  "proposal_ready",
  "proposal_executed",
  "owner_weight_changed",
];

export function NotificationCenter() {
  const { t } = useTranslation();
  const { notifications, unreadCount, markRead, markAllRead } = useNotificationCenter();
  const [open, setOpen] = useState(false);
  const [showPreferences, setShowPreferences] = useState(false);
  const [preferences, setPreferences] = useState(() => getNotificationPreferences());
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  function togglePreference(type: NotificationEventType) {
    setPreferences(setNotificationPreference(type, !preferences[type]));
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`${t("notifications.title")}${unreadCount > 0 ? `, ${t("notifications.unread", { count: unreadCount })}` : ""}`}
        aria-expanded={open}
        className="relative inline-flex items-center justify-center rounded-lg p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-zinc-400"
      >
        <Bell size={18} />
        {unreadCount > 0 && (
          <span
            data-testid="notification-unread-badge"
            className="absolute -top-0.5 -end-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-semibold text-black"
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute end-0 z-50 mt-2 w-80 rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl">
          <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2.5">
            <h3 className="text-sm font-semibold text-zinc-200">{t("notifications.title")}</h3>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setShowPreferences((v) => !v)}
                aria-pressed={showPreferences}
                className="text-xs text-zinc-400 hover:text-zinc-200"
              >
                {showPreferences ? t("notifications.done") : t("notifications.preferences")}
              </button>
              {!showPreferences && unreadCount > 0 && (
                <button
                  type="button"
                  onClick={markAllRead}
                  className="text-xs text-emerald-400 hover:text-emerald-300"
                >
                  {t("notifications.markAllRead")}
                </button>
              )}
            </div>
          </div>

          {showPreferences ? (
            <div className="max-h-80 space-y-3 overflow-y-auto p-3">
              {EVENT_TYPES.map((type) => (
                <label key={type} className="flex items-center justify-between text-sm text-zinc-300">
                  <span>{t(`notifications.events.${type}`)}</span>
                  <input
                    type="checkbox"
                    checked={preferences[type]}
                    onChange={() => togglePreference(type)}
                    aria-label={t(`notifications.events.${type}`)}
                    className="h-4 w-4 rounded border-zinc-600 bg-zinc-800 text-emerald-500 focus:ring-emerald-400 focus:ring-2"
                  />
                </label>
              ))}
            </div>
          ) : notifications.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-zinc-600 dark:text-zinc-400">{t("notifications.empty")}</p>
          ) : (
            <ul className="max-h-80 divide-y divide-zinc-800 overflow-y-auto">
              {notifications.map((n) => (
                <li key={n.id} className={n.read ? "" : "bg-zinc-800/40"}>
                  <button
                    type="button"
                    onClick={() => markRead(n.id)}
                    className="w-full px-3 py-2.5 text-left"
                  >
                    <div className="flex items-center gap-2">
                      {!n.read && (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden="true" />
                      )}
                      <p className="text-sm font-medium text-zinc-200">{n.title}</p>
                    </div>
                    <p className="mt-0.5 text-xs text-zinc-400">{n.body}</p>
                    <p className="mt-1 text-[11px] text-zinc-600 dark:text-zinc-400">
                      {new Date(n.createdAt).toLocaleString()}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
