import { useState } from "react";
import { Link, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { CreateProposalModal } from "./components/CreateProposalModal";
import { useContract } from "./hooks/useContract";
import { useEventPolling } from "./hooks/useEventPolling";
import { useNotifications } from "./hooks/useNotifications";
import { useWallet } from "./hooks/useWallet";
import { approveProposal, executeProposal, revokeProposal } from "./lib/submit";
import { DashboardPage } from "./pages/DashboardPage";
import { HistoryPage } from "./pages/HistoryPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OwnersPage } from "./pages/OwnersPage";
import { SettingsPage } from "./pages/SettingsPage";
import type { Proposal } from "./types/accord";

const NAV_ITEMS = [
  { label: "dashboard", to: "/app" },
  { label: "history", to: "/app/history" },
  { label: "owners", to: "/app/owners" },
  { label: "settings", to: "/app/settings" },
];

type OptimisticPatch = {
  id: number;
  patch: Partial<Proposal>;
};

export default function App() {
  const [showCreate, setShowCreate] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);
  const [txPending, setTxPending] = useState(false);

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
  } = useContract(wallet.address);

  useEventPolling(refresh, 5000);
  useNotifications(wallet.address, proposals);

  const activeProposals = proposals.filter((proposal) =>
    ["pending", "ready"].includes(proposal.status)
  );
  const isOwner = Boolean(
    wallet.address && ownerAddresses.includes(wallet.address)
  );
  const showReadOnlyBanner = Boolean(
    wallet.address && !loading && !error && !isOwner
  );

  async function withTx(
    fn: () => Promise<void>,
    optimisticPatch?: OptimisticPatch
  ) {
    if (!wallet.address) {
      await wallet.connect();
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
  }

  const handleApprove = (id: number) => {
    const proposal = proposals.find((candidate) => candidate.id === id);
    if (!proposal) {
      return withTx(() => approveProposal(wallet.address!, id));
    }

    const approvals = proposal.approvals + 1;
    const status = approvals >= proposal.threshold ? "ready" : proposal.status;

    return withTx(() => approveProposal(wallet.address!, id), {
      id,
      patch: {
        approvals,
        status,
        userHasApproved: true,
      },
    });
  };

  const handleExecute = (id: number) =>
    withTx(() => executeProposal(wallet.address!, id), {
      id,
      patch: { status: "executed" },
    });

  const handleRevoke = (id: number) => {
    const proposal = proposals.find((candidate) => candidate.id === id);
    if (!proposal) {
      return withTx(() => revokeProposal(wallet.address!, id));
    }

    const approvals = Math.max(proposal.approvals - 1, 0);
    const status =
      approvals >= proposal.threshold && proposal.status === "ready"
        ? "ready"
        : "pending";

    return withTx(() => revokeProposal(wallet.address!, id), {
      id,
      patch: {
        approvals,
        status,
        userHasApproved: false,
      },
    });
  };

  const thresholdStat = stats.find((stat) => stat.label === "Threshold");
  const threshold = Number.parseInt(
    thresholdStat?.value.split(" ")[0] ?? "0",
    10
  );

  function shortenAddr(addr: string) {
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <Link
            to="/"
            className="flex items-center gap-3 transition-opacity hover:opacity-80"
          >
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500 text-xs font-bold text-black">
              A
            </div>
            <span className="font-semibold tracking-tight">Accord</span>
            <span className="hidden font-mono text-xs text-zinc-600 sm:block">
              testnet
            </span>
          </Link>

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

      <main className="mx-auto max-w-4xl px-6 py-8">
        {txError && (
          <div className="mb-6 flex items-center justify-between rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            <span>{txError}</span>
            <button
              type="button"
              onClick={() => {
                setTxError(null);
                refresh();
              }}
              className="ml-4 shrink-0 underline hover:text-red-300"
            >
              Dismiss
            </button>
          </div>
        )}

        {wallet.networkMismatch && (
          <div className="mb-6 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-400">
            Your wallet network does not match this app. Expected network:{" "}
            {import.meta.env.VITE_NETWORK_PASSPHRASE}. Switch Freighter network to
            continue.
          </div>
        )}

        {txPending && (
          <div className="mb-6 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-400">
            Waiting for confirmation…
          </div>
        )}

        {showReadOnlyBanner && (
          <div className="mb-6 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
            You are connected in read-only mode. This wallet is not a multisig
            owner.
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
            <h1 className="text-2xl font-semibold">Freighter wallet required</h1>
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
        ) : (
          <Routes>
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
              path="owners"
              element={
                <OwnersPage
                  owners={owners}
                  threshold={threshold}
                  totalOwners={owners.length}
                />
              }
            />
            <Route path="settings" element={<SettingsPage stats={stats} />} />
            <Route
              path="*"
              element={<NotFoundPage onGoHome={() => navigate("/app")} />}
            />
          </Routes>
        )}
      </main>

      {showCreate && (
        <CreateProposalModal
          walletAddress={wallet.address}
          onClose={() => setShowCreate(false)}
          onSubmitted={refresh}
        />
      )}
    </div>
  );
}
