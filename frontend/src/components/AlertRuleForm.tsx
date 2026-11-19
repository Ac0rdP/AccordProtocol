import { useId, useState, type FormEvent } from "react";
import {
  AlertRulesApiError,
  RULE_TYPES,
  SEVERITIES,
  WINDOW_UNITS,
  draftErrorsFromApi,
  draftToInput,
  emptyDraft,
  ruleToDraft,
  validateDraft,
  type AlertRule,
  type AlertRuleDraft,
  type AlertRuleInput,
  type AlertRuleTestResult,
  type DraftErrors,
} from "../lib/alertRules";
import { AlertRuleTestResultView } from "./AlertRuleTestResult";

const FOCUS_RING =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950";
const INPUT = "min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 disabled:opacity-50";
const BUTTON = `min-h-11 rounded-lg px-4 text-sm font-medium disabled:opacity-50 ${FOCUS_RING}`;

const LOOKBACKS = [
  { hours: 24, label: "Last 24 hours" },
  { hours: 72, label: "Last 3 days" },
  { hours: 168, label: "Last 7 days" },
];

export type AlertRuleFormProps = {
  /** The rule being edited; omit to create one. */
  rule?: AlertRule;
  /** Saves the rule. May reject with an `AlertRulesApiError`. */
  onSubmit: (input: AlertRuleInput) => Promise<void>;
  onCancel: () => void;
  /** Dry-runs the draft against recent history. Nothing is stored or sent. */
  onTest: (input: AlertRuleInput, lookbackHours: number) => Promise<AlertRuleTestResult>;
};

/** Create or edit a threshold or anomaly alert rule, and test it before saving. */
export function AlertRuleForm({ rule, onSubmit, onCancel, onTest }: AlertRuleFormProps) {
  const editing = rule !== undefined;
  const [draft, setDraft] = useState<AlertRuleDraft>(() => (rule ? ruleToDraft(rule) : emptyDraft()));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [lookback, setLookback] = useState(24);
  const [result, setResult] = useState<AlertRuleTestResult | null>(null);
  const base = useId();
  const id = (name: string) => `${base}-${name}`;

  function patch(change: Partial<AlertRuleDraft>) {
    setDraft((current) => ({ ...current, ...change }));
    setErrors({});
    setFormError(null);
    // A test of an older draft would be misleading next to a changed one.
    setResult(null);
  }

  function check(): AlertRuleInput | null {
    const found = validateDraft(draft, { requireId: !editing });
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setFormError("Fix the highlighted fields.");
      return null;
    }
    return draftToInput(draft, { includeId: !editing });
  }

  function report(error: unknown, fallback: string) {
    if (error instanceof AlertRulesApiError) {
      const mapped = draftErrorsFromApi(error);
      setErrors(mapped);
      setFormError(Object.keys(mapped).length > 0 ? "Fix the highlighted fields." : error.message);
    } else {
      setFormError(error instanceof Error ? error.message : fallback);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const input = check();
    if (!input) return;
    setBusy("save");
    try {
      await onSubmit(input);
    } catch (error) {
      report(error, "Could not save the rule.");
    } finally {
      setBusy(null);
    }
  }

  async function handleTest() {
    const input = check();
    if (!input) return;
    setBusy("test");
    setResult(null);
    try {
      setResult(await onTest(input, lookback));
      setFormError(null);
    } catch (error) {
      report(error, "Could not test the rule.");
    } finally {
      setBusy(null);
    }
  }

  const type = draft.type;
  const typeInfo = RULE_TYPES.find((entry) => entry.value === type);
  const field = (name: keyof DraftErrors) => ({
    "aria-invalid": errors[name] ? true : undefined,
    "aria-describedby": errors[name] ? id(`${name}-error`) : undefined,
  });
  const fieldError = (name: keyof DraftErrors) =>
    errors[name] ? (
      <p id={id(`${name}-error`)} className="mt-1 text-xs text-red-400">
        {errors[name]}
      </p>
    ) : null;

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label={editing ? `Edit rule ${rule.id}` : "New alert rule"}
      className="space-y-5 rounded-xl border border-zinc-800 bg-zinc-900 p-4"
    >
      <h2 className="text-base font-semibold text-zinc-100">
        {editing ? `Edit rule ${rule.id}` : "New alert rule"}
      </h2>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id("id")} className="mb-1 block text-xs text-zinc-400">
            Rule id
          </label>
          <input
            id={id("id")}
            value={draft.id}
            disabled={editing}
            onChange={(e) => patch({ id: e.target.value })}
            placeholder="large-usdc-spend"
            autoComplete="off"
            className={`${INPUT} ${FOCUS_RING}`}
            {...field("id")}
          />
          {fieldError("id")}
        </div>
        <div>
          <label htmlFor={id("type")} className="mb-1 block text-xs text-zinc-400">
            Rule type
          </label>
          <select
            id={id("type")}
            value={type}
            onChange={(e) => patch({ type: e.target.value as AlertRuleDraft["type"] })}
            className={`${INPUT} ${FOCUS_RING}`}
          >
            {RULE_TYPES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label} ({entry.category})
              </option>
            ))}
          </select>
        </div>
      </div>
      {typeInfo && <p className="-mt-3 text-xs text-zinc-400">{typeInfo.hint}</p>}

      {type === "spend_threshold" && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={id("token")} className="mb-1 block text-xs text-zinc-400">
              Token (optional)
            </label>
            <input
              id={id("token")}
              value={draft.token}
              onChange={(e) => patch({ token: e.target.value })}
              placeholder="Any token"
              className={`${INPUT} ${FOCUS_RING}`}
            />
          </div>
          <div>
            <label htmlFor={id("threshold")} className="mb-1 block text-xs text-zinc-400">
              Threshold (smallest unit)
            </label>
            <input
              id={id("threshold")}
              value={draft.threshold}
              inputMode="numeric"
              onChange={(e) => patch({ threshold: e.target.value })}
              placeholder="50000000000"
              className={`${INPUT} ${FOCUS_RING}`}
              {...field("threshold")}
            />
            {fieldError("threshold")}
          </div>
        </div>
      )}

      {type === "approval_burst" && (
        <div>
          <label htmlFor={id("max")} className="mb-1 block text-xs text-zinc-400">
            Alert when one owner approves more than
          </label>
          <input
            id={id("max")}
            value={draft.maxApprovals}
            inputMode="numeric"
            onChange={(e) => patch({ maxApprovals: e.target.value })}
            placeholder="5"
            className={`${INPUT} sm:max-w-48 ${FOCUS_RING}`}
            {...field("maxApprovals")}
          />
          {fieldError("maxApprovals")}
        </div>
      )}

      {(type === "spend_threshold" || type === "approval_burst") && (
        <fieldset>
          <legend className="mb-1 text-xs text-zinc-400">Rolling window</legend>
          <div className="flex gap-2">
            <input
              aria-label="Window length"
              value={draft.windowValue}
              inputMode="numeric"
              onChange={(e) => patch({ windowValue: e.target.value })}
              className={`${INPUT} max-w-28 ${FOCUS_RING}`}
              {...field("window")}
            />
            <select
              aria-label="Window unit"
              value={draft.windowUnit}
              onChange={(e) => patch({ windowUnit: e.target.value as AlertRuleDraft["windowUnit"] })}
              className={`${INPUT} max-w-36 ${FOCUS_RING}`}
            >
              {WINDOW_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </select>
          </div>
          {fieldError("window")}
        </fieldset>
      )}

      {type === "off_hours_approval" && (
        <fieldset>
          <legend className="mb-1 text-xs text-zinc-400">
            Off-hours window (UTC, wraps past midnight when the start is later than the end)
          </legend>
          <div className="grid grid-cols-2 gap-3 sm:max-w-md">
            <div>
              <label htmlFor={id("start")} className="mb-1 block text-xs text-zinc-400">
                Start hour
              </label>
              <input
                id={id("start")}
                value={draft.startHour}
                inputMode="numeric"
                onChange={(e) => patch({ startHour: e.target.value })}
                className={`${INPUT} ${FOCUS_RING}`}
                {...field("startHour")}
              />
              {fieldError("startHour")}
            </div>
            <div>
              <label htmlFor={id("end")} className="mb-1 block text-xs text-zinc-400">
                End hour
              </label>
              <input
                id={id("end")}
                value={draft.endHour}
                inputMode="numeric"
                onChange={(e) => patch({ endHour: e.target.value })}
                className={`${INPUT} ${FOCUS_RING}`}
                {...field("endHour")}
              />
              {fieldError("endHour")}
            </div>
          </div>
        </fieldset>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id("severity")} className="mb-1 block text-xs text-zinc-400">
            Severity
          </label>
          <select
            id={id("severity")}
            value={draft.severity}
            onChange={(e) => patch({ severity: e.target.value as AlertRuleDraft["severity"] })}
            className={`${INPUT} ${FOCUS_RING}`}
          >
            {SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {severity}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={id("cooldown")} className="mb-1 block text-xs text-zinc-400">
            Cooldown in minutes (optional)
          </label>
          <input
            id={id("cooldown")}
            value={draft.cooldownMinutes}
            inputMode="numeric"
            onChange={(e) => patch({ cooldownMinutes: e.target.value })}
            placeholder="Deployment default"
            className={`${INPUT} ${FOCUS_RING}`}
            {...field("cooldownMinutes")}
          />
          {fieldError("cooldownMinutes")}
        </div>
      </div>

      <label htmlFor={id("enabled")} className="flex min-h-11 items-center gap-3 text-sm text-zinc-200">
        <input
          id={id("enabled")}
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
          className="h-4 w-4 accent-emerald-500"
        />
        Active (a paused rule is kept but raises no alerts)
      </label>

      <div className="rounded-lg border border-zinc-800 p-3">
        <p className="mb-2 text-sm font-medium text-zinc-200">Test before saving</p>
        <p className="mb-3 text-xs text-zinc-400">
          Replays recent indexed activity through this rule. Nothing is saved and nobody is notified.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={id("lookback")} className="sr-only">
            History to test against
          </label>
          <select
            id={id("lookback")}
            value={lookback}
            onChange={(e) => {
              setLookback(Number(e.target.value));
              setResult(null);
            }}
            className={`${INPUT} max-w-48 ${FOCUS_RING}`}
          >
            {LOOKBACKS.map((option) => (
              <option key={option.hours} value={option.hours}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleTest}
            disabled={busy !== null}
            className={`${BUTTON} border border-zinc-700 text-zinc-200 hover:bg-zinc-800`}
          >
            {busy === "test" ? "Testing…" : "Test rule"}
          </button>
        </div>
        {result && <AlertRuleTestResultView result={result} />}
      </div>

      {formError && (
        <p role="alert" className="text-sm text-red-400">
          {formError}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={busy !== null}
          className={`${BUTTON} bg-emerald-500 text-black hover:bg-emerald-400`}
        >
          {busy === "save" ? "Saving…" : editing ? "Save changes" : "Create rule"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy === "save"}
          className={`${BUTTON} text-zinc-300 hover:bg-zinc-800`}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
