import { Link, useParams } from "react-router-dom";
import { StatusBadge } from "../components/StatusBadge";
import { useProposal } from "../hooks/useProposal";

export function ProposalDetailPage() {
  const { id } = useParams();
  const proposalId = Number(id);
  const isValidProposalId = Number.isInteger(proposalId) && proposalId > 0;
  const { proposal, loading, error } = useProposal(proposalId);

  if (!isValidProposalId) {
    return (
      <div className="min-h-screen bg-zinc-950 px-6 py-16 text-white">
        <div className="mx-auto max-w-3xl rounded-3xl border border-zinc-900 bg-zinc-950 p-8">
          <p className="text-sm text-red-400">Invalid proposal identifier.</p>
          <Link to="/app" className="mt-6 inline-flex text-sm text-emerald-300 underline">
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 px-6 py-12 text-white">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-zinc-600">
              Proposal Detail
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">
              Proposal #{proposalId}
            </h1>
          </div>
          <Link
            to="/app"
            className="rounded-lg border border-zinc-800 px-4 py-2 text-sm text-zinc-300 transition-colors hover:border-zinc-700 hover:text-white"
          >
            Back to dashboard
          </Link>
        </div>

        {loading && (
          <div className="rounded-3xl border border-zinc-900 bg-zinc-950 p-8 text-sm text-zinc-400">
            Loading proposal details…
          </div>
        )}

        {!loading && error && (
          <div className="rounded-3xl border border-red-500/20 bg-red-500/10 p-8 text-sm text-red-300">
            {error}
          </div>
        )}

        {!loading && proposal && (
          <div className="rounded-3xl border border-zinc-900 bg-zinc-950 p-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm text-zinc-500">{proposal.createdAt}</p>
                <h2 className="mt-2 text-2xl font-semibold text-white">
                  Send {proposal.amount} {proposal.token}
                </h2>
                <p className="mt-2 font-mono text-sm text-zinc-400">
                  Recipient: {proposal.to}
                </p>
              </div>
              <StatusBadge status={proposal.status} />
            </div>

            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-zinc-900 bg-zinc-900/50 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-zinc-600">Approvals</p>
                <p className="mt-2 text-lg text-white">
                  {proposal.approvals} of {proposal.threshold}
                </p>
              </div>
              <div className="rounded-2xl border border-zinc-900 bg-zinc-900/50 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-zinc-600">Deadline</p>
                <p className="mt-2 text-lg text-white">{proposal.deadline}</p>
              </div>
            </div>

            <div className="mt-8 rounded-2xl border border-zinc-900 bg-zinc-900/50 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-zinc-600">Description</p>
              <p className="mt-3 text-sm leading-7 text-zinc-300">
                {proposal.description || "No description provided."}
              </p>
            </div>

            <div className="mt-8 rounded-2xl border border-zinc-900 bg-zinc-900/50 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-zinc-600">Proposer</p>
              <p className="mt-3 font-mono text-sm text-zinc-300">{proposal.proposer}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
