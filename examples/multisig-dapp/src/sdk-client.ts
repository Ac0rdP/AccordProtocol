import { AccordClient } from "@accord-protocol/sdk";
import type { Transaction } from "@stellar/stellar-sdk";
import { signWithFreighter } from "./wallet.js";

const CONTRACT_ID =
  (import.meta.env.VITE_CONTRACT_ID as string) ||
  "CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS";

const RPC_URL =
  (import.meta.env.VITE_SOROBAN_RPC_URL as string) ||
  "https://soroban-testnet.stellar.org";

const NETWORK_PASSPHRASE =
  (import.meta.env.VITE_NETWORK_PASSPHRASE as string) ||
  "Test SDF Network ; September 2015";

export function createAccordClient(userAddress?: string): AccordClient {
  return new AccordClient({
    contractId: CONTRACT_ID,
    rpcUrl: RPC_URL,
    networkPassphrase: NETWORK_PASSPHRASE,
    sourceAccount: userAddress,
    signTransaction: async (tx: Transaction) => {
      return signWithFreighter(tx, NETWORK_PASSPHRASE);
    },
  });
}
