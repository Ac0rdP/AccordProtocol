# Continuous Integration

This document is the map of Accord Protocol's GitHub Actions setup: what each
workflow does, how runs are cached and deduplicated, and which repository
settings the release and preview workflows expect.

For how to run any suite locally, see [CONTRIBUTING.md](../CONTRIBUTING.md) →
*Testing and quality gates*.

## Workflow map

| Workflow | File | Triggers | Purpose |
| --- | --- | --- | --- |
| Smart Contract — Build & CI | `.github/workflows/contract.yml` | push to `main`/`v*` tags, PRs | Builds the Soroban contract, runs the weight-fixture, RBAC, differential, and spend-window property test suites, enforces coverage and resource-benchmark gates, and (on push/tags) runs the testnet smoke test and weight-invariant gate. |
| Security Checks | `.github/workflows/security.yml` | PRs, pushes to `main` | Runs the tracked-file secret heuristic and Gitleaks over the full git history; any finding fails the job. |
| Malware scan | `.github/workflows/malware-scan.yml` | PRs targeting `main` | Runs a trusted scanner against the pull-request diff and a ClamAV scan over changed files. It blocks download-and-execute payloads, obfuscated code, credential access, install scripts, non-registry dependencies, suspicious binaries, workflow privilege escalation, and Stellar address swaps. |
| Supply-chain policy | `.github/workflows/supply-chain.yml` | PRs, pushes to `main`, PR reviews | Enforces [`SUPPLY_CHAIN_POLICY.md`](SUPPLY_CHAIN_POLICY.md): committed lockfiles, allowed sources, SHA-pinned third-party actions, `--locked`/`npm ci` installs, npm signature/provenance verification, and approving review for any policy exception. |
| Launch checklist | `.github/workflows/launch-checklist.yml` | PRs touching `launch/**` | Validates the structure of the mainnet launch checklist. The strict, signed-off check runs as the `mainnet-checklist` gate in Release (see [`MAINNET_LAUNCH.md`](MAINNET_LAUNCH.md)). |
| Frontend CI & Coverage | `.github/workflows/frontend-ci.yml` | pushes/PRs touching `frontend/**` | Type-check, lint (advisory), unit tests with coverage thresholds, and responsive screenshot comparisons. |
| Frontend Storybook & Visual Regression | `.github/workflows/frontend-storybook.yml` | pushes/PRs touching `frontend/**` | Visual snapshot regression tests covering transaction preview, risk, and error states across themes and viewports, plus Storybook build. |
| Indexer & Analytics CI | `.github/workflows/indexer-analytics.yml` | pushes/PRs touching indexer/analytics paths | Indexer tests against SQLite and Postgres, the analytics test suite, and the analytics API Rust checks (fmt, Clippy, tests). |
| Frontend Preview | `.github/workflows/preview.yml` | `frontend/**` PRs | Builds a seeded frontend preview per PR, publishes it to `gh-pages`, comments the URL, and tears it down on close. |
| Nightly Full Suite | `.github/workflows/nightly.yml` | `schedule` (03:17 UTC), manual | Runs every component suite — including the slower E2E run — and files/updates a single tracked issue on failure. |
| Release | `.github/workflows/release.yml` | `v*` tags, manual | Gates on all suites, builds the contract artifact + manifest, publishes the SDK to GitHub Packages, and creates a GitHub Release with generated notes. |
| Status Page | `.github/workflows/status-page.yml` | `schedule` (every 15 minutes), manual | Probes the `/status` endpoints of the indexer and the analytics API and publishes the public status page when the status changed (see [STATUS.md](STATUS.md)). |
| Reproducible Contract Builds | `.github/workflows/reproducible-builds.yml` | pushes/PRs touching `contracts/**`, tags | Verifies byte-for-byte reproducible WASM artifacts across isolated build passes and supported toolchain versions with least-privilege permissions and failure artifact links. |

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

`release.yml` and `release-notes.yml` need:

- **Least-privilege permissions**: `release.yml` sets `contents: read` at the top level and grants extra scopes per job only where needed:
  - `build-and-attest`: `contents: read`, `id-token: write`, `attestations: write` (keyless OIDC provenance attestation via `actions/attest-build-provenance`)
  - `release`: `contents: write` (creates the GitHub Release and uploads attested assets)
  - `publish-sdk`: `contents: read`, `packages: write` (publishes `@<owner>/accord-sdk` to GitHub Packages)
- **No extra secrets**: signing uses keyless OIDC (`id-token: write`), and release/package publishing use the built-in `GITHUB_TOKEN`.
- **Dry-run mode**: `workflow_dispatch` on `release.yml` exposes `dry_run` (default `true`) to validate contract/frontend builds, `SHA256SUMS.txt` generation, and `scripts/verify-release.sh` without attesting or publishing.
- **Owner & rollback/disable**: Owned by Release Engineering / Maintainers. To disable releases in an emergency, run `gh workflow disable "Release"` and delete any bad release/tag as described below.

### Automated release notes & dry run

Automated release notes are generated using GitHub's built-in categorizer configured
in [`.github/release.yml`](../.github/release.yml) and the custom categorization script
`scripts/generate-release-notes.py`.

- **Labels recognized**:
  - `breaking`, `breaking-change` → 💥 Breaking Changes
  - `security`, `vulnerability` → 🔒 Security
  - `contract`, `soroban` → 📜 Smart Contract
  - `feat`, `feature`, `enhancement` → 🚀 New Features
  - `bug`, `fix`, `bugfix` → 🐛 Bug Fixes
  - `frontend`, `ui` → 🖥️ Frontend
  - `ci`, `infrastructure`, `devops`, `workflow` → 🔧 CI & Infrastructure
  - `docs`, `documentation` → 📚 Documentation
  - `test`, `testing` → 🧪 Testing
  - `perf`, `performance`, `optimization` → ⚡ Performance
  - `chore`, `maintenance`, `refactor`, `dependencies`, `build`, `style` → 🏗️ Maintenance
  - Unlabeled / other → 🔀 Other Changes
- **Dry run**: To preview release notes without publishing a release:
  1. Go to **Actions** → **Release Notes** (`.github/workflows/release-notes.yml`).
  2. Click **Run workflow**.
  3. Specify the target `tag` (optional) and keep `dry_run: true`.
  4. View the generated notes directly in the GitHub Actions step summary or download
     the `release-notes-preview` artifact.
- **Rollback steps (deleting or editing a bad release and re-running)**:
  1. Delete the incorrect GitHub release via `gh release delete <tag> --yes` or in the GitHub Releases UI.
  2. If the tag was pushed incorrectly, delete the tag locally and remotely:
     `git tag -d <tag> && git push origin :refs/tags/<tag>`.
  3. If release notes contained incorrect categorizations or entries, correct the PR labels or commit metadata.
  4. Re-run `.github/workflows/release-notes.yml` (with `dry_run: false` or publish via tag push) to regenerate.

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

Make the **Malware scan** and **ClamAV scan** jobs required status checks in
branch protection, alongside the existing Security and Supply-chain jobs.

## Reproducible contract builds

`reproducible-builds.yml` verifies byte-for-byte reproducibility of the compiled
Soroban contract WASM (`target/wasm32v1-none/release/accord.wasm`). It runs on
every push to `main`, version tags, and pull requests affecting contract sources
or toolchain manifests.

### Guarantees and verification model

1. Two clean, isolated compilation passes are executed in independent environments.
2. The SHA-256 digests of the resulting WASM binaries are computed and compared.
3. The build is declared valid only when both passes produce identical byte sequences.
4. The verification script (`scripts/verify-reproducible-build.sh`) supports local
   and CI execution, including dry-run validation (`DRY_RUN=1`).

```bash
# Run local verification
bash scripts/verify-reproducible-build.sh

# Dry-run validation of the environment
DRY_RUN=1 bash scripts/verify-reproducible-build.sh
```

### Permissions, settings and secrets

- **Workflow permissions**: Configured with strict least privilege:
  ```yaml
  permissions:
    contents: read
  ```
- **Secrets**: Requires zero secrets. The workflow uses only standard GitHub Actions
  runners and public toolchain registries.
- **Actions pinning**: Third-party actions follow `SUPPLY_CHAIN_POLICY.md` and are
  strictly pinned.

### Failure reporting and artifacts

When a divergence occurs:
- The job outputs an error annotation containing direct links to the affected run
  and artifact report:
  `${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}#artifacts`.
- Detailed status and mismatch diagnostics are written to
  `target/reproducible-build/failure-report.txt` and uploaded as an artifact with
  30-day retention.
- An issue summary is appended to `$GITHUB_STEP_SUMMARY`.

### Rollback steps

If a bytecode mismatch or unreproducible release build is detected:
1. **Halt Deployment**: Reject pending upgrade proposals or deployments referencing
   the mismatched WASM hash.
2. **Quarantine Commit**: Mark the offending commit/tag in `quarantine.json` or
   block promotion in release gating.
3. **Audit Toolchains & Dependencies**: Verify compiler and toolchain versions:
   `rustc --version --verbose`, `stellar --version`, and `cargo metadata --locked`.
   Check whether upstream dependency versions shifted in untracked files or transient
   dependencies.
4. **Revert and Re-tag**: Revert the commit on `main` and redeploy using the last
   verified reproducible release WASM digest.

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

The contract workflow (`contract.yml`) still runs on every pull request, but
its build, coverage, benchmark, snapshot, and upgrade-detection jobs are
advisory: they report results without blocking a merge. `Testnet Upgrade
Simulation` only runs when the upgrade-path detector marks a pull request as
relevant, and GitHub treats a skipped job as passing.

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
      "Exception changes need an approving review"
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

## CI Time and Cost Budgets

Workflow durations and runner resource costs are monitored and budgeted via
`.github/workflows/ci-budgets.yml` using the central configuration file
[`.github/ci-budgets.json`](../.github/ci-budgets.json).

### Configuration & Runner Rates
- **Thresholds**: Each workflow job defines a `warn_minutes` (soft breach reported as warning)
  and a `fail_minutes` (hard breach failing the check).
- **Runner Rates**: Per-minute billing rates are configured under `rates_per_minute_usd`
  in `.github/ci-budgets.json` (e.g. `ubuntu-latest`: $0.008/min, `macos-latest`: $0.080/min).
  > [!NOTE]
  > Runner cost rates are configurable assumptions and must be checked against GitHub's
  > active billing documentation. Public repositories frequently receive free standard GitHub-hosted
  > runners ($0.00/min).

### Required Settings & Permissions
- **Workflow permissions**: Requires `actions: read` and `contents: read`.
- **Secrets**: No custom secrets required; uses the standard `GITHUB_TOKEN`.
- **Self-trigger prevention**: The budget workflow triggers on `workflow_run` of other suites
  and explicitly avoids monitoring itself to prevent infinite execution loops.

### Changing Budgets
To adjust a job's time limit or update cost assumptions:
1. Open `.github/ci-budgets.json`.
2. Locate the job entry under `"jobs"` (e.g., `"Contract CI"` or `"Mutation Testing (cargo-mutants)"`).
3. Update `warn_minutes` or `fail_minutes` with appropriate headroom for runner variance.
4. Commit the change in a pull request.

### Rollback & Emergency Disable
If the budget check causes false-positive failures during runner degradation or outage:
1. **Quick Disable**: Disable the workflow via GitHub CLI or UI:
   ```bash
   gh workflow disable "CI Time and Cost Budgets"
   ```
2. **Raise Thresholds**: Temporarily increase `fail_minutes` in `.github/ci-budgets.json`
   to permit in-flight work.
3. Re-enable the workflow once provider speeds normalize:
   ```bash
   gh workflow enable "CI Time and Cost Budgets"
   ```

## Canary contract release & rollback

Contract upgrades follow a staged canary release and manual promotion workflow in [`.github/workflows/canary-release.yml`](../.github/workflows/canary-release.yml), backed by [`scripts/canary-release-gate.mjs`](../scripts/canary-release-gate.mjs) and [`scripts/canary-release-gate.test.mjs`](../scripts/canary-release-gate.test.mjs).

### Upgrade & rollback model

Accord implements in-place WASM upgrades via `upgrade(approvers, new_wasm_hash)` in `contracts/accord/src/lib.rs`, preserving contract ID and persistent state. Rollback therefore reverts the contract in-place to the previous verified WASM hash (unless a flawed release altered persistent storage schema — see [`docs/runbooks/UPGRADE_ROLLBACK.md`](./runbooks/UPGRADE_ROLLBACK.md) Step 4.2). **Rollback is never automatic** to avoid worsening partial state changes.

### Stages & gates

1. **Stage 1 (`build-and-hash`)**: Runs `scripts/canary-release-gate.test.mjs`, runs `cargo test --locked -p accord invariants`, runs `scripts/verify-reproducible-build.sh`, and records the built WASM SHA-256 hash into `canary-manifest.json`.
2. **Stage 2 (`canary-gate`, Environment: `canary`)**: Verifies that:
   - `deployed_wasm_hash` matches the Stage 1 `built_hash` exactly (prevents promoting an untested binary).
   - Both the canary Indexer (`GET <CANARY_INDEXER_STATUS_URL>/status`) and Analytics API (`GET <CANARY_ANALYTICS_API_STATUS_URL>/status`) return HTTP 200, `status: "operational"`, all dependency checks `ok: true`, and a fresh `updatedAt` timestamp (<= 300s old, preventing stale-endpoint false passes).
   - Core contract invariants from [`docs/INVARIANTS.md`](./INVARIANTS.md) hold (`INV-01` total weight == sum of owner weights, `INV-02` `1 <= threshold <= total_weight`, `INV-03` `1 <= owners <= 20`, `INV-08` `active_proposals <= 50`, and `version`/`storage_version >= 1`).
3. **Stage 3 (`prepare-production-promotion`, Environment: `production-promotion`)**: Runs **only** on manual `workflow_dispatch` with `action: promote` after required reviewers approve the protected environment. Following [`docs/OPERATIONS.md`](./OPERATIONS.md#hsm-and-mpc-signer-integration-runbook), **no production owner private keys exist in GitHub secrets**; Stage 3 outputs an unsigned `production-promotion-bundle.json` artifact for out-of-band HSM/MPC owner co-signing.
4. **Rollback (`prepare-rollback-plan`, Environment: `production-rollback`)**: Runs on manual `workflow_dispatch` with `action: rollback-plan`, selects the latest verified prior WASM hash via `scripts/canary-release-gate.mjs rollback-plan`, and outputs an unsigned rollback + optional `freeze` containment plan.

### Required repository settings, environments & variables

| Setting | Type | Purpose |
| --- | --- | --- |
| `canary` | GitHub Environment | Isolates testnet canary verification variables |
| `production-promotion` | Protected GitHub Environment | **Must configure required reviewers** before enabling mainnet promotion |
| `production-rollback` | Protected GitHub Environment | **Must configure required reviewers** for rollback plan approval |
| `CANARY_CONTRACT_ID` | Environment / Repo Variable | Testnet canary contract ID (e.g. `CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS`) |
| `CANARY_INDEXER_STATUS_URL` | Environment / Repo Variable | Base URL of the canary indexer status endpoint |
| `CANARY_ANALYTICS_API_STATUS_URL` | Environment / Repo Variable | Base URL of the canary analytics API status endpoint |
| `PRODUCTION_CONTRACT_ID` | Environment / Repo Variable | Mainnet Accord contract ID (once deployed) |

- **Secrets**: None required for production signing (production owner keys stay strictly in HSM/MPC custody).
- **Permissions**: Top-level `permissions: {}`; every job uses `contents: read` only.
- **Dry run**: Dispatch `Canary Contract Release` with `dry_run: true` (the default) to validate build tooling, unit tests, gate evaluation, and rollback planning without touching any network.

## Status-page incident automation

Automated incident creation, updates, and resolution from Indexer and Analytics API health checks run via [`.github/workflows/status-incident-automation.yml`](../.github/workflows/status-incident-automation.yml), backed by [`scripts/status-incident-automation.mjs`](../scripts/status-incident-automation.mjs) and [`scripts/status-incident-automation.test.mjs`](../scripts/status-incident-automation.test.mjs).

### Provider & state model

- **Default provider (`repo-status-page`)**: The repository does not configure a third-party hosted status-page SaaS. By default, automation manages incidents in `docs/status/incidents.json` (rendered into `docs/status/index.html` by `scripts/status-page.mjs render`) and persists consecutive failure/success counters in `docs/status/incident-automation-state.json`.
- **External provider adapter**: Passing `--provider=external` (or setting `STATUS_PAGE_PROVIDER` to an external provider name) routes through `createExternalProviderAdapter`, which **fails loudly** until a real provider adapter and `STATUS_PAGE_API_TOKEN` / `STATUS_PAGE_ID` are configured.
- **Component isolation & deduplication**: `indexer` and `analytics-api` are evaluated independently (partial outages open an incident only for the failing component). Open automated incidents are matched by a stable marker (`accord-auto:<componentId>`) so repeated runs update the existing incident rather than creating duplicates.
- **Anti-flapping thresholds**:
  - `INCIDENT_FAILURE_THRESHOLD` (default `3` consecutive failed runs) before opening an incident.
  - `INCIDENT_RECOVERY_THRESHOLD` (default `2` consecutive healthy runs) before resolving an open incident.
  - Transient probe retries (`2` retries per run) before counting a probe as failed.

### Required repository settings, variables & secrets

| Name | Kind | Purpose |
| --- | --- | --- |
| `INDEXER_STATUS_URL` | Repo Variable | Base URL of the Indexer `/status` endpoint (never logged) |
| `ANALYTICS_API_STATUS_URL` | Repo Variable | Base URL of the Analytics API `/status` endpoint (never logged) |
| `INCIDENT_FAILURE_THRESHOLD` | Repo Variable (optional) | Consecutive failures to open an incident (default `3`) |
| `INCIDENT_RECOVERY_THRESHOLD` | Repo Variable (optional) | Consecutive successes to resolve an incident (default `2`) |
| `STATUS_PAGE_PROVIDER` | Repo Variable (optional) | `repo-status-page` (default) or an implemented external provider |
| `STATUS_PAGE_ID` | Repo Variable (external only) | External status page ID |
| `STATUS_PAGE_API_TOKEN` | Repo Secret (external only) | External status page API token (never printed) |

- **Permissions**: Top-level `permissions: {}`; `evaluate` uses `contents: read`; `publish` uses `contents: write` only when publishing non-dry-run `repo-status-page` updates.
- **Scheduled workflow caveat**: GitHub Actions `schedule` triggers can be delayed during platform load and are automatically disabled after 60 days of repository inactivity. A failing `Status Page Incident Automation` workflow run indicates a monitoring or configuration failure, **not** necessarily a service outage; inspect the uploaded `status-incident-automation-report` artifact and workflow summary link.

### Rollback & emergency disable

If automated incident management misbehaves or creates false-positive incidents:

1. **Disable the workflow immediately**:
   ```bash
   gh workflow disable "Status Page Incident Automation"
   ```
2. **Manually resolve any false-positive incident**: Edit `docs/status/incidents.json` to set `"status": "resolved"`, set `"resolvedAt"` to the current UTC ISO-8601 timestamp, and append a clarifying update note.
3. **Re-render and commit**:
   ```bash
   node scripts/status-page.mjs render
   git add docs/status/incidents.json docs/status/index.html
   git commit -m "chore(status): manually resolve false-positive automated incident"
   ```
4. Re-enable the workflow once the root cause is fixed:
   ```bash
   gh workflow enable "Status Page Incident Automation"
   ```

