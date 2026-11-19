/**
 * Client and form helpers for the analytics API's alert rule management
 * endpoints (`/alert-rules`, see docs/ANALYTICS_API.md#alert-rule-management).
 *
 * Threshold rules are `spend_threshold`; anomaly rules are `approval_burst` and
 * `off_hours_approval`. Rules from the deployment configuration are read-only.
 */

export type AlertRuleType = "spend_threshold" | "approval_burst" | "off_hours_approval";
export type AlertSeverity = "info" | "warning" | "critical";
export type AlertRuleCategory = "threshold" | "anomaly";

export const RULE_TYPES: { value: AlertRuleType; label: string; category: AlertRuleCategory; hint: string }[] = [
  {
    value: "spend_threshold",
    label: "Spend threshold",
    category: "threshold",
    hint: "Total transferred out within a rolling window reaches an amount.",
  },
  {
    value: "approval_burst",
    label: "Approval burst",
    category: "anomaly",
    hint: "One owner approves more than a set number of proposals within a window.",
  },
  {
    value: "off_hours_approval",
    label: "Off-hours approval",
    category: "anomaly",
    hint: "An approval lands inside a window of UTC hours.",
  },
];

export const SEVERITIES: AlertSeverity[] = ["info", "warning", "critical"];

/** A rule as the API returns it. */
export type AlertRule = {
  id: string;
  type: AlertRuleType;
  severity: AlertSeverity;
  cooldownSecs?: number;
  token?: string;
  threshold?: string;
  windowSecs?: number;
  maxApprovals?: number;
  startHour?: number;
  endHour?: number;
  category: AlertRuleCategory;
  /** `config` rules come from ALERT_RULES and cannot be changed. */
  source: "config" | "managed";
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
};

/** The body of a create, replace or test request. */
export type AlertRuleInput = {
  id?: string;
  type: AlertRuleType;
  severity: AlertSeverity;
  cooldownSecs?: number;
  token?: string;
  threshold?: string;
  windowSecs?: number;
  maxApprovals?: number;
  startHour?: number;
  endHour?: number;
  enabled?: boolean;
};

export type AlertRulePage = {
  items: AlertRule[];
  total: number;
  limit: number;
  offset: number;
};

export type TestedAlert = {
  ruleId: string;
  severity: AlertSeverity;
  subject: string;
  message: string;
  firedAt: string;
};

export type AlertRuleTestResult = {
  ruleId: string;
  lookbackHours: number;
  eventsEvaluated: number;
  truncated: boolean;
  wouldFire: number;
  suppressed: number;
  alerts: TestedAlert[];
};

export type FieldError = { field: string; message: string; code: string };

export class AlertRulesApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | undefined,
    public readonly details: FieldError[] = [],
  ) {
    super(message);
    this.name = "AlertRulesApiError";
  }
}

export type AlertRulesClientOptions = {
  /** Called per write so a token typed after the page loaded is still sent. */
  adminToken?: () => string | undefined;
};

type ErrorBody = { error?: { code?: string; message?: string; details?: FieldError[] } };

export function createAlertRulesClient(
  baseUrl: string = import.meta.env.VITE_API_BASE_URL || "",
  options: AlertRulesClientOptions = {},
) {
  const root = baseUrl.replace(/\/+$/, "");

  async function request<T>(
    method: string,
    path: string,
    { body, query, write, signal }: {
      body?: unknown;
      query?: Record<string, string | number | undefined>;
      write?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== "") params.set(key, String(value));
    }
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const token = write ? options.adminToken?.()?.trim() : undefined;
    if (token) headers.Authorization = `Bearer ${token}`;

    const search = params.toString();
    const response = await fetch(`${root}${path}${search ? `?${search}` : ""}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (response.status === 204) return undefined as T;

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new AlertRulesApiError(
        response.ok ? `Invalid JSON from ${path}` : `Alert rules request failed (${response.status})`,
        response.status,
        undefined,
      );
    }
    if (!response.ok) {
      const error = (parsed as ErrorBody)?.error;
      throw new AlertRulesApiError(
        error?.message ?? `Alert rules request failed (${response.status})`,
        response.status,
        error?.code,
        error?.details ?? [],
      );
    }
    return parsed as T;
  }

  const encode = encodeURIComponent;
  return {
    list: (query: { limit?: number; offset?: number; status?: "active" | "paused" } = {}, signal?: AbortSignal) =>
      request<AlertRulePage>("GET", "/alert-rules", { query, signal }),
    create: (input: AlertRuleInput) =>
      request<AlertRule>("POST", "/alert-rules", { body: input, write: true }),
    replace: (id: string, input: AlertRuleInput) =>
      request<AlertRule>("PUT", `/alert-rules/${encode(id)}`, { body: input, write: true }),
    remove: (id: string) => request<void>("DELETE", `/alert-rules/${encode(id)}`, { write: true }),
    pause: (id: string) => request<AlertRule>("POST", `/alert-rules/${encode(id)}/pause`, { write: true }),
    resume: (id: string) => request<AlertRule>("POST", `/alert-rules/${encode(id)}/resume`, { write: true }),
    /** Dry-runs a draft rule against recent history; nothing is stored or sent. */
    testDraft: (input: AlertRuleInput, lookbackHours = 24) =>
      request<AlertRuleTestResult>("POST", "/alert-rules/test", { body: input, query: { lookbackHours } }),
    testSaved: (id: string, lookbackHours = 24) =>
      request<AlertRuleTestResult>("POST", `/alert-rules/${encode(id)}/test`, { query: { lookbackHours } }),
  };
}

export type AlertRulesClient = ReturnType<typeof createAlertRulesClient>;

// --- form model -----------------------------------------------------------------

export type WindowUnit = "minutes" | "hours" | "days";

const UNIT_SECONDS: Record<WindowUnit, number> = { minutes: 60, hours: 3600, days: 86400 };
export const WINDOW_UNITS: WindowUnit[] = ["minutes", "hours", "days"];
/** Matches the API: a managed rule's window and cooldown may not exceed 30 days. */
export const MAX_SECONDS = 30 * 24 * 3600;

/** Everything the form edits, as the strings the inputs hold. */
export type AlertRuleDraft = {
  id: string;
  type: AlertRuleType;
  severity: AlertSeverity;
  enabled: boolean;
  /** Optional, in minutes; empty means the deployment-wide cooldown. */
  cooldownMinutes: string;
  token: string;
  threshold: string;
  windowValue: string;
  windowUnit: WindowUnit;
  maxApprovals: string;
  startHour: string;
  endHour: string;
};

export function emptyDraft(type: AlertRuleType = "spend_threshold"): AlertRuleDraft {
  return {
    id: "",
    type,
    severity: "warning",
    enabled: true,
    cooldownMinutes: "",
    token: "",
    threshold: "",
    windowValue: "1",
    windowUnit: "hours",
    maxApprovals: "",
    startHour: "22",
    endHour: "5",
  };
}

function splitWindow(seconds: number | undefined): Pick<AlertRuleDraft, "windowValue" | "windowUnit"> {
  if (!seconds) return { windowValue: "1", windowUnit: "hours" };
  for (const unit of ["days", "hours", "minutes"] as const) {
    if (seconds % UNIT_SECONDS[unit] === 0) {
      return { windowValue: String(seconds / UNIT_SECONDS[unit]), windowUnit: unit };
    }
  }
  // Not a whole number of minutes: show it exactly in the smallest unit.
  return { windowValue: String(Math.round(seconds / 60)), windowUnit: "minutes" };
}

export function ruleToDraft(rule: AlertRule): AlertRuleDraft {
  return {
    ...emptyDraft(rule.type),
    id: rule.id,
    severity: rule.severity,
    enabled: rule.enabled,
    cooldownMinutes: rule.cooldownSecs === undefined ? "" : String(Math.round(rule.cooldownSecs / 60)),
    token: rule.token ?? "",
    threshold: rule.threshold ?? "",
    ...splitWindow(rule.windowSecs),
    maxApprovals: rule.maxApprovals === undefined ? "" : String(rule.maxApprovals),
    startHour: rule.startHour === undefined ? "22" : String(rule.startHour),
    endHour: rule.endHour === undefined ? "5" : String(rule.endHour),
  };
}

const ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const WHOLE_NUMBER = /^\d+$/;

function windowSeconds(draft: AlertRuleDraft): number {
  return Number(draft.windowValue) * UNIT_SECONDS[draft.windowUnit];
}

export type DraftErrors = Partial<Record<
  "id" | "cooldownMinutes" | "threshold" | "window" | "maxApprovals" | "startHour" | "endHour",
  string
>>;

/** Mirrors the API's validation so most mistakes are caught before a request. */
export function validateDraft(draft: AlertRuleDraft, { requireId = true } = {}): DraftErrors {
  const errors: DraftErrors = {};
  const id = draft.id.trim();
  if (requireId) {
    if (!id) errors.id = "Enter an id.";
    else if (id === "test") errors.id = 'The id "test" is reserved.';
    else if (!ID_PATTERN.test(id)) errors.id = "Use 1-64 letters, digits, dots, dashes or underscores.";
  }

  if (draft.cooldownMinutes.trim()) {
    const minutes = Number(draft.cooldownMinutes);
    if (!WHOLE_NUMBER.test(draft.cooldownMinutes.trim()) || minutes * 60 > MAX_SECONDS) {
      errors.cooldownMinutes = "Enter whole minutes, at most 43200 (30 days).";
    }
  }

  const needsWindow = draft.type === "spend_threshold" || draft.type === "approval_burst";
  if (needsWindow) {
    const seconds = windowSeconds(draft);
    if (!WHOLE_NUMBER.test(draft.windowValue.trim()) || seconds < 1 || seconds > MAX_SECONDS) {
      errors.window = "Enter a window of at least 1 and at most 30 days.";
    }
  }
  if (draft.type === "spend_threshold" && !/^[1-9]\d*$/.test(draft.threshold.trim())) {
    errors.threshold = "Enter a positive whole number, in the token's smallest unit.";
  }
  if (draft.type === "approval_burst" && !/^[1-9]\d*$/.test(draft.maxApprovals.trim())) {
    errors.maxApprovals = "Enter a whole number of at least 1.";
  }
  if (draft.type === "off_hours_approval") {
    const valid = (value: string) => WHOLE_NUMBER.test(value.trim()) && Number(value) <= 23;
    if (!valid(draft.startHour)) errors.startHour = "Enter an hour from 0 to 23.";
    if (!valid(draft.endHour)) errors.endHour = "Enter an hour from 0 to 23.";
    if (!errors.startHour && !errors.endHour && Number(draft.startHour) === Number(draft.endHour)) {
      errors.endHour = "The start and end hours must differ.";
    }
  }
  return errors;
}

/** Builds the request body. Call only when `validateDraft` found no errors. */
export function draftToInput(draft: AlertRuleDraft, { includeId = true } = {}): AlertRuleInput {
  const input: AlertRuleInput = {
    type: draft.type,
    severity: draft.severity,
    enabled: draft.enabled,
  };
  if (includeId && draft.id.trim()) input.id = draft.id.trim();
  if (draft.cooldownMinutes.trim()) input.cooldownSecs = Number(draft.cooldownMinutes) * 60;

  if (draft.type === "spend_threshold") {
    if (draft.token.trim()) input.token = draft.token.trim();
    input.threshold = draft.threshold.trim();
    input.windowSecs = windowSeconds(draft);
  } else if (draft.type === "approval_burst") {
    input.maxApprovals = Number(draft.maxApprovals);
    input.windowSecs = windowSeconds(draft);
  } else {
    input.startHour = Number(draft.startHour);
    input.endHour = Number(draft.endHour);
  }
  return input;
}

/** Maps a server-side field name onto the form field that holds it. */
export function draftErrorsFromApi(error: AlertRulesApiError): DraftErrors {
  const target: Record<string, keyof DraftErrors> = {
    id: "id",
    cooldownSecs: "cooldownMinutes",
    threshold: "threshold",
    windowSecs: "window",
    maxApprovals: "maxApprovals",
    startHour: "startHour",
    endHour: "endHour",
  };
  const errors: DraftErrors = {};
  for (const detail of error.details) {
    const field = target[detail.field];
    if (field && !errors[field]) errors[field] = detail.message;
  }
  return errors;
}

function formatDuration(seconds: number): string {
  for (const [unit, size] of [["day", 86400], ["hour", 3600], ["minute", 60]] as const) {
    if (seconds % size === 0) {
      const count = seconds / size;
      return `${count} ${unit}${count === 1 ? "" : "s"}`;
    }
  }
  return `${seconds} seconds`;
}

function padHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/** A one-line, human description of what a rule watches for. */
export function describeRule(rule: AlertRule): string {
  switch (rule.type) {
    case "spend_threshold":
      return `${rule.token ?? "Any token"} spend reaches ${rule.threshold ?? "?"} within ${formatDuration(rule.windowSecs ?? 0)}`;
    case "approval_burst":
      return `One owner approves more than ${rule.maxApprovals ?? "?"} proposals within ${formatDuration(rule.windowSecs ?? 0)}`;
    case "off_hours_approval":
      return `An approval lands between ${padHour(rule.startHour ?? 0)} and ${padHour(rule.endHour ?? 0)} UTC`;
  }
}
