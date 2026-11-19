import type { Owner, Proposal } from "../types/accord";
import { addressesMatch } from "./ownerActivity";

/**
 * A recurring weekly window during which an owner expects to be reachable
 * for approvals. All times are UTC so every owner reads the same calendar.
 */
export type AvailabilityWindow = {
  /** 0 = Sunday … 6 = Saturday (UTC). */
  day: number;
  /** Start hour, inclusive (0–23). */
  start: number;
  /** End hour, exclusive (1–24). */
  end: number;
};

export type AvailabilityMap = Record<string, AvailabilityWindow[]>;

export type RotationWeek = {
  weekStart: Date;
  primary: string;
  backup: string | null;
};

export type CoverageSuggestion = {
  address: string;
  label: string;
  weight: number;
  /** When the owner is next available (now or later), before the deadline. */
  availableAt: Date;
};

export type CoveragePlan = {
  proposalId: number;
  deadline: Date;
  /** Approval weight still needed to reach quorum. */
  remainingWeight: number;
  suggestions: CoverageSuggestion[];
  /** True when the suggested owners together close the remaining gap. */
  covered: boolean;
};

const STORAGE_KEY = "accord_owner_availability";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** Proposals expiring within this window count as time-sensitive. */
export const TIME_SENSITIVE_WINDOW_MS = 72 * HOUR_MS;

/** Monday 2024-01-01 00:00 UTC — anchors rotation so it is stable across views. */
const ROTATION_EPOCH_MS = Date.UTC(2024, 0, 1);

export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Display order for the calendar: Monday first. */
export const WEEK_DAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** Assumed availability for owners who have not set any: weekdays 09:00–17:00 UTC. */
export const DEFAULT_WINDOWS: AvailabilityWindow[] = [1, 2, 3, 4, 5].map((day) => ({
  day,
  start: 9,
  end: 17,
}));

export function ownerKey(owner: Pick<Owner, "address" | "fullAddress">): string {
  return owner.fullAddress || owner.address;
}

export function validateWindows(windows: AvailabilityWindow[]): string | null {
  const seen = new Set<number>();
  for (const w of windows) {
    if (!Number.isInteger(w.day) || w.day < 0 || w.day > 6) return "Invalid day";
    if (seen.has(w.day)) return `${DAY_NAMES[w.day]} is listed more than once`;
    seen.add(w.day);
    if (!Number.isInteger(w.start) || !Number.isInteger(w.end)) return "Hours must be whole numbers";
    if (w.start < 0 || w.end > 24 || w.start >= w.end) {
      return `${DAY_NAMES[w.day]}: end time must be after start time`;
    }
  }
  return null;
}

/** Reads stored availability. Throws when storage is unreadable or corrupt. */
export function readAvailabilityMap(): AvailabilityMap {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Saved availability data is corrupted");
  }
  return parsed as AvailabilityMap;
}

export function saveOwnerAvailability(
  map: AvailabilityMap,
  address: string,
  windows: AvailabilityWindow[],
): AvailabilityMap {
  const problem = validateWindows(windows);
  if (problem) throw new Error(problem);
  const next = {
    ...map,
    [address]: [...windows].sort((a, b) => a.day - b.day),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    throw new Error("Could not save availability. Browser storage is unavailable.");
  }
  return next;
}

export function resetAvailabilityStorage(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // nothing else to do — reads will keep failing and surface the error
  }
}

export function windowsFor(map: AvailabilityMap, address: string): AvailabilityWindow[] {
  return map[address] ?? DEFAULT_WINDOWS;
}

export function hasCustomAvailability(map: AvailabilityMap, address: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, address);
}

export function isAvailableAt(windows: AvailabilityWindow[], at: Date): boolean {
  const day = at.getUTCDay();
  const hour = at.getUTCHours();
  return windows.some((w) => w.day === day && hour >= w.start && hour < w.end);
}

/**
 * The earliest moment at or after `from` that falls in one of `windows`,
 * searching up to `horizonMs` ahead. Returns null when none is found.
 */
export function nextAvailableAt(
  windows: AvailabilityWindow[],
  from: Date,
  horizonMs = WEEK_MS,
): Date | null {
  if (isAvailableAt(windows, from)) return from;
  const startOfNextHour = Math.floor(from.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS;
  for (let t = startOfNextHour; t <= from.getTime() + horizonMs; t += HOUR_MS) {
    const candidate = new Date(t);
    if (isAvailableAt(windows, candidate)) return candidate;
  }
  return null;
}

/** Monday 00:00 UTC of the week containing `date`. */
export function startOfWeekUTC(date: Date): Date {
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  return new Date(midnight - daysSinceMonday * DAY_MS);
}

export function addWeeks(date: Date, weeks: number): Date {
  return new Date(date.getTime() + weeks * WEEK_MS);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/**
 * Weekly round-robin approval rotation. The primary owner is expected to
 * watch the queue that week; the backup is the next owner in order.
 */
export function buildRotation(
  ownerAddresses: string[],
  fromWeek: Date,
  weeks: number,
): RotationWeek[] {
  if (ownerAddresses.length === 0) return [];
  const first = startOfWeekUTC(fromWeek);
  const n = ownerAddresses.length;
  return Array.from({ length: weeks }, (_, i) => {
    const weekStart = addWeeks(first, i);
    const index = Math.floor((weekStart.getTime() - ROTATION_EPOCH_MS) / WEEK_MS);
    const primaryIndex = ((index % n) + n) % n;
    return {
      weekStart,
      primary: ownerAddresses[primaryIndex],
      backup: n > 1 ? ownerAddresses[(primaryIndex + 1) % n] : null,
    };
  });
}

export function deadlineOf(proposal: Proposal): Date {
  return new Date(proposal.deadlineTs * 1000);
}

export function isTimeSensitive(proposal: Proposal, nowMs: number): boolean {
  if (proposal.status !== "pending") return false;
  const remaining = proposal.deadlineTs * 1000 - nowMs;
  return remaining > 0 && remaining <= TIME_SENSITIVE_WINDOW_MS;
}

/**
 * Suggests which owners to ask for approval so a time-sensitive proposal
 * reaches quorum before its deadline: owners who have not approved yet and
 * are available before the deadline, earliest first, then heaviest first,
 * until their combined weight closes the gap.
 */
export function suggestCoverage(
  proposal: Proposal,
  owners: Owner[],
  availability: AvailabilityMap,
  nowMs: number,
): CoveragePlan {
  const deadline = deadlineOf(proposal);
  // Weighted proposals compare voting weight; legacy ones count approvals.
  const weighted = proposal.quorumWeight !== undefined;
  const quorum = weighted ? (proposal.quorumWeight ?? 0) : proposal.threshold;
  const approved = weighted ? (proposal.approvalWeight ?? 0) : proposal.approvals;
  const remainingWeight = Math.max(quorum - approved, 0);
  const now = new Date(nowMs);

  const candidates: CoverageSuggestion[] = [];
  for (const owner of owners) {
    const key = ownerKey(owner);
    const alreadyApproved = proposal.approverAddresses.some(
      (approver) => addressesMatch(approver, key) || addressesMatch(approver, owner.address),
    );
    const weight = weighted ? (owner.weight ?? 1) : 1;
    if (alreadyApproved || weight <= 0) continue;
    const availableAt = nextAvailableAt(
      windowsFor(availability, key),
      now,
      Math.max(deadline.getTime() - nowMs, 0),
    );
    if (!availableAt || availableAt.getTime() >= deadline.getTime()) continue;
    candidates.push({
      address: key,
      label: owner.label || owner.address,
      weight,
      availableAt,
    });
  }

  candidates.sort(
    (a, b) => a.availableAt.getTime() - b.availableAt.getTime() || b.weight - a.weight,
  );

  const suggestions: CoverageSuggestion[] = [];
  let gathered = 0;
  for (const candidate of candidates) {
    if (gathered >= remainingWeight) break;
    suggestions.push(candidate);
    gathered += candidate.weight;
  }

  return {
    proposalId: proposal.id,
    deadline,
    remainingWeight,
    suggestions,
    covered: gathered >= remainingWeight,
  };
}

export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export function formatRelative(target: Date, nowMs: number): string {
  const diff = target.getTime() - nowMs;
  if (diff <= 0) return "now";
  const hours = Math.round(diff / HOUR_MS);
  if (hours < 1) return "in under an hour";
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}
