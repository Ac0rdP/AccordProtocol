import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { CreateProposalModal } from "./components/CreateProposalModal";
import { CreateRecurringPaymentModal } from "./components/CreateRecurringPaymentModal";
import { ErrorState } from "./components/ErrorState";
import { GlobalSearch } from "./components/GlobalSearch";
import { GrantRevokeRoleModal } from "./components/GrantRevokeRoleModal";
import { LoadingState } from "./components/LoadingState";
import { useContract } from "./hooks/useContract";
import { useEventPolling } from "./hooks/useEventPolling";
import { useNotifications } from "./hooks/useNotifications";
import { useRoles } from "./hooks/useRoles";
import { useWallet } from "./hooks/useWallet";
import { approveProposal, executeProposal, revokeProposal } from "./lib/submit";
import { isFrozen } from "./lib/contract";
import { PWAInstallBanner } from "./components/PWAInstallBanner";
import { ThemeControl } from "./components/ThemeControl";
import { applyTheme, getStoredTheme, subscribeToSystemTheme, type ThemeChoice } from "./lib/theme";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { HistoryPage } from "./pages/HistoryPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { OwnersPage } from "./pages/OwnersPage";
import { OwnerProfilePage } from "./pages/OwnerProfilePage";
import { ProposalDetailPage } from "./pages/ProposalDetailPage";
import { RecurringPage } from "./pages/RecurringPage";
import { SettingsPage } from "./pages/SettingsPage";
import type { Proposal } from "./types/accord";

const NAV_ITEMS = [
  { label: "dashboard", to: "/app" },
  { label: "recurring", to: "/app/recurring" },
  { label: "history", to: "/app/history" },
  { label: "analytics", to: "/app/analytics" },
  { label: "owners", to: "/app/owners" },
  { label: "settings", to: "/app/settings" },
  { label: "docs", to: "/docs" },
];

type OptimisticPatch = {
  id: number;
  patch: Partial<Proposal>;
};

export default function App() {
  const [showCreate, setShowCreate] = useState(false);
  const [showCreateRecurring, setShowCreateRecurring] = useState(false);
  const [roleModalTarget, setRoleModalTarget] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);
  const [txPending, setTxPending] = useState(false);
  const [isStale, setIsStale] = useState(false);
  const [contractFrozen, setContractFrozen] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>(() => getStoredTheme());
  // Ref to return focus to the "+ New" trigger after modal closes (Task 4)
  const newProposalButtonRef = useRef<HTMLButtonElement>(null);
  const recurringButtonRef = useRef<HTMLButtonElement>(null);

  const wallet = useWallet();
  const navigate = useNavigate();
  const location = useLocation();

  const {
    proposals,
    owners,
    ownerAddresses,
    stats,
    loading,
    error,
    refresh,
    optimisticUpdate,
    lastSuccessAt,
  } = useContract(wallet.address);

  useEventPolling(refresh, 5000);
  useNotifications(wallet.address, proposals);

  // Apply theme with system mode subscription
  useEffect(() => {
    applyTheme(theme);
    if (theme === "system") {
      const unsubscribe = subscribeToSystemTheme(() => {
        applyTheme("system");
      });
      return unsubscribe;
    }
  }, [theme]);

  // Deep-link handling: ensure direct proposal URLs or query params open the correct page
  useEffect(() => {
    const directMatch = location.pathname.match(/^\/proposals\/(\d+)/);
    if (directMatch) {
      const id = directMatch[1];
      navigate(`/app/proposals/${id}`, { replace: true });
      return;
    }

    if (location.pathname === "/onboarding" || location.pathname === "/onboarding/") {
      navigate("/app/onboarding", { replace: true });
      return;
    }

    const params = new URLSearchParams(location.search);
    const proposalParam = params.get("proposal");
    if (proposalParam) {
      navigate(`/app/proposals/${proposalParam}`, { replace: true });
    }
  }, [location.pathname, location.search, navigate]);

  // Return focus to the New Proposal trigger when modal transitions from open → closed
  const wasShowCreateRef = useRef(false);
  useEffect(() => {
    if (!showCreate && wasShowCreateRef.current) {
      newProposalButtonRef.current?.focus();
    }
    wasShowCreateRef.current = showCreate;
  }, [showCreate]);

  // Return focus to the Recurring trigger when modal transitions from open → closed
  const wasShowRecurringRef = useRef(false);
  useEffect(() => {
    if (!showCreateRecurring && wasShowRecurringRef.current) {
      recurringButtonRef.current?.focus();
    }
    wasShowRecurringRef.current = showCreateRecurring;
  }, [showCreateRecurring]);

  useEffect(() => {
    if (!wallet.address && txPending) {
      setTxPending(false);
      setTxError("Wallet disconnected. Please reconnect and try again.");
    }
  }, [wallet.address, txPending]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (lastSuccessAt) {
        setIsStale(Date.now() - lastSuccessAt > 60000);
      } else {
        setIsStale(false);
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [lastSuccessAt]);

  // Poll frozen state
  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const f = await isFrozen();
        if (!cancelled) setContractFrozen(f);
      } catch {
        // ignore
      }
    }
    check();
    const interval = setInterval(check, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [lastSuccessAt]);

  const activeProposals = useMemo(
    () =>
      proposals.filter((proposal) =>
        ["pending", "ready"].includes(proposal.status),
      ),
    [proposals]
  );
  const walletRoles = useRoles({
    walletAddress: wallet.address,
    ownerAddresses,
    loading,
    error,
  });

  const { address, connect } = wallet;

  const ownerWeightForWallet = useCallback(
    (addr: string | null | undefined) => {
      if (!addr) return 0;
      const index = ownerAddresses.indexOf(addr);
      return index >= 0 ? owners[index]?.weight ?? 0 : 0;
    },
    [ownerAddresses, owners]
  );

  const withTx = useCallback(
    async (
      fn: () => Promise<void>,
      optimisticPatch?: OptimisticPatch
    ) => {
      if (!address) {
        await connect();
        return;
      }

      setTxError(null);
      setTxPending(true);

      if (optimisticPatch) {
        optimisticUpdate(optimisticPatch.id, optimisticPatch.patch);
      }

      try {
        await fn();
        refresh();
      } catch (err) {
        setTxError(err instanceof Error ? err.message : "Transaction failed");
      } finally {
        setTxPending(false);
      }
    },
    [address, connect, optimisticUpdate, refresh]
  );

  const handleApprove = useCallback((id: number) => {
    const proposal = proposals.find((candidate) => candidate.id === id);
    if (!proposal) {
      return withTx(() => approveProposal(wallet.address!, id));
    }

    const myWeight = ownerWeightForWallet(wallet.address);
    const approvals = proposal.approvals + 1;
    const approvalWeight = (proposal.approvalWeight ?? 0) + myWeight;
    const quorumWeight = proposal.quorumWeight ?? proposal.threshold;
    const status = approvalWeight >= quorumWeight ? "ready" : proposal.status;

    return withTx(() => approveProposal(wallet.address!, id), {
      id,
      patch: {
        approvals,
        approvalWeight,
        status,
        userHasApproved: true,
      },
    });
  }, [ownerWeightForWallet, proposals, wallet.address, withTx]);

  const handleExecute = useCallback((id: number) =>
    withTx(() => executeProposal(wallet.address!, id), {
      id,
      patch: { status: "executed" },
    }), [wallet.address, withTx]);

  const handleRevoke = useCallback((id: number) => {
    const proposal = proposals.find((candidate) => candidate.id === id);
    if (!proposal) {
      return withTx(() => revokeProposal(wallet.address!, id));
    }

    const myWeight = ownerWeightForWallet(wallet.address);
    const approvals = Math.max(proposal.approvals - 1, 0);
    const approvalWeight = Math.max((proposal.approvalWeight ?? 0) - myWeight, 0);
    const quorumWeight = proposal.quorumWeight ?? proposal.threshold;

    const status =
      approvalWeight >= quorumWeight && proposal.status === "ready"
        ? "ready"
        : "pending";

    return withTx(() => revokeProposal(wallet.address!, id), {
      id,
      patch: {
        approvals,
        approvalWeight,
        status,
        userHasApproved: false,
      },
    });
  }, [ownerWeightForWallet, proposals, wallet.address, withTx]);

  const thresholdStat = stats.find((stat) => stat.label === "Threshold");
  const threshold = Number.parseInt(
    thresholdStat?.value.split(" ")[0] ?? "0",
    10,
  );

  function shortenAddr(addr: string) {
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  }

  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950 text-zinc-900 dark:text-white">
      <PWAInstallBanner />
      <header className="border-b border-zinc-800 dark:border-zinc-800 border-zinc-200 px-4 sm:px-6 py-4">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-2">
          <Link
            to="/"
            className="flex shrink-0 items-center gap-3 transition-opacity hover:opacity-80"
          >
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500 text-xs font-bold text-black">
              A
            </div>
            <span className="font-semibold tracking-tight">Accord</span>
            <span className="hidden font-mono text-xs text-zinc-600 sm:block">
              testnet
            </span>
          </Link>

          <GlobalSearch proposals={proposals} owners={owners} />

          <nav className="flex items-center gap-1">
            {NAV_ITEMS.map(({ label, to }) => (
              <Link
                key={label}
                to={to}
                className={`rounded-lg px-3 py-1.5 text-sm capitalize transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-400 ${
                  location.pathname === to ||
                  (to === "/app" && location.pathname === "/app/")
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {label}
              </Link>
            ))}

            {/* Explicit Light, System, Dark theme control */}
            <ThemeControl
              currentTheme={theme}
              onThemeChange={setTheme}
              className="ml-1"
            />
          </nav>

          {!wallet.installed ? (
            <a
              href="https://www.freighter.app"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg bg-amber-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-amber-500 focus:outline-none focus:ring-2 focus:ring-zinc-400"
            >
              Install Freighter
            </a>
          ) : wallet.address ? (
            <button
              type="button"
              onClick={wallet.disconnect}
              className="rounded-lg bg-zinc-800 px-4 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-400"
            >
              {shortenAddr(wallet.address)}
            </button>
          ) : (
            <button
              type="button"
              onClick={wallet.connect}
              disabled={wallet.connecting}
              className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-zinc-400 disabled:opacity-50"
            >
              {wallet.connecting ? "Connecting…" : "Connect Wallet"}
            </button>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 sm:px-6 py-8">
        {contractFrozen && (
          <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/20 px-4 py-3 text-sm text-red-300 font-medium flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 shrink-0">
              <path fillRule="evenodd" d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003zM12 8.25a.75.75 0 01.75.75v3.75a.75.75 0 01-1.5 0V9a.75.75 0 01.75-.75zm0 8.25a.75.75 0 100-1.5.75.75 0 000 1.5z" clipRule="evenodd" />
            </svg>
            Contract is currently frozen. All proposal creation and execution has been paused.
          </div>
        )}

        {isStale && !loading && (
          <div className="mb-6 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-400 font-medium">
            Data may be out of date — last updated over 60 seconds ago.
          </div>
        )}

        {txError && (
          <ErrorState
            message={txError}
            variant="banner"
            onRetry={() => {
              setTxError(null);
              refresh();
            }}
            onDismiss={() => setTxError(null)}
          />
        )}

        {wallet.networkMismatch && (
          <div className="mb-6 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-400">
            Your wallet network does not match this app. Expected network:{" "}
            {import.meta.env.VITE_NETWORK_PASSPHRASE}. Switch Freighter network
            to continue.
          </div>
        )}

        {txPending && (
          <div className="mb-6 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-400">
            Waiting for confirmation…
          </div>
        )}

        {!wallet.installed ? (
          <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
            <div className="mb-6 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-300">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="h-6 w-6"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15.75 19.5a3 3 0 0 0 3-3V6.75A3 3 0 0 0 15.75 3.75H8.25a3 3 0 0 0-3 3V16.5a3 3 0 0 0 3 3m7.5 0h-7.5m7.5 0v.75a.75.75 0 0 1-.75.75H8.25a.75.75 0 0 1-.75-.75v-.75m7.5 0v-3.375c0-.621-.504-1.125-1.125-1.125H9.375c-.621 0-1.125.504-1.125 1.125V19.5"
                />
              </svg>
            </div>
            <h1 className="text-2xl font-semibold">
              Freighter wallet required
            </h1>
            <p className="mt-3 max-w-md text-sm leading-6 text-zinc-400">
              Freighter is the supported browser extension for signing Stellar
              transactions in Accord. Install it to connect a wallet and use the
              app.
            </p>
            <a
              href="https://www.freighter.app"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-6 inline-flex items-center rounded-lg bg-amber-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-amber-500"
            >
              Install Freighter
            </a>
          </div>
        ) : loading ? (
          <LoadingState message="Loading contract data…" />
        ) : (
          <>
            {owners.length === 0 && location.pathname !== "/app/onboarding" && (
              <div
                data-testid="no-multisig-banner"
                className="mb-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-xs text-emerald-200"
              >
                <div>
                  <p className="font-semibold text-emerald-300 text-sm">No multisig configured yet</p>
                  <p className="text-zinc-400 mt-0.5">
                    Take the guided onboarding wizard to configure owners, quorum threshold, and your first proposal.
                  </p>
                </div>
                <Link
                  to="/app/onboarding"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-black hover:bg-emerald-400 transition-colors shrink-0"
                >
                  Start Setup Wizard →
                </Link>
              </div>
            )}
            <Routes>
              <Route
                path="onboarding"
                element={<OnboardingPage wallet={wallet} onComplete={refresh} />}
              />
              <Route
                index
              element={
                <DashboardPage
                  activeProposals={activeProposals}
                  owners={owners}
                  dashboardStats={stats}
                  walletAddress={wallet.address}
                  onApprove={handleApprove}
                  onExecute={handleExecute}
                  onRevoke={handleRevoke}
                  onCreateProposal={() => setShowCreate(true)}
                  onCreateRecurringPayment={() => setShowCreateRecurring(true)}
                  walletRoles={walletRoles.roles}
                  roleBanner={walletRoles.banner}
                  loading={loading}
                  error={error}
                />
              }
            />
            <Route
              path="history"
              element={
                <HistoryPage proposals={proposals} onApprove={handleApprove} />
              }
            />
            <Route
              path="recurring"
              element={
                <RecurringPage walletAddress={wallet.address} />
              }
            />
            <Route path="analytics" element={<AnalyticsPage />} />
            <Route
              path="owners"
              element={
                <OwnersPage
                  owners={owners}
                  ownerAddresses={ownerAddresses}
                  threshold={threshold}
                  totalOwners={owners.length}
                  onManageRoles={setRoleModalTarget}
                />
              }
            />
            <Route
              path="owners/:address"
              element={
                <OwnerProfilePage
                  proposals={proposals}
                  owners={owners}
                  walletAddress={wallet.address}
                  walletRoles={walletRoles.roles}
                  onApprove={handleApprove}
                  onExecute={handleExecute}
                  onRevoke={handleRevoke}
                />
              }
            />
            <Route
              path="settings"
              element={
                <SettingsPage
                  stats={stats}
                  walletAddress={wallet.address}
                  ownerAddresses={ownerAddresses}
                  onProposalSubmitted={refresh}
                />
              }
            />
            <Route
              path="proposals/:id"
              element={
                <ProposalDetailPage
                  proposals={proposals}
                  walletAddress={wallet.address}
                  onApprove={handleApprove}
                  onExecute={handleExecute}
                />
              }
            />
            <Route
              path="*"
              element={<NotFoundPage onGoHome={() => navigate("/app")} />}
            />
          </Routes>
        </>
      )}
      </main>
      
      {showCreate && (
        <CreateProposalModal
          walletAddress={wallet.address}
          onClose={() => setShowCreate(false)}
          onSubmitted={refresh}
          triggerRef={newProposalButtonRef}
        />
      )}
      {showCreateRecurring && (
        <CreateRecurringPaymentModal
          walletAddress={wallet.address}
          onClose={() => setShowCreateRecurring(false)}
          onSubmitted={refresh}
          triggerRef={recurringButtonRef}
        />
      )}
      {roleModalTarget && (
        <GrantRevokeRoleModal
          walletAddress={wallet.address}
          ownerAddresses={ownerAddresses}
          threshold={threshold}
          initialTargetAddress={roleModalTarget}
          onClose={() => setRoleModalTarget(null)}
          onSubmitted={refresh}
        />
      )}
    </div>
  );
}
