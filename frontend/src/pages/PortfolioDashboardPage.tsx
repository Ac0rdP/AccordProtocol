import { useEffect, useState, type FormEvent } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { EmptyState } from "../components/EmptyState";
import { PageState } from "../components/PageState";
import {
  getPortfolioContractSummary,
  type PortfolioContractSummary,
} from "../lib/contract";
import {
  loadWorkspaces,
  saveWorkspaces,
  type Workspace,
} from "../lib/workspaces";

type PortfolioRow =
  | { contractId: string; summary: PortfolioContractSummary; error: null }
  | { contractId: string; summary: null; error: string };

type PortfolioDashboardPageProps = {
  activeContractId: string;
  onSelectContract: (contractId: string) => void;
  onWorkspacesChange?: (workspaces: Workspace[]) => void;
};

function formatAggregateBalance(
  rows: PortfolioRow[],
  balanceKey: "treasuryXlm" | "treasuryUsdc",
): string {
  const balances = rows.flatMap((row) => {
    const balance = row.summary?.[balanceKey];
    return balance && /^\d+(?:\.\d{1,7})?$/.test(balance) ? [balance] : [];
  });
  if (balances.length === 0) return "Unavailable";

  const totalStroops = balances.reduce((total, balance) => {
    const [whole = "0", fraction = ""] = balance.split(".");
    const stroops = BigInt(whole) * 10_000_000n +
      BigInt((fraction + "0000000").slice(0, 7));
    return total + stroops;
  }, 0n);
  const whole = totalStroops / 10_000_000n;
  const fraction = String(totalStroops % 10_000_000n).padStart(7, "0");
  return `${whole}.${fraction}`;
}

function formatCount(value: number): string {
  return Number.isFinite(value) ? String(value) : "—";
}

export function PortfolioDashboardPage({
  activeContractId,
  onSelectContract,
  onWorkspacesChange,
}: PortfolioDashboardPageProps) {
  const [contractIds, setContractIds] = useState<string[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [portfolioReady, setPortfolioReady] = useState(false);
  const [rows, setRows] = useState<PortfolioRow[]>([]);
  const [newContractId, setNewContractId] = useState("");
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    try {
      const loadedWorkspaces = loadWorkspaces();
      setWorkspaces(loadedWorkspaces);
      setContractIds(loadedWorkspaces.map((workspace) => workspace.contractId));
      setLoadError(null);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Could not load saved portfolios.",
      );
    } finally {
      setPortfolioReady(true);
    }
  }, []);

  useEffect(() => {
    let active = true;
    if (!portfolioReady) return;
    if (contractIds.length === 0) {
      setRows([]);
      setLoading(false);
      return () => {
        active = false;
      };
    }

    setLoading(true);
    setLoadError(null);
    Promise.all(
      contractIds.map(async (contractId): Promise<PortfolioRow> => {
        try {
          return {
            contractId,
            summary: await getPortfolioContractSummary(contractId),
            error: null,
          };
        } catch (error) {
          return {
            contractId,
            summary: null,
            error:
              error instanceof Error
                ? error.message
                : "Could not load this contract.",
          };
        }
      }),
    )
      .then((result) => {
        if (!active) return;
        setRows(result);
        if (result.every((row) => row.summary === null)) {
          setLoadError(
            result
              .map((row) => `${row.contractId}: ${row.error}`)
              .join(" "),
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [contractIds, portfolioReady, retryToken]);

  const summaries = rows.flatMap((row) =>
    row.summary ? [row.summary] : [],
  );
  const aggregate = {
    treasuryXlm: formatAggregateBalance(rows, "treasuryXlm"),
    treasuryUsdc: formatAggregateBalance(rows, "treasuryUsdc"),
    activeProposals: summaries.reduce(
      (total, summary) => total + summary.activeProposals,
      0,
    ),
    readyProposals: summaries.reduce(
      (total, summary) => total + summary.readyProposals,
      0,
    ),
    overdueProposals: summaries.reduce(
      (total, summary) => total + summary.overdueProposals,
      0,
    ),
  };

  function persistContractIds(nextIds: string[]) {
    try {
      const nextWorkspaces = nextIds.map((contractId) => {
        const existing = workspaces.find((workspace) => workspace.contractId === contractId);
        return existing ?? {
          id: contractId,
          name: "Workspace",
          contractId,
          network: (import.meta.env.VITE_NETWORK_PASSPHRASE as string | undefined) ?? "stellar",
        };
      });
      saveWorkspaces(nextWorkspaces);
      setWorkspaces(nextWorkspaces);
      setContractIds(nextIds);
      onWorkspacesChange?.(nextWorkspaces);
      setFormError(null);
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : "Could not save your portfolio list.",
      );
    }
  }

  function addPortfolio(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const contractId = newContractId.trim();
    if (!StrKey.isValidContract(contractId)) {
      setFormError("Enter a valid Stellar contract ID.");
      return;
    }
    if (contractIds.includes(contractId)) {
      setFormError("This contract is already in your portfolio.");
      return;
    }
    const name = newWorkspaceName.trim();
    if (!name) {
      setFormError("Workspace name is required.");
      return;
    }
    const nextWorkspace: Workspace = {
      id: contractId,
      name,
      contractId,
      network: (import.meta.env.VITE_NETWORK_PASSPHRASE as string | undefined) ?? "stellar",
    };
    const nextWorkspaces = [
      ...workspaces,
      nextWorkspace,
    ];
    try {
      saveWorkspaces(nextWorkspaces);
      setWorkspaces(nextWorkspaces);
      setContractIds([...contractIds, contractId]);
      onWorkspacesChange?.(nextWorkspaces);
      setFormError(null);
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : "Could not save the workspace.",
      );
      return;
    }
    setNewContractId("");
    setNewWorkspaceName("");
  }

  function removePortfolio(contractId: string) {
    const nextIds = contractIds.filter((id) => id !== contractId);
    if (nextIds.length === 0) {
      setFormError("Keep at least one contract in your portfolio.");
      return;
    }
    persistContractIds(nextIds);
    if (activeContractId === contractId && nextIds[0]) {
      onSelectContract(nextIds[0]);
    }
  }

  return (
    <main className="space-y-6">
      <header>
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-emerald-400">
          Portfolio
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-white">
          Multisig portfolio
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-zinc-400">
          Track treasury and proposal health across your Accord contracts, then
          switch the active contract used by the rest of the app.
        </p>
      </header>

      <form
        onSubmit={addPortfolio}
        className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4 sm:flex-row"
      >
        <div className="min-w-0 sm:w-48">
          <label
            htmlFor="workspace-name"
            className="mb-1.5 block text-xs text-zinc-400"
          >
            Workspace name
          </label>
          <input
            id="workspace-name"
            value={newWorkspaceName}
            onChange={(event) => setNewWorkspaceName(event.target.value)}
            disabled={!portfolioReady}
            placeholder="Operations"
            autoComplete="off"
            className="min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-zinc-400"
          />
        </div>
        <div className="min-w-0 flex-1">
          <label
            htmlFor="portfolio-contract-id"
            className="mb-1.5 block text-xs text-zinc-400"
          >
            Add Accord contract
          </label>
          <input
            id="portfolio-contract-id"
            value={newContractId}
            onChange={(event) => setNewContractId(event.target.value)}
            disabled={!portfolioReady}
            placeholder="C..."
            autoComplete="off"
            className="min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-zinc-400"
          />
        </div>
        <button
          type="submit"
          disabled={!portfolioReady}
          className="min-h-11 self-end rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 focus:outline-none focus:ring-2 focus:ring-zinc-300"
        >
          Add contract
        </button>
      </form>

      {formError && (
        <p role="alert" className="rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {formError}
        </p>
      )}

      {loading ? (
        <PageState
          status="loading"
          title="Loading portfolio contracts"
          description="Fetching treasury and proposal health."
        />
      ) : loadError && summaries.length === 0 ? (
        <PageState
          status="error"
          title="Could not load portfolio"
          description={loadError}
          onRetry={() => setRetryToken((token) => token + 1)}
          retryLabel="Retry"
        />
      ) : contractIds.length === 0 ? (
        <EmptyState
          title="No contracts in your portfolio"
          description="Add an Accord contract ID to see its treasury and proposal health."
        />
      ) : (
        <>
          {loadError && (
            <p role="alert" className="rounded-lg bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              {loadError}
            </p>
          )}
          <section aria-label="Aggregate portfolio health">
            <h2 className="mb-3 text-sm font-semibold text-zinc-200">
              Aggregate health
            </h2>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              {[
                ["Treasury (XLM)", aggregate.treasuryXlm],
                ["Treasury (USDC)", aggregate.treasuryUsdc],
                ["Active proposals", formatCount(aggregate.activeProposals)],
                ["Ready to execute", formatCount(aggregate.readyProposals)],
                ["Overdue proposals", formatCount(aggregate.overdueProposals)],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900 p-4"
                >
                  <p className="text-xs text-zinc-500">{label}</p>
                  <p className="mt-2 truncate font-mono text-xl font-semibold text-white">
                    {value}
                  </p>
                </div>
              ))}
            </div>
          </section>

          <section aria-label="Portfolio contracts">
            <h2 className="mb-3 text-sm font-semibold text-zinc-200">
              Contracts
            </h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {rows.map((row) => (
                <article
                  key={row.contractId}
                  className={`min-w-0 rounded-xl border bg-zinc-900 p-4 ${
                    row.contractId === activeContractId
                      ? "border-emerald-500/50"
                      : "border-zinc-800"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-zinc-100">
                        {workspaces.find((workspace) => workspace.contractId === row.contractId)?.name ?? "Workspace"}
                      </p>
                      <p className="mt-1 break-all font-mono text-xs text-zinc-400">
                        {row.contractId}
                      </p>
                    </div>
                    {row.contractId === activeContractId && (
                      <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-300">
                        Active
                      </span>
                    )}
                  </div>
                  {row.error ? (
                    <PageState
                      status="error"
                      title="Contract unavailable"
                      description={row.error}
                      onRetry={() => setRetryToken((token) => token + 1)}
                      retryLabel="Retry"
                    />
                  ) : row.summary ? (
                    <>
                      <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-4 text-sm">
                        <div>
                          <dt className="text-xs text-zinc-500">Treasury XLM</dt>
                          <dd className="mt-1 font-mono text-zinc-100">
                            {row.summary.treasuryXlm}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs text-zinc-500">Active proposals</dt>
                          <dd className="mt-1 font-mono text-zinc-100">
                            {row.summary.activeProposals}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs text-zinc-500">Owners / weight</dt>
                          <dd className="mt-1 font-mono text-zinc-100">
                            {row.summary.owners} / {row.summary.totalWeight}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs text-zinc-500">Threshold</dt>
                          <dd className="mt-1 font-mono text-zinc-100">
                            {row.summary.threshold}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs text-zinc-500">Ready / overdue</dt>
                          <dd className="mt-1 font-mono text-zinc-100">
                            {row.summary.readyProposals} / {row.summary.overdueProposals}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs text-zinc-500">Proposals created</dt>
                          <dd className="mt-1 font-mono text-zinc-100">
                            {row.summary.totalProposals}
                          </dd>
                        </div>
                      </dl>
                      <div className="mt-5 flex flex-wrap gap-2">
                        <button
                          type="button"
                          aria-pressed={row.contractId === activeContractId}
                          onClick={() => onSelectContract(row.contractId)}
                          disabled={row.contractId === activeContractId}
                          className="min-h-10 rounded-lg bg-zinc-800 px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-400 disabled:cursor-default disabled:text-emerald-300"
                        >
                          {row.contractId === activeContractId
                            ? "Active contract"
                            : "Switch to contract"}
                        </button>
                        <button
                          type="button"
                          onClick={() => removePortfolio(row.contractId)}
                          className="min-h-10 rounded-lg px-3 py-2 text-xs text-zinc-500 hover:bg-red-500/10 hover:text-red-300 focus:outline-none focus:ring-2 focus:ring-red-400"
                        >
                          Remove
                        </button>
                      </div>
                    </>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
