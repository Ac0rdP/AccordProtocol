import { useEffect, useMemo, useRef, useState } from "react";
import type { Proposal } from "../types/accord";
import {
  BULK_ACTION_LABELS,
  eligibleProposals,
  retryableIds,
  runBulkAction,
  summarizeResults,
  type BulkActionKind,
  type BulkItemResult,
  type BulkItemStatus,
} from "../lib/bulkActions";
import { EmptyState } from "./EmptyState";
import { StatusBadge } from "./StatusBadge";

type Step = "select" | "review" | "running" | "done";

const STEPS: { key: Step; label: string }[] = [
  { key: "select", label: "Select" },
  { key: "review", label: "Review" },
  { key: "running", label: "Submit" },
  { key: "done", label: "Results" },
];

const RESULT_STYLES: Record<BulkItemStatus, { label: string; className: string }> = {
  queued: { label: "Queued", className: "text-zinc-400" },
  running: { label: "Waiting for signature…", className: "text-amber-400" },
  succeeded: { label: "Done", className: "text-emerald-400" },
  failed: { label: "Failed", className: "text-red-400" },
  skipped: { label: "Skipped", className: "text-zinc-400" },
};

const FOCUS_RING =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950";

export type BulkActionWorkflowProps = {
  proposals: Proposal[];
  walletAddress: string | null;
  /** Approve a single proposal. Must throw a user-facing message on failure. */
  onApprove: (id: number) => Promise<void>;
  /** Execute a single proposal. Must throw a user-facing message on failure. */
  onExecute: (id: number) => Promise<void>;
  /** Called once a batch finishes so callers can refresh contract data. */
  onBatchComplete?: () => void;
  onConnectWallet?: () => void;
  initialAction?: BulkActionKind;
};

/**
 * Guided select → review → submit → results flow for approving or executing
 * several proposals at once. Each proposal is still its own signed
 * transaction; the flow only sequences them and reports per-item outcomes.
 */
export function BulkActionWorkflow({
  proposals,
  walletAddress,
  onApprove,
  onExecute,
  onBatchComplete,
  onConnectWallet,
  initialAction = "execute",
}: BulkActionWorkflowProps) {
  const [action, setAction] = useState<BulkActionKind>(initialAction);
  const [step, setStep] = useState<Step>("select");
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [results, setResults] = useState<BulkItemResult[]>([]);
  const [stopping, setStopping] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const isFirstRender = useRef(true);

  const candidates = useMemo(() => eligibleProposals(proposals, action), [proposals, action]);
  const byId = useMemo(() => new Map(proposals.map((p) => [p.id, p])), [proposals]);
  // Selection survives refreshes, but only for proposals that are still eligible.
  const selectedIds = useMemo(
    () => candidates.filter((p) => selected.has(p.id)).map((p) => p.id),
    [candidates, selected],
  );
  const labels = BULK_ACTION_LABELS[action];

  // Move focus to the step heading whenever the step changes so keyboard and
  // screen-reader users land at the start of the new content.
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function changeAction(next: BulkActionKind) {
    setAction(next);
    setSelected(new Set());
  }

  function toggle(id: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(
      selectedIds.length === candidates.length
        ? new Set()
        : new Set(candidates.map((p) => p.id)),
    );
  }

  async function run(ids: number[]) {
    const controller = new AbortController();
    abortRef.current = controller;
    setStopping(false);
    setStep("running");
    const perform = action === "approve" ? onApprove : onExecute;
    await runBulkAction(ids, perform, setResults, controller.signal);
    abortRef.current = null;
    setStep("done");
    onBatchComplete?.();
  }

  function stop() {
    setStopping(true);
    abortRef.current?.abort();
  }

  function startOver() {
    setSelected(new Set());
    setResults([]);
    setStep("select");
  }

  const summary = summarizeResults(results);
  const completed = results.filter(
    (r) => r.status !== "queued" && r.status !== "running",
  ).length;
  const retryIds = retryableIds(results);
  const stepIndex = STEPS.findIndex((s) => s.key === step);

  return (
    <section
      aria-labelledby="bulk-step-heading"
      className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 sm:p-6"
    >
      <ol className="mb-5 flex flex-wrap gap-2 text-xs" aria-label="Bulk action progress">
        {STEPS.map((s, index) => (
          <li
            key={s.key}
            aria-current={index === stepIndex ? "step" : undefined}
            className={`rounded-full px-3 py-1 ${
              index === stepIndex
                ? "bg-emerald-500/15 text-emerald-300"
                : index < stepIndex
                  ? "bg-zinc-800 text-zinc-300"
                  : "bg-zinc-800/50 text-zinc-500"
            }`}
          >
            <span className="sr-only">Step {index + 1} of {STEPS.length}: </span>
            {s.label}
          </li>
        ))}
      </ol>

      {step === "select" && (
        <>
          <h2
            id="bulk-step-heading"
            ref={headingRef}
            tabIndex={-1}
            className="mb-4 text-base font-semibold text-zinc-100 focus:outline-none"
          >
            Choose proposals to {labels.verb.toLowerCase()}
          </h2>

          <fieldset className="mb-4">
            <legend className="mb-2 text-xs uppercase tracking-wide text-zinc-400">
              Action
            </legend>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(BULK_ACTION_LABELS) as BulkActionKind[]).map((kind) => (
                <label
                  key={kind}
                  className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-4 py-2 text-sm has-focus-visible:ring-2 has-focus-visible:ring-emerald-400 ${
                    action === kind
                      ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-200"
                      : "border-zinc-700 text-zinc-300 hover:border-zinc-500"
                  }`}
                >
                  <input
                    type="radio"
                    name="bulk-action"
                    value={kind}
                    checked={action === kind}
                    onChange={() => changeAction(kind)}
                    className="accent-emerald-500"
                  />
                  {BULK_ACTION_LABELS[kind].verb} ({eligibleProposals(proposals, kind).length})
                </label>
              ))}
            </div>
          </fieldset>

          {candidates.length === 0 ? (
            <EmptyState
              variant="section"
              title={`No proposals to ${labels.verb.toLowerCase()}`}
              description={
                action === "execute"
                  ? "Proposals appear here once they reach quorum."
                  : "Pending proposals you have not approved yet appear here."
              }
            />
          ) : (
            <>
              <label className="mb-2 flex min-h-11 items-center gap-3 rounded-lg px-2 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  checked={selectedIds.length === candidates.length}
                  ref={(el) => {
                    if (el) {
                      el.indeterminate =
                        selectedIds.length > 0 && selectedIds.length < candidates.length;
                    }
                  }}
                  onChange={toggleAll}
                  className="h-4 w-4 accent-emerald-500"
                />
                Select all ({candidates.length})
              </label>

              <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
                {candidates.map((proposal) => (
                  <li key={proposal.id}>
                    <label className="flex min-h-11 cursor-pointer items-start gap-3 px-3 py-3 hover:bg-zinc-800/50">
                      <input
                        type="checkbox"
                        checked={selected.has(proposal.id)}
                        onChange={() => toggle(proposal.id)}
                        aria-describedby={`bulk-proposal-meta-${proposal.id}`}
                        className="mt-1 h-4 w-4 shrink-0 accent-emerald-500"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block wrap-break-word text-sm text-zinc-100">
                          #{proposal.id} · {proposal.description || "Untitled proposal"}
                        </span>
                        <span
                          id={`bulk-proposal-meta-${proposal.id}`}
                          className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400"
                        >
                          <span>
                            {proposal.amount} {proposal.token}
                          </span>
                          <span>Due {proposal.deadline}</span>
                          <StatusBadge status={proposal.status} />
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-zinc-400" aria-live="polite">
              {selectedIds.length} selected
            </p>
            <button
              type="button"
              disabled={selectedIds.length === 0}
              onClick={() => setStep("review")}
              className={`min-h-11 rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`}
            >
              Review {selectedIds.length || ""} {selectedIds.length === 1 ? "proposal" : "proposals"}
            </button>
          </div>
        </>
      )}

      {step === "review" && (
        <>
          <h2
            id="bulk-step-heading"
            ref={headingRef}
            tabIndex={-1}
            className="mb-2 text-base font-semibold text-zinc-100 focus:outline-none"
          >
            Review: {labels.verb.toLowerCase()} {selectedIds.length}{" "}
            {selectedIds.length === 1 ? "proposal" : "proposals"}
          </h2>
          <p className="mb-4 text-sm text-zinc-400">
            Each proposal is submitted as its own transaction, one after another. Your
            wallet will ask you to sign {selectedIds.length}{" "}
            {selectedIds.length === 1 ? "time" : "times"}. A failure does not stop the rest
            of the batch.
          </p>
          <ul className="mb-5 space-y-2">
            {selectedIds.map((id) => {
              const proposal = byId.get(id);
              return (
                <li
                  key={id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-zinc-800/60 px-3 py-2 text-sm"
                >
                  <span className="min-w-0 wrap-break-word text-zinc-100">
                    #{id} · {proposal?.description || "Untitled proposal"}
                  </span>
                  <span className="text-xs text-zinc-400">
                    {proposal?.amount} {proposal?.token}
                  </span>
                </li>
              );
            })}
          </ul>

          {!walletAddress && (
            <div
              role="alert"
              className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-300"
            >
              Connect a wallet to sign these transactions.
              {onConnectWallet && (
                <button
                  type="button"
                  onClick={onConnectWallet}
                  className={`min-h-11 rounded-lg bg-zinc-800 px-3 py-1.5 text-zinc-200 hover:bg-zinc-700 ${FOCUS_RING}`}
                >
                  Connect wallet
                </button>
              )}
            </div>
          )}

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => setStep("select")}
              className={`min-h-11 rounded-lg bg-zinc-800 px-5 py-2 text-sm text-zinc-200 hover:bg-zinc-700 ${FOCUS_RING}`}
            >
              Back
            </button>
            <button
              type="button"
              disabled={!walletAddress}
              onClick={() => void run(selectedIds)}
              className={`min-h-11 rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`}
            >
              Confirm and {labels.verb.toLowerCase()} {selectedIds.length}
            </button>
          </div>
        </>
      )}

      {(step === "running" || step === "done") && (
        <>
          <h2
            id="bulk-step-heading"
            ref={headingRef}
            tabIndex={-1}
            className="mb-2 text-base font-semibold text-zinc-100 focus:outline-none"
          >
            {step === "running"
              ? `${labels.verb === "Approve" ? "Approving" : "Executing"} proposals`
              : "Batch results"}
          </h2>

          {step === "running" ? (
            <div className="mb-4">
              <p className="mb-2 text-sm text-zinc-400" aria-live="polite">
                {completed} of {results.length} complete
              </p>
              <div
                role="progressbar"
                aria-label="Batch progress"
                aria-valuemin={0}
                aria-valuemax={results.length}
                aria-valuenow={completed}
                className="h-2 overflow-hidden rounded-full bg-zinc-800"
              >
                <div
                  className="h-full bg-emerald-500 transition-all"
                  style={{
                    width: `${results.length ? (completed / results.length) * 100 : 0}%`,
                  }}
                />
              </div>
            </div>
          ) : (
            <p role="status" className="mb-4 text-sm text-zinc-300">
              {summary.succeeded} {labels.past}, {summary.failed} failed
              {summary.skipped > 0 ? `, ${summary.skipped} skipped` : ""}.
            </p>
          )}

          <ul className="mb-5 divide-y divide-zinc-800 rounded-lg border border-zinc-800" aria-label="Per-proposal results">
            {results.map((item) => {
              const style = RESULT_STYLES[item.status];
              const proposal = byId.get(item.id);
              return (
                <li key={item.id} className="px-3 py-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 wrap-break-word text-zinc-100">
                      #{item.id} · {proposal?.description || "Untitled proposal"}
                    </span>
                    <span className={`text-xs font-medium ${style.className}`}>
                      {style.label}
                    </span>
                  </div>
                  {item.error && (
                    <p className="mt-1 text-xs text-red-300">{item.error}</p>
                  )}
                </li>
              );
            })}
          </ul>

          {step === "running" ? (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={stop}
                disabled={stopping}
                className={`min-h-11 rounded-lg bg-zinc-800 px-5 py-2 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-50 ${FOCUS_RING}`}
              >
                {stopping ? "Stopping after current…" : "Stop after current"}
              </button>
            </div>
          ) : (
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={startOver}
                className={`min-h-11 rounded-lg bg-zinc-800 px-5 py-2 text-sm text-zinc-200 hover:bg-zinc-700 ${FOCUS_RING}`}
              >
                Start a new batch
              </button>
              {retryIds.length > 0 && (
                <button
                  type="button"
                  disabled={!walletAddress}
                  onClick={() => void run(retryIds)}
                  className={`min-h-11 rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50 ${FOCUS_RING}`}
                >
                  Retry {retryIds.length} unfinished
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
