import { StrKey } from "@stellar/stellar-sdk";
import type { WalletResult } from "./wallet";

export type WalletProviderId = "freighter" | "ledger" | "walletconnect" | "passkey";

export interface WalletSession {
  id: string;
  provider: WalletProviderId;
  address: string;
  label: string;
  derivationPath?: string;
  topic?: string;
  credentialId?: string;
  connectedAt: number;
}

export interface ConnectProviderOptions {
  label?: string;
  derivationPath?: string;
  pairingUri?: string;
  passkeyMode?: "login" | "register";
}

export interface LedgerBridge {
  getPublicKey: (derivationPath: string) => Promise<string>;
  signTransaction: (
    xdrStr: string,
    derivationPath: string,
    networkPassphrase: string
  ) => Promise<string>;
}

export interface WalletConnectBridge {
  connect: (pairingUri: string) => Promise<{ address: string; topic: string }>;
  signTransaction: (
    xdrStr: string,
    topic: string,
    networkPassphrase: string
  ) => Promise<string>;
  disconnect?: (topic: string) => Promise<void>;
}

export interface PasskeyBridge {
  register: (label: string) => Promise<{ address: string; credentialId: string }>;
  authenticate: () => Promise<{ address: string; credentialId: string }>;
  signTransaction: (
    xdrStr: string,
    credentialId: string,
    networkPassphrase: string
  ) => Promise<string>;
}

declare global {
  interface Window {
    __ACCORD_LEDGER__?: LedgerBridge;
    __ACCORD_WALLETCONNECT__?: WalletConnectBridge;
    __ACCORD_PASSKEY__?: PasskeyBridge;
  }
}

export const SESSIONS_STORAGE_KEY = "accord_wallet_sessions_v1";
export const ACTIVE_SESSION_STORAGE_KEY = "accord_active_wallet_session_v1";
export const DEFAULT_LEDGER_PATH = "44'/148'/0'";

const LEDGER_PATH_PATTERN = /^44'\/148'\/\d+'$/;

let activeSigningSession: WalletSession | null = null;

export function setActiveSigningSession(session: WalletSession | null): void {
  activeSigningSession = session;
}

export function getActiveSigningSession(): WalletSession | null {
  return activeSigningSession;
}

export function makeSessionId(provider: WalletProviderId, address: string): string {
  return `${provider}:${address}`;
}

export function getNetworkPassphrase(network: "TESTNET" | "PUBLIC" = "TESTNET"): string {
  return network === "TESTNET"
    ? "Test SDF Network ; September 2015"
    : "Public Global Stellar Network ; September 2015";
}

export function loadStoredSessions(): WalletSession[] {
  try {
    const raw = window.localStorage.getItem(SESSIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is WalletSession =>
        typeof item === "object" &&
        item !== null &&
        typeof item.id === "string" &&
        typeof item.provider === "string" &&
        typeof item.address === "string" &&
        typeof item.label === "string"
    );
  } catch {
    return [];
  }
}

export function saveStoredSessions(sessions: WalletSession[]): void {
  try {
    window.localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    // Ignore storage quota or private browsing errors
  }
}

export function loadActiveSessionId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveActiveSessionId(sessionId: string | null): void {
  try {
    if (sessionId) {
      window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, sessionId);
    } else {
      window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota or private browsing errors
  }
}

export function upsertSession(
  sessions: WalletSession[],
  incoming: WalletSession
): WalletSession[] {
  const existingIndex = sessions.findIndex((s) => s.id === incoming.id);
  if (existingIndex === -1) {
    return [...sessions, incoming];
  }
  const next = [...sessions];
  next[existingIndex] = { ...next[existingIndex], ...incoming };
  return next;
}

// ---------------------------------------------------------------------------
// Ledger Hardware Wallet (#973) — secret key never leaves the device
// ---------------------------------------------------------------------------

export function isValidLedgerPath(path: string): boolean {
  return LEDGER_PATH_PATTERN.test(path.trim());
}

export function isLedgerTransportSupported(): boolean {
  if (typeof window === "undefined") return false;
  if (window.__ACCORD_LEDGER__) return true;
  const nav = navigator as Navigator & { hid?: unknown; usb?: unknown };
  return Boolean(nav.hid || nav.usb);
}

export async function connectLedgerWallet(
  options: ConnectProviderOptions = {}
): Promise<WalletResult<WalletSession>> {
  const derivationPath = (options.derivationPath ?? DEFAULT_LEDGER_PATH).trim();
  if (!isValidLedgerPath(derivationPath)) {
    return {
      ok: false,
      error: "Invalid Stellar derivation path. Use format 44'/148'/0'.",
    };
  }

  if (!isLedgerTransportSupported()) {
    return {
      ok: false,
      error: "WebHID/WebUSB is not supported in this browser. Use a Chromium-based browser to connect Ledger.",
    };
  }

  try {
    if (window.__ACCORD_LEDGER__) {
      const address = await window.__ACCORD_LEDGER__.getPublicKey(derivationPath);
      if (!address) {
        return { ok: false, error: "Ledger did not return a public key." };
      }
      return {
        ok: true,
        value: {
          id: makeSessionId("ledger", address),
          provider: "ledger",
          address,
          label: options.label?.trim() || `Ledger (${derivationPath})`,
          derivationPath,
          connectedAt: Date.now(),
        },
      };
    }

    const nav = navigator as Navigator & {
      hid?: { requestDevice: (opts: { filters: Array<{ vendorId: number }> }) => Promise<Array<{ productName?: string }>> };
    };
    if (nav.hid) {
      const devices = await nav.hid.requestDevice({ filters: [{ vendorId: 0x2c97 }] });
      if (!devices || devices.length === 0) {
        return {
          ok: false,
          error: "No Ledger device selected. Unlock your Ledger and open the Stellar app.",
        };
      }
      return {
        ok: false,
        error:
          "Ledger device detected, but the Stellar APDU bridge is unavailable in this environment.",
      };
    }

    return {
      ok: false,
      error: "Connect your Ledger via USB, unlock it, and open the Stellar app.",
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to connect Ledger device.",
    };
  }
}

export async function signWithLedger(
  xdrStr: string,
  derivationPath: string = DEFAULT_LEDGER_PATH,
  network: "TESTNET" | "PUBLIC" = "TESTNET"
): Promise<WalletResult<string>> {
  if (!window.__ACCORD_LEDGER__) {
    return {
      ok: false,
      error: "Ledger device is not connected. Reconnect your Ledger to sign this transaction.",
    };
  }
  try {
    const signedTxXdr = await window.__ACCORD_LEDGER__.signTransaction(
      xdrStr,
      derivationPath,
      getNetworkPassphrase(network)
    );
    if (!signedTxXdr) {
      return { ok: false, error: "Ledger did not return a signed transaction." };
    }
    return { ok: true, value: signedTxXdr };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Ledger signing rejected or failed.",
    };
  }
}

// ---------------------------------------------------------------------------
// WalletConnect (#974) — mobile & desktop Stellar wallets, same signing flow
// ---------------------------------------------------------------------------

function randomHex(bytesLength: number): string {
  const bytes = new Uint8Array(bytesLength);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytesLength; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createWalletConnectPairingUri(): string {
  const topic = randomHex(16);
  const symKey = randomHex(32);
  return `wc:${topic}@2?relay-protocol=irn&symKey=${symKey}`;
}

export async function connectWalletConnect(
  options: ConnectProviderOptions = {}
): Promise<WalletResult<WalletSession>> {
  const pairingUri = options.pairingUri?.trim() || createWalletConnectPairingUri();
  if (!pairingUri.startsWith("wc:")) {
    return {
      ok: false,
      error: "Invalid WalletConnect URI. Expected a wc: pairing link.",
    };
  }

  if (!window.__ACCORD_WALLETCONNECT__) {
    return {
      ok: false,
      error:
        "WalletConnect relay client is not configured. Set VITE_WALLETCONNECT_PROJECT_ID or pair from a supported Stellar wallet.",
    };
  }

  try {
    const { address, topic } = await window.__ACCORD_WALLETCONNECT__.connect(pairingUri);
    if (!address || !topic) {
      return { ok: false, error: "WalletConnect pairing did not return an account." };
    }
    return {
      ok: true,
      value: {
        id: makeSessionId("walletconnect", address),
        provider: "walletconnect",
        address,
        label: options.label?.trim() || "WalletConnect",
        topic,
        connectedAt: Date.now(),
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "WalletConnect pairing failed.",
    };
  }
}

export async function signWithWalletConnect(
  xdrStr: string,
  topic: string,
  network: "TESTNET" | "PUBLIC" = "TESTNET"
): Promise<WalletResult<string>> {
  if (!window.__ACCORD_WALLETCONNECT__) {
    return {
      ok: false,
      error: "WalletConnect session is unavailable. Reconnect your wallet to sign.",
    };
  }
  try {
    const signedTxXdr = await window.__ACCORD_WALLETCONNECT__.signTransaction(
      xdrStr,
      topic,
      getNetworkPassphrase(network)
    );
    if (!signedTxXdr) {
      return { ok: false, error: "WalletConnect did not return a signed XDR." };
    }
    return { ok: true, value: signedTxXdr };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "WalletConnect signing rejected or failed.",
    };
  }
}

// ---------------------------------------------------------------------------
// Passkey Smart-Wallet Login (#975) — WebAuthn smart wallet, no extension
// ---------------------------------------------------------------------------

export function isPasskeySupported(): boolean {
  if (typeof window === "undefined") return false;
  if (window.__ACCORD_PASSKEY__) return true;
  return Boolean(
    typeof window.PublicKeyCredential !== "undefined" &&
      typeof navigator !== "undefined" &&
      navigator.credentials
  );
}

async function deriveSmartWalletAddress(rawId: ArrayBuffer): Promise<string> {
  const input = new Uint8Array(rawId);
  let digestBytes: Uint8Array;
  if (typeof crypto !== "undefined" && crypto.subtle?.digest) {
    const digest = await crypto.subtle.digest("SHA-256", input);
    digestBytes = new Uint8Array(digest);
  } else {
    digestBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) {
      digestBytes[i] = input[i % Math.max(input.length, 1)] ?? (i + 1);
    }
  }
  const payload = typeof Buffer !== "undefined" ? Buffer.from(digestBytes) : (digestBytes as unknown as Buffer);
  return StrKey.encodeContract(payload);
}

function toBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function connectPasskeyWallet(
  options: ConnectProviderOptions = {}
): Promise<WalletResult<WalletSession>> {
  if (!isPasskeySupported()) {
    return {
      ok: false,
      error: "Passkeys (WebAuthn) are not supported in this browser.",
    };
  }

  const mode = options.passkeyMode ?? "login";
  const label = options.label?.trim() || "Passkey Smart Wallet";

  try {
    if (window.__ACCORD_PASSKEY__) {
      const res =
        mode === "register"
          ? await window.__ACCORD_PASSKEY__.register(label)
          : await window.__ACCORD_PASSKEY__.authenticate();
      if (!res.address || !res.credentialId) {
        return { ok: false, error: "Passkey authentication did not return a smart-wallet address." };
      }
      return {
        ok: true,
        value: {
          id: makeSessionId("passkey", res.address),
          provider: "passkey",
          address: res.address,
          label,
          credentialId: res.credentialId,
          connectedAt: Date.now(),
        },
      };
    }

    const challenge = new Uint8Array(32);
    crypto.getRandomValues(challenge);
    const rpId = window.location.hostname || "localhost";

    if (mode === "register") {
      const userId = new Uint8Array(16);
      crypto.getRandomValues(userId);
      const cred = (await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { name: "Accord Protocol", id: rpId },
          user: {
            id: userId,
            name: label,
            displayName: label,
          },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          authenticatorSelection: {
            residentKey: "preferred",
            userVerification: "preferred",
          },
          timeout: 60_000,
        },
      })) as PublicKeyCredential | null;

      if (!cred) {
        return { ok: false, error: "Passkey registration was cancelled." };
      }
      const address = await deriveSmartWalletAddress(cred.rawId);
      return {
        ok: true,
        value: {
          id: makeSessionId("passkey", address),
          provider: "passkey",
          address,
          label,
          credentialId: toBase64Url(cred.rawId),
          connectedAt: Date.now(),
        },
      };
    }

    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge,
        rpId,
        userVerification: "preferred",
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;

    if (!assertion) {
      return { ok: false, error: "Passkey login was cancelled." };
    }
    const address = await deriveSmartWalletAddress(assertion.rawId);
    return {
      ok: true,
      value: {
        id: makeSessionId("passkey", address),
        provider: "passkey",
        address,
        label,
        credentialId: toBase64Url(assertion.rawId),
        connectedAt: Date.now(),
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Passkey authentication failed.",
    };
  }
}

export async function signWithPasskey(
  xdrStr: string,
  credentialId: string,
  network: "TESTNET" | "PUBLIC" = "TESTNET"
): Promise<WalletResult<string>> {
  if (window.__ACCORD_PASSKEY__) {
    try {
      const signedTxXdr = await window.__ACCORD_PASSKEY__.signTransaction(
        xdrStr,
        credentialId,
        getNetworkPassphrase(network)
      );
      if (!signedTxXdr) {
        return { ok: false, error: "Passkey signing did not return a signed transaction." };
      }
      return { ok: true, value: signedTxXdr };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Passkey signing failed.",
      };
    }
  }

  return {
    ok: false,
    error: "Passkey smart-wallet signer bridge is unavailable in this environment.",
  };
}

export async function signWithActiveSession(
  session: WalletSession,
  xdrStr: string,
  network: "TESTNET" | "PUBLIC" = "TESTNET"
): Promise<WalletResult<string>> {
  if (session.provider === "ledger") {
    return signWithLedger(xdrStr, session.derivationPath ?? DEFAULT_LEDGER_PATH, network);
  }
  if (session.provider === "walletconnect") {
    return signWithWalletConnect(xdrStr, session.topic ?? "", network);
  }
  if (session.provider === "passkey") {
    return signWithPasskey(xdrStr, session.credentialId ?? "", network);
  }
  return { ok: false, error: `Unsupported non-Freighter provider: ${session.provider}` };
}
