# ADR-0009: Frontend Stack and Freighter Browser Wallet Integration

- **Status**: accepted (backfilled and reconstructed record)
- **Date**: 2026-05-04 (initial scaffold in commit `94adbe3`), updated 2026-09-26 (Freighter integration in commit `8a35476` / PR #717)
- **Type**: Client Architecture

## Context

Treasury co-owners require an intuitive, accessible web dashboard to monitor treasury balances, create proposals, view approval bars, and sign transactions with hardware or browser-based keypairs.

## Decision

1. **Technology Stack**:
   - Built with **React 19**, **TypeScript**, **Vite**, and **Tailwind CSS**.
   - State management utilizes custom React hooks (`useContract`, `useWallet`, `useRoles`, `useEventPolling`) paired with polling over Soroban RPC.
2. **Wallet Connection**:
   - Integrates with the **Freighter** browser wallet extension using `@stellar/freighter-api` and `@stellar/stellar-sdk`.
   - The frontend builds transactions, requests hardware/software signature from Freighter, simulates the call against the configured Soroban RPC endpoint, and submits the assembled transaction envelope.
3. **Generated Contract Types**:
   - A build script (`scripts/generate-contract-types.py`) parses the contract source and generates TypeScript definitions (`frontend/src/types/contract.generated.ts`) to ensure frontend and on-chain ABI types never desynchronize.

## Consequences

### Positive
- Direct user control of signing keys through standard Stellar ecosystem wallets without intermediary custody.
- Strict end-to-end typing between contract and client UI components.
- Fast local development and responsive bundle builds with Vite.

### Negative / Trade-offs
- Users without Freighter installed must install an extension or use CLI workflows.
- Polling directly against Soroban RPC can hit public testnet rate limits during high activity.

### Neutral
- End-to-end user flows are covered by Playwright and Vitest component suites.

## Alternatives Considered

- *Rationale not recorded; reconstructed from code and documentation.*

## Links & Evidence

- Manifest: `frontend/package.json`
- Source: `frontend/src/lib/wallet.ts`, `frontend/src/lib/contract.ts`, `frontend/src/types/contract.generated.ts`
- Documentation: `docs/ARCHITECTURE.md` §1 (System Overview), `frontend/docs/testing.md`
- Commits: `94adbe3` (2026-05-04), `8a35476` (2026-09-26)
