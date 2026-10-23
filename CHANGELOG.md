# Changelog

Contributors: add new work under `Unreleased` using the `Added`, `Changed`, `Fixed`, and `Removed` subsections, then move those entries into a version section when a release is cut.

All notable changes to this project will be documented in this file. The format follows Keep a Changelog so each release records what was introduced, adjusted, corrected, or removed in one consistent place.

## [Unreleased]

### Added
- Public status page for the indexer and the analytics API: a structured `/status` endpoint on both services, a health-mapping and rendering script (`scripts/status-page.mjs`), a scheduled workflow that probes the health endpoints and publishes the page, daily availability history and incident notes (`docs/status/`), and the documentation in `docs/STATUS.md`.
- In-app "What's new" panel that reads this changelog at build time, lists recent entries by release, badges entries the user has not seen yet, and links issue references and documentation paths to GitHub.
- Release workflow (`release.yml`) that gates on all test suites, builds and attaches the contract artifact with its manifest, publishes the SDK package to GitHub Packages, and generates release notes from a `v*` tag (#822).
- Nightly full-suite workflow (`nightly.yml`) covering the contract, frontend, indexer, analytics API, and Playwright E2E suites, with per-component attribution and a single tracked failure issue (#820).
- Frontend pull-request preview deployments (`preview.yml`) built from a deterministic seed dataset and torn down when the PR closes (#819).
- `scripts/seed-preview.mjs` and `frontend/src/lib/previewSeed.ts` to serve seeded analytics data in preview builds.
- `docs/CI.md` documenting the workflow map, caching/concurrency policy, and required repository settings.
- Indexer storage is abstracted behind one interface with an opt-in Postgres backend (`STORE_BACKEND=postgres`) and versioned migrations; SQLite stays the default and the store test suites run against both (#799).
- GraphQL endpoint (`POST /graphql`) over proposals, owners, spends and treasury flows with pagination, filtering and depth/complexity/size limits (#801).
- Prometheus `/metrics`, `/healthz` and `/readyz` on the indexer and analytics API, tracking ingestion lag, events processed, errors and request latency (#802).
- Signed webhook push delivery of indexed events with exponential-backoff retries and a dead-letter queue (#800).
- Frontend analytics response types, HTTP client, treasury polling hook, and currency, percentage, and UTC date formatting helpers (#656–#659).

- Indexer events carry a stable dedupe key (`ledger:transaction:eventIndex`) enforced by a unique index in both stores, so reprocessing, backfill and reindex never double-count (#807).
- Analytics alerting engine: configurable spend-threshold and approval-pattern rules, evaluation of newly indexed events, `log`/`email` notification channels, cooldowns, a storm cap and per-event dedupe, `GET /alerts` and `GET /alerts/rules` (#808).
- OpenAPI 3.0.3 specification for the analytics API (`docs/analytics-api.openapi.json`) with pagination, filter, sort and invalid-parameter contract tests, and a CI check that fails when the spec drifts from the implementation (#809).
- Per-client rate limiting (`429 RATE_LIMITED`), short-lived response caching invalidated by newly indexed events, and Prometheus metrics for both on the analytics API (#810).

### Changed
- CI workflows now use concurrency groups that cancel superseded pull-request runs, and cache Rust builds, npm installs, and Playwright browsers (#821).
- Event and treasury analytics polling share serial requests, capped exponential backoff, and cleanup.

### Fixed
- Repair merge damage that stopped the indexer tests (`test/helpers.js`, `test/ledger.test.js`, `src/ledger.js` held two interleaved copies) and the analytics API from compiling (missing report/mail dependencies, two incompatible `AppState` definitions, dropped `/reports` routes).
- Restore green frontend CI: sync `frontend/package-lock.json` so `npm ci` resolves the `@emnapi/*` optional peer dependencies, and classify the new `submit` helpers (`mapSubmissionError`, `withSubmissionRetry`) as pure in the contract harness guard.

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
