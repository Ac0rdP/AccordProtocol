import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import {
  getOwners,
  getProposalsPaged,
  getThreshold,
  getTotalProposals,
  getTotalWeight,
  mapProposal,
} from "../lib/contract";
import {
  parseEmbedParams,
  parseProposalId,
  redactShareError,
} from "../lib/shareLinks";
import type { Proposal } from "../types/accord";
import { StatusBadge } from "./StatusBadge";

export type EmbedWidgetProps = {
  mode: "proposal" | "treasury";
};

type TreasurySnapshot = {
  ownerCount: number;
  threshold: number;
  totalProposals: number;
  totalWeight: number;
};

export function EmbedWidget({ mode }: EmbedWidgetProps) {
  const { id } = useParams<{ id?: string }>();
  const location = useLocation();
  const { theme, compact } = parseEmbedParams(location.search);

  const parsedProposalId = mode === "proposal" ? parseProposalId(id) : null;
  const invalidProposalId = mode === "proposal" && parsedProposalId === null;

  const [loading, setLoading] = useState(!invalidProposalId);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [treasury, setTreasury] = useState<TreasurySnapshot | null>(null);

  useEffect(() => {
    if (invalidProposalId) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const [owners, threshold, totalProposals, totalWeight] =
          await Promise.all([
            getOwners(),
            getThreshold(),
            getTotalProposals(),
            getTotalWeight(),
          ]);

        if (cancelled) return;

        if (mode === "treasury") {
          setTreasury({
            ownerCount: owners.length,
            threshold,
            totalProposals,
            totalWeight,
          });
          return;
        }

        const rawList =
          totalProposals > 0
            ? await getProposalsPaged(0, Math.min(totalProposals, 50))
            : [];

        if (cancelled) return;

        const mapped = rawList.map((raw) => mapProposal(raw, threshold));
        const match =
          mapped.find((candidate) => candidate.id === parsedProposalId) ?? null;
        setProposal(match);
      } catch (err) {
        if (!cancelled) {
          setError(redactShareError(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [invalidProposalId, mode, parsedProposalId]);

  const shellClasses =
    theme === "light"
      ? "bg-white text-zinc-900 border-zinc-200"
      : "bg-zinc-950 text-white border-zinc-800";

  if (invalidProposalId) {
    return (
      <div
        data-testid="embed-error"
        data-theme={theme}
        data-compact={String(compact)}
        className={`rounded-xl border p-4 ${shellClasses}`}
      >
        <p className="text-xs font-semibold uppercase tracking-wider text-amber-500">
          Accord Embed
        </p>
        <h1 className="mt-1 text-base font-semibold">Invalid proposal link</h1>
        <p className="mt-1 text-xs text-zinc-400">
          The embedded proposal ID must be a positive integer.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div
        data-testid="embed-loading"
        data-theme={theme}
        data-compact={String(compact)}
        className={`rounded-xl border p-4 ${shellClasses}`}
      >
        <p className="text-xs text-zinc-400">Loading Accord widget…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div
        data-testid="embed-error"
        data-theme={theme}
        data-compact={String(compact)}
        className={`rounded-xl border p-4 ${shellClasses}`}
      >
        <p className="text-xs font-semibold uppercase tracking-wider text-rose-400">
          Accord Embed
        </p>
        <h1 className="mt-1 text-base font-semibold">
          Unable to load embedded {mode === "proposal" ? "proposal" : "treasury"}
        </h1>
        <p className="mt-1 text-xs text-zinc-400">{error}</p>
      </div>
    );
  }

  if (mode === "treasury" && treasury) {
    return (
      <article
        data-testid="embed-treasury-widget"
        data-theme={theme}
        data-compact={String(compact)}
        className={`rounded-xl border p-4 ${shellClasses}`}
      >
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
              Accord Multisig Treasury
            </p>
            <h1 className="mt-1 text-lg font-semibold">Treasury Overview</h1>
          </div>
          <Link
            to="/app"
            data-testid="embed-open-treasury-link"
            className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-400 hover:bg-emerald-500/20"
          >
            Open Accord Treasury
          </Link>
        </div>

        <dl className="mt-4 grid grid-cols-3 gap-3 text-xs">
          <div className="rounded-lg border border-zinc-800/60 p-2.5">
            <dt className="text-zinc-400">Threshold</dt>
            <dd className="mt-1 text-sm font-semibold">
              {treasury.threshold} of {treasury.totalWeight}
            </dd>
          </div>
          <div className="rounded-lg border border-zinc-800/60 p-2.5">
            <dt className="text-zinc-400">Signers</dt>
            <dd className="mt-1 text-sm font-semibold">
              {treasury.ownerCount}
            </dd>
          </div>
          <div className="rounded-lg border border-zinc-800/60 p-2.5">
            <dt className="text-zinc-400">Proposals</dt>
            <dd className="mt-1 text-sm font-semibold">
              {treasury.totalProposals}
            </dd>
          </div>
        </dl>
      </article>
    );
  }

  if (!proposal) {
    return (
      <div
        data-testid="embed-not-found"
        data-theme={theme}
        data-compact={String(compact)}
        className={`rounded-xl border p-4 ${shellClasses}`}
      >
        <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Accord Embed
        </p>
        <h1 className="mt-1 text-base font-semibold">Proposal not found</h1>
        <p className="mt-1 text-xs text-zinc-400">
          No on-chain proposal matches ID #{parsedProposalId}.
        </p>
      </div>
    );
  }

  return (
    <article
      data-testid="embed-proposal-widget"
      data-theme={theme}
      data-compact={String(compact)}
      className={`rounded-xl border p-4 ${shellClasses}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
            Accord Proposal Embed
          </p>
          <h1 className="mt-1 text-lg font-semibold">
            Proposal #{proposal.id}
          </h1>
        </div>
        <StatusBadge status={proposal.status} />
      </div>

      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
        <p
          data-testid="embed-proposal-amount"
          className="text-xl font-semibold"
        >
          {proposal.amount} {proposal.token}
        </p>
        <p
          data-testid="embed-proposal-approvals"
          className="font-mono text-xs text-zinc-400"
        >
          Approvals: {proposal.approvals} / {proposal.threshold}
        </p>
      </div>

      {!compact && (
        <div className="mt-3 space-y-1.5 text-xs text-zinc-400">
          <p data-testid="embed-proposal-description">
            {proposal.description || "No description provided."}
          </p>
          <p className="break-all font-mono">Recipient: {proposal.to}</p>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between border-t border-zinc-800/60 pt-3 text-xs">
        <span className="text-zinc-400">Read-only public widget</span>
        <Link
          to={`/proposals/${proposal.id}`}
          data-testid="embed-open-proposal-link"
          className="font-medium text-emerald-400 hover:text-emerald-300"
        >
          Open in Accord →
        </Link>
      </div>
    </article>
  );
}
