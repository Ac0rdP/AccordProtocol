#!/usr/bin/env node
// Semantic release for @accord-protocol/sdk.
//
// Reads Conventional Commits that touched packages/sdk since the last
// `sdk-v*` tag, derives the next version, writes the version and changelog
// section into the package (working tree only), publishes to npm with
// provenance, then pushes the tag and creates a GitHub Release.
//
//   npm run build && node scripts/release.mjs             # dry run: print the plan
//   npm run build && node scripts/release.mjs --publish   # CI only (sdk-release.yml)
//
// The `sdk-v*` tag is the source of truth for the released version; nothing is
// committed back to the default branch, so branch protection stays intact.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(root, "dist/esm/index.js");
const publish = process.argv.includes("--publish");
const TAG_PREFIX = "sdk-v";

const { planRelease, prependChangelog } = await import(entry).catch((err) => {
  console.error(`Cannot load ${relative(root, entry)}; run \`npm run build\` first.\n${err.message}`);
  process.exit(2);
});

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options }).trim();
}

function tryRun(cmd, args) {
  try {
    return run(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const lastTag = tryRun("git", ["describe", "--tags", "--abbrev=0", `--match=${TAG_PREFIX}*`]);
const currentVersion = lastTag ? lastTag.slice(TAG_PREFIX.length) : pkg.version;

// %x1f separates hash from message, %x1e separates commits. `-- .` limits the
// history to commits that touched this package.
const log = run("git", ["log", "--format=%H%x1f%B%x1e", ...(lastTag ? [`${lastTag}..HEAD`] : []), "--", "."]);
const commits = log
  .split("\x1e")
  .map((chunk) => chunk.trim())
  .filter(Boolean)
  .map((chunk) => {
    const [hash, message = ""] = chunk.split("\x1f");
    return { hash, message };
  });

const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
const repositoryUrl = process.env.GITHUB_REPOSITORY ? `${server}/${process.env.GITHUB_REPOSITORY}` : undefined;
const plan = planRelease(currentVersion, commits, { tagPrefix: TAG_PREFIX, repositoryUrl });

console.log(`Last release: ${lastTag ?? `(none; using package.json ${pkg.version})`}`);
console.log(`Commits considered: ${commits.length}`);

if (!plan) {
  console.log("No feat, fix, perf, revert or breaking commits since the last release; nothing to publish.");
  output("released", "false");
  process.exit(0);
}

console.log(`Next release: ${plan.nextVersion} (${plan.releaseType}) -> ${plan.tag}\n\n${plan.notes}`);

if (!publish) {
  console.log("Dry run. Pass --publish to version, publish, tag and create the GitHub Release.");
  process.exit(0);
}

// Without a baseline tag the whole package history (including the commit that
// produced the current version) would be counted again.
if (!lastTag) {
  console.error(
    `No ${TAG_PREFIX}* tag found. Seed one at the commit that released ${pkg.version} first:\n` +
      `  git tag -a ${TAG_PREFIX}${pkg.version} <commit> -m "Release ${pkg.version}" && git push origin ${TAG_PREFIX}${pkg.version}`
  );
  process.exit(1);
}

// Version + changelog live in the published tarball and the GitHub Release.
pkg.version = plan.nextVersion;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
const changelogPath = join(root, "CHANGELOG.md");
writeFileSync(changelogPath, prependChangelog(readFileSync(changelogPath, "utf8"), plan.notes));

// Idempotent on retry: a version already on npm is not republished, but the
// tag and GitHub Release are still created if an earlier run stopped short.
if (tryRun("npm", ["view", `${pkg.name}@${plan.nextVersion}`, "version"]) === plan.nextVersion) {
  console.log(`${pkg.name}@${plan.nextVersion} is already on npm; skipping publish.`);
} else {
  run("npm", ["publish", "--provenance", "--access", "public"], { stdio: "inherit" });
}

run("git", ["tag", "-a", plan.tag, "-m", `Release ${pkg.name} ${plan.nextVersion}`]);
run("git", ["push", "origin", `refs/tags/${plan.tag}`], { stdio: "inherit" });

const notesFile = join(mkdtempSync(join(tmpdir(), "sdk-release-")), "notes.md");
writeFileSync(notesFile, plan.notes);
run("gh", ["release", "create", plan.tag, "--title", `${pkg.name} ${plan.nextVersion}`, "--notes-file", notesFile], {
  stdio: "inherit",
});

output("released", "true");
output("version", plan.nextVersion);
output("tag", plan.tag);
