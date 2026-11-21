import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowDownUp, Plus, RefreshCw, Trash2 } from "lucide-react";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { LoadingState } from "../components/LoadingState";
import { StatusBadge } from "../components/StatusBadge";
import { getWorkspaceInbox, type ProposalInboxEntry } from "../lib/proposalInbox";
import { scoreProposalRisk } from "../lib/proposalRisk";
import {
  loadProposalWorkspaces,
  saveProposalWorkspaces,
  type ProposalWorkspace,
} from "../lib/proposalWorkspaces";

type Props = {
  walletAddress: string | null;
  onConnect: () => void;
  onApprove: (entry: ProposalInboxEntry) => Promise<void>;
  onExecute: (entry: ProposalInboxEntry) => Promise<void>;
};

function entryKey(entry: ProposalInboxEntry): string {
  return `${entry.workspace.contractId}:${entry.proposal.id}`;
}

function CompareView({ entries }: { entries: ProposalInboxEntry[] }) {
  const rows: Array<{ label: string; value: (entry: ProposalInboxEntry) => string }> = [
    { label: "Status", value: (entry) => entry.proposal.status },
    { label: "Amount", value: (entry) => `${entry.proposal.amount} ${entry.proposal.token}` },
    { label: "Recipient / target", value: (entry) => entry.proposal.to },
    { label: "Approvals", value: (entry) => `${entry.proposal.approvalWeight ?? entry.proposal.approvals} / ${entry.proposal.quorumWeight ?? entry.proposal.threshold}` },
    { label: "Risk signals", value: (entry) => {
      const risk = scoreProposalRisk(entry.proposal, entry.history);
      return `${risk.level} (${risk.score}/100)${risk.signals.length ? ` · ${risk.signals.map((signal) => signal.label).join(", ")}` : " · none detected"}`;
    } },
    { label: "Deadline", value: (entry) => entry.proposal.deadline },
    { label: "Description", value: (entry) => entry.proposal.description || "—" },
  ];

  return (
    <section
      aria-labelledby="proposal-comparison-heading"
      className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-5"
    >
      <div className="mb-4 flex items-center gap-2">
        <ArrowDownUp className="h-4 w-4 text-emerald-400" aria-hidden="true" />
        <h2 id="proposal-comparison-heading" className="font-semibold">
          Side-by-side comparison
        </h2>
      </div>
      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="min-w-[620px] w-full border-collapse text-left text-sm">
          <caption className="sr-only">Selected proposals compared by amount, recipients, approvals, and status</caption>
          <thead>
            <tr className="bg-zinc-800/70">
              <th scope="col" className="w-36 px-3 py-2 font-medium text-zinc-400">Detail</th>
              {entries.map((entry) => (
                <th scope="col" key={entryKey(entry)} className="min-w-52 px-3 py-2 font-medium text-zinc-200">
                  <span className="block truncate">{entry.workspace.name}</span>
                  <span className="font-mono text-[11px] font-normal text-zinc-500">
                    Proposal #{entry.proposal.id}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row" className="px-3 py-2.5 font-medium text-zinc-400">{row.label}</th>
                {entries.map((entry) => (
                  <td key={entryKey(entry)} className="max-w-64 break-words px-3 py-2.5 text-zinc-200">
                    {row.value(entry)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        Horizontal scrolling is available on narrow screens.
      </p>
    </section>
  );
}

export function ProposalInboxPage({ walletAddress, onConnect, onApprove, onExecute }: Props) {
  const [workspaces, setWorkspaces] = useState<ProposalWorkspace[]>([]);
  const [entries, setEntries] = useState<ProposalInboxEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [workspaceErrors, setWorkspaceErrors] = useState<Array<{ name: string; error: string }>>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showAdd, setShowAdd] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [contractId, setContractId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setStorageError(null);
    setWorkspaceErrors([]);
    try {
      const savedWorkspaces = loadProposalWorkspaces();
      setWorkspaces(savedWorkspaces);
      if (!walletAddress || savedWorkspaces.length === 0) {
        setEntries([]);
        setLoading(false);
        return;
      }

      const results = await Promise.allSettled(
        savedWorkspaces.map((workspace) => getWorkspaceInbox(workspace, walletAddress)),
      );
      const loaded: ProposalInboxEntry[] = [];
      const failures: Array<{ name: string; error: string }> = [];
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          loaded.push(...result.value);
        } else {
          failures.push({
            name: savedWorkspaces[index].name,
            error: result.reason instanceof Error ? result.reason.message : "Could not load this workspace.",
          });
        }
      });
      setEntries(loaded);
      setWorkspaceErrors(failures);
      setSelected((previous) => new Set([...previous].filter((key) => loaded.some((entry) => entryKey(entry) === key))));
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : "Could not read saved workspaces.");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [walletAddress]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const selectedEntries = useMemo(
    () => entries.filter((entry) => selected.has(entryKey(entry))),
    [entries, selected],
  );

  function addWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    try {
      const next = [...workspaces, { id: contractId.trim(), name: workspaceName.trim(), contractId: contractId.trim() }];
      saveProposalWorkspaces(next);
      setWorkspaceName("");
      setContractId("");
      setShowAdd(false);
      void reload();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not add workspace.");
    }
  }

  function removeWorkspace(workspace: ProposalWorkspace) {
    try {
      const next = workspaces.filter((item) => item.contractId !== workspace.contractId);
      saveProposalWorkspaces(next);
      setSelected(new Set());
      void reload();
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : "Could not remove workspace.");
    }
  }

  function toggleSelected(entry: ProposalInboxEntry) {
    const key = entryKey(entry);
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else if (next.size < 4) next.add(key);
      return next;
    });
  }

  async function runAction(entry: ProposalInboxEntry, action: "approve" | "execute") {
    setBusyAction(entryKey(entry));
    setActionError(null);
    try {
      if (action === "approve") await onApprove(entry);
      else await onExecute(entry);
      await reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The proposal action failed.");
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <main aria-labelledby="proposal-inbox-heading">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 id="proposal-inbox-heading" className="text-2xl font-semibold tracking-tight">Proposal inbox</h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-400">
            Review proposals that need your approval or execution across your saved workspaces.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void reload()} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-zinc-700 px-3 text-sm text-zinc-200 hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-emerald-500">
            <RefreshCw size={14} aria-hidden="true" /> Refresh
          </button>
          <button type="button" onClick={() => { setShowAdd((value) => !value); setFormError(null); }} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-emerald-700 px-3 text-sm font-medium text-white hover:bg-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-400">
            <Plus size={14} aria-hidden="true" /> Add workspace
          </button>
        </div>
      </div>

      {showAdd && (
        <form onSubmit={addWorkspace} className="mb-6 grid gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
          <div>
            <label htmlFor="inbox-workspace-name" className="mb-1 block text-xs text-zinc-400">Workspace name</label>
            <input id="inbox-workspace-name" value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} required maxLength={60} className="min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500" />
          </div>
          <div>
            <label htmlFor="inbox-contract-id" className="mb-1 block text-xs text-zinc-400">Soroban contract address</label>
            <input id="inbox-contract-id" value={contractId} onChange={(event) => setContractId(event.target.value.trim().toUpperCase())} required spellCheck={false} autoCapitalize="characters" placeholder="C..." className="min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 font-mono text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500" />
          </div>
          <button type="submit" className="min-h-11 rounded-lg bg-emerald-700 px-4 text-sm font-medium text-white hover:bg-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-400">Save workspace</button>
          {formError && <p role="alert" className="text-sm text-red-300 sm:col-span-3">{formError}</p>}
        </form>
      )}

      {storageError && (
        <div className="mb-6">
          <ErrorState message={storageError} onRetry={() => void reload()} />
        </div>
      )}
      {actionError && (
        <div className="mb-6">
          <ErrorState message={actionError} onRetry={() => void reload()} onDismiss={() => setActionError(null)} />
        </div>
      )}

      <section aria-labelledby="workspace-list-heading" className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 id="workspace-list-heading" className="mb-3 text-sm font-semibold">Connected workspaces</h2>
        {workspaces.length === 0 ? (
          <p className="text-sm text-zinc-400">No workspaces saved. Add a Soroban contract to start a unified inbox.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {workspaces.map((workspace) => (
              <li key={workspace.id} className="inline-flex min-h-9 max-w-full items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 text-xs">
                <span className="max-w-36 truncate font-medium text-zinc-200">{workspace.name}</span>
                <span className="max-w-40 truncate font-mono text-zinc-500">{workspace.contractId}</span>
                <button type="button" aria-label={`Remove ${workspace.name} workspace`} onClick={() => removeWorkspace(workspace)} className="rounded p-1 text-zinc-500 hover:text-red-300 focus:outline-none focus:ring-2 focus:ring-red-400">
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {!walletAddress ? (
        <EmptyState title="Connect a wallet to see your proposals" description="Your inbox only includes proposals that the connected wallet can approve or execute." action={<button type="button" onClick={onConnect} className="min-h-11 rounded-lg bg-emerald-700 px-4 text-sm font-medium text-white hover:bg-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-400">Connect wallet</button>} />
      ) : loading ? (
        <LoadingState message="Loading proposals across workspaces…" />
      ) : workspaceErrors.length === workspaces.length && workspaces.length > 0 ? (
        <ErrorState message={`Could not load proposals: ${workspaceErrors.map(({ name, error }) => `${name}: ${error}`).join("; ")}`} onRetry={() => void reload()} />
      ) : (
        <>
          {workspaceErrors.length > 0 && (
            <div role="alert" className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
              <p className="font-medium">Some workspaces could not be loaded.</p>
              <ul className="mt-1 list-inside list-disc text-xs text-amber-100/80">
                {workspaceErrors.map(({ name, error }) => <li key={name}>{name}: {error}</li>)}
              </ul>
            </div>
          )}
          {entries.length === 0 ? (
            workspaces.length === 0 ? (
              <EmptyState title="Add a workspace to begin" description="Add one or more Soroban contracts to collect the wallet's pending actions." action={<button type="button" onClick={() => setShowAdd(true)} className="min-h-11 rounded-lg bg-emerald-700 px-4 text-sm font-medium text-white hover:bg-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-400">Add workspace</button>} />
            ) : (
              <EmptyState title="You're all caught up" description="No proposals currently need action from this wallet." />
            )
          ) : (
            <section aria-labelledby="inbox-items-heading">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 id="inbox-items-heading" className="font-semibold">Needs your action <span className="ml-1 text-sm font-normal text-zinc-500">({entries.length})</span></h2>
                <p className="text-xs text-zinc-500">Select up to four proposals to compare.</p>
              </div>
              <ul className="space-y-3">
                {entries.map((entry) => {
                  const key = entryKey(entry);
                  const isExecute = entry.proposal.status === "ready";
                  return (
                    <li key={key} className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-5">
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <label className="inline-flex min-h-8 items-center gap-2 text-sm text-zinc-300">
                              <input type="checkbox" checked={selected.has(key)} disabled={!selected.has(key) && selected.size >= 4} onChange={() => toggleSelected(entry)} aria-label={`Compare proposal ${entry.proposal.id} in ${entry.workspace.name}`} className="h-4 w-4 accent-emerald-500 focus:ring-2 focus:ring-emerald-500" />
                              Compare
                            </label>
                            <StatusBadge status={entry.proposal.status} />
                            <span className="rounded-full bg-zinc-800 px-2 py-1 text-xs text-zinc-300">{entry.workspace.name}</span>
                            <span className="text-xs text-zinc-500">Proposal #{entry.proposal.id}</span>
                          </div>
                          <h3 className="mt-3 break-words font-medium text-zinc-100">{entry.proposal.description || `${entry.proposal.amount} ${entry.proposal.token}`}</h3>
                          <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
                            <div><dt className="text-xs text-zinc-500">Amount</dt><dd className="mt-1 text-zinc-200">{entry.proposal.amount} {entry.proposal.token}</dd></div>
                            <div><dt className="text-xs text-zinc-500">Recipient / target</dt><dd className="mt-1 break-all font-mono text-xs text-zinc-300">{entry.proposal.to}</dd></div>
                            <div><dt className="text-xs text-zinc-500">Approvals / quorum</dt><dd className="mt-1 text-zinc-200">{entry.proposal.approvalWeight ?? entry.proposal.approvals} / {entry.proposal.quorumWeight ?? entry.proposal.threshold}</dd></div>
                          </dl>
                        </div>
                        <button type="button" onClick={() => void runAction(entry, isExecute ? "execute" : "approve")} disabled={busyAction === key} className="min-h-11 shrink-0 rounded-lg bg-emerald-700 px-4 text-sm font-medium text-white hover:bg-emerald-600 disabled:cursor-wait disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-emerald-400">
                          {busyAction === key ? "Submitting…" : isExecute ? "Execute" : "Approve"}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {selectedEntries.length >= 2 && <CompareView entries={selectedEntries} />}
        </>
      )}
    </main>
  );
}
