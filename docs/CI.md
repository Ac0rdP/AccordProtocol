# Continuous Integration

This document is the map of Accord Protocol's GitHub Actions setup: what each
workflow does, how runs are cached and deduplicated, and which repository
settings the release and preview workflows expect.

For how to run any suite locally, see [CONTRIBUTING.md](../CONTRIBUTING.md) →
*Testing and quality gates*.

## Workflow map

| Workflow | File | Triggers | Purpose |
| --- | --- | --- | --- |
| Smart Contract — Build & CI | `.github/workflows/contract.yml` | push to `main`/`v*` tags, PRs | Builds the Soroban contract, runs the weight-fixture and RBAC suites, reports committed test snapshot drift (advisory artifact), enforces coverage and resource-benchmark gates, and (on push/tags) runs the testnet smoke test and weight-invariant gate. |
| Frontend CI & Coverage | `.github/workflows/frontend-ci.yml` | pushes/PRs touching `frontend/**` | Type-check, lint (advisory), unit tests with coverage thresholds, and responsive screenshot comparisons. |
| Frontend Storybook & Visual Regression | `.github/workflows/frontend-storybook.yml` | pushes/PRs touching `frontend/**` | Visual snapshot tests and a Storybook build. |
| Indexer & Analytics CI | `.github/workflows/indexer-analytics.yml` | pushes/PRs touching indexer/analytics paths | Indexer tests against SQLite and Postgres, the analytics test suite, and the analytics API Rust checks (fmt, Clippy, tests). |
| Frontend Preview | `.github/workflows/preview.yml` | `frontend/**` PRs | Builds a seeded frontend preview per PR, publishes it to `gh-pages`, comments the URL, and tears it down on close. |
| Nightly Full Suite | `.github/workflows/nightly.yml` | `schedule` (03:17 UTC), manual | Runs every component suite — including the slower E2E run — and files/updates a single tracked issue on failure. |
| Release | `.github/workflows/release.yml` | `v*` tags, manual | Gates on all suites, builds the contract artifact + manifest, publishes the SDK to GitHub Packages, and creates a GitHub Release with generated notes. |

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
