import { useCallback, useEffect, useState } from "react";
import { connectWallet, freighterInstalled, getWalletAddress, getAccountBalances, getWalletNetworkPassphrase } from "../lib/wallet";

export type WalletState = {
  installed: boolean;
  address: string | null;
  connecting: boolean;
  networkMismatch: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  xlmBalance?: string | null;
  usdcBalance?: string | null;
};

export function useWallet(): WalletState {
  const [installed, setInstalled] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [networkMismatch, setNetworkMismatch] = useState(false);
  const [xlmBalance, setXlmBalance] = useState<string | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<string | null>(null);

  // On mount: check if Freighter is present and already authorized
  useEffect(() => {
    freighterInstalled().then((ok) => {
      setInstalled(ok);
      if (ok) {
        getWalletAddress().then(async (res) => {
          if (res.ok) {
            setAddress(res.value);
            const expected = import.meta.env.VITE_NETWORK_PASSPHRASE;
            const actual = await getWalletNetworkPassphrase();
            setNetworkMismatch(actual !== null && actual !== expected);
          }
        });
      }
    });
  }, []);

  // Fetch balances whenever address becomes non-null. Swallow errors silently.
  useEffect(() => {
    if (!address) {
      setXlmBalance(null);
      setUsdcBalance(null);
      return;
    }

    getAccountBalances(address)
      .then((res) => {
        setXlmBalance(res.xlm);
        setUsdcBalance(res.usdc);
      })
      .catch(() => {
        // ignore failures — keep balances null
      });
  }, [address]);

  // Detect external disconnects. Freighter emits no event when the user
  // disconnects from inside the extension, so we poll every 3s while connected
  // and clear local state if Freighter no longer reports the stored address
  // (disconnected, or switched to a different account). The interval is only
  // created when an address is set, so no polling runs while disconnected.
  useEffect(() => {
    if (!address) return;

    const interval = setInterval(async () => {
      const res = await getWalletAddress();
      if (!res.ok || res.value !== address) {
        setAddress(null);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [address]);

  const connect = useCallback(async () => {
    setConnecting(true);
    try {
      const res = await connectWallet();
      if (res.ok) {
        setAddress(res.value);
        const expected = import.meta.env.VITE_NETWORK_PASSPHRASE;
        const actual = await getWalletNetworkPassphrase();
        setNetworkMismatch(actual !== null && actual !== expected);
      } else alert(`Freighter error: ${res.error}`);
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    // Freighter has no programmatic disconnect — clear local state only.
    setAddress(null);
    setXlmBalance(null);
    setUsdcBalance(null);
    setNetworkMismatch(false);
  }, []);

  return { installed, address, connecting, networkMismatch, connect, disconnect, xlmBalance, usdcBalance };
}
