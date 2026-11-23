import { beforeEach, describe, expect, test, vi } from "vitest";

// The real raw import is denied by Vite's dev-server fs allow list in tests;
// these suites exercise the parser and unread helpers with fixtures only.
vi.mock("../../../CHANGELOG.md?raw", () => ({ default: "# Changelog\n" }));

import {
  getUnreadEntries,
  markChangelogSeen,
  parseChangelog,
  type ChangelogRelease,
} from "./changelog";

const FIXTURE = `# Changelog

## [Unreleased]

### Added
- Nightly workflow (#820) documented in docs/CI.md.
- Seeded preview deployments.

### Fixed
- Repair merge damage in the indexer.

## [0.1.0]

### Added
- Initial Soroban multisig contract.
`;

describe("parseChangelog", () => {
  test("returns releases newest-first", () => {
    const releases = parseChangelog(FIXTURE);
    expect(releases.map((r) => r.version)).toEqual(["Unreleased", "0.1.0"]);
  });

  test("parses entries with category, issue refs, and doc refs", () => {
    const releases = parseChangelog(FIXTURE);
    const unreleased = releases[0];

    expect(unreleased.entries).toHaveLength(3);
    expect(unreleased.entries[0]).toMatchObject({
      text: "Nightly workflow (#820) documented in docs/CI.md.",
      category: "Added",
      issues: [820],
      docs: ["docs/CI.md"],
    });
    expect(unreleased.entries[1].category).toBe("Added");
    expect(unreleased.entries[2].category).toBe("Fixed");
    expect(releases[1].entries[0].text).toBe("Initial Soroban multisig contract.");
  });

  test("gives each entry a stable unique id", () => {
    const releases = parseChangelog(FIXTURE);
    const ids = releases.flatMap((r) => r.entries.map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("getUnreadEntries", () => {
  const releases = parseChangelog(FIXTURE);
  let store: Record<string, string> = {};

  beforeEach(() => {
    store = {};
    const mockStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, val: string) => {
        store[key] = val;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
    };
    Object.defineProperty(window, "localStorage", {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
  });

  test("treats every entry as unread when nothing has been seen", () => {
    const unread = getUnreadEntries(releases, null);
    expect(unread).toHaveLength(4);
  });

  test("returns only newer entries after the top release has been seen", () => {
    const seen = markChangelogSeen(releases);
    expect(seen).toEqual({ version: "Unreleased", entryCount: 3 });
    expect(getUnreadEntries(releases, seen)).toHaveLength(0);
  });

  test("flags entries added to the seen release since it was viewed", () => {
    const seen = { version: "Unreleased", entryCount: 2 };
    const unread = getUnreadEntries(releases, seen);
    expect(unread).toHaveLength(1);
    expect(unread[0].text).toContain("Repair merge damage");
  });

  test("includes all newer releases when an older version was last seen", () => {
    const seen = { version: "0.1.0", entryCount: 1 };
    const unread = getUnreadEntries(releases, seen);
    expect(unread).toHaveLength(3);
    expect(unread.every((entry) => entry.release === "Unreleased")).toBe(true);
  });

  test("treats an unknown seen version as fully unread", () => {
    const seen = { version: "9.9.9", entryCount: 5 };
    expect(getUnreadEntries(releases, seen)).toHaveLength(4);
  });
});

describe("markChangelogSeen", () => {
  let store: Record<string, string> = {};

  beforeEach(() => {
    store = {};
    const mockStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, val: string) => {
        store[key] = val;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
    };
    Object.defineProperty(window, "localStorage", {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
  });

  test("persists the top release and its entry count", () => {
    const releases: ChangelogRelease[] = [
      { version: "Unreleased", entries: [] },
    ];
    expect(markChangelogSeen(releases)).toEqual({
      version: "Unreleased",
      entryCount: 0,
    });
    expect(localStorage.getItem("accord_changelog_seen")).toContain("Unreleased");
  });

  test("returns null when there are no releases", () => {
    expect(markChangelogSeen([])).toBeNull();
  });
});
