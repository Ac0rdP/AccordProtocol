#!/usr/bin/env node

// Guards the merge-gate configuration against regressions that have already
// blocked pull requests once. Runs in the required supply-chain "Pinning
// policy" job, so a regression fails the same check that protects `main`.

import { existsSync, readFileSync } from "node:fs";

const failures = [];

function read(path) {
  return readFileSync(path, "utf8");
}

function expect(condition, message) {
  if (!condition) failures.push(message);
}

// 1. Dependabot must stay disabled. Dependabot reads this file from the
//    default branch and reopens scheduled version-update PRs as soon as it
//    exists again.
expect(
  !existsSync(".github/dependabot.yml"),
  ".github/dependabot.yml is back. Dependency updates are manual; remove the file (see docs/CI.md#dependency-updates).",
);

// 2. Fork pull requests must remain scannable. actions/checkout refuses to
//    check out a fork PR in a pull_request_target workflow unless the two
//    PR-head checkouts opt in. Without this the required Malware scan and
//    ClamAV jobs fail for every contributor fork.
const malwareScan = read(".github/workflows/malware-scan.yml");
const forkCheckouts = malwareScan.match(
  /repository:\s*\$\{\{\s*github\.event\.pull_request\.head\.repo\.full_name\s*\}\}/g,
);
const unsafeOptIns = malwareScan.match(/allow-unsafe-pr-checkout:\s*true/g);
expect(
  (forkCheckouts?.length ?? 0) === (unsafeOptIns?.length ?? 0) &&
    (forkCheckouts?.length ?? 0) >= 2,
  "malware-scan.yml must set allow-unsafe-pr-checkout: true on every fork PR checkout, or fork PRs cannot be scanned.",
);

// 3. lychee-action treats `--output` in args and its `output` input as a
//    conflict and exits before checking a single link.
const docsWorkflow = read(".github/workflows/docs.yml");
expect(
  docsWorkflow.includes("output: lychee-report.md") &&
    !/--output\s+lychee-report\.md/.test(docsWorkflow),
  "docs.yml must use the lychee-action `output` input, not `--output` inside args.",
);

if (failures.length > 0) {
  for (const failure of failures) console.error(`CI guardrail: ${failure}`);
  process.exit(1);
}

console.log("CI guardrails OK (Dependabot off, fork checkout opt-in, lychee output).");
