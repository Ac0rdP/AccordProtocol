import React, { useEffect, useId, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  HardDrive,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Trash2,
  Wallet,
  X,
} from "lucide-react";
import type { WalletState } from "../hooks/useWallet";
import {
  createWalletConnectPairingUri,
  DEFAULT_LEDGER_PATH,
  type WalletProviderId,
} from "../lib/walletProviders";

type Props = {
  wallet: WalletState;
  defaultOpen?: boolean;
};

const PROVIDERS: Array<{
  id: WalletProviderId;
  name: string;
  shortName: string;
}> = [
  { id: "freighter", name: "Freighter", shortName: "Freighter" },
  { id: "ledger", name: "Ledger", shortName: "Ledger" },
  { id: "walletconnect", name: "WalletConnect", shortName: "WC" },
  { id: "passkey", name: "Passkey", shortName: "Passkey" },
];

function shortenAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function ProviderIcon({
  provider,
  className = "h-3.5 w-3.5",
}: {
  provider: WalletProviderId;
  className?: string;
}) {
  switch (provider) {
    case "ledger":
      return <HardDrive className={className} aria-hidden="true" />;
    case "walletconnect":
      return <Smartphone className={className} aria-hidden="true" />;
    case "passkey":
      return <KeyRound className={className} aria-hidden="true" />;
    default:
      return <Wallet className={className} aria-hidden="true" />;
  }
}

export function WalletSessionSwitcher({ wallet, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [selectedTab, setSelectedTab] = useState<WalletProviderId>("freighter");
  const [ledgerPath, setLedgerPath] = useState(DEFAULT_LEDGER_PATH);
  const [wcUri, setWcUri] = useState(() => createWalletConnectPairingUri());
  const [copiedUri, setCopiedUri] = useState(false);
  const [passkeyLabel, setPasskeyLabel] = useState("");
  const [lastAttempt, setLastAttempt] = useState<(() => Promise<void>) | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogId = useId();

  const sessions = wallet.sessions ?? [];
  const activeSession = wallet.activeSession ?? null;
  const activeProvider = wallet.activeProvider ?? activeSession?.provider ?? "freighter";

  useEffect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open]);

  function handleTabKeyDown(event: React.KeyboardEvent, index: number) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setSelectedTab(PROVIDERS[(index + 1) % PROVIDERS.length].id);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      setSelectedTab(PROVIDERS[(index - 1 + PROVIDERS.length) % PROVIDERS.length].id);
    }
  }

  async function runConnect(fn: () => Promise<void>) {
    setLastAttempt(() => fn);
    await fn();
  }

  async function handleConnectFreighter() {
    await runConnect(async () => {
      if (wallet.connectProvider) {
        await wallet.connectProvider("freighter");
      } else {
        await wallet.connect();
      }
    });
  }

  async function handleConnectLedger() {
    await runConnect(async () => {
      if (wallet.connectProvider) {
        await wallet.connectProvider("ledger", { derivationPath: ledgerPath });
      }
    });
  }

  async function handleConnectWalletConnect() {
    await runConnect(async () => {
      if (wallet.connectProvider) {
        await wallet.connectProvider("walletconnect", { pairingUri: wcUri });
      }
    });
  }

  async function handleConnectPasskey(mode: "login" | "register") {
    await runConnect(async () => {
      if (wallet.connectProvider) {
        await wallet.connectProvider("passkey", {
          passkeyMode: mode,
          label: passkeyLabel.trim() || undefined,
        });
      }
    });
  }

  async function handleCopyWcUri() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(wcUri);
      }
      setCopiedUri(true);
      setTimeout(() => setCopiedUri(false), 2000);
    } catch {
      // Ignore clipboard failures in restricted contexts
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={dialogId}
        onClick={() => setOpen((prev) => !prev)}
        className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-400 ${
          wallet.address
            ? "bg-zinc-800 text-zinc-100 hover:bg-zinc-700"
            : "bg-emerald-700 text-white hover:bg-emerald-600"
        }`}
      >
        {wallet.connecting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <ProviderIcon provider={wallet.address ? activeProvider : "freighter"} />
        )}
        <span>
          {wallet.connecting
            ? "Connecting…"
            : wallet.address
              ? shortenAddr(wallet.address)
              : "Connect Wallet"}
        </span>
        {sessions.length > 1 && (
          <span
            aria-label={`${sessions.length} connected sessions`}
            className="rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-300"
          >
            {sessions.length}
          </span>
        )}
        <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden="true" />
      </button>

      {open && (
        <div
          id={dialogId}
          role="dialog"
          aria-label="Wallet sessions and providers"
          className="fixed inset-x-3 top-16 z-50 max-h-[82vh] overflow-y-auto rounded-xl border border-zinc-200 bg-white p-4 text-zinc-900 shadow-xl dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-96"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold">Wallet Sessions</h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Switch accounts or connect another wallet provider
              </p>
            </div>
            <button
              type="button"
              aria-label="Close wallet menu"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
              className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          {wallet.connecting && (
            <div
              role="status"
              aria-live="polite"
              className="mb-3 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" aria-hidden="true" />
              <span>
                Connecting{" "}
                {wallet.connectingProvider
                  ? PROVIDERS.find((p) => p.id === wallet.connectingProvider)?.name ?? "wallet"
                  : "wallet"}
                …
              </span>
            </div>
          )}

          {wallet.error && (
            <div
              role="alert"
              className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300"
            >
              <p className="font-medium">{wallet.error}</p>
              <div className="mt-2 flex items-center gap-2">
                {lastAttempt && (
                  <button
                    type="button"
                    onClick={() => void lastAttempt()}
                    className="rounded bg-red-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-red-400"
                  >
                    Retry
                  </button>
                )}
                {wallet.clearError && (
                  <button
                    type="button"
                    onClick={wallet.clearError}
                    className="rounded border border-red-500/30 px-2 py-1 text-[11px] font-medium hover:bg-red-500/10 focus:outline-none focus:ring-2 focus:ring-red-400"
                  >
                    Dismiss
                  </button>
                )}
              </div>
            </div>
          )}

          <section aria-label="Connected sessions" className="mb-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                Connected ({sessions.length})
              </span>
            </div>

            {sessions.length === 0 ? (
              <div
                data-testid="wallet-sessions-empty"
                className="rounded-lg border border-dashed border-zinc-300 px-3 py-4 text-center text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400"
              >
                No active wallet sessions. Choose a provider below to connect.
              </div>
            ) : (
              <ul className="space-y-1.5" role="list">
                {sessions.map((session) => {
                  const isActive = activeSession?.id === session.id;
                  return (
                    <li
                      key={session.id}
                      className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-xs transition-colors ${
                        isActive
                          ? "border-emerald-500/40 bg-emerald-500/10"
                          : "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => wallet.switchSession?.(session.id)}
                        aria-pressed={isActive}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left focus:outline-none focus:ring-2 focus:ring-zinc-400 rounded"
                      >
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
                          <ProviderIcon provider={session.provider} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5 font-medium">
                            <span className="truncate">{session.label}</span>
                            {isActive && (
                              <Check
                                className="h-3.5 w-3.5 shrink-0 text-emerald-500"
                                aria-label="Active session"
                              />
                            )}
                          </span>
                          <span className="block font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                            {shortenAddr(session.address)} · {session.provider}
                          </span>
                        </span>
                      </button>

                      <button
                        type="button"
                        aria-label={`Remove ${session.label} session`}
                        onClick={() => wallet.removeSession?.(session.id)}
                        className="rounded p-1 text-zinc-400 hover:bg-zinc-200 hover:text-red-500 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:hover:bg-zinc-800"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section aria-label="Add wallet provider">
            <div
              role="tablist"
              aria-label="Wallet providers"
              className="mb-3 grid grid-cols-4 gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900"
            >
              {PROVIDERS.map((provider, index) => {
                const selected = selectedTab === provider.id;
                return (
                  <button
                    key={provider.id}
                    type="button"
                    role="tab"
                    id={`wallet-tab-${provider.id}`}
                    aria-selected={selected}
                    aria-controls={`wallet-panel-${provider.id}`}
                    onClick={() => setSelectedTab(provider.id)}
                    onKeyDown={(e) => handleTabKeyDown(e, index)}
                    className={`flex flex-col items-center justify-center gap-1 rounded-md px-1.5 py-1.5 text-[11px] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-400 ${
                      selected
                        ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-white"
                        : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                    }`}
                  >
                    <ProviderIcon provider={provider.id} />
                    <span>{provider.shortName}</span>
                  </button>
                );
              })}
            </div>

            {selectedTab === "freighter" && (
              <div
                role="tabpanel"
                id="wallet-panel-freighter"
                aria-labelledby="wallet-tab-freighter"
                className="space-y-2.5 text-xs"
              >
                <p className="text-zinc-500 dark:text-zinc-400">
                  Connect your Freighter browser extension account. Existing sessions stay saved when switching accounts.
                </p>
                {wallet.installed ? (
                  <button
                    type="button"
                    disabled={wallet.connecting}
                    onClick={() => void handleConnectFreighter()}
                    className="w-full rounded-lg bg-emerald-700 px-3 py-2 font-medium text-white hover:bg-emerald-600 focus:outline-none focus:ring-2 focus:ring-zinc-400 disabled:opacity-50"
                  >
                    Connect Freighter
                  </button>
                ) : (
                  <div className="space-y-2">
                    <p className="text-amber-600 dark:text-amber-400">
                      Freighter extension not detected. You can install it or use Ledger, WalletConnect, or Passkey.
                    </p>
                    <a
                      href="https://www.freighter.app"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex w-full items-center justify-center rounded-lg bg-amber-600 px-3 py-2 font-medium text-white hover:bg-amber-500 focus:outline-none focus:ring-2 focus:ring-zinc-400"
                    >
                      Install Freighter
                    </a>
                  </div>
                )}
              </div>
            )}

            {selectedTab === "ledger" && (
              <div
                role="tabpanel"
                id="wallet-panel-ledger"
                aria-labelledby="wallet-tab-ledger"
                className="space-y-2.5 text-xs"
              >
                <div className="flex items-start gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-2.5 text-emerald-700 dark:text-emerald-300">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>
                    Transactions are signed directly on your Ledger hardware device. Secret keys are never exposed to the browser.
                  </span>
                </div>
                <label className="block">
                  <span className="mb-1 block font-medium text-zinc-700 dark:text-zinc-300">
                    Stellar Derivation Path
                  </span>
                  <input
                    type="text"
                    value={ledgerPath}
                    onChange={(e) => setLedgerPath(e.target.value)}
                    placeholder="44'/148'/0'"
                    className="w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 font-mono text-xs text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                </label>
                <button
                  type="button"
                  disabled={wallet.connecting}
                  onClick={() => void handleConnectLedger()}
                  className="w-full rounded-lg bg-emerald-700 px-3 py-2 font-medium text-white hover:bg-emerald-600 focus:outline-none focus:ring-2 focus:ring-zinc-400 disabled:opacity-50"
                >
                  Connect Ledger Device
                </button>
              </div>
            )}

            {selectedTab === "walletconnect" && (
              <div
                role="tabpanel"
                id="wallet-panel-walletconnect"
                aria-labelledby="wallet-tab-walletconnect"
                className="space-y-2.5 text-xs"
              >
                <p className="text-zinc-500 dark:text-zinc-400">
                  Pair a mobile or desktop Stellar wallet via WalletConnect v2 using the same signing flow.
                </p>
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-900">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-medium text-zinc-600 dark:text-zinc-300">Pairing URI</span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        aria-label="Regenerate WalletConnect URI"
                        onClick={() => setWcUri(createWalletConnectPairingUri())}
                        className="rounded p-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                      >
                        <RefreshCw className="h-3 w-3" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        aria-label="Copy WalletConnect URI"
                        onClick={() => void handleCopyWcUri()}
                        className="rounded p-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                      >
                        {copiedUri ? (
                          <Check className="h-3 w-3 text-emerald-500" aria-hidden="true" />
                        ) : (
                          <Copy className="h-3 w-3" aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  </div>
                  <p className="break-all font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                    {wcUri}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={wallet.connecting}
                  onClick={() => void handleConnectWalletConnect()}
                  className="w-full rounded-lg bg-emerald-700 px-3 py-2 font-medium text-white hover:bg-emerald-600 focus:outline-none focus:ring-2 focus:ring-zinc-400 disabled:opacity-50"
                >
                  Connect via WalletConnect
                </button>
              </div>
            )}

            {selectedTab === "passkey" && (
              <div
                role="tabpanel"
                id="wallet-panel-passkey"
                aria-labelledby="wallet-tab-passkey"
                className="space-y-2.5 text-xs"
              >
                <p className="text-zinc-500 dark:text-zinc-400">
                  Sign in with a passkey-backed smart wallet using Face ID, Touch ID, or a security key — no browser extension required.
                </p>
                <label className="block">
                  <span className="mb-1 block font-medium text-zinc-700 dark:text-zinc-300">
                    Smart Wallet Label (optional)
                  </span>
                  <input
                    type="text"
                    value={passkeyLabel}
                    onChange={(e) => setPasskeyLabel(e.target.value)}
                    placeholder="e.g. Treasury Owner Passkey"
                    className="w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={wallet.connecting}
                    onClick={() => void handleConnectPasskey("login")}
                    className="rounded-lg bg-emerald-700 px-3 py-2 font-medium text-white hover:bg-emerald-600 focus:outline-none focus:ring-2 focus:ring-zinc-400 disabled:opacity-50"
                  >
                    Sign in with Passkey
                  </button>
                  <button
                    type="button"
                    disabled={wallet.connecting}
                    onClick={() => void handleConnectPasskey("register")}
                    className="rounded-lg border border-zinc-300 px-3 py-2 font-medium text-zinc-800 hover:bg-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-400 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                  >
                    Create Passkey
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
