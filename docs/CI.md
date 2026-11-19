# Continuous Integration

This document is the map of Accord Protocol's GitHub Actions setup: what each
workflow does, how runs are cached and deduplicated, and which repository
settings the release and preview workflows expect.

For how to run any suite locally, see [CONTRIBUTING.md](../CONTRIBUTING.md) →
*Testing and quality gates*.

## Workflow map

| Workflow | File | Triggers | Purpose |
| --- | --- | --- | --- |
| Smart Contract — Build & CI | `.github/workflows/contract.yml` | push to `main`/`v*` tags, PRs | Builds the Soroban contract, runs the weight-fixture and RBAC suites, enforces coverage and resource-benchmark gates, and (on push/tags) runs the testnet smoke test and weight-invariant gate. |
| Security Checks | `.github/workflows/security.yml` | PRs, pushes to `main` | Runs the tracked-file secret heuristic and Gitleaks over the full git history; any finding fails the job. |
| Malware scan | `.github/workflows/malware-scan.yml` | PRs targeting `main` | Runs a trusted scanner against the pull-request diff and a ClamAV scan over changed files. It blocks download-and-execute payloads, obfuscated code, credential access, install scripts, non-registry dependencies, suspicious binaries, workflow privilege escalation, and Stellar address swaps. |
| Supply-chain policy | `.github/workflows/supply-chain.yml` | PRs, pushes to `main`, PR reviews | Enforces [`SUPPLY_CHAIN_POLICY.md`](SUPPLY_CHAIN_POLICY.md): committed lockfiles, allowed sources, SHA-pinned third-party actions, `--locked`/`npm ci` installs, npm signature/provenance verification, and approving review for any policy exception. |
| Launch checklist | `.github/workflows/launch-checklist.yml` | PRs touching `launch/**` | Validates the structure of the mainnet launch checklist. The strict, signed-off check runs as the `mainnet-checklist` gate in Release (see [`MAINNET_LAUNCH.md`](MAINNET_LAUNCH.md)). |
| Frontend CI & Coverage | `.github/workflows/frontend-ci.yml` | pushes/PRs touching `frontend/**` | Type-check, lint (advisory), unit tests with coverage thresholds, and responsive screenshot comparisons. |
| Frontend Storybook & Visual Regression | `.github/workflows/frontend-storybook.yml` | pushes/PRs touching `frontend/**` | Visual snapshot tests and a Storybook build. |
| Indexer & Analytics CI | `.github/workflows/indexer-analytics.yml` | pushes/PRs touching indexer/analytics paths | Indexer tests against SQLite and Postgres, the analytics test suite, and the analytics API Rust checks (fmt, Clippy, tests). |
| Frontend Preview | `.github/workflows/preview.yml` | `frontend/**` PRs | Builds a seeded frontend preview per PR, publishes it to `gh-pages`, comments the URL, and tears it down on close. |
| Nightly Full Suite | `.github/workflows/nightly.yml` | `schedule` (03:17 UTC), manual | Runs every component suite — including the slower E2E run — and files/updates a single tracked issue on failure. |
| Release | `.github/workflows/release.yml` | `v*` tags, manual | Gates on all suites, builds the contract artifact + manifest, publishes the SDK to GitHub Packages, and creates a GitHub Release with generated notes. |
| Status Page | `.github/workflows/status-page.yml` | `schedule` (every 15 minutes), manual | Probes the `/status` endpoints of the indexer and the analytics API and publishes the public status page when the status changed (see [STATUS.md](STATUS.md)). |

## Testnet upgrade simulation

`contract.yml` includes a `Testnet Upgrade Simulation` job that runs on pull
requests touching `contracts/accord/**`, the workspace manifests, the simulation
script, or the contract workflow itself. It:

1. Builds a legacy-shaped contract with the `legacy-fixture` cargo feature, so
   `initialize` leaves the governance-migration flag and storage-schema marker
   absent.
2. Deploys that build to testnet using an ephemeral Friendbot-funded identity.
3. Adds two owners and creates a partially-unapproved in-flight proposal.
4. Uploads the PR build and upgrades the same contract ID in place.
5. Runs `migrate_to_weighted_governance`.
6. Verifies owner set, weights, total weight, threshold, storage-schema version,
   proposal count, and the in-flight proposal before approving/revoking it.

No repository secrets are required: the identity is generated per run and
removed in an exit trap. The contract itself is left isolated on testnet
(Soroban has no contract-delete operation) and holds no funds. The job uploads
`target/testnet-upgrade-simulation/` as an artifact with the full check report.

Run it locally with the Stellar CLI and the `wasm32v1-none` Rust target:

```bash
bash scripts/testnet-upgrade-simulation.sh
```

See [DEPLOYMENT.md](./DEPLOYMENT.md#automated-testnet-upgrade-simulation) for
the operator-facing description and cleanup notes.

## Concurrency and cancellation

Every workflow sets a `concurrency` group keyed on the workflow and ref, with
`cancel-in-progress` enabled for pull requests. A new push to a PR branch
therefore cancels the superseded run instead of queueing behind it, while pushes
to `main`, tag runs, and nightly runs are never cancelled mid-flight.

The Release workflow uses a per-tag group with `cancel-in-progress: false` so a
partially published release can never be interrupted.

## Caching

| Ecosystem | Mechanism | Key material |
| --- | --- | --- |
| Rust | `actions-rust-lang/setup-rust-toolchain` (`cache: true`) and `Swatinem/rust-cache` | `Cargo.lock` |
| npm | `actions/setup-node` (`cache: npm`) | the relevant `package-lock.json` |
| Playwright browsers | `actions/cache` (`~/.cache/ms-playwright`) | `frontend/package-lock.json` |

Cache keys derive from the lockfiles, so a dependency change invalidates the
cache automatically. These caches remove the repeated compile and download work
that dominated cold runs; expect the largest wins on the Rust jobs, where the
crates.io registry and `target/` are restored between runs.

## Nightly failures

`nightly.yml` names each job after the component it owns (`Contract`, `Frontend`,
`Indexer`, `Analytics API`, `E2E`), so a failing job is attributed in the run
summary. A final job runs when any component fails and opens — or updates a
single open issue marked with `<!-- accord-nightly-failure -->`, listing the
failing components and linking the run. This keeps the maintainer notified
without a new issue every night.

## Release settings

`release.yml` needs:

- **Actions → General → Workflow permissions**: read and write, so the run can
  create a release and publish to GitHub Packages.
- No extra secrets: the SDK is published to GitHub Packages with the built-in
  `GITHUB_TOKEN`. The published package name is scoped to the repository owner
  (`@<owner>/accord-sdk`).

Cut a release by following the *Release process* section of
[CONTRIBUTING.md](../CONTRIBUTING.md), then push an annotated `v*` tag.

## Preview settings

`preview.yml` needs:

- **Settings → Pages → Build and deployment → Deploy from a branch** with the
  `gh-pages` branch and the `/ (root)` folder selected.
- Optional repository variable **`PREVIEW_BASE_URL`** to override the computed
  base URL when the site uses a custom domain.

Previews are built from the committed sample dataset
(`scripts/sample-analytics-data.json`) via `scripts/seed-preview.mjs`; the build
receives no secrets, and only pull requests whose branch lives in this
repository are deployed (fork PRs get a read-only token and are skipped).

## Malware scan

`malware-scan.yml` uses `pull_request_target` so the workflow and scanner are
always loaded from the base branch: a pull request cannot edit the check that
is evaluating it. The job never runs pull-request code. It checks out the
contribution with `persist-credentials: false`, reads changed files through Git
objects, and runs with a read-only token.

High-severity findings fail the job and are reported as annotations on the
diff. Medium findings are warnings. Add a reviewed exception to
`.github/malware-scan-allowlist.json` only after deciding the finding is a
false positive; because the allowlist is read from the base branch, the
exception must be merged separately before it applies to a pull request.
Changes to `malware-scan.mjs` itself are reported as a high-severity
security-control change, so scanner updates need the same separate review.

The scanner is dependency-free and can be run locally:

```bash
node .github/scripts/malware-scan.mjs \
  --repo . \
  --base origin/main \
  --head HEAD
```

## Required status checks

`main` is protected: a pull request cannot be merged unless every required
status check passes and the branch is up to date with `main`. No one,
including administrators, can bypass the checks, force-push `main`, or delete
it. The required checks are the jobs that run on **every** pull request,
regardless of which paths it touches:

| Required check | Workflow |
| --- | --- |
| Secret heuristic scan | `security.yml` |
| Security and SSO control tests | `security.yml` |
| Gitleaks secret scan | `security.yml` |
| Malware scan | `malware-scan.yml` |
| ClamAV scan | `malware-scan.yml` |
| Pinning policy | `supply-chain.yml` |
| npm provenance (frontend) | `supply-chain.yml` |
| npm provenance (indexer) | `supply-chain.yml` |
| Cargo sources and lockfile | `supply-chain.yml` |
| Exception changes need an approving review | `supply-chain.yml` |
| Contract CI | `contract.yml` |
| Contract Snapshot Verification | `contract.yml` |
| Contract Coverage | `contract.yml` |
| Contract Benchmarks | `contract.yml` |
| Detect testnet upgrade paths | `contract.yml` |

`Testnet Upgrade Simulation` is intentionally not required: it only runs when
the upgrade-path detector marks a pull request as relevant, and GitHub treats a
skipped job as passing.

`Docs build & link validation` is also not required while the lychee action's
`output` configuration is being fixed; the documentation build still runs and
reports on every pull request.

Path-filtered workflows (`frontend-ci.yml`, `frontend-storybook.yml`,
`indexer-analytics.yml`, `launch-checklist.yml`, `sbom.yml`, `pages.yml`,
`preview.yml`) are **not** required checks. A path filter prevents the workflow
from starting on unrelated pull requests, and a required check that never runs
leaves the pull request permanently "Expected — waiting for status to be
reported". They still run and report normally whenever their paths change; use
the release gates or a follow-up aggregator workflow if they must block merges
unconditionally.

`scripts/check-ci-guards.mjs` runs in the required **Pinning policy** job and
fails if a change reintroduces a gate regression that has blocked pull requests
before: a `.github/dependabot.yml` file, a fork pull-request checkout in
`malware-scan.yml` without `allow-unsafe-pr-checkout: true`, or a lychee
`--output` argument in `docs.yml` that conflicts with the action input.

Apply the protection with the GitHub CLI (run as a repository administrator):

```bash
gh api -X PUT repos/Ac0rdP/AccordProtocol/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "Secret heuristic scan",
      "Security and SSO control tests",
      "Gitleaks secret scan",
      "Malware scan",
      "ClamAV scan",
      "Pinning policy",
      "npm provenance (frontend)",
      "npm provenance (indexer)",
      "Cargo sources and lockfile",
      "Exception changes need an approving review",
      "Contract CI",
      "Contract Snapshot Verification",
      "Contract Coverage",
      "Contract Benchmarks",
      "Detect testnet upgrade paths"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
```

## Dependency updates

Dependabot version updates are disabled: the repository has no
`.github/dependabot.yml` and Dependabot security updates are off in repository
settings. Dependency upgrades are opened manually as pull requests and must pass
the required checks above plus the supply-chain workflow before merge.
