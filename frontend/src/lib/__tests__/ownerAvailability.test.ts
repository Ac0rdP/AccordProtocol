import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOWS,
  buildRotation,
  isAvailableAt,
  isTimeSensitive,
  nextAvailableAt,
  readAvailabilityMap,
  saveOwnerAvailability,
  startOfWeekUTC,
  suggestCoverage,
  validateWindows,
  windowsFor,
} from "../ownerAvailability";
import { baseProposal } from "../../stories/fixtures";
import type { Owner } from "../../types/accord";

// Thursday 2026-11-19 12:00 UTC
const NOW = Date.UTC(2026, 10, 19, 12);
const HOUR = 3_600_000;

const owners: Owner[] = [
  { address: "GAAA…0001", fullAddress: "GAAA0001", label: "Alice", roles: ["Owner"], weight: 2 },
  { address: "GBBB…0002", fullAddress: "GBBB0002", label: "Bob", roles: ["Owner"], weight: 3 },
  { address: "GCCC…0003", fullAddress: "GCCC0003", label: "Cara", roles: ["Owner"], weight: 1 },
];

beforeEach(() => localStorage.clear());

describe("windows", () => {
  it("defaults to weekdays 09–17 UTC", () => {
    expect(windowsFor({}, "anyone")).toBe(DEFAULT_WINDOWS);
    expect(isAvailableAt(DEFAULT_WINDOWS, new Date(NOW))).toBe(true);
    expect(isAvailableAt(DEFAULT_WINDOWS, new Date(Date.UTC(2026, 10, 19, 17)))).toBe(false);
    expect(isAvailableAt(DEFAULT_WINDOWS, new Date(Date.UTC(2026, 10, 21, 12)))).toBe(false); // Saturday
  });

  it("validates ordering, range, and duplicates", () => {
    expect(validateWindows([{ day: 1, start: 9, end: 17 }])).toBeNull();
    expect(validateWindows([{ day: 1, start: 17, end: 9 }])).toMatch(/end time must be after/);
    expect(validateWindows([{ day: 7, start: 1, end: 2 }])).toBe("Invalid day");
    expect(
      validateWindows([
        { day: 1, start: 1, end: 2 },
        { day: 1, start: 3, end: 4 },
      ]),
    ).toMatch(/more than once/);
  });

  it("finds the next available hour", () => {
    const friday5pm = new Date(Date.UTC(2026, 10, 20, 17, 30));
    expect(nextAvailableAt(DEFAULT_WINDOWS, friday5pm)?.toISOString()).toBe(
      "2026-11-23T09:00:00.000Z", // Monday
    );
    expect(nextAvailableAt([], friday5pm)).toBeNull();
  });
});

describe("storage", () => {
  it("round-trips saved windows", () => {
    const map = saveOwnerAvailability({}, "GAAA0001", [{ day: 6, start: 10, end: 12 }]);
    expect(readAvailabilityMap()).toEqual(map);
  });

  it("rejects invalid windows on save", () => {
    expect(() => saveOwnerAvailability({}, "x", [{ day: 1, start: 5, end: 5 }])).toThrow();
  });

  it("throws on corrupted data so the page can show an error", () => {
    localStorage.setItem("accord_owner_availability", "[1,2]");
    expect(() => readAvailabilityMap()).toThrow("corrupted");
    localStorage.setItem("accord_owner_availability", "{oops");
    expect(() => readAvailabilityMap()).toThrow();
  });
});

describe("rotation", () => {
  it("starts weeks on Monday UTC", () => {
    expect(startOfWeekUTC(new Date(NOW)).toISOString()).toBe("2026-11-16T00:00:00.000Z");
  });

  it("round-robins primaries with the next owner as backup, stable across start dates", () => {
    const keys = owners.map((o) => o.fullAddress);
    const rotation = buildRotation(keys, new Date(NOW), 4);
    expect(rotation).toHaveLength(4);
    const primaries = rotation.map((w) => w.primary);
    expect(new Set(primaries.slice(0, 3)).size).toBe(3);
    expect(primaries[3]).toBe(primaries[0]);
    const i = keys.indexOf(rotation[0].primary);
    expect(rotation[0].backup).toBe(keys[(i + 1) % keys.length]);

    const nextWeek = buildRotation(keys, new Date(NOW + 7 * 24 * HOUR), 1)[0];
    expect(nextWeek.primary).toBe(rotation[1].primary);
  });

  it("handles a single owner and no owners", () => {
    expect(buildRotation(["solo"], new Date(NOW), 1)[0]).toMatchObject({ primary: "solo", backup: null });
    expect(buildRotation([], new Date(NOW), 2)).toEqual([]);
  });
});

describe("coverage suggestions", () => {
  const deadlineIn = (hours: number) => Math.floor((NOW + hours * HOUR) / 1000);

  it("treats pending proposals expiring within 72h as time-sensitive", () => {
    expect(isTimeSensitive(baseProposal({ deadlineTs: deadlineIn(10) }), NOW)).toBe(true);
    expect(isTimeSensitive(baseProposal({ deadlineTs: deadlineIn(100) }), NOW)).toBe(false);
    expect(isTimeSensitive(baseProposal({ deadlineTs: deadlineIn(-1) }), NOW)).toBe(false);
    expect(isTimeSensitive(baseProposal({ status: "ready", deadlineTs: deadlineIn(5) }), NOW)).toBe(false);
  });

  it("suggests available owners who have not approved, earliest then heaviest, until quorum", () => {
    const proposal = baseProposal({
      deadlineTs: deadlineIn(30),
      quorumWeight: 5,
      approvalWeight: 1,
      approverAddresses: ["GCCC0003"],
    });
    const availability = { GAAA0001: [{ day: 5, start: 9, end: 17 }] }; // Alice: Friday only
    const plan = suggestCoverage(proposal, owners, availability, NOW);

    expect(plan.remainingWeight).toBe(4);
    // Bob (default hours) is available now; Alice only tomorrow; Cara already approved.
    expect(plan.suggestions.map((s) => s.label)).toEqual(["Bob", "Alice"]);
    expect(plan.covered).toBe(true);
  });

  it("flags proposals that cannot reach quorum before the deadline", () => {
    const proposal = baseProposal({
      deadlineTs: deadlineIn(2),
      quorumWeight: 10,
      approvalWeight: 0,
      approverAddresses: [],
    });
    const plan = suggestCoverage(proposal, owners, {}, NOW);
    expect(plan.covered).toBe(false);
    expect(plan.suggestions.map((s) => s.label)).toEqual(["Bob", "Alice", "Cara"]);
  });

  it("counts approvals instead of weight for unweighted proposals", () => {
    const proposal = baseProposal({
      deadlineTs: deadlineIn(5),
      quorumWeight: undefined,
      approvalWeight: undefined,
      threshold: 2,
      approvals: 1,
      approverAddresses: [],
    });
    const plan = suggestCoverage(proposal, owners, {}, NOW);
    expect(plan.remainingWeight).toBe(1);
    expect(plan.suggestions).toHaveLength(1);
    expect(plan.suggestions[0].weight).toBe(1);
  });
});
