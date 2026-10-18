# Contributing to Accord Protocol

Thank you for your interest in improving Accord. This document is the **authoritative contributor guide** for this repository: how to set up your environment, how we expect changes to be proposed and reviewed, and how to work effectively with the project’s current **prototype** phase (dummy frontend data plus Soroban contract scaffold).

Please read the [README](./README.md) first for product context, architecture, and security expectations.

---

## Table of contents

1. [Code of conduct and collaboration](#code-of-conduct-and-collaboration)
2. [Ways you can contribute](#ways-you-can-contribute)
3. [Development setup](#development-setup)
4. [Repository layout and boundaries](#repository-layout-and-boundaries)
5. [Finding work and program participation](#finding-work-and-program-participation)
6. [Contribution workflow](#contribution-workflow)
7. [Branching, commits, and pull requests](#branching-commits-and-pull-requests)
8. [Coding standards](#coding-standards)
9. [Testing and quality gates](#testing-and-quality-gates)
10. [Debugging tips](#debugging-tips)
11. [Documentation](#documentation)
12. [Dependency updates](#dependency-updates)
13. [Release process](#release-process)
14. [Security and responsible disclosure](#security-and-responsible-disclosure)
15. [Licensing](#licensing)
16. [Questions and maintainer contact](#questions-and-maintainer-contact)

---

## Code of conduct and collaboration

This project follows the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you agree to uphold its standards.

- **Be respectful and constructive.** Review comments should focus on the change, not the person.
- **Assume good intent** and prefer clear questions over assumptions.
- **Keep discussions on-topic** in issues and pull requests (PRs).

Harassment, discrimination, or abusive behavior are not acceptable. Maintainers may remove disruptive content and, when necessary, block participation to protect contributors.

---

## Ways you can contribute

You do not have to write production Soroban code on day one. Useful contributions include:

| Area | Examples |
|------|----------|
| **Frontend** | UI/UX improvements, accessibility, state handling, new pages or components wired to mock data |
| **Contracts** | Storage design, proposal lifecycle, tests, gas-friendly patterns, error handling |
| **Quality** | Tests, lint fixes, CI suggestions, reproducible bug reports |
| **Documentation** | README clarifications, diagrams, deployment notes, contributor onboarding |
| **Reviews** | Thoughtful PR reviews that catch edge cases, naming issues, or missing tests |

Small, focused PRs are easier to review and merge than large refactors bundled with unrelated changes.

---

## Development setup

### Required tools (summary)

| Tool | Purpose |
|------|---------|
| **Git** | Version control |
| **Node.js** (LTS recommended) | Frontend (`frontend/`) |
| **Rust** + `wasm32v1-none` (Soroban WASM target) | Soroban contracts |
| **Stellar CLI** (`stellar`) | Build and test contracts from the repo root |

### Rust and Soroban

```bash
# Install Rust (if needed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# WASM target for Soroban (see Stellar CLI / Soroban docs if this changes)
rustup target add wasm32v1-none
```

Install the Stellar CLI as described in the [README](./README.md) (or the [official Stellar docs](https://developers.stellar.org/docs/build/smart-contracts/getting-started/setup)).

From the **repository root**:

```bash
stellar contract build
stellar contract test
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Other useful commands:

```bash
npm run build   # Typecheck + production build
npm run lint    # ESLint
```

### Testnet XLM and your deployer account (no browser wallet required)

On Stellar, transactions (including contract deploy) pay a **small fee in XLM**. On **testnet**, that XLM is **free play money** with no real value. You do **not** need Freighter or another browser extension to deploy from the CLI: you only need a **keypair** (an “identity” in Stellar CLI) that holds a little **testnet XLM**.

**1. Create a local deployer identity (this *is* your “wallet” for the CLI)**

```bash
stellar keys generate accord-deployer
stellar keys public-key accord-deployer
```

The second command prints your **public key** (starts with `G…`). That account will pay fees when you pass `--source-account accord-deployer` to `stellar contract deploy` and similar commands.

**2. Fund it with testnet XLM**

Try the built-in faucet (uses the configured testnet RPC):

```bash
stellar network use testnet
stellar keys fund accord-deployer --network testnet
```

If that fails or rate-limits, use **Friendbot** in a browser: open  
`https://friendbot.stellar.org/?addr=YOUR_PUBLIC_KEY_HERE`  
(paste your `G…` address). You can also create/fund via **[Stellar Lab](https://lab.stellar.org/)** (account / friendbot tools).

**3. Confirm you are on testnet for deploy commands**

```bash
stellar network use testnet
# or pass --network testnet on each command
```

**4. Deploy (fees come from that same identity)**

```bash
stellar contract deploy \
  --network testnet \
  --source-account accord-deployer \
  --package accord
```

**How this relates to “a wallet”**

| Approach | What pays fees | Typical use |
|----------|----------------|-------------|
| **Stellar CLI identity** | The key you generated (`accord-deployer`) | Building, deploying, `stellar contract invoke` from terminal |
| **Freighter / other wallet** | Account you unlock in the browser | dApps, signing in the UI (your frontend does not use this yet) |

Keep your **secret key / seed phrase private**. For testnet-only keys, treat them as disposable if they leak, but still avoid committing them to git.

### Explorer shows “Unverified build” — what that means

Explorers (for example [Stellar Lab Contract Explorer](https://lab.stellar.org/smart-contracts/contract-explorer)) can show **build verification** only when a **standard chain of evidence** exists between the WASM on-chain and a **public, automated build** with **GitHub Artifact Attestations**. That process is described in **[SEP-0055: Contract Build Verification](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0055.md)** (discussion: [stellar/stellar-protocol#1573](https://github.com/stellar/stellar-protocol/discussions/1573)).

In short, “verified” in the UI usually requires **all** of the following:

1. **Metadata inside the WASM** (embedded at build time), including at least  
   `source_repo=github:OWNER/REPO`  
   and optionally `home_domain=your.domain` (for `stellar.toml` discovery per SEP-1).
2. A **GitHub Actions** workflow that builds the contract, runs **`actions/attest-build-provenance`**, and publishes an attestation tied to the **same WASM hash** that was deployed.
3. Deploying the **WASM produced by that pipeline** (not a one-off local build), so the hash on the ledger matches the attested artifact.

If you deploy from your laptop with `stellar contract deploy` and no attestation pipeline, explorers will typically show **unverified** even though your code is public. That is expected: the UI is not saying your contract is malicious; it means **no attested provenance record** was found.

**Practical options**

| Goal | What to do |
|------|------------|
| **Green “verified” / Build info in Lab** | Add a SEP-55-style **release workflow** (see SEP-0055 example YAML), use `stellar contract build` with `--meta source_repo=github:${{ github.repository }}` (and optional `--meta home_domain=...`), attest the WASM, then **deploy the CI-built WASM** (or wire deploy into CI). Reusable pattern: [stellar-expert/soroban-build-workflow](https://github.com/stellar-expert/soroban-build-workflow). |
| **Trust without explorer badge** | Keep the contract **open source**, tag releases, and document the **WASM hash** and commit; reviewers can rebuild and compare hashes manually. |
| **Embed repo hint only** | You can still pass `--meta` on `stellar contract build` / deploy so the WASM carries `source_repo=...`; explorers may show repo linkage, but **full verification** still depends on GitHub attestations as in SEP-55. |

Stellar’s docs note that even “Build verified” only proves an attested workflow built that WASM — **you still must review the source and logic** before trusting a contract.

---

## Repository layout and boundaries

Understanding where code belongs reduces review churn and merge conflicts.

### Frontend (`frontend/`)

- **`src/types/accord.ts`** — Shared domain types (proposals, owners, stats). Extend these deliberately when the data model grows.
- **`src/data/mockData.ts`** — **Temporary data layer** until Soroban + wallet integration. New UI features should read/write through app state that is ultimately fed from here (or from a future API layer), not scattered magic constants.
- **`src/components/`** — Reusable presentational and small interactive pieces.
- **`src/pages/`** — Route-level or tab-level composition (dashboard, history, etc.).
- **`src/App.tsx`** — Shell: navigation, top-level state, and page switching. Avoid turning it into a dumping ground for feature logic.

**Prototype rule:** Unless an issue explicitly asks for Stellar network integration, avoid adding wallet/SDK dependencies that couple the UI to testnet/mainnet prematurely. Prefer mock-driven flows and clear seams (types + data module) so integration can land in one place later.

### Contracts (`contracts/`)

- The workspace is defined by the root **`Cargo.toml`** (`members = ["contracts/*"]`).
- Today the scaffold lives under **`contracts/accord/`**. Future multisig work may add **`contracts/multisig/`** (or similar); follow existing patterns in `Cargo.toml` and sibling crates when adding packages.

### Do not commit

- **`frontend/node_modules/`** and **`frontend/dist/`** — ignored via `frontend/.gitignore`
- **Rust `target/`** — ignored from the repo root
- Local Stellar/Soroban artifacts (see root `.gitignore`)

---

## Finding work and program participation

### Project roadmap

Check [`ROADMAP.md`](./ROADMAP.md) for an overview of upcoming milestones, targeted features, and acceptance criteria. The roadmap helps you understand what is planned versus already shipped and where your contribution would have the most impact.

### GitHub issues

- Use **open issues** as the primary source of scoped work.
- Prefer issues that have **clear acceptance criteria** (what “done” means, which files or behaviors are in scope).

### Choosing your first issue

If you are new to Accord Protocol, we recommend starting with issues scoped specifically for onboarding:

1. **Look for beginner-friendly tags**:
   - `good first issue`: Scoped to be self-contained and achievable without deep architectural knowledge.
   - `documentation`: Clarifying guides, updating diagrams, writing tutorials, fixing typos.
   - `testing`: Adding edge-case unit tests in Rust or UI tests for frontend components.
   - `frontend-good-first-issue`: UI tweaks, accessibility (a11y) improvements, or styling fixes.
2. **Assess technical scope**:
   - **Frontend / React**: Best if you know TypeScript and Tailwind CSS; starts in `frontend/`.
   - **Soroban Contracts**: Best if you know Rust; starts in `contracts/accord/src/`.
   - **Docs & DevRel**: Best for first-time open-source contributors; located in `docs/`.
3. **Claiming an issue**:
   - Check that the issue is not already assigned to someone else.
   - Leave a comment stating that you want to work on it with a brief 1-2 sentence outline of your proposed approach.
   - Wait for a maintainer to assign the issue to you before submitting code, preventing overlapping work.
4. **Avoid common pitfalls**:
   - Do not bundle unrequested refactorings into a first issue.
   - Keep the scope tightly bounded to the issue's acceptance criteria.

### Stellar Drips Wave

Accord is positioned for participation in **[Stellar Drips Wave](https://drips.network/wave/stellar)**. Program rules can change by season; always follow the **current** official instructions for applying, claiming, or earning rewards.

**General expectations:**

1. **Do not start large work** on an issue that is already assigned or actively being addressed by someone else, unless maintainers invite collaboration.
2. **Comment on the issue** if you plan to pick it up, so effort is not duplicated.
3. If the program requires **application or assignment before coding**, wait for that confirmation.

If an issue is labeled for Wave eligibility, treat the label as informational only until you confirm the latest program rules on the Drips site.

---

## Contribution workflow

1. **Fork** the repository (or gain push access to a contributor fork, if your team uses that model).
2. **Create a branch** from `main` (or the branch the maintainers designate as default).
3. **Implement the smallest change** that satisfies the issue, with tests where applicable.
4. **Run local checks** (see [Testing and quality gates](#testing-and-quality-gates)).
5. **Open a pull request** into the default branch with a clear title and description.
6. **Respond to review feedback** in a timely way; it is normal to go through several review rounds.
7. **After your PR merges**, clean up and move on (see below).

If you discover that an issue is **wrongly scoped** or **blocked**, comment on the issue early rather than investing days of work in the wrong direction.

### What happens after you open a PR

Once your pull request is open, automated CI workflows trigger immediately to test and lint your code. Review comments appear directly on the PR in GitHub — on specific lines of code, on the overall diff, or as general discussion. Subscribe to email notifications for the PR so you do not miss feedback.

### Review process and SLAs

We value your time and aim to keep review cycles predictable and transparent. Our maintainer team commits to the following Service Level Agreements (SLAs):

| Review Stage | Expected Turnaround | Description |
|---|---|---|
| **Initial Triage** | **Within 24–48 hours** | PR is acknowledged, labeled, and assigned a reviewer. Basic CI status is verified. |
| **First In-Depth Review** | **Within 3 business days (72 hours)** | Detailed line-by-line feedback, architecture review, and test validation. |
| **Follow-up Reviews** | **Within 2 business days (48 hours)** | Re-review after contributor pushes requested changes or answers questions. |
| **Final Merge** | **Within 24 hours of approval** | Once all reviews are approved and CI passes, a maintainer squashes or merges the PR. |

**Review stages:**
1. **Automated CI**: GitHub Actions runs contract tests, lints, and builds automatically. PRs with failing CI will not be reviewed until green.
2. **Peer Review**: Verification of code style, component modularity, and test coverage.
3. **Architecture & Security**: For contract changes (`contracts/accord`), security invariants and storage costs are reviewed by a core maintainer.
4. **Approval & Merge**: The PR is merged into `main` and credited in the changelog.

**Escalation**: If you have addressed all comments and have not received a response within the SLA window, feel free to politely ping the assigned reviewer in the PR comments or reach out on the project's discussion channel.

### Definition of Done (DoD)

Before a pull request can be approved and merged, it must meet our Definition of Done:

- [ ] **Acceptance Criteria**: The change fulfills 100% of the acceptance criteria defined in the linked issue.
- [ ] **Scoped Focus**: No unrelated changes, unnecessary dependency updates, or accidental formatting refactors.
- [ ] **Test Coverage**:
  - For Soroban contracts: Unit tests cover all success and failure branches in `contracts/accord/src/test.rs`.
  - For Frontend: Component tests or mocks in `frontend/` reflect new state transitions.
- [ ] **CI Passing**: All automated GitHub Actions checks pass without warnings or errors:
  - Contract: `cargo test` passes all tests.
  - Rust Lints: `cargo fmt --check` and `cargo clippy -- -D warnings` pass cleanly.
  - Frontend: `npm run lint` and `npm run build` succeed.
- [ ] **Documentation**:
  - Updated relevant docs in `docs/` or `README.md` if any user-facing behavior, API, or configuration changed.
  - If storage keys or TTL constants changed, `docs/ARCHITECTURE.md` and `docs/STORAGE_MODEL.md` are updated.
- [ ] **Clean Git History**: Commits follow the convention `feat(<module>): ...` or `fix(<module>): ...` with concise imperative messages.
- [ ] **Linked Issue**: The PR description includes `Closes #<issue_number>` or `Fixes #<issue_number>`.

### Review and merge criteria

Reviewers check that the PR meets these conditions before approving:

- **Tests pass.** All CI checks (contract tests, frontend lint, and frontend build) are green.
- **Scope matches the issue.** The change addresses the issue it claims to fix without unrelated drive-by refactors.
- **Coding standards followed.** The code matches the style and patterns described in [Coding standards](#coding-standards).
- **Description is complete.** The PR description explains what changed, why, how to verify it, and links the relevant issue.

Once all criteria are met, a maintainer approves the PR and merges it into `main`.

### Handling review feedback

When a reviewer requests changes:

1. **Push follow-up commits** to the same branch. Do not open a new PR — the existing PR updates automatically.
2. **Reply to each review comment** explaining what you changed or why you kept the current approach.
3. **Mark comments as resolved** in the GitHub UI once the feedback has been addressed.
4. If you disagree with feedback, **push back with a counter-argument** in the review thread. Explain your reasoning, link supporting references if applicable, and come to a consensus before proceeding. Reviewers are collaborators, not gatekeepers — discussion is expected.

### After your PR merges

- **Delete your feature branch** to keep the repository tidy. GitHub offers a button for this after merge.
- **Your name appears in the commit history** as a contributor to the project.
- **Check the changelog** (`CHANGELOG.md`) to verify your entry is recorded under `[Unreleased]`. See the [Release process](#release-process) section for details on versioning, tagging, and how unreleased entries are packaged into official releases.

---

## Branching, commits, and pull requests

### Branch naming

Use short, descriptive prefixes when possible:

| Prefix | Example |
|--------|---------|
| `feat/` | `feat/history-filters` |
| `fix/` | `fix/proposal-card-a11y` |
| `docs/` | `docs/contributing-setup` |
| `chore/` | `chore/eslint-config` |
| `contract/` | `contract/proposal-storage` |

Maintainership may standardize naming further; follow any updated guidance in issues or pinned discussions.

### Commit messages

- Use the **imperative mood** in the subject line (`Add`, `Fix`, not `Added`, `Fixed`).
- Keep the **first line around 72 characters** or less when practical.
- Optionally add a blank line and a body explaining **why** the change was needed, especially for contracts and security-sensitive behavior.

### Pull request description

A strong PR description helps reviewers and future readers. Include:

1. **What** changed (high level).
2. **Why** it was needed (link the issue: `Fixes #123` or `Refs #123`).
3. **How to verify** (commands you ran, screenshots for UI).
4. **Risks or follow-ups** (known limitations, TODOs that are intentionally left).

### Examples of well-formed pull requests

Here are practical examples of well-formed pull requests across different domains:

#### Example 1: Contract feature or bugfix PR

```markdown
## Title: fix(contract): prevent duplicate approver weight in quorum calculation (#412)

### Summary
Fixes an edge case where an owner who re-approved an active proposal could have their weight counted twice if the approval key was not checked before updating cumulative weight.

### Changes
- Updated `approve()` in `contracts/accord/src/lib.rs` to check `has_approved()` prior to adding weight.
- Added regression test `test_duplicate_approval_rejected` in `contracts/accord/src/test.rs`.

### Verification
Ran local contract checks:
```bash
cargo test
cargo fmt --check
cargo clippy -- -D warnings
```
All 32 tests pass without warnings.

### Definition of Done Checklist
- [x] Meets all acceptance criteria in #412
- [x] Unit tests added covering edge case
- [x] CI checks pass locally
- [x] Storage/event docs updated (none affected)

Closes #412
```

#### Example 2: Frontend UI improvement PR

```markdown
## Title: feat(frontend): add filter dropdown for proposal category (#520)

### Summary
Adds a filter selector allowing users to filter proposals by category (Transfer, Payroll, Grant, Ops).

### Changes
- Added `CategoryFilter` component in `frontend/src/components/CategoryFilter.tsx`.
- Integrated filter into `frontend/src/pages/Dashboard.tsx`.
- Updated test coverage for filter state transitions.

### Verification
- Tested with mock data across all 4 categories.
- Verified responsive layout on desktop and mobile viewports.
- Screenshot:
  [Screenshot attached showing filter dropdown in active state]
- Ran `npm run lint` and `npm run build` cleanly.

### Definition of Done Checklist
- [x] Meets acceptance criteria in #520
- [x] Responsive layout verified
- [x] Linting and build green
- [x] No extraneous changes

Closes #520
```

### PR size and scope

- **One PR should address one concern** (one issue, or one tightly related cluster of changes).
- Avoid drive-by refactors in files you are not required to touch.
- If you must refactor to implement a feature, **say so in the PR** and keep the refactor minimal and reviewable.

### Draft PRs

Use **GitHub Draft PRs** when you want early feedback on direction before the change is polished. Clearly mark what is incomplete.

---

## Coding standards

### TypeScript and React (`frontend/`)

- **Strict typing:** avoid `any`. Prefer explicit types and narrow unions.
- **Components:** prefer small, composable components; lift state only as high as needed.
- **Accessibility:** use semantic HTML where possible; label form controls; ensure keyboard operability for interactive elements.
- **Styling:** follow existing Tailwind usage; avoid one-off inline styles unless there is a strong reason.
- **Imports:** keep imports ordered in a readable way (no need for automated sorting unless the project adds a formatter rule).

### Rust and Soroban (`contracts/`)

- Prefer **clear names** for storage keys, types, and public contract functions.
- Document **non-obvious invariants** (for example, threshold bounds, owner uniqueness) in comments near the code that enforces them.
- Keep **error handling** explicit; use typed errors where the Soroban project pattern supports it.
- Avoid **panics** on user-controlled inputs; return errors that tests can assert.
- Run `cargo clippy -- -D warnings` before opening a PR and fix all lints it reports. You can enforce this automatically with a local pre-commit hook:

  ```bash
  # Create the hook file
  cat > .git/hooks/pre-commit << 'EOF'
  #!/usr/bin/env sh
  set -e
  cargo clippy -- -D warnings
  EOF

  # Make it executable
  chmod +x .git/hooks/pre-commit
  ```

  The hook runs from the repository root on every `git commit` attempt and aborts the commit if any clippy warning is found.

### General

- Match the **style and patterns** of surrounding code unless an issue mandates a deliberate migration.
- Do not add **secrets**, private keys, or personal configuration to the repository.

### Secret scanning

Every pull request and push to `main` runs Gitleaks over the full git history in
the `Security checks` workflow (`.github/workflows/security.yml`). A finding
fails the job. CI pins Gitleaks `8.30.1`; the reviewed configuration lives in
[`.gitleaks.toml`](./.gitleaks.toml).

Run the same scan locally:

```bash
gitleaks detect --source . --config .gitleaks.toml --no-banner --redact --verbose
```

**If a real secret is detected:**

1. Treat the credential as compromised and revoke or rotate it **immediately**,
   before cleaning up the repository. Do not wait for the scan to be allowlisted.
2. Remove it from the working tree and replace it with an environment variable
   or a managed secret-store reference. Never commit a real value in a fixture,
   test, script, or example.
3. If the secret is already in git history, coordinate with maintainers to purge
   it from history with `git filter-repo` (or an equivalent tool), then
   force-push the affected branches. Assume anyone who fetched the history
   already has the value.
4. Audit provider logs and dependent systems for unauthorized use, and follow
   the incident process in [`docs/SECRETS_MANAGEMENT.md`](./docs/SECRETS_MANAGEMENT.md)
   and [`docs/INCIDENT_RESPONSE.md`](./docs/INCIDENT_RESPONSE.md).
5. Never paste the leaked value into a public issue, pull request, or chat.
   Reference it by provider and rotation status only.

**False positives:** add the narrowest possible exact regex or path to the
allowlist in [`.gitleaks.toml`](./.gitleaks.toml), with a comment explaining why
the value is public or synthetic. Every allowlist change requires maintainer
review. Do not add broad patterns or disable default rules to silence a finding.

---

## Testing and quality gates

Run the relevant checks before requesting review.

> **How CI is wired:** every suite below is exercised by GitHub Actions. See
> [`docs/CI.md`](./docs/CI.md) for the workflow map, the caching/concurrency
> policy, and the settings the release and preview workflows expect.

### Frontend

```bash
cd frontend
npm run lint
npm run test          # unit tests + page-state matrix tests
npm run build
npm run check:bundle  # production bundle budget (run after `npm run build`)
npm run e2e           # Playwright end-to-end suite
```

Bundle and load-performance budgets are documented in
[`frontend/docs/performance-budgets.md`](./frontend/docs/performance-budgets.md).
Raise a budget only as a deliberate, reviewed change — never to make a red build
green.

After editing any `#[contracttype]` or `#[contracterror]` definition, regenerate
the frontend contract types and commit the result — see
[`docs/CONTRACT_TYPES.md`](./docs/CONTRACT_TYPES.md):

```bash
python3 scripts/generate-contract-types.py
```

### Contracts (from repo root)

```bash
stellar contract test
```

#### Test snapshots

Soroban writes a snapshot for every `Env` created by a test into
`contracts/accord/test_snapshots/` when the `Env` is dropped. The committed
snapshots are the baseline for the `Contract Snapshot Verification` CI job
(`.github/workflows/contract.yml`), which runs the suite and **reports drift as
a warning**. The report is advisory so an existing stale baseline cannot block
every pull request; the full patch is uploaded as the
`contract-snapshot-verification` artifact. The job never rewrites or commits
snapshots.

Run the same check locally:

```bash
bash scripts/verify-snapshots.sh
```

The script runs `cargo test -p accord --lib --no-fail-fast`, writes the
changed-file list and a readable patch to `target/snapshot-verification/`, and
exits non-zero on drift. Set `SNAPSHOT_VERIFY_WARN_ONLY=1` to match CI's
advisory mode. Test failures are reported by the regular Contract CI job; a
failure that writes a changed snapshot is still reported as drift. Snapshot
files are pinned to LF with `.gitattributes` so Windows line-ending conversion
is not mistaken for drift.

**Updating snapshots intentionally.** Snapshots are rewritten automatically
when the tests run, so a normal `cargo test` is enough. If a contract change
intentionally alters behaviour:

1. Run `cargo test -p accord --lib`.
2. Review the changed files under `contracts/accord/test_snapshots/` (the patch
   from `scripts/verify-snapshots.sh` is easy to read).
3. `git add contracts/accord/test_snapshots` and commit the refreshed snapshots
   in the same PR.

Never update snapshots just to make a red build green. Property tests use
`non_snapshot_env()` on purpose: their inputs are random, so they do not write
snapshots and no property-test snapshots should be committed. Use the same
helper for any new randomized test.

#### Coverage threshold

CI (`Contract Coverage` in `.github/workflows/contract.yml`) measures line coverage of the contract source with [`cargo-llvm-cov`](https://github.com/taiki-e/cargo-llvm-cov), excluding `test.rs` and `bench.rs`, and **fails when it drops below the minimum** in `contracts/accord/Cargo.toml`:

```toml
[package.metadata.coverage]
min-line-coverage = 85
```

The HTML report, `lcov.info` and a text summary are uploaded as the `contract-coverage` artifact on every run, and the summary is shown on the run page.

```bash
cargo install cargo-llvm-cov --locked   # once; also needs `rustup component add llvm-tools-preview`
cargo llvm-cov -p accord --lib --ignore-filename-regex '(test|bench)\.rs$' --html --open
```

**Raising the threshold deliberately.** The threshold is a ratchet, not a target to hover at. When a PR adds tests that lift coverage durably, raise `min-line-coverage` in the same PR to a whole number about 2–3 points below the new measured figure (headroom for harmless refactors). Never lower it to make a PR pass: add the missing tests, or explain in the PR why the code is untestable and get maintainer sign-off for the change.

#### Benchmark regression gate

CI (`Contract Benchmarks`) runs `bench_hot_entrypoints` (`contracts/accord/src/bench.rs`), which meters the hot entrypoints (`initialize`, `create_proposal`, `approve`, `revoke`, `execute` for transfers and governance, and the main reads) and compares CPU instructions, memory, ledger entries and write entries/bytes with the baseline in `contracts/accord/bench-baseline.txt`. **A figure that grows more than 5% fails the build.** The per-metric deltas appear in the job summary, in the `contract-benchmarks` artifact and as a comment on the pull request.

```bash
cargo test -p accord --lib bench_hot_entrypoints -- --nocapture   # compare with the baseline
```

**Updating baselines intentionally.** Metering is deterministic, so the baseline only changes when the contract's cost does. If growth is intended (new feature, extra safety check), or a change made things cheaper:

1. Confirm the delta in the report is explained by your change, and that the entrypoint still fits the budget documented in `docs/ARCHITECTURE.md` §12.
2. Re-record: `ACCORD_BENCH_UPDATE=1 cargo test -p accord --lib bench_hot_entrypoints`.
3. Commit the updated `bench-baseline.txt` **in the same PR** and state the old and new figures and why in the PR description. A baseline change with no explanation will not be merged.

Set `ACCORD_BENCH_THRESHOLD_PCT` to try a different threshold locally. A new entrypoint to track needs a call in `measure()` plus a re-recorded baseline.

If your change touches both areas, run **both** frontend and contract commands and state that in the PR.

### Adding tests

- **Contracts:** add or extend tests alongside behavior changes. Prefer tests that encode **invariants** (for example, cannot execute below threshold).
- **Frontend:** add or extend Vitest unit/component tests (`npm run test`) for logic and page states, and Playwright end-to-end tests (`npm run e2e`) for user flows. Every page must cover loading, empty, and error states in the page-state matrix (`frontend/src/pages/pageStateMatrix.test.tsx`).

---

## Debugging tips

This section covers the three tools you are most likely to need when a contract call misbehaves, a Rust build refuses to compile, or you need to inspect what actually landed on the network.

### Reading Soroban diagnostic events

Every state-changing function in the Accord contract calls `env.events().publish()` before returning. These events are the fastest way to confirm that a call did what you expected, or to find out at exactly which point it diverged from what you intended.

#### Viewing events during a local `contract invoke`

Append `--diagnostic-events` to any `stellar contract invoke` command. The CLI simulates the transaction first and prints the events that would be emitted alongside the result:

```bash
stellar contract invoke \
  --network local \
  --rpc-url http://localhost:8000 \
  --source-account alice \
  --id "$CONTRACT_ID" \
  --diagnostic-events \
  -- approve \
  --approver "$ALICE" \
  --proposal_id 1
```

The output includes a `diagnosticEvents` array. Each entry looks like this:

```json
{
  "event": {
    "type": "contract",
    "contractId": "CA7...",
    "topics": [{ "type": "sym", "value": "approved" }],
    "data": {
      "type": "map",
      "entries": [
        { "key": { "value": "id" },        "val": { "value": "1"       } },
        { "key": { "value": "approver" },  "val": { "value": "GALICE..." } },
        { "key": { "value": "approvals" }, "val": { "value": "1"       } },
        { "key": { "value": "threshold" }, "val": { "value": "2"       } }
      ]
    }
  }
}
```

#### Event names and what they tell you

The topic symbol identifies which event fired. All event names and their full payload schemas are documented in [`docs/CONTRACT_API.md — Event Payloads`](./docs/CONTRACT_API.md#event-payloads).

| Topic symbol | Emitted by | Key fields to check |
|---|---|---|
| `"created"` | `create_proposal` | `id` (new proposal ID), `proposer`, `threshold`, `category`, `transfers` |
| `"approved"` | `approve` | `id`, `approver`, `approvals` (running total), `threshold` |
| `"revoked"` | `revoke` | `id`, `approver`, `approvals` (remaining count after revoke) |
| `"executed"` | `execute` | `id`, `executor`, `transfers` (what was actually moved) |

#### Using events to diagnose failures

If a call returns an error, `--diagnostic-events` still shows any events that fired before the revert. If no topic event appears at all, the error happened before `env.events().publish()` — meaning the problem is in input validation (wrong owner, invalid token, expired deadline, and so on).

Use the error code together with the event absence to narrow the root cause quickly. For the full list of error codes and their meanings, see [`docs/CONTRACT_API.md — Error Reference`](./docs/CONTRACT_API.md#error-reference).

---

### Common Rust compile errors in Soroban contracts

New contributors to the contract layer tend to hit the same handful of compiler errors. Here are the most common ones and what they mean in the context of Soroban SDK code.

#### 1. "value used after move" / "use of partially moved value"

```
error[E0382]: use of moved value: `proposal`
  --> contracts/accord/src/lib.rs:123:18
```

**Cause:** Rust moves a value when it is passed to a function that takes ownership. Soroban types such as `Address`, `String`, and `Vec<T>` are not `Copy`, so passing one to a function or storing it consumes it. A subsequent use of the same binding fails to compile.

**Fix:** Clone the value at the first use when you need it in more than one place:

```rust
// Before — compile error
env.events().publish((symbol_short!("created"),), ProposalCreatedEvent {
    proposer,         // moved here
    ..
});
some_other_fn(proposer);  // ❌ moved value used again

// After — clone at first use
env.events().publish((symbol_short!("created"),), ProposalCreatedEvent {
    proposer: proposer.clone(),  // ✅ clone consumed, original still valid
    ..
});
some_other_fn(proposer);        // ✅ original used here
```

#### 2. "cannot borrow as mutable" / borrow checker conflicts

```
error[E0502]: cannot borrow `env` as mutable because it is also borrowed as immutable
```

**Cause:** Soroban's `Env` is a shared handle. Holding an immutable reference — for example, iterating over a storage result — while also trying to write through `env.storage()` creates an aliasing conflict the borrow checker rejects.

**Fix:** Collect the data you need from `env` into an owned value (such as a `Vec`) before the mutable operation:

```rust
// Before — borrow conflict
for owner in env.storage().persistent().get::<_, Vec<Address>>(&key).unwrap().iter() {
    env.storage().persistent().set(&other_key, &owner);  // ❌ mutable borrow while iter holds ref
}

// After — collect first, then write
let owners: Vec<Address> = env.storage().persistent().get(&key).unwrap();
for owner in owners.iter() {
    env.storage().persistent().set(&other_key, owner);  // ✅ no overlapping borrow
}
```

#### 3. Unwrapping `Option` / `Result` with `.unwrap()` in contract code

```
error[E0308]: mismatched types
  expected `Result<(), ContractError>`, found `()`
```
or a runtime panic in test output:

```
called `Option::unwrap()` on a `None` value
```

**Cause:** Soroban contract functions return `Result<T, ContractError>`. Using `.unwrap()` on a storage read or SDK call compiles, but panics at runtime if the value is absent — which produces an opaque host trap instead of a typed `ContractError` that tests can assert.

**Fix:** Use `ok_or(ContractError::...)` to convert `Option` to `Result` and propagate errors with `?`:

```rust
// Before — panics on missing key
let threshold: u32 = env.storage().instance().get(&threshold_key()).unwrap();

// After — returns ContractError::NotInitialized if key is absent
let threshold: u32 = env.storage()
    .instance()
    .get(&threshold_key())
    .ok_or(ContractError::NotInitialized)?;
```

#### 4. `#[no_std]` environment: missing `std` types

```
error[E0433]: failed to resolve: use of undeclared crate or module `std`
  --> contracts/accord/src/lib.rs:5:5
  |
  use std::collections::HashMap;
```

**Cause:** Soroban contracts compile with `#![no_std]` (the first line of `lib.rs`), which excludes the Rust standard library. Types like `HashMap`, `String` from `std`, `Vec` from `std`, and `format!` are not available.

**Fix:** Use the Soroban SDK equivalents declared in `soroban_sdk`:  
`soroban_sdk::Vec` instead of `std::vec::Vec`, `soroban_sdk::String` instead of `std::string::String`, `soroban_sdk::Map` instead of `std::collections::HashMap`. Import them from the SDK crate at the top of the file, matching the existing import block in `lib.rs`.

#### 5. Missing `IntoVal` / `TryFromVal` implementations

```
error[E0277]: the trait bound `MyType: IntoVal<Env, Val>` is not satisfied
```

**Cause:** Storing a custom type in Soroban persistent storage requires that type to implement `IntoVal<Env, Val>` and `TryFromVal<Env, Val>`. The SDK generates these implementations automatically, but only when you annotate the type with `#[contracttype]`.

**Fix:** Add `#[contracttype]` (and `#[derive(Clone)]`) to any struct or enum you store in or read from contract storage:

```rust
#[derive(Clone)]
#[contracttype]
pub struct MyData {
    pub value: u32,
}
```

---

### Inspecting transactions in Stellar Lab

[Stellar Lab](https://lab.stellar.org/) provides a browser-based interface for looking up transactions by hash and reading their full XDR result — useful when you have submitted a transaction from the CLI or the frontend and want to verify exactly what the network recorded.

#### Finding a transaction by hash

1. Open [https://lab.stellar.org/](https://lab.stellar.org/) in your browser.
2. Click **Explorer** in the top navigation, then choose **Transactions**.
3. Paste your transaction hash (the 64-character hex string printed by `stellar contract invoke` or returned by the Stellar SDK) into the search field and press Enter.

If you are working against testnet, make sure the network selector in the top bar reads **Testnet** — results are network-specific and a mainnet hash will not appear in a testnet search.

#### Reading the result: success vs. failure

The transaction detail page shows a **Result** section. The two cases look like this:

| Outcome | What you see in the Result section |
|---|---|
| **Success** | `txSUCCESS` at the top level; the `OperationResult` entry for the `invokeHostFunction` op shows `invokeHostFunctionSuccess` and the return value (or void for functions that return `()`) |
| **Failure** | `txFAILED` at the top level; the `OperationResult` shows `invokeHostFunctionTrapped` or `invokeHostFunctionRecovered` |

#### Locating the contract error code

When a call fails, the contract error code is encoded as an `ScVal::Error` in the operation's `resultXdr`. Stellar Lab renders this in the **XDR Viewer** pane. Look for a field named `error` with a `contractCode` sub-field — its numeric value maps directly to the `ContractError` variants listed in [`docs/CONTRACT_API.md — Common Errors Quick Reference`](./docs/CONTRACT_API.md#common-errors-quick-reference).

For example, a `contractCode` of `3` means `Unauthorized` (the signer is not a registered owner), and `10` means `ThresholdNotMet` (the proposal does not yet have enough approvals). Cross-referencing that table with the Lab output is usually the fastest way to diagnose a failed on-chain call without re-running the transaction locally.

---

## Documentation

- Update the **README** when you change user-visible setup steps, prerequisites, or high-level architecture.
- Update **this file** when contribution rules or quality gates change.
- For small behavior changes, **PR description** may be enough; for new contributor-facing workflows, prefer durable docs in the repo.

### Translating the docs

We welcome translations of Accord Protocol guides and documentation! Localized documents live in `docs/i18n/<locale>/` and mirror the English source structure.

Before submitting a translation:
- Review [`docs/i18n/README.md`](./docs/i18n/README.md) for directory layout, what must not be translated (code, commands, identifiers, contract types), and the required YAML header block.
- Each translation requires review by a fluent or native speaker and a maintainer. If no fluent reviewer is currently available, PRs are accepted with `status: draft`.
- Run `node scripts/check-translation-staleness.js` locally to ensure metadata and source commit references are valid.
### Architecture decision records

We document significant architectural decisions in [`docs/adr/`](./docs/adr/) using the [ADR template](./docs/adr/template.md).

**When to write an ADR:**
- Any change to the contract's authorization model, operational roles, or governance thresholds
- Any change to the storage layout, storage key naming conventions, or entry lifetime (TTL) strategy
- Any change to the contract upgrade mechanism, schema versioning, or on-chain migration strategy
- Any change to the public contract interface, error codes, or event architecture
- Introducing a new platform, language, major framework, or architectural pattern across frontend, contract, or indexer
- Any design decision that would be costly or difficult to reverse

Do not write an ADR for routine bug fixes, refactoring that preserves existing interfaces, or regular dependency updates. See [`docs/adr/README.md`](./docs/adr/README.md) for numbering, status lifecycles, and supersession guidelines.

### API documentation build

The project generates unified API reference documentation combining:
1. **Rustdoc** for the Soroban smart contract (`contracts/accord`)
2. **TypeDoc** for the frontend client libraries and domain types (`frontend/src/types` and `frontend/src/lib`)

**Local build command:**
```bash
# Build both documentation suites into docs-site/
bash scripts/build-docs.sh docs-site

# Or using Makefile:
make docs
```

**Publishing and GitHub Pages:**
API references are published to GitHub Pages on pushes to `main` via [`.github/workflows/pages.yml`](./.github/workflows/pages.yml). The expected live address is `https://thegreatfeez.github.io/accord-protocol/` (maintainers should confirm upon enabling GitHub Actions as the Pages source). Pull requests validate documentation generation in CI without deploying.

### Documentation link check and allowlist policy

CI validates internal links, relative markdown paths, fragment anchors, and external URLs on every pull request and push to `main` via [`.github/workflows/docs.yml`](./.github/workflows/docs.yml), and runs weekly to detect external link rot.

**Local verification:**
```bash
# If lychee is installed locally:
lychee --config lychee.toml --ignore-path .lycheeignore "**/*.md"
```

**Allowlist policy:**
- The reviewed allowlist lives in [`.lycheeignore`](./.lycheeignore).
- **Mandatory comment**: Every pattern added to `.lycheeignore` must include a required reason comment explaining why it is excluded (e.g. anti-bot rate limits, parameterized placeholder URL, local test server).
- **No broken links**: Genuine broken links and missing anchors must be fixed in source documentation; allowlisting broken links to bypass CI is forbidden.
- **Review requirement**: Any changes to `.lycheeignore` require explicit maintainer review.

---

## Dependency updates

The project uses [Dependabot](https://docs.github.com/en/code-security/dependabot) to keep dependencies current across Cargo crates, npm packages, and GitHub Actions. The automation is configured in [`.github/dependabot.yml`](./.github/dependabot.yml).

### Cadence and limits

- **Schedule**: Weekly on Mondays at 09:00 UTC (proposed default; maintainers to confirm).
- **Open pull request limits**: Bounded to at most 10 open pull requests per package ecosystem to avoid notification fatigue.

### Grouping and lockstep dependency families

To reduce PR noise without hiding risk, Dependabot is configured with grouped updates:
- **Minor and patch updates**: Grouped together within each ecosystem so routine maintenance arrives in single, consolidated PRs.
- **Major updates**: Excluded from groups and opened as separate, isolated pull requests to ensure individual review, migration notes, and compatibility verification.
- **Lockstep dependency families**:
  - **Soroban ecosystem (`Cargo.toml`)**: `soroban-*` crates are grouped together to prevent version skew across SDK packages.
  - **Stellar JavaScript SDKs (`frontend/package.json`, `indexer/package.json`)**: `@stellar/*` packages (`@stellar/stellar-sdk`, `@stellar/freighter-api`) are grouped so protocol bindings stay aligned.
  - **React ecosystem (`frontend/package.json`)**: `react`, `react-dom`, and `@types/react*` packages are grouped to move in lockstep.
  - **GitHub Actions (`.github/workflows`)**: Workflow action minor and patch updates are grouped.

### Review, assignment, and auto-merge policy

- **Review policy**: All dependency pull requests must be manually reviewed and approved by repository maintainers. Auto-merge is explicitly disabled.
- **Reviewers and CODEOWNERS**: GitHub has deprecated the `reviewers` option in `dependabot.yml` in favor of `CODEOWNERS`. When a `CODEOWNERS` file is established with maintainer handles, Dependabot will automatically request reviews according to ownership rules.
- **CI requirements**: Every Dependabot PR must pass all standard CI workflows before merge:
  - Contract build, unit tests, coverage gate, and benchmarks (`.github/workflows/contract.yml`)
  - Frontend lint, typecheck, unit tests, contract types currency check, and bundle budgets (`.github/workflows/frontend-ci.yml`)
  - Indexer tests and analytics checks (`.github/workflows/indexer-analytics.yml`)
  Dependabot branches run with a read-only `GITHUB_TOKEN` and no access to repository secrets; no required CI check depends on repository secrets or uses `pull_request_target`.

### Handling major and security updates

- **Security updates**: When a vulnerability advisory is published for a dependency, Dependabot or maintainers submit a targeted PR addressing the advisory. Security updates take precedence over routine weekly batches.
- **Major upgrades**: Major version bumps represent breaking changes. The PR description must note the breaking API changes, required code adaptations, and testing evidence.

### Adding a new manifest directory

When adding a new service, crate, or application with its own manifest:
1. Open [`.github/dependabot.yml`](./.github/dependabot.yml).
2. Add a new entry under `updates:` specifying:
   - `package-ecosystem`: `"npm"`, `"cargo"`, etc.
   - `directory`: The relative path to the manifest directory (e.g. `"/services/new-service"`).
   - `schedule`: The standard weekly cadence matching existing entries.
   - `groups`: Ecosystem-specific grouping configuration.
3. Commit the configuration change alongside the new manifest.

---

## Release process

This section covers how releases are planned, versioned, tagged, and documented in Accord Protocol, and how contributors ensure their merged work is included.

### How a release is cut

Releases package accumulated changes from the `main` branch into official, tagged milestones (cross-referenced with [`ROADMAP.md`](./ROADMAP.md)). When cutting a release, a maintainer:

1. Opens a release PR that updates [`CHANGELOG.md`](./CHANGELOG.md):
   - Moves entries from `## [Unreleased]` into a new version section titled `## [X.Y.Z] - YYYY-MM-DD` (for example, `## [0.2.0] - 2026-08-01`).
   - Re-creates empty `Added`, `Changed`, `Fixed`, and `Removed` subsections under `## [Unreleased]` for future PRs.
2. Merges the release PR into `main`.
3. Creates and pushes an annotated git tag matching the version string (for example, `git tag -a v0.2.0 -m "Release v0.2.0"` followed by `git push origin v0.2.0`).
4. Publishes a GitHub Release attached to the new tag containing the release notes summary.

### Versioning scheme

Accord Protocol follows [Semantic Versioning (SemVer 2.0.0)](https://semver.org/): `MAJOR.MINOR.PATCH` (for example, `v0.2.0`).

- **MAJOR (`X.0.0`)**: Incremented for breaking contract API changes, incompatible storage layout modifications, or protocol changes requiring data migration.  
  *Example:* Changing public contract function parameters in `lib.rs` in a way that breaks existing clients, or altering storage keys such that previously written state cannot be deserialized without a migration script.
- **MINOR (`0.X.0`)**: Incremented for new, backward-compatible features in the contract or frontend.  
  *Example:* Adding spending limit governance (`create_spending_limit_proposal`), introducing guardian pause controls (`freeze`/`unfreeze`), or adding proposal category filters in the UI.
- **PATCH (`0.0.X`)**: Incremented for backward-compatible bug fixes, security patches, documentation updates, or internal refactoring.  
  *Example:* Correcting a deadline validation edge case, fixing a layout bug on proposal cards, or clarifying setup instructions in documentation.

### What belongs in release notes

Release notes provide a concise overview of changes since the prior release for treasury operators, integration developers, and co-owners.

Release notes should include:
- A high-level summary of the milestone theme (referencing [`ROADMAP.md`](./ROADMAP.md)).
- Bulleted items organized under the standard Keep a Changelog categories matching [`CHANGELOG.md`](./CHANGELOG.md):
  - **Added**: New contract functions, UI views, or developer tooling.
  - **Changed**: Modifications to existing behavior, component styles, or default parameters.
  - **Fixed**: Bug fixes, security patches, or error handling corrections.
  - **Removed**: Deprecated or removed functions and features.
- Explicit migration or upgrade notes if deployment steps or configuration options changed.

### Ensuring your work is included in a release

To ensure your merged pull request is credited and included in the next release:

1. **Update `CHANGELOG.md` in your PR**: Before merging your PR, add a clear bullet point under `## [Unreleased]` in [`CHANGELOG.md`](./CHANGELOG.md) under the appropriate subsection (`Added`, `Changed`, `Fixed`, or `Removed`).
2. **Write user/developer-oriented entries**: Frame the entry around what changed for users or developers (for example, `- Add spending limit proposal creation flow and display table`).
3. **Ask when in doubt**: If you are unsure which subsection (`Added` vs `Changed`) your change belongs under, or whether your change requires a changelog entry, comment on your PR or tag a maintainer during code review.

---

## Security and responsible disclosure

Accord is **not audited** and is under active development. Treat it accordingly.

- **Do not open public issues** for unfixed security vulnerabilities.
- Use **GitHub Security Advisories** (or the contact process maintainers publish) for responsible disclosure.

If you are unsure whether something is a vulnerability, you may open a discussion or issue framed as a **private** security report per GitHub’s security policy, if enabled on the repository.

---

## Licensing

By contributing to this repository, you agree that your contributions will be licensed under the same terms as the project. See [LICENSE](./LICENSE) (MIT).

If your employer owns your contributions, ensure you have **authorization** to contribute before opening a PR.

---

## Questions and maintainer contact

- **General questions** about *how* to contribute: open a GitHub Discussion if enabled, or an issue labeled for questions (if maintainers provide one).
- **Issue-specific questions:** comment on the issue thread.
- **PR feedback:** keep responses in the PR review thread so decisions stay searchable.

Thank you again for helping make Accord a solid, contributor-friendly Stellar project.
