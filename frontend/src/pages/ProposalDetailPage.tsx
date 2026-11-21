import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { getTokenBalanceOf, getTreasuryTokenBalance } from "../lib/contract";
import { previewProposalExecution, type ProposalExecutionDryRun } from "../lib/transactionPreview";
import { rawCidFromDigestHex } from "../lib/ipfs";
import { stroopsToDisplay } from "../lib/soroban";
import { ApprovalBar } from "../components/ApprovalBar";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { MarkdownDescription } from "../components/MarkdownDescription";
import { LoadingState } from "../components/LoadingState";
import { StatusBadge } from "../components/StatusBadge";
import { PageState } from "../components/PageState";
import { FiatValue } from "../components/FiatValue";
import { ProposalRiskPanel } from "../components/ProposalRiskPanel";
import { ShareQrCode } from "../components/ShareQrCode";
import type { Proposal, ProposalEvent } from "../types/accord";
import {
  getHistoricalWeightChangeEvents,
  getOwners,
  getProposalEvents,
  getRequiredQuorumWeight,
} from "../lib/contract";
import { useOwnerWeights } from "../hooks/useOwnerWeights";

type ProposalDetailPageProps = {
  proposals: Proposal[];
  walletAddress: string | null;
  onApprove: (id: number) => void;
  onExecute: (id: number) => void;
  /** Forces the loading state (used by the page-state matrix tests). */
  loading?: boolean;
  /** Forces the error state (used by the page-state matrix tests). */
  error?: string | null;
  onRetry?: () => void;
};

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
      <p className="text-xs uppercase tracking-[0.2em] text-zinc-600 dark:text-zinc-400">{label}</p>
      <div className="mt-2 text-sm text-zinc-200">{children}</div>
    </div>
  );
}

type DiffEntry = { label: string; timestamp: string; changes: string[] };

/** Turns the append-only event feed into a compact, readable proposal diff. */
function buildTimelineDiff(proposal: Proposal, events: ProposalEvent[]): DiffEntry[] {
  let approvals = 0;
  let status: Proposal["status"] = "pending";
  const entries: DiffEntry[] = [{
    label: "Created",
    timestamp: proposal.createdAt,
    changes: [
      `Metadata: ${proposal.description || "No description"}`,
      `Recipient: ${proposal.to}`,
      `Amount: ${proposal.amount} ${proposal.token}`,
      "Status: pending",
    ],
  }];

  for (const event of events) {
    const type = event.type.toLowerCase();
    const changes: string[] = [];
    let label: string;
    if (type === "approved" || type === "approve") {
      approvals += 1;
      label = "Approval added";
      changes.push(`Approvals: ${approvals} / ${proposal.threshold}`);
      if (approvals >= proposal.threshold && status !== "ready") {
        status = "ready";
        changes.push("Status: pending → ready");
      }
    } else if (type === "revoked" || type === "revoke") {
      approvals = Math.max(0, approvals - 1);
      label = "Approval revoked";
      changes.push(`Approvals: ${approvals} / ${proposal.threshold}`);
      if (status === "ready") {
        status = "pending";
        changes.push("Status: ready → pending");
      }
    } else if (type === "executed" || type === "execute") {
      label = "Executed";
      changes.push(`Status: ${status} → executed`);
      status = "executed";
    } else if (type.includes("weight")) {
      label = "Governance metadata changed";
      changes.push(`Change: ${event.details || "Owner voting weight changed"}`);
    } else {
      label = event.type.replace(/_/g, " ");
      changes.push(`Change: ${event.details || `Actor: ${event.actor}`}`);
    }
    entries.push({ label, timestamp: event.timestamp, changes });
  }
  return entries;
}

export function ProposalDetailPage({
  proposals,
  walletAddress,
  onApprove,
  onExecute,
  loading = false,
  error = null,
  onRetry,
}: ProposalDetailPageProps) {
  const { id } = useParams();
  const proposalId = Number(id);
  const proposal = Number.isInteger(proposalId)
    ? proposals.find((candidate) => candidate.id === proposalId)
    : undefined;
  const connected = Boolean(walletAddress);
  const showApprove = proposal?.status === "pending" && !proposal.userHasApproved;
  const showExecute = connected && proposal?.status === "ready";
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);

  const [events, setEvents] = useState<ProposalEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState<boolean>(true);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState<ProposalExecutionDryRun | null>(null);
  const [dryRunLoading, setDryRunLoading] = useState(false);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const [liveBalances, setLiveBalances] = useState<Array<{ label: string; amount: string }> | null>(null);
  const [liveBalanceError, setLiveBalanceError] = useState<string | null>(null);

  // Owners / weights for weight-based approval bar
  const [ownerAddresses, setOwnerAddresses] = useState<string[]>([]);
  const { weights, totalWeight } = useOwnerWeights(ownerAddresses);
  const [quorumWeight, setQuorumWeight] = useState<number>(0);

  useEffect(() => {
    let active = true;
    getOwners()
      .then((owners) => {
        if (active) setOwnerAddresses(owners);
      })
      .catch(() => {
        /* noop */
      });

    getRequiredQuorumWeight()
      .then((w) => {
        if (active) setQuorumWeight(w);
      })
      .catch(() => {
        /* noop */
      });

    return () => { active = false; };
  }, []);

  useEffect(() => {
    setAwaitingConfirmation(false);

    if (!proposal) return;

    let active = true;
    setLoadingEvents(true);
    setEventsError(null);

    Promise.all([
      getProposalEvents(proposal.id).catch(() => [] as ProposalEvent[]),
      // Weight-change (c_wgt) events carry no proposal id, so load the
      // global history and interleave it chronologically with the
      // proposal-scoped approve/revoke/execute entries.
      getHistoricalWeightChangeEvents().catch(() => []),
    ])
      .then(([proposalEvents, weightChanges]) => {
        if (!active) return;
        const weightEvents: ProposalEvent[] = weightChanges.map((change) => ({
          type: "owner_weight_changed",
          actor: change.owner,
          timestamp: change.timestamp,
          ledger: change.ledger,
          details: `${change.owner} Weight: ${change.oldWeight} → ${change.newWeight}`,
        }));
        // De-duplicate in case the proposal event feed already contains the
        // same weight-change entries (same ledger + owner + weights).
        const seen = new Set(
          proposalEvents.map(
            (e) => `${e.type}|${e.ledger}|${e.actor}|${e.details}`,
          ),
        );
        const merged = [...proposalEvents];
        for (const e of weightEvents) {
          const key = `${e.type}|${e.ledger}|${e.actor}|${e.details}`;
          // Also match shortened-actor variants produced by getProposalEvents.
          const shortKey = `${e.type}|${e.ledger}`;
          const already = [...seen].some(
            (k) => k === key || k.startsWith(shortKey),
          );
          if (!already) {
            merged.push(e);
            seen.add(key);
          }
        }
        merged.sort((a, b) => (a.ledger ?? 0) - (b.ledger ?? 0));
        setEvents(merged);
        setLoadingEvents(false);
      })
      .catch((err) => {
        if (active) {
          console.error("Failed to load proposal events:", err);
          setEventsError(
            err instanceof Error ? err.message : "Failed to load events."
          );
          setLoadingEvents(false);
        }
      });

    return () => {
      active = false;
    };
  }, [proposal?.id, proposal?.status]);

  useEffect(() => {
    if (
      proposal?.status !== "executed" ||
      proposal.kind !== "transfer" ||
      !proposal.tokenAddress ||
      !proposal.recipientAddress
    ) {
      setLiveBalances(null);
      setLiveBalanceError(null);
      return;
    }

    let active = true;
    Promise.all([
      getTreasuryTokenBalance(proposal.tokenAddress),
      getTokenBalanceOf(proposal.tokenAddress, proposal.recipientAddress),
    ])
      .then(([treasury, recipient]) => {
        if (active) {
          setLiveBalances([
            { label: "Treasury", amount: stroopsToDisplay(treasury) },
            { label: "Recipient", amount: stroopsToDisplay(recipient) },
          ]);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setLiveBalanceError(reason instanceof Error ? reason.message : "Could not read current balances.");
        }
      });

    return () => { active = false; };
  }, [proposal?.id, proposal?.status, proposal?.kind, proposal?.tokenAddress, proposal?.recipientAddress]);

  if (loading) {
    return <PageState status="loading" title="Loading proposal…" />;
  }

  if (error) {
    return (
      <PageState
        status="error"
        title="Could not load proposal"
        description={error}
        onRetry={onRetry}
      />
    );
  }

  if (!proposal) {
    return (
      <EmptyState
        title="Proposal not found"
        description="No proposal matches this URL."
        action={
          <Link
            to="/app"
            className="inline-flex rounded-lg bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-white focus:outline-none focus:ring-2 focus:ring-zinc-400"
          >
            Back to dashboard
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link
            to="/app"
            className="text-sm text-zinc-600 dark:text-zinc-400 transition-colors hover:text-zinc-300"
          >
            Back to dashboard
          </Link>
          <p className="mt-5 text-xs font-semibold uppercase tracking-[0.25em] text-zinc-600 dark:text-zinc-400">
            Proposal Detail
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
            Proposal #{proposal.id}
          </h1>
        </div>
        <StatusBadge status={proposal.status} />
      </div>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">Amount</p>
            <p className="mt-1 text-2xl font-semibold text-white">
              {proposal.amount} {proposal.token}
            </p>
            <FiatValue amount={proposal.amount} token={proposal.token} className="mt-1" />
          </div>
          <div className="sm:min-w-64">
            <ApprovalBar
              approvals={proposal.approvals}
              threshold={proposal.threshold}
              approverAddresses={proposal.approverAddresses}
              approverWeights={proposal.approverWeights}
              approvalWeight={(proposal.approverAddresses || []).reduce((acc, addr) => acc + (weights[addr] ?? 0), 0)}
              quorumWeight={quorumWeight || proposal.threshold}
              totalWeight={totalWeight}
            />
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <DetailRow label="Recipient Address">
          <p className="break-all font-mono">{proposal.to}</p>
        </DetailRow>
        <DetailRow label="Approvals">
          {proposal.approvals} / {proposal.threshold}
        </DetailRow>
        <DetailRow label="Deadline">{proposal.deadline}</DetailRow>
        <DetailRow label="Created Date">{proposal.createdAt}</DetailRow>
        <DetailRow label="Status">
          <StatusBadge status={proposal.status} />
        </DetailRow>
        <DetailRow label="Proposer">
          <p className="break-all font-mono">{proposal.proposer}</p>
        </DetailRow>
      </section>

      {proposal.attachmentHash && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-5" aria-labelledby="proposal-attachment-heading">
          <h2 id="proposal-attachment-heading" className="text-sm font-semibold text-zinc-200">Supporting document</h2>
          <p className="mt-1 break-all font-mono text-xs text-zinc-500">SHA-256 · {proposal.attachmentHash}</p>
          {rawCidFromDigestHex(proposal.attachmentHash) && (
            <a
              href={`https://ipfs.io/ipfs/${rawCidFromDigestHex(proposal.attachmentHash)}`}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex min-h-11 items-center rounded-lg border border-zinc-700 px-3 text-sm text-emerald-300 hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            >
              Open attachment on IPFS
            </a>
          )}
        </section>
      )}

      {(proposal.status === "ready" || proposal.status === "executed") && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-5" aria-labelledby="execution-comparison-heading">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 id="execution-comparison-heading" className="text-sm font-semibold text-zinc-200">Dry-run vs. execution</h2>
              <p className="mt-1 text-sm text-zinc-400">Simulate the proposal execution to review projected balances and required authorization before signing.</p>
            </div>
            {proposal.status === "ready" && (
              <button
                type="button"
                disabled={!walletAddress || dryRunLoading}
                onClick={() => {
                  if (!walletAddress) return;
                  setDryRunLoading(true);
                  setDryRunError(null);
                  previewProposalExecution(walletAddress, proposal)
                    .then(setDryRun)
                    .catch((reason: unknown) => setDryRunError(reason instanceof Error ? reason.message : "Execution simulation failed."))
                    .finally(() => setDryRunLoading(false));
                }}
                className="min-h-11 shrink-0 rounded-lg border border-zinc-700 px-3 text-sm text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                {dryRunLoading ? "Simulating…" : dryRun ? "Run again" : "Run dry-run"}
              </button>
            )}
          </div>
          {dryRunError && <p role="alert" className="mt-3 text-sm text-red-300">{dryRunError}</p>}
          {proposal.status === "executed" && !dryRun && (
            <p className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 text-sm text-zinc-400">
              No dry-run snapshot is available for this execution. Run the simulation while a proposal is ready to compare its projected balances and authorization requirements with the confirmed event.
            </p>
          )}
          {dryRun && (
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-sky-300">Simulated</h3>
                <p className="mt-2 text-sm text-zinc-300">Estimated fee: {dryRun.feeEstimate.toFixed(7)} XLM</p>
                <p className="mt-1 text-sm text-zinc-300">Authorization entries: {dryRun.authorizationEntryCount}</p>
                {dryRun.balances.length > 0 && (
                  <ul className="mt-3 space-y-2 text-xs">
                    {dryRun.balances.map((balance) => (
                      <li key={`${balance.label}-${balance.address}`} className="rounded bg-zinc-950/60 p-2">
                        <span className="text-zinc-400">{balance.label}: </span>
                        <span className="font-mono text-zinc-200">{balance.before} → {balance.after} {balance.token}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {dryRun.balanceErrors.length > 0 && (
                  <ul role="alert" className="mt-3 space-y-1 text-xs text-amber-300">
                    {dryRun.balanceErrors.map((message) => <li key={message}>{message}</li>)}
                  </ul>
                )}
              </div>
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-emerald-300">On-chain execution</h3>
                {proposal.status === "executed" ? (
                  <>
                    <p className="mt-2 text-sm text-zinc-200">Execution confirmed by the contract.</p>
                    {events.filter((event) => event.type.toLowerCase() === "executed").slice(-1).map((event) => (
                      <p key={`${event.actor}-${event.ledger ?? event.timestamp}`} className="mt-1 break-words text-xs text-zinc-400">
                        Executor {event.actor}{event.ledger ? ` · ledger ${event.ledger}` : ""} · {event.timestamp}
                      </p>
                    ))}
                    <p className="mt-3 text-xs text-zinc-500">Current balances can include activity after this execution.</p>
                    {liveBalanceError && <p role="alert" className="mt-2 text-xs text-red-300">{liveBalanceError}</p>}
                    {liveBalances && (
                      <ul className="mt-2 space-y-1 text-xs text-zinc-300">
                        {liveBalances.map((balance) => <li key={balance.label}>{balance.label}: {balance.amount}</li>)}
                      </ul>
                    )}
                  </>
                ) : (
                  <p className="mt-2 text-sm text-zinc-400">No execution result is recorded yet. Approve the dry-run, then execute the proposal to populate this comparison.</p>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {proposal.status === "pending" && (
        <ProposalRiskPanel proposal={proposal} history={proposals} />
      )}

      <ShareQrCode
        url={typeof window === "undefined" ? "" : window.location.href}
        name={`proposal-${proposal.id}`}
      />

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-5" aria-labelledby="timeline-diff-heading">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 id="timeline-diff-heading" className="text-xs uppercase tracking-[0.2em] text-zinc-600 dark:text-zinc-400">Change timeline</h2>
            <p className="mt-1 text-sm text-zinc-400">Status, approvals, and proposal metadata over time.</p>
          </div>
          {loadingEvents && <LoadingState message="Building timeline…" variant="inline" />}
        </div>
        {!loadingEvents && eventsError && <div className="mt-4"><ErrorState message={eventsError} variant="section" /></div>}
        {!loadingEvents && !eventsError && (
          <ol className="mt-4 space-y-3 border-s border-zinc-700 ps-4">
            {buildTimelineDiff(proposal, events).map((entry, index) => (
              <li key={`${entry.label}-${index}`} className="relative">
                <span aria-hidden="true" className="absolute -start-[21px] top-1.5 h-2 w-2 rounded-full bg-emerald-500" />
                <div className="rounded-lg bg-zinc-950/50 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <h3 className="text-sm font-medium capitalize text-zinc-200">{entry.label}</h3>
                    <time className="text-xs text-zinc-500">{entry.timestamp}</time>
                  </div>
                  <ul className="mt-2 space-y-1 text-xs text-zinc-400">
                    {entry.changes.map((change) => <li key={change} className="break-words">{change}</li>)}
                  </ul>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
        <p className="text-xs uppercase tracking-[0.2em] text-zinc-600 dark:text-zinc-400">
          Description
        </p>
        <MarkdownDescription
          text={proposal.description}
          className="mt-3 text-sm text-zinc-300"
        />
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-[0.2em] text-zinc-600 dark:text-zinc-400">
            Activity Timeline
          </p>
          {loadingEvents && (
            <LoadingState message="Loading events…" variant="inline" />
          )}
        </div>

        {eventsError && (
          <div className="mt-4">
            <ErrorState message={eventsError} variant="section" />
          </div>
        )}

        {!loadingEvents && !eventsError && events.length === 0 && (
          <EmptyState variant="section" title="No activity yet" />
        )}

        {!loadingEvents && !eventsError && events.length > 0 && (
          <div className="mt-4 space-y-3">
            {events.map((event, index) => {
              const norm = String(event.type || "").toLowerCase().replace(/_/g, "");
              let badgeColors = "bg-amber-500/10 text-amber-400 border-amber-500/20";
              let label = "Revoked";

              if (norm === "approved" || norm === "approve") {
                badgeColors = "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
                label = "Approved";
              } else if (norm === "executed" || norm === "execute") {
                badgeColors = "bg-sky-500/10 text-sky-400 border-sky-500/20";
                label = "Executed";
              } else if (norm === "revoked" || norm === "revoke") {
                badgeColors = "bg-amber-500/10 text-amber-400 border-amber-500/20";
                label = "Revoked";
              } else if (
                norm === "ownerweightchanged" ||
                norm === "cwgt" ||
                norm === "ownerweightchange"
              ) {
                badgeColors = "bg-purple-500/10 text-purple-400 border-purple-500/20";
                label = "Weight Changed";
              } else if (
                (norm.includes("recurring") && norm.includes("creat")) ||
                norm === "reccreated" ||
                norm === "schedulecreated"
              ) {
                badgeColors = "bg-indigo-500/10 text-indigo-400 border-indigo-500/20";
                label = "Recurring Payment Created";
              } else if (
                (norm.includes("recurring") && norm.includes("disburs")) ||
                norm === "recdisbursed" ||
                norm === "scheduledisbursed" ||
                norm === "disbursed" ||
                norm === "disburse"
              ) {
                badgeColors = "bg-teal-500/10 text-teal-400 border-teal-500/20";
                label = "Recurring Payment Disbursed";
              } else if (
                (norm.includes("recurring") && norm.includes("pause")) ||
                norm === "recpaused" ||
                norm === "schedulepaused" ||
                norm === "paused" ||
                norm === "pause"
              ) {
                badgeColors = "bg-yellow-500/10 text-yellow-400 border-yellow-500/20";
                label = "Recurring Payment Paused";
              } else if (
                (norm.includes("recurring") && norm.includes("cancel")) ||
                norm.includes("cancel") ||
                norm === "reccancelled" ||
                norm === "schedulecancelled"
              ) {
                badgeColors = "bg-rose-500/10 text-rose-400 border-rose-500/20";
                label = "Recurring Payment Cancelled";
              }

              const isWeightChange =
                norm === "ownerweightchanged" ||
                norm === "cwgt" ||
                norm === "ownerweightchange";
              const details =
                event.details ||
                (isWeightChange
                  ? `${event.actor} Weight changed`
                  : event.scheduleId !== undefined || event.amount
                    ? [
                        event.scheduleId !== undefined ? `Schedule #${event.scheduleId}` : null,
                        event.amount
                          ? event.token
                            ? `${event.amount} ${event.token}`
                            : event.amount
                          : null,
                        event.recipient ? `to ${event.recipient}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : null);

              return (
                <div
                  key={`${event.type}-${event.actor}-${event.ledger ?? index}-${index}`}
                  className="flex flex-col gap-1 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <span
                      className={`inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-medium uppercase tracking-wider ${badgeColors}`}
                    >
                      {label}
                    </span>
                    <span className="font-mono text-sm text-zinc-200">
                      {event.actor}
                    </span>
                    {details && (
                      <span className="text-sm text-zinc-400">
                        {details}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-zinc-600 dark:text-zinc-400">{event.timestamp}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {(showApprove || showExecute) && (
        <section className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-5 sm:flex-row sm:items-center sm:justify-end">
          {showApprove && (
            <button
              type="button"
              onClick={() => onApprove(proposal.id)}
              aria-label={
                connected
                  ? `Approve proposal #${proposal.id}`
                  : `Connect and approve proposal #${proposal.id}`
              }
              className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-600 focus:outline-none focus:ring-2 focus:ring-zinc-400"
            >
              {connected ? "Approve" : "Connect & Approve"}
            </button>
          )}

          {showExecute && !awaitingConfirmation && (
            <button
              type="button"
              onClick={() => setAwaitingConfirmation(true)}
              aria-label={`Execute proposal #${proposal.id}`}
              className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-500 focus:outline-none focus:ring-2 focus:ring-zinc-400"
            >
              Execute
            </button>
          )}

          {showExecute && awaitingConfirmation && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <span className="text-sm text-zinc-400">Send this transaction?</span>
              <button
                type="button"
                onClick={() => {
                  onExecute(proposal.id);
                  setAwaitingConfirmation(false);
                }}
                className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-500 focus:outline-none focus:ring-2 focus:ring-zinc-400"
              >
                Confirm
              </button>
              <button
                type="button"
                onClick={() => setAwaitingConfirmation(false)}
                className="rounded-lg bg-zinc-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-600 focus:outline-none focus:ring-2 focus:ring-zinc-400"
              >
                Cancel
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
