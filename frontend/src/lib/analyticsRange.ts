import type { AnalyticsGranularity, AnalyticsQuery } from "../types/accord";

/** yyyy-mm-dd (inclusive) bounds; "" means unbounded, matching AnalyticsFilters. */
export type DateRange = { startDate: string; endDate: string };

export type RangePreset = "7d" | "30d" | "90d" | "ytd" | "all";

export const DEFAULT_RANGE_PRESET: RangePreset = "30d";

const MS_PER_DAY = 86_400_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse a strict yyyy-mm-dd string to UTC midnight ms, or null if invalid. */
export function parseDateOnly(value: string): number | null {
  const m = DATE_ONLY.exec(value);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  // Reject roll-overs such as 2026-02-31.
  return d.toISOString().slice(0, 10) === value ? ms : null;
}

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Common ranges, in UTC. "Nd" ranges include today and span exactly N days. */
export function getPresetRange(
  preset: RangePreset,
  now: Date = new Date(),
): DateRange {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const endDate = toIsoDate(new Date(today));
  switch (preset) {
    case "7d":
    case "30d":
    case "90d": {
      const days = Number.parseInt(preset, 10);
      return { startDate: toIsoDate(new Date(today - (days - 1) * MS_PER_DAY)), endDate };
    }
    case "ytd":
      return { startDate: `${now.getUTCFullYear()}-01-01`, endDate };
    case "all":
      return { startDate: "", endDate: "" };
  }
}

export function getDefaultRange(now: Date = new Date()): DateRange {
  return getPresetRange(DEFAULT_RANGE_PRESET, now);
}

export type RangeBounds = {
  /** Earliest allowed yyyy-mm-dd. */
  min?: string;
  /** Latest allowed yyyy-mm-dd. */
  max?: string;
  /** Longest allowed span in days (inclusive of both ends). */
  maxDays?: number;
};

export type RangeValidation =
  | { valid: true; range: DateRange }
  | { valid: false; reason: string };

/** Strict validation: rejects malformed dates and start > end. Empty bounds are allowed. */
export function validateDateRange(range: DateRange): RangeValidation {
  const start = range.startDate ? parseDateOnly(range.startDate) : null;
  const end = range.endDate ? parseDateOnly(range.endDate) : null;
  if (range.startDate && start === null) {
    return { valid: false, reason: "startDate must be a valid yyyy-mm-dd date" };
  }
  if (range.endDate && end === null) {
    return { valid: false, reason: "endDate must be a valid yyyy-mm-dd date" };
  }
  if (start !== null && end !== null && start > end) {
    return { valid: false, reason: "startDate must be before or equal to endDate" };
  }
  return { valid: true, range };
}

/**
 * Lenient normalisation for user-supplied ranges: malformed bounds are dropped,
 * swapped bounds are reordered, then the range is clamped to `bounds`.
 */
export function clampDateRange(
  range: DateRange,
  bounds: RangeBounds = {},
): DateRange {
  const parse = (v: string | undefined) => (v ? parseDateOnly(v) : null);
  let start = parse(range.startDate);
  let end = parse(range.endDate);
  const min = parse(bounds.min);
  const max = parse(bounds.max);

  if (start !== null && end !== null && start > end) [start, end] = [end, start];
  if (min !== null) {
    if (start !== null && start < min) start = min;
    if (end !== null && end < min) end = min;
  }
  if (max !== null) {
    if (start !== null && start > max) start = max;
    if (end !== null && end > max) end = max;
  }
  if (bounds.maxDays !== undefined && bounds.maxDays >= 1) {
    const span = (bounds.maxDays - 1) * MS_PER_DAY;
    if (start !== null && end !== null && end - start > span) start = end - span;
  }

  const fmt = (ms: number | null) => (ms === null ? "" : toIsoDate(new Date(ms)));
  return { startDate: fmt(start), endDate: fmt(end) };
}

export const GRANULARITY_OPTIONS: ReadonlyArray<{
  label: string;
  value: AnalyticsGranularity;
}> = [
  { label: "Daily", value: "day" },
  { label: "Weekly", value: "week" },
  { label: "Monthly", value: "month" },
];

const GRANULARITY_ALIASES: Record<string, AnalyticsGranularity> = {
  day: "day",
  daily: "day",
  week: "week",
  weekly: "week",
  month: "month",
  monthly: "month",
};

/** Map a UI choice ("Weekly", "week", ...) to the API value, or undefined if unknown. */
export function toApiGranularity(choice: string): AnalyticsGranularity | undefined {
  return GRANULARITY_ALIASES[choice.trim().toLowerCase()];
}

/** Pick a readable bucket size for a range: day ≤ 31 days, week ≤ 180 days, else month. */
export function suggestGranularity(range: DateRange): AnalyticsGranularity {
  const start = range.startDate ? parseDateOnly(range.startDate) : null;
  const end = range.endDate ? parseDateOnly(range.endDate) : null;
  if (start === null || end === null) return "month";
  const days = Math.floor((end - start) / MS_PER_DAY) + 1;
  if (days <= 31) return "day";
  if (days <= 180) return "week";
  return "month";
}

/** Build the analytics query for a range + granularity choice, omitting empty bounds. */
export function buildRangeQuery(
  range: DateRange,
  granularity?: string,
): AnalyticsQuery {
  const query: AnalyticsQuery = {};
  if (range.startDate) query.startDate = range.startDate;
  if (range.endDate) query.endDate = range.endDate;
  const g = granularity ? toApiGranularity(granularity) : undefined;
  if (g) query.granularity = g;
  return query;
}
