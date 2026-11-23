import type { WalletSession } from "./types";

const ADDRESS_KEY = "accord.mobile.wallet.address";
const CONNECTED_AT_KEY = "accord.mobile.wallet.connectedAt";

export interface SessionStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export async function loadSession(
  storage: SessionStorageLike,
): Promise<WalletSession | null> {
  try {
    const address = await storage.getItem(ADDRESS_KEY);
    if (!address) return null;
    const connectedAtRaw = await storage.getItem(CONNECTED_AT_KEY);
    return { address, connectedAt: Number(connectedAtRaw) || Date.now() };
  } catch {
    return null;
  }
}

export async function saveSession(
  session: WalletSession,
  storage: SessionStorageLike,
): Promise<void> {
  await storage.setItem(ADDRESS_KEY, session.address);
  await storage.setItem(CONNECTED_AT_KEY, String(session.connectedAt));
}

export async function clearSession(storage: SessionStorageLike): Promise<void> {
  await storage.removeItem(ADDRESS_KEY);
  await storage.removeItem(CONNECTED_AT_KEY);
}
