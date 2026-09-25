# Changelog

Contributors: add new work under `Unreleased` using the `Added`, `Changed`, `Fixed`, and `Removed` subsections, then move those entries into a version section when a release is cut.

All notable changes to this project will be documented in this file. The format follows Keep a Changelog so each release records what was introduced, adjusted, corrected, or removed in one consistent place.

## [Unreleased]

### Added
- Frontend analytics response types, HTTP client, treasury polling hook, and currency, percentage, and UTC date formatting helpers (#656–#659).

### Changed
- Event and treasury analytics polling share serial requests, capped exponential backoff, and cleanup.

### Fixed
- No unreleased fixes recorded yet.

### Removed
- No unreleased removals recorded yet.

## [0.1.0]

### Added
- The initial Soroban multisig contract with proposal creation, approvals, revocations, execution, deadline handling, and owner-only authorization.
- Threshold-based treasury governance so teams can operate with configurable M-of-N signer requirements instead of a single-key wallet.
- Owner management and threshold configuration flows so the multisig can evolve without redeploying the treasury state to a new contract.
- A web frontend for connecting Freighter, reviewing proposals, and interacting with the multisig from the browser on Stellar testnet.
- Supporting documentation for setup, deployment, security posture, contract architecture, and API-level contract behavior.

### Changed
- Project guidance and deployment steps were organized around a testnet-first operating model so contributors could verify contract and frontend behavior before attempting any broader rollout.

### Fixed
- Initial release hardening covered proposal expiry checks, threshold enforcement, and guardrails that prevent non-owners from performing multisig actions.

### Removed
- No features were removed in the initial release.
