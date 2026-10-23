# Supply-Chain Policy

Accord Protocol controls real funds, so an unexpected or malicious dependency
update is a direct risk to them. This policy defines what we pin, what we verify,
and how a deviation gets approved. It is enforced in CI by
[`scripts/check-supply-chain.mjs`](../scripts/check-supply-chain.mjs) and the
[Supply-chain policy workflow](../.github/workflows/supply-chain.yml).

## Rationale

| Threat | Control |
| --- | --- |
| A maintainer account or registry is compromised and a new version is published under an existing name | Resolved versions are pinned in committed lockfiles; CI installs only what the lockfile says (`--locked`, `npm ci`). Upgrades are explicit reviewed PRs. |
| A package is swapped or tampered with after review | Lockfiles carry content hashes (Cargo `checksum`, npm `sha512` `integrity`); the check fails if any are missing. |
| A dependency is redirected to a git branch, tarball URL or alternate registry | Only crates.io and registry.npmjs.org are allowed sources. |
| A mutable CI action tag (`@v2`, `@stable`) is repointed | Third-party actions must be pinned to a full commit SHA. |
| A release binary used in CI is replaced | Downloaded tools are verified against the publisher's checksum file. |
| A malicious install script runs in CI | Provenance job installs with `--ignore-scripts`. |

## Rules

Each rule has an ID used by exceptions.

| Rule ID | Requirement | Enforced by |
| --- | --- | --- |
| `lockfile-missing` | `Cargo.lock` and a `package-lock.json` next to every tracked `package.json` are committed. | `check-supply-chain.mjs` |
| `lockfile-integrity` | Every npm lockfile package resolves from `registry.npmjs.org` and has a `sha512` integrity hash (packages bundled inside a verified parent tarball are exempt). | `check-supply-chain.mjs` |
| `cargo-source` | Every package in `Cargo.lock` comes from crates.io and has a checksum. `deny.toml` `[sources]` denies unknown registries and git sources. | `check-supply-chain.mjs`, `cargo deny check sources` |
| `manifest-spec` | `package.json` dependencies are registry version ranges: no `*`, `latest`, git, GitHub-shorthand or URL specs. The exact version is fixed by the lockfile. `soroban-sdk` is additionally pinned with `=` in the workspace `Cargo.toml`. | `check-supply-chain.mjs` |
| `cargo-unlocked` | `cargo build/test/check/clippy/run/doc/bench/install/llvm-cov` in workflows pass `--locked`. | `check-supply-chain.mjs` |
| `npm-install` | Workflows use `npm ci`, never `npm install`. | `check-supply-chain.mjs` |
| `action-unpinned` | Third-party GitHub Actions are pinned to a 40-character commit SHA. First-party `actions/*` and `github/*` may use version tags. | `check-supply-chain.mjs` |

## Provenance verification

Verification is applied wherever the ecosystem supports it:

- **npm** — `npm audit signatures` verifies registry signatures and, where a
  package publishes one, its provenance attestation, for `frontend/` and
  `indexer/` after `npm ci --ignore-scripts`.
- **Cargo** — Cargo verifies each crate against the `checksum` in `Cargo.lock`
  when built with `--locked`; `cargo metadata --locked` fails if the lockfile is
  out of date, and `cargo deny check sources` rejects non-crates.io sources.
  crates.io has no publisher-signature scheme, so checksum + source restriction
  is the strongest available check.
- **Release binaries** — the Gitleaks binary is checked against the checksum
  file published with its release before it runs.
- **Advisories and licenses** — `cargo audit` and `cargo deny check` run in
  [`contract.yml`](../.github/workflows/contract.yml); Dependabot opens weekly
  update PRs for Cargo, npm and GitHub Actions
  ([`dependabot.yml`](../.github/dependabot.yml)).

## Updating dependencies

1. Update through a PR (usually Dependabot). The lockfile diff is part of the review.
2. Review new or changed packages, especially new transitive packages and any
   that gained install scripts.
3. CI must pass the supply-chain workflow before merge.

## Exceptions

A rule may be bypassed only through an entry in
[`supply-chain/exceptions.json`](../supply-chain/exceptions.json):

```json
{
  "id": "SC-014",
  "rule": "action-unpinned",
  "target": "owner/action@ref",
  "reason": "Why the rule cannot be met and what removes the exception.",
  "requestedBy": "github-handle",
  "added": "2026-10-23",
  "expires": "2027-04-01"
}
```

- `rule` and `target` must match the finding exactly (the checker prints both).
- Exceptions expire: `expires` is at most 180 days after `added`. An expired
  exception fails CI until the finding is fixed or the exception is renewed
  through review.
- A stale exception (one that no longer matches a finding) fails CI, so
  exceptions are removed as soon as they are fixed.
- **Review is enforced.** The `exception-review` job fails any PR that changes
  `supply-chain/exceptions.json` or `scripts/check-supply-chain.mjs` until
  someone other than the author has approved it. The PR approval is the
  recorded sign-off. Mark that job as a required status check in branch
  protection.

## Known gaps (tracked as exceptions)

- Third-party Actions are still tag-pinned. Each is listed as an `action-unpinned`
  exception; resolve the SHA, pin it, and delete the entry. Dependabot keeps SHA
  pins current.
- `packages/sdk` and `examples/multisig-dapp` have no committed lockfile.
- CI tool installs (`cargo install cargo-audit/cargo-deny --locked`) use the
  latest release; their dependencies are locked but the tool version is not.
