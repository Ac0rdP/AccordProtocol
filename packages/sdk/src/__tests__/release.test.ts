import { describe, expect, it } from "vitest";
import { AccordValidationError } from "../errors.js";
import * as sdk from "../index.js";
import {
  bumpVersion,
  determineReleaseType,
  parseConventionalCommit,
  parseSemver,
  planRelease,
  prependChangelog,
  renderReleaseNotes,
} from "../release.js";

const date = new Date("2026-11-19T12:00:00Z");

describe("parseConventionalCommit", () => {
  it("parses type, scope, subject and breaking markers", () => {
    expect(parseConventionalCommit("feat(sdk): add codegen", "abc1234def")).toMatchObject({
      hash: "abc1234def",
      type: "feat",
      scope: "sdk",
      subject: "add codegen",
      breaking: false,
    });
    expect(parseConventionalCommit("fix!: drop node 18")).toMatchObject({ breaking: true, breakingNote: "drop node 18" });
    expect(
      parseConventionalCommit("refactor: rename client\n\nBREAKING CHANGE: AccordClient is now default-exported")
    ).toMatchObject({ type: "refactor", breaking: true, breakingNote: "AccordClient is now default-exported" });
  });

  it("returns null for non-conventional messages", () => {
    expect(parseConventionalCommit("Merge pull request #1061 from someone/branch")).toBeNull();
    expect(parseConventionalCommit("added api keys")).toBeNull();
    expect(parseConventionalCommit(undefined as unknown as string)).toBeNull();
  });
});

describe("version bumps", () => {
  it("picks the highest release type", () => {
    const commits = ["docs: readme", "fix: a", "feat: b"].map((m) => parseConventionalCommit(m)!);
    expect(determineReleaseType(commits)).toBe("minor");
    expect(determineReleaseType([parseConventionalCommit("chore: deps")!])).toBeNull();
  });

  it("bumps semver, treating breaking changes as minor while on 0.x", () => {
    expect(bumpVersion("0.1.0", "patch")).toBe("0.1.1");
    expect(bumpVersion("0.1.3", "minor")).toBe("0.2.0");
    expect(bumpVersion("0.1.3", "major")).toBe("0.2.0");
    expect(bumpVersion("0.1.3", "major", { initialDevelopment: false })).toBe("1.0.0");
    expect(bumpVersion("1.4.2", "major")).toBe("2.0.0");
  });

  it("rejects invalid versions", () => {
    expect(() => parseSemver("1.2")).toThrow(AccordValidationError);
    expect(() => bumpVersion("01.0.0", "patch")).toThrow(/not a MAJOR\.MINOR\.PATCH/);
  });
});

describe("planRelease", () => {
  it("produces version, tag and Keep a Changelog notes", () => {
    const plan = planRelease(
      "0.1.0",
      [
        { hash: "1111111aaaa", message: "feat(sdk): add bundle budgets" },
        { hash: "2222222bbbb", message: "fix: handle empty spec" },
        { hash: "3333333cccc", message: "Merge branch 'main'" },
      ],
      { date, repositoryUrl: "https://github.com/Ac0rdP/AccordProtocol" }
    );

    expect(plan).not.toBeNull();
    expect(plan!.nextVersion).toBe("0.2.0");
    expect(plan!.tag).toBe("sdk-v0.2.0");
    expect(plan!.commits).toHaveLength(2);
    expect(plan!.notes).toBe(
      "## [0.2.0] - 2026-11-19\n\n" +
        "### Added\n- **sdk:** add bundle budgets ([1111111](https://github.com/Ac0rdP/AccordProtocol/commit/1111111aaaa))\n\n" +
        "### Fixed\n- handle empty spec ([2222222](https://github.com/Ac0rdP/AccordProtocol/commit/2222222bbbb))\n"
    );
  });

  it("returns null when nothing is releasable", () => {
    expect(planRelease("0.1.0", ["docs: typo", "chore: bump deps"])).toBeNull();
  });

  it("validates inputs", () => {
    expect(() => planRelease("latest", [])).toThrow(AccordValidationError);
    expect(() => planRelease("0.1.0", "feat: x" as never)).toThrow(/must be an array/);
  });

  it("lists breaking changes first", () => {
    const notes = renderReleaseNotes("0.3.0", [parseConventionalCommit("feat!: remove legacy API")!], { date });
    expect(notes.indexOf("### BREAKING CHANGES")).toBeLessThan(notes.indexOf("### Added"));
  });
});

describe("prependChangelog", () => {
  it("inserts above the latest release section", () => {
    const existing = "# Changelog\n\nIntro.\n\n## [0.1.0] - 2026-10-18\n\n### Added\n- Initial release.\n";
    const updated = prependChangelog(existing, "## [0.2.0] - 2026-11-19\n\n### Added\n- New\n");
    expect(updated).toBe(
      "# Changelog\n\nIntro.\n\n## [0.2.0] - 2026-11-19\n\n### Added\n- New\n\n## [0.1.0] - 2026-10-18\n\n### Added\n- Initial release.\n"
    );
    expect(prependChangelog("# Changelog\n", "## [0.1.0]\n")).toBe("# Changelog\n\n## [0.1.0]\n");
  });

  it("is exported from the package root", () => {
    expect(sdk.planRelease).toBe(planRelease);
  });
});
