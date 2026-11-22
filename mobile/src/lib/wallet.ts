import { StrKey, TransactionBuilder } from "@stellar/stellar-sdk";

export interface StellarDeepLink {
  /** Base64 XDR of the assembled transaction to be signed. */
  xdr: string;
  /** URL the wallet redirects to after signing. */
  callback: string;
  /** Optional user-facing prompt shown by the wallet. */
  message?: string;
  /** Wallet deep-link scheme. `web+stellar` is the SEP-0007 standard. */
  scheme?: string;
}

export interface WalletCallbackResult {
  signedXdr?: string;
  error?: string;
}

/**
 * Builds a SEP-0007 signing request. The wallet never receives a secret key:
 * it displays the assembled transaction, asks the owner to sign, and returns
 * the signed XDR to the callback URL.
 */
export function buildStellarTxUri(options: StellarDeepLink): string {
  if (!options.xdr) throw new Error("A transaction XDR is required.");
  if (!options.callback) throw new Error("A wallet callback URL is required.");
  const scheme = options.scheme ?? "web+stellar";
  const params = [
    `xdr=${encodeURIComponent(options.xdr)}`,
    `callback=${encodeURIComponent(options.callback)}`,
  ];
  if (options.message) params.push(`msg=${encodeURIComponent(options.message)}`);
  return `${scheme}:tx?${params.join("&")}`;
}

/** Parses either a full `accord://...?signed_xdr=...` URL or a raw query string. */
export function parseWalletCallback(input: string): WalletCallbackResult {
  const query = input.includes("?") ? input.slice(input.indexOf("?") + 1) : input;
  const params: Record<string, string> = {};
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const separator = pair.indexOf("=");
    const key = separator === -1 ? pair : pair.slice(0, separator);
    const value = separator === -1 ? "" : pair.slice(separator + 1);
    try {
      params[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, " "));
    } catch {
      params[key] = value;
    }
  }
  const signedXdr = params.signed_xdr ?? params.signedTxXdr ?? params.xdr;
  const error = params.error ?? params.error_code ?? params.errorCode;
  const result: WalletCallbackResult = {};
  if (signedXdr) result.signedXdr = signedXdr;
  if (error) result.error = String(error);
  return result;
}

export function isValidWalletAddress(address: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(address);
  } catch {
    return false;
  }
}

export function isValidContractId(contractId: string): boolean {
  try {
    return StrKey.isValidContract(contractId);
  } catch {
    return false;
  }
}

/** Stellar SDK v17 returns a Uint8Array from `hash()`, which needs explicit hex encoding. */
export function hashToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Hash of a signed transaction in hex, or null when the XDR is malformed. */
export function signedTransactionHash(
  signedXdr: string,
  networkPassphrase: string,
): string | null {
  try {
    return hashToHex(TransactionBuilder.fromXDR(signedXdr, networkPassphrase).hash());
  } catch {
    return null;
  }
}

/**
 * Guards against a wallet callback returning a different transaction than the
 * one the owner approved. A hash comparison is sufficient: any changed field
 * changes the hash.
 */
export function verifySignedTransaction(
  unsignedXdr: string,
  signedXdr: string,
  networkPassphrase: string,
): boolean {
  const expected = signedTransactionHash(unsignedXdr, networkPassphrase);
  return Boolean(expected && expected === signedTransactionHash(signedXdr, networkPassphrase));
}
