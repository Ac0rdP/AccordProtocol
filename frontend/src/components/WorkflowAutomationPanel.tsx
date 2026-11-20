import { useState } from "react";
import {
  WORKFLOW_TRIGGERS,
  createWorkflowWebhook,
  deleteWorkflowWebhook,
  testWorkflowWebhook,
  validateWebhookDraft,
  type CreateWebhookDraft,
  type WebhookTargetType,
  type WorkflowTriggerEvent,
  type WorkflowWebhook,
} from "../lib/workflows";

type WorkflowAutomationPanelProps = {
  contractId: string;
  network?: string;
  canManageWebhooks: boolean;
  initialWebhooks?: WorkflowWebhook[];
};

const EMPTY_DRAFT: CreateWebhookDraft = {
  name: "",
  targetType: "zapier",
  url: "",
  events: ["proposal.created", "proposal.approved"],
};

export function WorkflowAutomationPanel({
  contractId,
  network = "testnet",
  canManageWebhooks,
  initialWebhooks = [],
}: WorkflowAutomationPanelProps) {
  const [webhooks, setWebhooks] = useState<WorkflowWebhook[]>(initialWebhooks);
  const [draft, setDraft] = useState<CreateWebhookDraft>(EMPTY_DRAFT);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function toggleEvent(event: WorkflowTriggerEvent) {
    setDraft((prev) => {
      const exists = prev.events.includes(event);
      return {
        ...prev,
        events: exists ? prev.events.filter((e) => e !== event) : [...prev.events, event],
      };
    });
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setStatusMessage(null);
    setErrorMessage(null);

    if (!canManageWebhooks) {
      setErrorMessage("Only workspace owners can register workflow webhooks.");
      return;
    }

    const errors = validateWebhookDraft(draft);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setBusy(true);
    try {
      const created = await createWorkflowWebhook(contractId, network, draft);
      setWebhooks((prev) => [created, ...prev]);
      setDraft(EMPTY_DRAFT);
      setStatusMessage(`Webhook "${created.name}" registered.`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to register webhook.");
    } finally {
      setBusy(false);
    }
  }

  async function handleTest(id: number) {
    setStatusMessage(null);
    setErrorMessage(null);
    setBusy(true);
    try {
      const res = await testWorkflowWebhook(id, contractId, network);
      setStatusMessage(`Queued test "${res.eventType}" trigger.`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to test webhook.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: number) {
    setStatusMessage(null);
    setErrorMessage(null);
    setBusy(true);
    try {
      await deleteWorkflowWebhook(id, contractId, network);
      setWebhooks((prev) => prev.filter((w) => w.id !== id));
      setStatusMessage("Webhook removed.");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to remove webhook.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="workflow-automation-heading"
      className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="workflow-automation-heading" className="text-base font-semibold text-zinc-100">
            Workflow automation (Zapier &amp; webhooks)
          </h2>
          <p className="mt-1 text-xs text-zinc-400">
            Subscribe Zapier hooks or generic HTTPS endpoints to proposal, approval, and treasury
            events.
          </p>
        </div>
        {!canManageWebhooks && (
          <span className="rounded-full border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-400">
            Owner access required
          </span>
        )}
      </div>

      <form onSubmit={handleCreate} className="mt-4 grid gap-4 sm:grid-cols-2" noValidate>
        <div>
          <label htmlFor="webhook-name" className="block text-xs font-medium text-zinc-300">
            Subscription name
          </label>
          <input
            id="webhook-name"
            type="text"
            value={draft.name}
            disabled={!canManageWebhooks || busy}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder="Zapier Treasury Slack"
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
          />
          {fieldErrors.name && <p className="mt-1 text-xs text-red-400">{fieldErrors.name}</p>}
        </div>

        <div>
          <label htmlFor="webhook-target" className="block text-xs font-medium text-zinc-300">
            Integration type
          </label>
          <select
            id="webhook-target"
            value={draft.targetType}
            disabled={!canManageWebhooks || busy}
            onChange={(e) =>
              setDraft((d) => ({ ...d, targetType: e.target.value as WebhookTargetType }))
            }
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
          >
            <option value="zapier">Zapier Catch Hook</option>
            <option value="generic">Generic HTTPS Webhook</option>
          </select>
        </div>

        <div className="sm:col-span-2">
          <label htmlFor="webhook-url" className="block text-xs font-medium text-zinc-300">
            Endpoint URL (HTTPS)
          </label>
          <input
            id="webhook-url"
            type="url"
            value={draft.url}
            disabled={!canManageWebhooks || busy}
            onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
            placeholder="https://hooks.zapier.com/hooks/catch/..."
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
          />
          {fieldErrors.url && <p className="mt-1 text-xs text-red-400">{fieldErrors.url}</p>}
        </div>

        <fieldset className="sm:col-span-2">
          <legend className="text-xs font-medium text-zinc-300">Trigger events</legend>
          <div className="mt-2 flex flex-wrap gap-3">
            {WORKFLOW_TRIGGERS.map((item) => (
              <label
                key={item.event}
                className="flex items-center gap-2 text-xs text-zinc-300"
              >
                <input
                  type="checkbox"
                  checked={draft.events.includes(item.event)}
                  disabled={!canManageWebhooks || busy}
                  onChange={() => toggleEvent(item.event)}
                />
                <span>{item.label}</span>
              </label>
            ))}
          </div>
          {fieldErrors.events && (
            <p className="mt-1 text-xs text-red-400">{fieldErrors.events}</p>
          )}
        </fieldset>

        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={!canManageWebhooks || busy}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {busy ? "Saving..." : "Add workflow webhook"}
          </button>
        </div>
      </form>

      {webhooks.length > 0 && (
        <ul className="mt-5 space-y-2">
          {webhooks.map((hook) => (
            <li
              key={hook.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 text-xs"
            >
              <div>
                <div className="font-medium text-zinc-100">
                  {hook.name}{" "}
                  <span className="ml-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase text-zinc-300">
                    {hook.targetType}
                  </span>
                </div>
                <div className="mt-0.5 font-mono text-zinc-400">{hook.url}</div>
                <div className="mt-1 text-zinc-500">Triggers: {hook.events.join(", ")}</div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!canManageWebhooks || busy}
                  onClick={() => handleTest(hook.id)}
                  className="rounded border border-zinc-700 px-2.5 py-1 text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                >
                  Test trigger
                </button>
                <button
                  type="button"
                  disabled={!canManageWebhooks || busy}
                  onClick={() => handleDelete(hook.id)}
                  className="rounded border border-red-900/60 px-2.5 py-1 text-red-400 hover:bg-red-950/40 disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {statusMessage && (
        <p role="status" className="mt-3 text-xs text-emerald-400">
          {statusMessage}
        </p>
      )}
      {errorMessage && (
        <p role="alert" className="mt-3 text-xs text-red-400">
          {errorMessage}
        </p>
      )}
    </section>
  );
}
