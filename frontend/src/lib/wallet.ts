import { Horizon } from "@stellar/stellar-sdk";
import {
  isConnected,
  getAddress,
  requestAccess,
  signTransaction,
  getNetworkDetails,
} from "@stellar/freighter-api";

export type WalletResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export async function freighterInstalled(): Promise<boolean> {
  try {
    const res = await isConnected();
    return "isConnected" in res ? (res as { isConnected: boolean }).isConnected : false;
  } catch {
    return false;
  }
}

export async function connectWallet(): Promise<WalletResult<string>> {
  try {
    // requestAccess prompts the user to authorize the dApp
    const res = await requestAccess();
    if ("error" in res && res.error) return { ok: false, error: String(res.error) };
    if ("address" in res) return { ok: true, value: (res as { address: string }).address };
    return { ok: false, error: "Unknown Freighter response" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Connect failed" };
  }
}

export async function getWalletAddress(): Promise<WalletResult<string>> {
  try {
    const res = await getAddress();
    if ("error" in res && res.error) return { ok: false, error: String(res.error) };
    if ("address" in res) return { ok: true, value: (res as { address: string }).address };
    return { ok: false, error: "No address returned" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Get address failed" };
  }
}

export async function signTx(
  xdrStr: string,
  network: "TESTNET" | "PUBLIC" = "TESTNET"
): Promise<WalletResult<string>> {
  try {
    const passphrase =
      network === "TESTNET"
        ? "Test SDF Network ; September 2015"
        : "Public Global Stellar Network ; September 2015";
    const res = await signTransaction(xdrStr, { networkPassphrase: passphrase });
    if ("error" in res && res.error) return { ok: false, error: String(res.error) };
    if ("signedTxXdr" in res)
      return { ok: true, value: (res as { signedTxXdr: string }).signedTxXdr };
    return { ok: false, error: "No signed XDR returned" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Sign failed" };
  }
}

export async function getWalletNetworkPassphrase(): Promise<string | null> {
  try {
    const details = await getNetworkDetails();
    return details.networkPassphrase ?? null;
  } catch {
    return null;
  }
}

export async function getAccountBalances(address: string): Promise<{ xlm: string; usdc: string }>{
  const server = new Horizon.Server("https://horizon-testnet.stellar.org");
  const acct = await server.loadAccount(address);
  let xlm = "0.00";
  let usdc = "0.00";

  for (const b of acct.balances) {
    // native XLM
    if ((b as any).asset_type === "native") {
      const parsed = parseFloat((b as any).balance || "0");
      if (!Number.isNaN(parsed)) xlm = parsed.toFixed(2);
    } else if ((b as any).asset_code === "USDC") {
      const parsed = parseFloat((b as any).balance || "0");
      if (!Number.isNaN(parsed)) usdc = parsed.toFixed(2);
    }
  }

  return { xlm, usdc };
}
