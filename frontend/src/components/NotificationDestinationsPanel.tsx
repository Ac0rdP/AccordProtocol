import { useEffect, useState } from "react";
import { Send, Trash2 } from "lucide-react";
import {
  listNotificationDestinations,
  saveNotificationDestination,
  deleteNotificationDestination,
  testNotificationDestination,
  type NotificationDestination,
  type NotificationDestinationKind,
} from "../lib/notificationDestinations";

const KIND_OPTIONS: { kind: NotificationDestinationKind; label: string }[] = [
  { kind: "webhook", label: "Webhook" },
  { kind: "slack", label: "Slack" },
  { kind: "discord", label: "Discord" },
  { kind: "email", label: "Email" },
];

const KIND_LABELS: Record<NotificationDestinationKind, string> = {
  webhook: "Webhook",
  slack: "Slack",
  discord: "Discord",
  email: "Email",
};

type TestState = { pending: boolean; result?: { ok: boolean; message: string } };

export function NotificationDestinationsPanel() {
  const [destinations, setDestinations] = useState<NotificationDestination[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testState, setTestState] = useState<Record<string, TestState>>({});

  const [showForm, setShowForm] = useState(false);
  const [id, setId] = useState("");
  const [kind, setKind] = useState<NotificationDestinationKind>("webhook");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [to, setTo] = useState("");
  const [topics, setTopics] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setLoadError(null);
    try {
      setDestinations(await listNotificationDestinations());
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load notification destinations");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function resetForm() {
    setId("");
    setKind("webhook");
    setUrl("");
    setSecret("");
    setWebhookUrl("");
    setTo("");
    setTopics("");
    setSaveError(null);
  }

  async function handleSave() {
    if (!id.trim()) {
      setSaveError("Give this destination an id.");
      return;
    }
    const config =
      kind === "webhook"
        ? { url: url.trim(), secret: secret.trim() }
        : kind === "slack" || kind === "discord"
        ? { webhookUrl: webhookUrl.trim() }
        : { to: to.trim() };

    setSaving(true);
    setSaveError(null);
    try {
      await saveNotificationDestination({
        id: id.trim(),
        kind,
        config,
        topics: topics.trim() ? topics.split(",").map((t) => t.trim()).filter(Boolean) : null,
        enabled: true,
      });
      resetForm();
      setShowForm(false);
      await refresh();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save destination");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(destinationId: string) {
    try {
      await deleteNotificationDestination(destinationId);
      await refresh();
    } catch (e) {
      console.error("Failed to delete destination", e);
    }
  }

  async function handleTest(destinationId: string) {
    setTestState((prev) => ({ ...prev, [destinationId]: { pending: true } }));
    try {
      const result = await testNotificationDestination(destinationId);
      setTestState((prev) => ({
        ...prev,
        [destinationId]: {
          pending: false,
          result: {
            ok: result.ok,
            message: result.ok ? "Test notification sent" : result.error || "Test failed",
          },
        },
      }));
    } catch (e) {
      setTestState((prev) => ({
        ...prev,
        [destinationId]: {
          pending: false,
          result: { ok: false, message: e instanceof Error ? e.message : "Test failed" },
        },
      }));
    }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold">Notification Destinations</h2>
          <p className="text-sm text-zinc-400 mt-1">
            Deliver indexed events to email, a webhook, Slack, or Discord.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-3 py-1.5 rounded-lg transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none"
        >
          {showForm ? "Cancel" : "Add Destination"}
        </button>
      </div>

      {showForm && (
        <div className="space-y-3 border border-zinc-800 rounded-xl p-4 mb-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-zinc-400 block mb-1.5">Id</label>
              <input
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="treasury-alerts"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm focus:ring-2 focus:ring-zinc-400 focus:outline-none"
              />
            </div>
            <div>
              <label className="text-xs text-zinc-400 block mb-1.5">Kind</label>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as NotificationDestinationKind)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm focus:ring-2 focus:ring-zinc-400 focus:outline-none"
              >
                {KIND_OPTIONS.map(({ kind: k, label }) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {kind === "webhook" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-zinc-400 block mb-1.5">URL</label>
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/hooks/accord"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:ring-2 focus:ring-zinc-400 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-400 block mb-1.5">Signing secret</label>
                <input
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder="at least 16 characters"
                  type="password"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:ring-2 focus:ring-zinc-400 focus:outline-none"
                />
              </div>
            </div>
          )}

          {(kind === "slack" || kind === "discord") && (
            <div>
              <label className="text-xs text-zinc-400 block mb-1.5">
                {KIND_LABELS[kind]} webhook URL
              </label>
              <input
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                placeholder="https://hooks.slack.com/services/..."
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:ring-2 focus:ring-zinc-400 focus:outline-none"
              />
            </div>
          )}

          {kind === "email" && (
            <div>
              <label className="text-xs text-zinc-400 block mb-1.5">Recipient email</label>
              <input
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="treasury@example.com"
                type="email"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm focus:ring-2 focus:ring-zinc-400 focus:outline-none"
              />
            </div>
          )}

          <div>
            <label className="text-xs text-zinc-400 block mb-1.5">
              Event topics (comma-separated, blank = all)
            </label>
            <input
              value={topics}
              onChange={(e) => setTopics(e.target.value)}
              placeholder="proposal_executed, recurring_payment_disbursed"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm focus:ring-2 focus:ring-zinc-400 focus:outline-none"
            />
          </div>

          {saveError && (
            <p className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{saveError}</p>
          )}

          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="w-full bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white py-2.5 rounded-lg font-medium transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none"
          >
            {saving ? "Saving…" : "Save Destination"}
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Loading destinations…</p>
      ) : loadError ? (
        <p className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{loadError}</p>
      ) : destinations.length === 0 ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">No notification destinations configured yet.</p>
      ) : (
        <div className="divide-y divide-zinc-800">
          {destinations.map((destination) => {
            const state = testState[destination.id];
            return (
              <div
                key={destination.id}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-200">{destination.id}</span>
                    <span className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                      {KIND_LABELS[destination.kind]}
                    </span>
                    {!destination.enabled && (
                      <span className="rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-600 dark:text-zinc-400">
                        Disabled
                      </span>
                    )}
                  </div>
                  {state?.result && (
                    <p className={`text-xs mt-1 ${state.result.ok ? "text-emerald-400" : "text-red-400"}`}>
                      {state.result.message}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleTest(destination.id)}
                    disabled={state?.pending}
                    aria-label={`Send test notification to ${destination.id}`}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-700 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-zinc-400"
                  >
                    <Send size={14} />
                    {state?.pending ? "Sending…" : "Send test"}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(destination.id)}
                    aria-label={`Delete destination ${destination.id}`}
                    className="inline-flex items-center justify-center rounded-lg border border-zinc-700 p-1.5 text-zinc-400 transition-colors hover:text-red-400 hover:border-red-500/40 focus:outline-none focus:ring-2 focus:ring-zinc-400"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
