# Mobile App

The Accord mobile app lets owners review and approve proposals on the go. It is a
native iOS/Android app built with **Expo + React Native + TypeScript** and reads the
**same deployed Soroban contract** as the web frontend.

Source: [`mobile/`](../mobile) · Stack: Expo SDK 58, React 19, React Native 0.88,
`@stellar/stellar-sdk` 17 (the same SDK version family used by `frontend/`).

## What is in scope

| Capability | Status |
|---|---|
| Connect an owner wallet (public address only; no secret key handling) | ✅ |
| Read proposals, quorum progress and your prior approvals from the contract | ✅ |
| View proposal details and approve with a Stellar wallet deep link | ✅ |
| Share the deployed contract, RPC and network settings with the web app | ✅ |
| Create proposals / manage owners / recurring payments | ❌ (web app only) |

## Same contract, same interaction patterns

The mobile client in [`mobile/src/lib/contract.ts`](../mobile/src/lib/contract.ts)
uses the same read/write pattern as
[`frontend/src/lib/contract.ts`](../frontend/src/lib/contract.ts) and
[`frontend/src/lib/submit.ts`](../frontend/src/lib/submit.ts):

- reads are `simulateTransaction` calls against `get_proposal`,
  `get_proposals_paged`, `get_threshold`, `get_total_proposals`,
  `get_proposal_approval_progress` and `has_approved`;
- writes are built with `TransactionBuilder` + `Contract.call`, simulated,
  assembled with `rpc.assembleTransaction`, signed **outside the app**, then
  submitted and polled until confirmed.

The default configuration points at the same testnet RPC and contract ID as the
web app's `.env.example` / README deployment, so an unconfigured build still
reads the correct contract. Configuration is injected at build time through
`EXPO_PUBLIC_*` variables; never put a secret key in these.

| Web app (`frontend/.env`) | Mobile (`mobile/.env` or EAS env) | Purpose |
|---|---|---|
| `VITE_SOROBAN_RPC_URL` | `EXPO_PUBLIC_SOROBAN_RPC_URL` | Soroban RPC endpoint |
| `VITE_NETWORK_PASSPHRASE` | `EXPO_PUBLIC_NETWORK_PASSPHRASE` | Network passphrase |
| `VITE_CONTRACT_ADDRESS` | `EXPO_PUBLIC_CONTRACT_ADDRESS` | Deployed Accord contract ID |
| `VITE_SIM_SOURCE` | `EXPO_PUBLIC_SIM_SOURCE` | Funded account used as simulation source |
| — | `EXPO_PUBLIC_WALLET_CALLBACK_URL` | Deep link the wallet returns the signed XDR to (default `accord://wallet/callback`) |

`mobile/src/config.ts::readConfig()` is the only place that reads these values and
is unit-tested, including a test that pins the default contract ID.

### Entrypoint argument order

`contracts/accord/src/lib.rs` is authoritative. The mobile client follows it:

```
approve(approver: Address, proposal_id: u64)
has_approved(proposal_id: u64, owner: Address)
```

`mobile/src/lib/contract.test.ts` asserts the encoded argument order for both
calls so a future refactor cannot silently swap them.

## Wallet and approval flow

1. The owner pastes their Stellar public key (`G...`). It is validated with
   `StrKey.isValidEd25519PublicKey` and stored in `expo-secure-store`.
2. Proposal lists are paginated with `get_proposals_paged`; prior approvals are
   read with `has_approved` for the connected owner.
3. Tapping **Open wallet to approve** builds and simulates `approve`, then opens
   a [SEP-0007](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md)
   deep link: `web+stellar:tx?xdr=<assembled base64 XDR>&callback=accord://wallet/callback&msg=...`.
4. The wallet signs and redirects to the callback with `signed_xdr`. The app
   compares the signed transaction hash with the prepared transaction hash
   (rejecting any modified transaction) before submitting to the RPC.
5. If the wallet does not support return links, the owner can paste the signed
   XDR manually in the detail screen. The same hash check applies.

No private key, seed phrase or signing secret is ever read, stored or transmitted
by the mobile app.

## Setup and local development

Prerequisites: Node.js 20+, npm 10+, Xcode (iOS) and/or Android Studio (Android),
and [EAS CLI](https://docs.expo.dev/eas/) for release builds.

```bash
cd mobile
npm ci
cp ../frontend/.env.example .env            # optional: copy RPC/network values
# rename VITE_* keys to EXPO_PUBLIC_* and set EXPO_PUBLIC_CONTRACT_ADDRESS
npm start                                   # Metro bundler / Expo Go QR code
npm run ios                                 # iOS simulator
npm run android                             # Android emulator
```

Expo Go can load the JavaScript bundle, but wallet deep-link callbacks require a
development build with the `accord` URL scheme registered. Use
`npx expo run:ios` / `npx expo run:android`, or `eas build --profile development`.

## Tests

```bash
cd mobile
npm run typecheck   # strict TypeScript, no emit
npm test            # 25 unit tests via Node's built-in test runner
```

The test suite covers configuration defaults/overrides, Soroban value mapping
(statuses, transfer payloads, approval progress), SEP-0007 URI construction and
callback parsing, deep-link integrity verification, session persistence and the
contract client's entrypoints, argument order, transaction preparation and
submission. No network access or device is required. Tests are compiled with
`tsc` and executed with the built-in `node:test` runner, so the mobile project
adds no test-runner package with npm install scripts.

`mobile-ci.yml` runs both commands for every PR touching `mobile/**`.

## Build and release

Builds are handled by [Expo Application Services (EAS)](https://docs.expo.dev/eas/).
Profiles are defined in [`mobile/eas.json`](../mobile/eas.json):

```bash
cd mobile
npm ci
npx eas-cli login

# Internal test build
npm run build:ios -- --profile preview
npm run build:android -- --profile preview

# Store build (set production EXPO_PUBLIC_* env values in eas.json or EAS secrets)
npm run build:ios -- --profile production
npm run build:android -- --profile production

# Upload the most recent build to the stores
npm run submit:ios
npm run submit:android
```

Release checklist:

1. Bump `version` in `mobile/app.json` (and `mobile/package.json`).
2. Point `EXPO_PUBLIC_CONTRACT_ADDRESS` / `EXPO_PUBLIC_NETWORK_PASSPHRASE` at the
   intended network and verify `npm test` passes (the default-contract test
   intentionally pins testnet; update it consciously when promoting to mainnet).
3. Run `npm run typecheck && npm test`.
4. Produce preview builds and smoke-test connect → read → approve on both iOS
   and Android with a funded testnet owner.
5. Build with the `production` profile and submit with `npm run submit:*`.
6. Record the build hash / release tag in the repository CHANGELOG.

## Project layout

```
mobile/
├── App.tsx                      # screen state, wallet session, approval orchestration
├── index.ts / src/polyfills.ts  # Buffer + CSPRNG polyfills for the Stellar SDK
├── app.json / eas.json          # Expo config (URL scheme) and build profiles
└── src/
    ├── config.ts                # EXPO_PUBLIC_* configuration + contract defaults
    ├── components/              # connect, proposal list and detail screens
    └── lib/
        ├── contract.ts          # Soroban reads + approval preparation/submission
        ├── mapping.ts           # raw ScVal-native → UI model (mirrors web app)
        ├── session.ts           # storage-agnostic wallet session helpers
        ├── sessionStorage.ts    # expo-secure-store adapter
        └── wallet.ts            # address checks + SEP-0007 link/hash helpers
```
