/**
 * Freighter Wallet Adapter for Example dApp
 */

import {
  getAddress,
  isConnected,
  requestAccess,
  signTransaction as freighterSignTransaction,
} from "@stellar/freighter-api";
import { Transaction } from "@stellar/stellar-sdk";

export async function checkFreighterInstalled(): Promise<boolean> {
  try {
    const res = await isConnected();
    return "isConnected" in res ? (res as { isConnected: boolean }).isConnected : false;
  } catch {
    return false;
  }
}

export async function connectFreighter(): Promise<string> {
  const access = await requestAccess();
  if ("error" in access && access.error) {
    throw new Error(String(access.error));
  }
  if ("address" in access && access.address) {
    return String(access.address);
  }
  const addr = await getAddress();
  if ("address" in addr && addr.address) {
    return String(addr.address);
  }
  throw new Error("Could not retrieve Freighter wallet address.");
}

export async function signWithFreighter(
  tx: Transaction,
  networkPassphrase: string
): Promise<Transaction> {
  const xdrStr = tx.toXDR();
  const res = await freighterSignTransaction(xdrStr, { networkPassphrase });
  if ("error" in res && res.error) {
    throw new Error(String(res.error));
  }
  if ("signedTxXdr" in res && res.signedTxXdr) {
    return new Transaction(res.signedTxXdr, networkPassphrase);
  }
  throw new Error("Freighter did not return a signed transaction XDR.");
}
