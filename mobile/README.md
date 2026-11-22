# Accord Protocol — Mobile

Expo / React Native client for reviewing and approving Accord multisig proposals
against the **same Soroban contract** as the web app.

Full documentation: [`docs/MOBILE.md`](../docs/MOBILE.md).

## Quick start

```bash
cd mobile
npm ci
npm run typecheck
npm test
npm start            # Expo dev server
npm run ios          # iOS simulator
npm run android      # Android emulator
```

## Configuration

Public build-time settings use `EXPO_PUBLIC_*` names and map 1:1 to the web app's
`VITE_*` settings. Defaults match the repository's testnet deployment:

```bash
EXPO_PUBLIC_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
EXPO_PUBLIC_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
EXPO_PUBLIC_CONTRACT_ADDRESS=CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS
EXPO_PUBLIC_SIM_SOURCE=<funded-testnet-public-key>
EXPO_PUBLIC_WALLET_CALLBACK_URL=accord://wallet/callback
```

Never put a secret key in the environment or bundle — signing happens in an
external Stellar wallet via a SEP-0007 deep link.

## Release

`eas.json` defines `development`, `preview` and `production` profiles:

```bash
npm run build:ios -- --profile preview
npm run build:android -- --profile production
npm run submit:ios
```

See [`docs/MOBILE.md`](../docs/MOBILE.md#build-and-release) for the full release
checklist and the wallet/approval flow.
