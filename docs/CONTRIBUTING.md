# Contributing to Accord Protocol

Thank you for contributing! This guide covers the full contributor workflow: environment setup, finding work, opening pull requests, and code standards.

Read the [README](../README.md) and [Architecture](./ARCHITECTURE.md) for product context first.

---

## Table of Contents

1. [Ways to contribute](#ways-to-contribute)
2. [Glossary](./GLOSSARY.md)
3. [Development setup](#development-setup)
4. [Finding work](#finding-work)
5. [Contribution workflow](#contribution-workflow)
6. [Branching and commits](#branching-and-commits)
7. [Coding standards](#coding-standards)
8. [Testing](#testing)
9. [Documentation](#documentation)
10. [Security](#security)
11. [License](#license)

---

## Your First Contribution

This checklist is designed for first-time contributors to help you get started quickly and smoothly. It links to the more detailed sections below for further guidance.

- [ ] Read the [Architecture](./ARCHITECTURE.md) and [Setup](./SETUP.md) documentation.
- [ ] Clone the repository or fork it to your local machine.
- [ ] Run the installation commands as detailed in the [Development Setup](#development-setup) / [SETUP.md](./SETUP.md).
- [ ] Verify that your local builds succeed.
- [ ] Find an issue to work on (look for `good first issue`) via [Finding Work](#finding-work).
- [ ] Create a new branch following the conventions in [Branching and Commits](#branching-and-commits).
- [ ] Make your change and ensure it is as small as possible to satisfy the issue.
- [ ] Run local checks and tests (see [Testing](#testing)).
- [ ] Open a Pull Request and respond to feedback.

---

## Ways to Contribute

| Area               | Examples                                                                            |
| ------------------ | ----------------------------------------------------------------------------------- |
| **Contract**       | Proposal lifecycle improvements, owner rotation, spending limits, gas optimizations |
| **Frontend**       | Freighter wallet integration, real-time event feed, mobile UI, accessibility        |
| **Testing**        | Additional contract tests, property-based tests, E2E UI tests                       |
| **Documentation**  | Diagrams, video walkthroughs, API reference improvements                            |
| **Reviews**        | Thoughtful PR reviews with concrete suggestions                                     |
| **Infrastructure** | CI improvements, Dependabot config, deployment scripts                              |

---

## Development Setup

See [`docs/SETUP.md`](./SETUP.md) for a step-by-step guide across macOS, Linux, and Windows (WSL2).

---

## Finding Work & Choosing a First Issue

1. Check the [GitHub Issues](https://github.com/thegreatfeez/accord-protocol/issues) tab for open issues.
2. Filter by beginner labels:
   - **`good first issue`**: Self-contained tasks requiring minimal codebase context.
   - **`documentation`**: Updating guides, diagrams, and README walkthroughs.
   - **`testing`**: Adding unit tests for contract corner cases or UI components.
   - **`drips-wave`**: Issues eligible for Stellar Drips Wave developer rewards.
3. **Claiming an issue**:
   - Check that no other contributor is assigned or actively working on it.
   - Post a comment on the issue with a brief 1-2 sentence proposal on your approach.
   - Wait for maintainer assignment before starting deep work to avoid collision.
4. For comprehensive guidance on repository layout and environment details, see the authoritative root [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## Contribution Workflow & Review SLAs

1. **Fork** the repository (or clone if you have direct access).
2. **Create a branch** from `main` using the naming conventions below.
3. **Implement** the smallest change that satisfies the issue, with tests.
4. **Run local checks** (see [Testing](#testing)).
5. **Open a pull request** into `main` with a clear title and description.
6. **Review SLAs (Service Level Agreements)**:
   - **Initial Triage**: 24–48 business hours.
   - **First Review**: Within 3 business days (72 hours).
   - **Follow-up Review**: Within 2 business days (48 hours).
   - **Merge**: Within 24 hours of final approval.
7. **Respond to review feedback** promptly; reviewers will test and verify your PR.

---

## Definition of Done (DoD)

Every PR must satisfy the following checklist before merge:

- [ ] All issue acceptance criteria are 100% satisfied.
- [ ] New unit tests accompany contract logic or frontend component changes.
- [ ] All CI checks pass:
  - `cargo test`, `cargo fmt --check`, `cargo clippy -- -D warnings`
  - `npm run lint`, `npm run build`
- [ ] Documentation updated if API, storage, or workflows are touched.
- [ ] Clean commit history adhering to `feat(<module>): ...` or `fix(<module>): ...`.
- [ ] Issue linked via `Closes #<ID>` or `Fixes #<ID>`.

---

## Branching and Commits

### Branch Naming

| Prefix      | Use Case            | Example                     |
| ----------- | ------------------- | --------------------------- |
| `feat/`     | New feature         | `feat/freighter-wallet`     |
| `fix/`      | Bug fix             | `fix/approval-counter`      |
| `contract/` | Contract changes    | `contract/proposal-expiry`  |
| `docs/`     | Documentation       | `docs/architecture-diagram` |
| `chore/`    | Config, CI, tooling | `chore/dependabot-config`   |
| `test/`     | Tests only          | `test/execute-edge-cases`   |

### Commit Messages

- Use imperative mood: `Add`, `Fix`, `Update` — not `Added`, `Fixed`
- Keep the subject line ≤ 72 characters
- Add a blank line + body when explaining a non-obvious "why"

### Pull Request Description & Example

Include:

1. **What** changed (high level)
2. **Why** it was needed — link the issue (`Fixes #N` or `Refs #N`)
3. **How to verify** (commands you ran, test evidence)
4. **Definition of Done checklist**

#### Example PR Description:

```markdown
## Title: feat(docs): update multisig onboarding guide (#305)

### Summary
Clarifies step-by-step wallet connection and funding steps for Testnet co-owners.

### Changes
- Updated `docs/guides/connecting-your-wallet.md` with visual walkthrough embed.
- Added Friendbot faucet recovery instructions.

### Verification
- Tested all documentation links locally.
- Verified markdown rendering.

### Checklist
- [x] Meets acceptance criteria for #305
- [x] Links verified
- [x] Definition of Done satisfied

Closes #305
```

Use **Draft PRs** for early feedback when the change is not yet polished.

---

## Coding Standards

### TypeScript / React (`frontend/`)

- Avoid `any` — use explicit types and narrow unions.
- Prefer small, composable components; lift state only as high as needed.
- Use semantic HTML and label all form controls (accessibility).
- Follow existing Tailwind patterns; avoid one-off inline styles.
- Use `BigInt` (not `Number`) for all on-chain token amounts — see [Architecture](./ARCHITECTURE.md#7-token-handling).

### Rust / Soroban (`contracts/`)

- Name storage keys, types, and public functions clearly.
- Document non-obvious invariants in comments near the enforcement point.
- Return typed errors (`ContractError`) — never panic on user-controlled inputs.
- Use `checked_add` / `checked_sub` for all arithmetic; return `ArithmeticError` on overflow.
- Extend TTLs (`bump_instance` / `bump_persistent`) whenever you read from storage.

### General

- Match the style of surrounding code.
- Do not commit private keys, seed phrases, or `.env` files.
- Do not add production-network values (mainnet RPC URLs, mainnet contract IDs) to the codebase.

---

## Testing

Run these checks before opening a PR:

```bash
# Contract
cd contracts/accord
cargo fmt --check
cargo clippy -- -D warnings
cargo test

# Frontend (from repo root)
cd frontend
npm run lint
npm run build
```

All checks must pass (exit 0) before a PR can be merged.

### Adding Contract Tests

- Add tests in `contracts/accord/src/test.rs`.
- Test positive paths (happy flow) AND negative paths (error cases).
- Use `env.mock_all_auths()` for simplicity or `env.mock_auths()` when testing auth specifics.
- Set ledger timestamps explicitly with `env.ledger().set(...)` for deadline-sensitive tests.

### Adding Frontend Tests

The project currently uses manual verification for UI changes. If you add a test runner (`vitest`, `@testing-library/react`), update this section and the CI workflow.

---

## Documentation

- Update `README.md` when setup steps, prerequisites, or architecture changes.
- Update `docs/CONTRACT_API.md` when adding or changing contract functions.
- Update `docs/ARCHITECTURE.md` for structural changes to data flow or storage layout.
- For small behavior changes, a clear PR description is sufficient.

---

## Security

Do not open public GitHub issues for unfixed security vulnerabilities.

Use GitHub's private **Security Advisory** flow (Security tab → "Report a vulnerability"). See [`docs/SECURITY.md`](./SECURITY.md) for full disclosure policy.

---

## License

By contributing, you agree your contributions are licensed under the MIT license. See [LICENSE](../LICENSE).
