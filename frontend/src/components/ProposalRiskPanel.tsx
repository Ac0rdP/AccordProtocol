import { useMemo } from "react";
import type { Proposal } from "../types/accord";
import { scoreProposalRisk, type RiskLevel } from "../lib/proposalRisk";
import { ErrorState } from "./ErrorState";
import { LoadingState } from "./LoadingState";

type ProposalRiskPanelProps = {
  proposal: Proposal;
  /** Other proposals in the vault, used as the baseline for "unusual". */
  history: Proposal[];
  loading?: boolean;
  error?: string | null;
  now?: number;
};

const LEVEL_STYLES: Record<RiskLevel, string> = {
  low: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
  medium: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  high: "border-red-500/20 bg-red-500/10 text-red-300",
};

export function ProposalRiskPanel({
  proposal,
  history,
  loading = false,
  error = null,
  now,
}: ProposalRiskPanelProps) {
  const risk = useMemo(
    () => scoreProposalRisk(proposal, history, now),
    [proposal, history, now],
  );

  return (
    <section
      aria-labelledby="risk-panel-heading"
      className="rounded-xl border border-zinc-800 bg-zinc-900 p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id="risk-panel-heading"
          className="text-xs uppercase tracking-[0.2em] text-zinc-600 dark:text-zinc-400"
        >
          Risk check
        </h2>
        {!loading && !error && (
          <span
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize ${LEVEL_STYLES[risk.level]}`}
          >
            {risk.level} risk · {risk.score}/100
          </span>
        )}
      </div>

      {loading ? (
        <LoadingState message="Checking risk signals…" variant="inline" />
      ) : error ? (
        <ErrorState message={error} variant="section" />
      ) : risk.signals.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-400">
          No unusual recipient, amount, weight, or timing signals found.
        </p>
      ) : (
        <ul className="mt-3 space-y-2" aria-label="Risk warnings">
          {risk.signals.map((signal) => (
            <li
              key={signal.id}
              className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2"
            >
              <p className="text-sm font-medium text-zinc-200">{signal.label}</p>
              <p className="text-xs text-zinc-400">{signal.detail}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
