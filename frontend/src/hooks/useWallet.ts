import { useCallback, useEffect, useMemo, useState } from "react";
import {
  connectWallet,
  freighterInstalled,
  getWalletAddress,
  getAccountBalances,
  getWalletNetworkPassphrase,
} from "../lib/wallet";
import {
  connectLedgerWallet,
  connectPasskeyWallet,
  connectWalletConnect,
  loadActiveSessionId,
  loadStoredSessions,
  makeSessionId,
  saveActiveSessionId,
  saveStoredSessions,
  setActiveSigningSession,
  upsertSession,
  type ConnectProviderOptions,
  type WalletProviderId,
  type WalletSession,
} from "../lib/walletProviders";

export type WalletState = {
  installed: boolean;
  address: string | null;
  connecting: boolean;
  connectingProvider?: WalletProviderId | null;
  networkMismatch: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  xlmBalance?: string | null;
  usdcBalance?: string | null;
  sessions?: WalletSession[];
  activeSession?: WalletSession | null;
  activeProvider?: WalletProviderId | null;
  error?: string | null;
  clearError?: () => void;
  connectProvider?: (
    provider: WalletProviderId,
    options?: ConnectProviderOptions
  ) => Promise<WalletSession | null>;
  switchSession?: (sessionId: string) => void;
  removeSession?: (sessionId: string) => void;
};

export function useWallet(): WalletState {
  const [installed, setInstalled] = useState(false);
  const [sessions, setSessions] = useState<WalletSession[]>(() => loadStoredSessions());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
    const storedSessions = loadStoredSessions();
    const storedActive = loadActiveSessionId();
    if (storedActive && storedSessions.some((s) => s.id === storedActive)) {
      return storedActive;
    }
    return storedSessions[0]?.id ?? null;
  });
  const [connecting, setConnecting] = useState(false);
  const [connectingProvider, setConnectingProvider] = useState<WalletProviderId | null>(null);
  const [networkMismatch, setNetworkMismatch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [xlmBalance, setXlmBalance] = useState<string | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<string | null>(null);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId]
  );
  const address = activeSession?.address ?? null;
  const activeProvider = activeSession?.provider ?? null;

  useEffect(() => {
    saveStoredSessions(sessions);
  }, [sessions]);

  useEffect(() => {
    saveActiveSessionId(activeSessionId);
  }, [activeSessionId]);

  useEffect(() => {
    setActiveSigningSession(activeSession);
  }, [activeSession]);

  const registerSession = useCallback((session: WalletSession) => {
    setSessions((prev) => upsertSession(prev, session));
    setActiveSessionId(session.id);
    setActiveSigningSession(session);
  }, []);

  // On mount: check if Freighter is present and already authorized
  useEffect(() => {
    freighterInstalled().then((ok) => {
      setInstalled(ok);
      if (ok) {
        getWalletAddress().then(async (res) => {
          if (res.ok) {
            const session: WalletSession = {
              id: makeSessionId("freighter", res.value),
              provider: "freighter",
              address: res.value,
              label: "Freighter",
              connectedAt: Date.now(),
            };
            setSessions((prev) => upsertSession(prev, session));
            setActiveSessionId((prev) => prev ?? session.id);
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

  // Detect external Freighter disconnects only when Freighter is the active provider.
  useEffect(() => {
    if (!address || activeProvider !== "freighter") return;

    const interval = setInterval(async () => {
      const res = await getWalletAddress();
      if (!res.ok || res.value !== address) {
        setActiveSessionId((prev) => (prev === makeSessionId("freighter", address) ? null : prev));
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [address, activeProvider]);

  const connectProvider = useCallback(
    async (
      provider: WalletProviderId,
      options: ConnectProviderOptions = {}
    ): Promise<WalletSession | null> => {
      setConnecting(true);
      setConnectingProvider(provider);
      setError(null);
      try {
        if (provider === "freighter") {
          const res = await connectWallet();
          if (!res.ok) {
            setError(res.error);
            return null;
          }
          const session: WalletSession = {
            id: makeSessionId("freighter", res.value),
            provider: "freighter",
            address: res.value,
            label: options.label?.trim() || "Freighter",
            connectedAt: Date.now(),
          };
          registerSession(session);
          const expected = import.meta.env.VITE_NETWORK_PASSPHRASE;
          const actual = await getWalletNetworkPassphrase();
          setNetworkMismatch(actual !== null && actual !== expected);
          return session;
        }

        const res =
          provider === "ledger"
            ? await connectLedgerWallet(options)
            : provider === "walletconnect"
              ? await connectWalletConnect(options)
              : await connectPasskeyWallet(options);

        if (!res.ok) {
          setError(res.error);
          return null;
        }
        registerSession(res.value);
        setNetworkMismatch(false);
        return res.value;
      } finally {
        setConnecting(false);
        setConnectingProvider(null);
      }
    },
    [registerSession]
  );

  const connect = useCallback(async () => {
    await connectProvider("freighter");
  }, [connectProvider]);

  const switchSession = useCallback(
    (sessionId: string) => {
      const target = sessions.find((s) => s.id === sessionId);
      if (!target) return;
      setActiveSessionId(target.id);
      setActiveSigningSession(target);
      setError(null);
      if (target.provider !== "freighter") {
        setNetworkMismatch(false);
      }
    },
    [sessions]
  );

  const removeSession = useCallback(
    (sessionId: string) => {
      setSessions((prev) => {
        const remaining = prev.filter((s) => s.id !== sessionId);
        if (activeSessionId === sessionId) {
          const nextActive = remaining[0] ?? null;
          setActiveSessionId(nextActive?.id ?? null);
          setActiveSigningSession(nextActive);
          if (!nextActive) {
            setXlmBalance(null);
            setUsdcBalance(null);
            setNetworkMismatch(false);
          }
        }
        return remaining;
      });
    },
    [activeSessionId]
  );

  const disconnect = useCallback(() => {
    if (activeSessionId) {
      removeSession(activeSessionId);
      return;
    }
    setActiveSessionId(null);
    setActiveSigningSession(null);
    setXlmBalance(null);
    setUsdcBalance(null);
    setNetworkMismatch(false);
  }, [activeSessionId, removeSession]);

  const clearError = useCallback(() => setError(null), []);

  return {
    installed,
    address,
    connecting,
    connectingProvider,
    networkMismatch,
    connect,
    disconnect,
    xlmBalance,
    usdcBalance,
    sessions,
    activeSession,
    activeProvider,
    error,
    clearError,
    connectProvider,
    switchSession,
    removeSession,
  };
}
