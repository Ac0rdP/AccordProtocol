import { useState } from "react";
import { Link, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { CreateProposalModal } from "./components/CreateProposalModal";
import { DashboardPage } from "./pages/DashboardPage";
import { HistoryPage } from "./pages/HistoryPage";
import { SettingsPage } from "./pages/SettingsPage";
import { useContract } from "./hooks/useContract";
import { useWallet } from "./hooks/useWallet";
import { approveProposal, executeProposal, revokeProposal } from "./lib/submit";
import { NotFoundPage } from "./pages/NotFoundPage";

export default function App() {
  const [showCreate, setShowCreate] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);
  const [txPending, setTxPending] = useState(false);

  const wallet = useWallet();
  const { proposals, owners, stats, loading, error, refresh } = useContract(wallet.address);
  const navigate = useNavigate();
  const location = useLocation();
  const currentPath = location.pathname;

  async function withTx(fn: () => Promise<void>) {
    if (!wallet.address) {
      await wallet.connect();
      return;
    }

    setTxError(null);
    setTxPending(true);

    try {
      await fn();
      refresh();
    } catch (e) {
      setTxError(e instanceof Error ? e.message : "Transaction failed");
    } finally {
      setTxPending(false);
    }
  }

  const handleApprove = (id: number) =>
    withTx(() => approveProposal(wallet.address!, id));

  const handleExecute = (id: number) =>
    withTx(() => executeProposal(wallet.address!, id));

  const handleRevoke = (id: number) =>
    withTx(() => revokeProposal(wallet.address!, id));

  function shortenAddr(addr: string) {
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-lg bg-emerald-500 flex items-center justify-center text-xs font-bold text-black">
              A
            </div>
            <span className="font-semibold tracking-tight">Accord</span>
            <span className="text-xs text-zinc-600 font-mono hidden sm:block">
              testnet
            </span>
          </div>
     

          <nav className="flex items-center gap-1">
            {[
              { label: "dashboard", to: "/" },
              { label: "history", to: "/history" },
              { label: "settings", to: "/settings" },
            ].map(({ label, to }) => (
              <Link
                key={label}
                to={to}
                className={`text-sm px-3 py-1.5 rounded-lg capitalize transition-colors ${
                  currentPath === to
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
              className="text-sm px-4 py-1.5 rounded-lg font-medium bg-amber-600 hover:bg-amber-500 text-white transition-colors"
            >
              Install Freighter
            </a>
          ) : wallet.address ? (
            <button
              type="button"
              onClick={wallet.disconnect}
              className="text-sm px-4 py-1.5 rounded-lg font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
            >
              {shortenAddr(wallet.address)}
            </button>
          ) : (
            <button
              type="button"
              onClick={wallet.connect}
              disabled={wallet.connecting}
              className="text-sm px-4 py-1.5 rounded-lg font-medium bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white transition-colors"
            >
              {wallet.connecting ? "Connecting…" : "Connect Wallet"}
            </button>
          )}
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8">
        {txError && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 mb-6 text-sm text-red-400 flex items-center justify-between">
            <span>{txError}</span>
            <button
              type="button"
              onClick={() => {
                setTxError(null);
                refresh();
              }}
              className="underline hover:text-red-300 ml-4 shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}

        {txPending && (
          <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-4 py-3 mb-6 text-sm text-emerald-400">
            Waiting for confirmation…
          </div>
        )}

        <Routes>
          <Route
            path="/"
            element={
              <DashboardPage
                activeProposals={proposals.filter((p) =>
                  ["pending", "ready"].includes(p.status)
                )}
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
            path="/history"
            element={
              <HistoryPage proposals={proposals} onApprove={handleApprove} />
            }
          />
          <Route
            path="/settings"
            element={<SettingsPage stats={stats} />}
          />
          <Route path="*" element={<NotFoundPage onGoHome={() => navigate("/")} />} />
        </Routes>
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