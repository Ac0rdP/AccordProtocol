/**
 * Mobile build/runtime configuration.
 *
 * Expo inlines every `EXPO_PUBLIC_*` variable into the bundle at build time.
 * These are public network settings only — never put a secret key here. The
 * defaults intentionally match the web app's `.env.example` and the deployed
 * testnet contract in the repository README so the mobile app reads the exact
 * same contract as the web app unless explicitly overridden for a deployment.
 */

export interface MobileConfig {
  rpcUrl: string;
  networkPassphrase: string;
  contractId: string;
  /** Funded testnet account used as the source of read-only simulations. */
  simSource: string;
  /** Deep link the signing wallet redirects to with the signed transaction. */
  walletCallbackUrl: string;
  network: "TESTNET" | "PUBLIC";
}

export type Env = Record<string, string | undefined>;

// Keep in sync with frontend/.env.example and README's Live Deployment table.
export const DEFAULT_TESTNET_CONTRACT_ID =
  "CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS";
export const DEFAULT_RPC_URL = "https://soroban-testnet.stellar.org";
export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const PUBLIC_PASSPHRASE = "Public Global Stellar Network ; September 2015";

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}

export function readConfig(env: Env = {}): MobileConfig {
  const networkPassphrase =
    firstNonEmpty(env.EXPO_PUBLIC_NETWORK_PASSPHRASE) ?? TESTNET_PASSPHRASE;
  const network = networkPassphrase === PUBLIC_PASSPHRASE ? "PUBLIC" : "TESTNET";

  return {
    rpcUrl: firstNonEmpty(env.EXPO_PUBLIC_SOROBAN_RPC_URL) ?? DEFAULT_RPC_URL,
    networkPassphrase,
    contractId:
      firstNonEmpty(env.EXPO_PUBLIC_CONTRACT_ADDRESS) ?? DEFAULT_TESTNET_CONTRACT_ID,
    simSource: firstNonEmpty(env.EXPO_PUBLIC_SIM_SOURCE) ?? "",
    walletCallbackUrl:
      firstNonEmpty(env.EXPO_PUBLIC_WALLET_CALLBACK_URL) ?? "accord://wallet/callback",
    network,
  };
}

const processEnv: Env =
  typeof process !== "undefined" && process.env ? (process.env as Env) : {};

export const config = readConfig(processEnv);
