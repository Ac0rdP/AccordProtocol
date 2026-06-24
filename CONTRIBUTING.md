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
10. [Documentation](#documentation)
11. [Security and responsible disclosure](#security-and-responsible-disclosure)
12. [Licensing](#licensing)
13. [Questions and maintainer contact](#questions-and-maintainer-contact)

---

## Code of conduct and collaboration

- **Be respectful and constructive.** Review comments should focus on the change, not the person.
- **Assume good intent** and prefer clear questions over assumptions.
- **Keep discussions on-topic** in issues and pull requests (PRs).
- If the project adopts a formal Code of Conduct later, it will supersede this section; until then, these expectations apply to all spaces where the project is discussed (issues, PRs, chats linked from the repo).

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

### GitHub issues

- Use **open issues** as the primary source of scoped work.
- Prefer issues that have a **clear acceptance criteria** (what “done” means, which files or behaviors are in scope).

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

If you discover that an issue is **wrongly scoped** or **blocked**, comment on the issue early rather than investing days of work in the wrong direction.

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

---

## Testing and quality gates

Run the relevant checks before requesting review.

### Frontend

```bash
cd frontend
npm run lint
npm run build
```

### Contracts (from repo root)

```bash
stellar contract test
```

#### Updating snapshots

Soroban tests may store **snapshot files** alongside the test source that capture expected contract output. When you make an **intentional** contract behaviour change a test may fail only because its stored snapshot no longer matches the new output — not because the logic is wrong.

To regenerate all snapshot files in one pass, set the `UPDATE_EXPECT` environment variable when running the test suite:

```bash
UPDATE_EXPECT=1 stellar contract test
```

After regeneration, review each updated snapshot file to confirm the new output is correct, then **commit the updated snapshot files alongside your code change**. A PR that changes contract behaviour but omits the refreshed snapshots will fail CI.

If your change touches both areas, run **both** frontend and contract commands and state that in the PR.

### Adding tests

- **Contracts:** add or extend tests alongside behavior changes. Prefer tests that encode **invariants** (for example, cannot execute below threshold).
- **Frontend:** when logic grows beyond trivial UI, consider unit tests or component tests if the project introduces a test runner; until then, document manual test steps clearly in the PR.

---

## Documentation

- Update the **README** when you change user-visible setup steps, prerequisites, or high-level architecture.
- Update **this file** when contribution rules or quality gates change.
- For small behavior changes, **PR description** may be enough; for new contributor-facing workflows, prefer durable docs in the repo.

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
