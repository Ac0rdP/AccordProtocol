import rawChangelog from "../../../CHANGELOG.md?raw";

export interface ChangelogEntry {
  id: string;
  text: string;
  release: string;
  category: string;
  issues: number[];
  docs: string[];
}

export interface ChangelogRelease {
  version: string;
  entries: ChangelogEntry[];
}

export interface ChangelogSeen {
  version: string;
  entryCount: number;
}

const SEEN_KEY = "accord_changelog_seen";

/**
 * Parse Keep a Changelog markdown into structured releases. Releases are
 * returned newest-first, matching the order they appear in the file.
 */
export function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let current: ChangelogRelease | null = null;
  let category = "";
  let entryIndex = 0;

  for (const line of markdown.split(/\r?\n/)) {
    const versionMatch = line.match(/^##\s+\[?([^\]]+)\]?/);
    if (versionMatch) {
      current = { version: versionMatch[1].trim(), entries: [] };
      releases.push(current);
      entryIndex = 0;
      category = "";
      continue;
    }

    const categoryMatch = line.match(/^###\s+(.+)$/);
    if (categoryMatch) {
      category = categoryMatch[1].trim();
      continue;
    }

    const itemMatch = line.match(/^\s*[-*]\s+(.*)$/);
    if (itemMatch && current) {
      const text = itemMatch[1].trim();
      current.entries.push({
        id: `${current.version}-${entryIndex}`,
        text,
        release: current.version,
        category,
        issues: [...text.matchAll(/#(\d+)/g)].map((m) => Number(m[1])),
        docs: [...text.matchAll(/docs\/[\w./-]+/g)]
          .map((m) => m[0].replace(/[.,;:!?]+$/, ""))
          .filter(Boolean),
      });
      entryIndex += 1;
    }
  }

  return releases;
}

export function getChangelogSeen(): ChangelogSeen | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.version === "string" &&
      typeof parsed.entryCount === "number"
    ) {
      return parsed as ChangelogSeen;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Mark everything currently in the changelog as seen. Returns the new seen
 * state so callers can update component state without re-reading storage.
 */
export function markChangelogSeen(
  releases: ChangelogRelease[],
): ChangelogSeen | null {
  const top = releases[0];
  if (!top) return null;
  const seen: ChangelogSeen = {
    version: top.version,
    entryCount: top.entries.length,
  };
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // localStorage might be unavailable or throw in restricted environments
  }
  return seen;
}

/**
 * Entries the user has not seen yet: everything in releases newer than the
 * last-seen version, plus any entries added to the last-seen release since
 * it was viewed. When nothing has been seen yet every entry is unread.
 */
export function getUnreadEntries(
  releases: ChangelogRelease[],
  seen: ChangelogSeen | null,
): ChangelogEntry[] {
  if (!seen) {
    return releases.flatMap((release) => release.entries);
  }

  const unread: ChangelogEntry[] = [];
  for (const release of releases) {
    if (release.version === seen.version) {
      unread.push(...release.entries.slice(seen.entryCount));
      break;
    }
    unread.push(...release.entries);
  }
  return unread;
}

export const changelogReleases: ChangelogRelease[] = parseChangelog(rawChangelog);
