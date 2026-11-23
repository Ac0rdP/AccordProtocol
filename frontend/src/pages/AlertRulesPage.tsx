import { useMemo, useState } from "react";
import { AlertRuleForm } from "../components/AlertRuleForm";
import { PageState } from "../components/PageState";
import { useAlertRules } from "../hooks/useAlertRules";
import {
  createAlertRulesClient,
  describeRule,
  type AlertRule,
  type AlertRuleInput,
  type AlertRulesClient,
} from "../lib/alertRules";

const FOCUS_RING =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950";
const SMALL_BUTTON = `min-h-11 rounded-lg px-3 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50 ${FOCUS_RING}`;

type Filter = "all" | "active" | "paused";

/** Create, edit, pause, delete and test the threshold and anomaly alert rules. */
export function AlertRulesPage({ client: provided }: { client?: AlertRulesClient } = {}) {
  const [adminToken, setAdminToken] = useState("");
  // The client reads the token at call time, so one typed later is still sent.
  const [tokenStore] = useState(() => {
    let value = "";
    return { get: () => value, set: (next: string) => { value = next; } };
  });
  const client = useMemo(
    () => provided ?? createAlertRulesClient(undefined, { adminToken: tokenStore.get }),
    [provided, tokenStore],
  );
  const { rules, loading, error, reload } = useAlertRules(client);
  const [editing, setEditing] = useState<AlertRule | "new" | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const shown = rules.filter(
    (rule) => filter === "all" || (filter === "active") === rule.enabled,
  );

  async function act(work: () => Promise<unknown>, success: string) {
    setNotice(null);
    try {
      await work();
      setNotice({ tone: "ok", text: success });
      await reload();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "The request failed." });
    }
  }

  async function save(input: AlertRuleInput) {
    if (editing === "new") await client.create(input);
    else if (editing) await client.replace(editing.id, input);
    setEditing(null);
    setNotice({ tone: "ok", text: "Alert rule saved." });
    await reload();
  }

  let body;
  if (loading && rules.length === 0) {
    body = <PageState status="loading" title="Loading alert rules…" />;
  } else if (error && rules.length === 0) {
    body = <PageState status="error" title="Could not load alert rules" description={error} onRetry={reload} />;
  } else if (shown.length === 0) {
    body = <PageState status="empty" title="No alert rules" description="Create a rule to be alerted about large spend or unusual approvals." />;
  } else {
    body = (
      <ul className="space-y-3">
        {shown.map((rule) => {
          const managed = rule.source === "managed";
          return (
            <li key={rule.id} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-zinc-100">{rule.id}</h2>
                <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">{rule.category}</span>
                <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">{rule.severity}</span>
                {!rule.enabled && <span className="rounded bg-amber-500/20 px-2 py-0.5 text-xs text-amber-300">Paused</span>}
                {!managed && <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">Configured (read-only)</span>}
              </div>
              <p className="mt-1 text-sm text-zinc-400">{describeRule(rule)}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                <button
                  type="button"
                  className={SMALL_BUTTON}
                  aria-label={`Test ${rule.id}`}
                  onClick={() =>
                    act(async () => {
                      const result = await client.testSaved(rule.id);
                      setNotice({
                        tone: "ok",
                        text: `${rule.id} would have fired ${result.wouldFire} ${result.wouldFire === 1 ? "alert" : "alerts"} in the last ${result.lookbackHours} hours.`,
                      });
                    }, "")
                  }
                >
                  Test
                </button>
                {managed && (
                  <>
                    <button type="button" className={SMALL_BUTTON} aria-label={`Edit ${rule.id}`} onClick={() => setEditing(rule)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className={SMALL_BUTTON}
                      aria-label={`${rule.enabled ? "Pause" : "Resume"} ${rule.id}`}
                      onClick={() =>
                        act(
                          () => (rule.enabled ? client.pause(rule.id) : client.resume(rule.id)),
                          rule.enabled ? `Paused ${rule.id}.` : `Resumed ${rule.id}.`,
                        )
                      }
                    >
                      {rule.enabled ? "Pause" : "Resume"}
                    </button>
                    {confirmDelete === rule.id ? (
                      <>
                        <button
                          type="button"
                          className={`${SMALL_BUTTON} text-red-300`}
                          aria-label={`Confirm delete ${rule.id}`}
                          onClick={() => {
                            setConfirmDelete(null);
                            void act(() => client.remove(rule.id), `Deleted ${rule.id}.`);
                          }}
                        >
                          Confirm delete
                        </button>
                        <button type="button" className={SMALL_BUTTON} onClick={() => setConfirmDelete(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button type="button" className={SMALL_BUTTON} aria-label={`Delete ${rule.id}`} onClick={() => setConfirmDelete(rule.id)}>
                        Delete
                      </button>
                    )}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-white">Alert rules</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Threshold rules watch spend; anomaly rules watch approval patterns. Paused rules are kept but raise no alerts.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditing("new")}
          className={`min-h-11 rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-black hover:bg-emerald-400 ${FOCUS_RING}`}
        >
          New rule
        </button>
      </header>

      <div>
        <label htmlFor="alert-admin-token" className="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">
          Administrator token (only if this deployment requires one)
        </label>
        <input
          id="alert-admin-token"
          type="password"
          autoComplete="off"
          value={adminToken}
          onChange={(e) => {
            tokenStore.set(e.target.value);
            setAdminToken(e.target.value);
          }}
          className={`min-h-11 w-full max-w-sm rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 ${FOCUS_RING}`}
        />
        <p className="mt-1 text-xs text-zinc-500">Kept in memory only; never stored.</p>
      </div>

      {notice && (
        <p role={notice.tone === "error" ? "alert" : "status"} className={`text-sm ${notice.tone === "error" ? "text-red-400" : "text-emerald-400"}`}>
          {notice.text}
        </p>
      )}

      {editing && (
        <AlertRuleForm
          key={editing === "new" ? "new" : editing.id}
          rule={editing === "new" ? undefined : editing}
          onSubmit={save}
          onCancel={() => setEditing(null)}
          onTest={(input, hours) => client.testDraft(input, hours)}
        />
      )}

      <div role="radiogroup" aria-label="Show rules" className="flex gap-2">
        {(["all", "active", "paused"] as const).map((value) => (
          <label
            key={value}
            className={`min-h-11 cursor-pointer rounded-lg border px-3 py-2 text-sm capitalize has-focus-visible:ring-2 has-focus-visible:ring-emerald-400 ${
              filter === value ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-200" : "border-zinc-700 text-zinc-400"
            }`}
          >
            <input type="radio" name="alert-filter" className="sr-only" checked={filter === value} onChange={() => setFilter(value)} />
            {value}
          </label>
        ))}
      </div>

      {body}
    </div>
  );
}
