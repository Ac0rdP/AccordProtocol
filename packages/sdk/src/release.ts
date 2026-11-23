/**
 * Semantic Release Planning for @accord-protocol/sdk
 * Derives the next version, changelog section and git tag from Conventional
 * Commits. Used by `scripts/release.mjs` (and the `sdk-release.yml` workflow)
 * to automate versioning, changelog generation and npm publishing with
 * provenance. Pure and dependency-free so it can run before the package is
 * installed anywhere else and tree-shakes away from `AccordClient`.
 */

import { AccordValidationError } from "./errors.js";

export type ReleaseType = "major" | "minor" | "patch";

export interface ConventionalCommit {
  hash: string;
  type: string;
  scope: string | null;
  subject: string;
  body: string;
  breaking: boolean;
  /** Text of the `BREAKING CHANGE:` footer, or the subject for `type!:` commits. */
  breakingNote: string | null;
}

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

export interface ReleaseOptions {
  /**
   * While the major version is 0, breaking changes bump the minor version
   * instead of releasing 1.0.0 (SemVer §4). Defaults to `true`.
   */
  initialDevelopment?: boolean;
  /** Prefix for the git tag. Defaults to `sdk-v`, matching `sdk-publish.yml`. */
  tagPrefix?: string;
  /** Release date for the changelog heading. Defaults to now. */
  date?: Date;
  /** Base URL used to link commit hashes, e.g. `https://github.com/org/repo`. */
  repositoryUrl?: string;
}

export interface ReleasePlan {
  currentVersion: string;
  nextVersion: string;
  releaseType: ReleaseType;
  tag: string;
  /** Keep a Changelog section for the release, ready to prepend to CHANGELOG.md. */
  notes: string;
  commits: ConventionalCommit[];
}

const HEADER = /^(\w+)(?:\(([^()\r\n]+)\))?(!)?: (.+)$/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE: ([\s\S]+)$/m;
const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const RANK: Record<ReleaseType, number> = { patch: 1, minor: 2, major: 3 };

/** Commit types that produce a release, and the changelog section they land in. */
export const RELEASE_RULES: Readonly<Record<string, { release: ReleaseType; section: string }>> = {
  feat: { release: "minor", section: "Added" },
  fix: { release: "patch", section: "Fixed" },
  perf: { release: "patch", section: "Changed" },
  revert: { release: "patch", section: "Changed" },
};

/**
 * Parses a commit message in Conventional Commits form
 * (`type(scope)!: subject`, optional body and footers).
 * Returns `null` for messages that do not follow the convention (for example
 * merge commits), so they never influence the release.
 */
export function parseConventionalCommit(message: string, hash = ""): ConventionalCommit | null {
  if (typeof message !== "string") return null;
  const [header = "", ...rest] = message.trim().split(/\r?\n/);
  const match = header.match(HEADER);
  if (!match) return null;

  const [, type, scope, bang, subject] = match;
  const body = rest.join("\n").trim();
  const footer = body.match(BREAKING_FOOTER);
  const breakingNote = footer ? footer[1].trim() : bang ? subject.trim() : null;

  return {
    hash,
    type: type.toLowerCase(),
    scope: scope ?? null,
    subject: subject.trim(),
    body,
    breaking: breakingNote !== null,
    breakingNote,
  };
}

/** Returns the highest release type triggered by `commits`, or `null` if none. */
export function determineReleaseType(commits: readonly ConventionalCommit[]): ReleaseType | null {
  let best: ReleaseType | null = null;
  for (const commit of commits) {
    const type: ReleaseType | undefined = commit.breaking ? "major" : RELEASE_RULES[commit.type]?.release;
    if (type && (!best || RANK[type] > RANK[best])) best = type;
  }
  return best;
}

export function parseSemver(version: string): SemVer {
  const match = typeof version === "string" ? version.trim().match(SEMVER) : null;
  if (!match) {
    throw new AccordValidationError("version", `'${version}' is not a MAJOR.MINOR.PATCH version.`);
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Bumps `version` by `type`. See `ReleaseOptions.initialDevelopment` for 0.x behaviour. */
export function bumpVersion(version: string, type: ReleaseType, options: ReleaseOptions = {}): string {
  const { major, minor, patch } = parseSemver(version);
  const effective = type === "major" && major === 0 && options.initialDevelopment !== false ? "minor" : type;
  switch (effective) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new AccordValidationError("releaseType", `Unknown release type '${String(type)}'.`);
  }
}

function entry(commit: ConventionalCommit, text: string, repositoryUrl?: string): string {
  const scope = commit.scope ? `**${commit.scope}:** ` : "";
  const short = commit.hash.slice(0, 7);
  const ref = !short ? "" : repositoryUrl ? ` ([${short}](${repositoryUrl}/commit/${commit.hash}))` : ` (${short})`;
  return `- ${scope}${text}${ref}`;
}

/** Renders a Keep a Changelog section for a release, matching the repo's CHANGELOG format. */
export function renderReleaseNotes(
  version: string,
  commits: readonly ConventionalCommit[],
  options: ReleaseOptions = {}
): string {
  const date = (options.date ?? new Date()).toISOString().slice(0, 10);
  const sections = new Map<string, string[]>();
  const add = (section: string, line: string) => sections.set(section, [...(sections.get(section) ?? []), line]);

  for (const commit of commits) {
    if (commit.breakingNote) add("BREAKING CHANGES", entry(commit, commit.breakingNote, options.repositoryUrl));
    const rule = RELEASE_RULES[commit.type];
    if (rule) add(rule.section, entry(commit, commit.subject, options.repositoryUrl));
  }

  const order = ["BREAKING CHANGES", "Added", "Changed", "Fixed"];
  const body = order
    .filter((s) => sections.has(s))
    .map((s) => `### ${s}\n${sections.get(s)!.join("\n")}`)
    .join("\n\n");
  return `## [${version}] - ${date}\n\n${body}\n`;
}

/**
 * Inserts `notes` above the most recent release section of a Keep a Changelog
 * file (or appends it when the file has no releases yet).
 */
export function prependChangelog(changelog: string, notes: string): string {
  const index = changelog.search(/^## \[/m);
  if (index === -1) return `${changelog.trimEnd()}\n\n${notes}`;
  return `${changelog.slice(0, index)}${notes}\n${changelog.slice(index)}`;
}

/**
 * Plans a release from the current version and the raw commit messages since
 * the last release tag. Returns `null` when no commit warrants a release.
 */
export function planRelease(
  currentVersion: string,
  commitMessages: ReadonlyArray<string | { hash: string; message: string }>,
  options: ReleaseOptions = {}
): ReleasePlan | null {
  parseSemver(currentVersion);
  if (!Array.isArray(commitMessages)) {
    throw new AccordValidationError("commits", "Commits must be an array.");
  }

  const commits = commitMessages
    .map((c) => (typeof c === "string" ? parseConventionalCommit(c) : parseConventionalCommit(c.message, c.hash)))
    .filter((c): c is ConventionalCommit => c !== null);

  const releaseType = determineReleaseType(commits);
  if (!releaseType) return null;

  const nextVersion = bumpVersion(currentVersion, releaseType, options);
  return {
    currentVersion,
    nextVersion,
    releaseType,
    tag: `${options.tagPrefix ?? "sdk-v"}${nextVersion}`,
    notes: renderReleaseNotes(nextVersion, commits, options),
    commits,
  };
}
