import { useEffect, useMemo, useState } from "react";
import { getOwnerWeight, getOwners, getRequiredQuorumWeight, getTotalWeight } from "../lib/contract";
import { createChangeOwnerWeightProposal } from "../lib/submit";

const MIN_OWNER_WEIGHT = 1;
const MAX_OWNER_WEIGHT = 100_000;
const MAX_DESCRIPTION_LEN = 300;

type Props = {
  walletAddress: string | null;
  onClose: () => void;
  onSubmitted: () => void;
  initialOwnerAddress?: string;
};

function formatPct(value: number) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "0.0%";
}

function formatDeadlineDate(deadline: string) {
  return new Date(`${deadline}T00:00:00`).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function CreateWeightChangeProposalModal({
  walletAddress,
  onClose,
  onSubmitted,
  initialOwnerAddress,
}: Props) {
  const [owners, setOwners] = useState<string[]>([]);
  const [ownerWeights, setOwnerWeights] = useState<Record<string, number>>({});
  const [selectedOwner, setSelectedOwner] = useState("");
  const [newWeight, setNewWeight] = useState("");
  const [description, setDescription] = useState("");
  const [deadline, setDeadline] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  });
  const [currentTotalWeight, setCurrentTotalWeight] = useState(0);
  const [requiredQuorumWeight, setRequiredQuorumWeight] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const [ownerAddresses, totalWeight, quorumWeight] = await Promise.all([
          getOwners(),
          getTotalWeight(),
          getRequiredQuorumWeight(),
        ]);
        const weights = await Promise.all(ownerAddresses.map((owner) => getOwnerWeight(owner)));

        if (cancelled) return;

        const weightMap = ownerAddresses.reduce<Record<string, number>>((acc, owner, index) => {
          acc[owner] = Number(weights[index] ?? 0n);
          return acc;
        }, {});

        setOwners(ownerAddresses);
        setOwnerWeights(weightMap);
        setCurrentTotalWeight(totalWeight);
        setRequiredQuorumWeight(quorumWeight);
        setSelectedOwner((current) => {
          if (current && ownerAddresses.includes(current)) return current;
          if (initialOwnerAddress && ownerAddresses.includes(initialOwnerAddress)) {
            return initialOwnerAddress;
          }
          return ownerAddresses[0] ?? "";
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load owner weights.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [initialOwnerAddress]);

  const currentOwnerWeight = ownerWeights[selectedOwner] ?? 0;
  const parsedWeight = Number.parseInt(newWeight, 10);
  const weightIsValid =
    Number.isInteger(parsedWeight) &&
    parsedWeight >= MIN_OWNER_WEIGHT &&
    parsedWeight <= MAX_OWNER_WEIGHT;
  const projectedTotalWeight = weightIsValid
    ? currentTotalWeight - currentOwnerWeight + parsedWeight
    : currentTotalWeight;
  const currentQuorumShare =
    currentTotalWeight > 0 ? (requiredQuorumWeight / currentTotalWeight) * 100 : 0;
  const projectedQuorumShare =
    projectedTotalWeight > 0
      ? (requiredQuorumWeight / projectedTotalWeight) * 100
      : 0;
  const descriptionCount = useMemo(() => description.length, [description]);

  function validate(): string | null {
    if (!walletAddress) {
      return "Connect your wallet first.";
    }
    if (!selectedOwner) {
      return "Select an owner to update.";
    }
    if (!Number.isInteger(parsedWeight) || parsedWeight < MIN_OWNER_WEIGHT) {
      return `Weight must be at least ${MIN_OWNER_WEIGHT}.`;
    }
    if (parsedWeight > MAX_OWNER_WEIGHT) {
      return `Weight must be no more than ${MAX_OWNER_WEIGHT}.`;
    }
    if (!description.trim()) {
      return "Description is required.";
    }
    if (description.trim().length > MAX_DESCRIPTION_LEN) {
      return "Description is too long.";
    }

    const deadlineMs = new Date(deadline).getTime();
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    if (deadlineMs <= todayMidnight.getTime()) {
      return "Deadline must be in the future.";
    }
    const maxMs = Date.now() + 90 * 24 * 3600 * 1000;
    if (deadlineMs > maxMs) {
      return "Deadline cannot be more than 90 days away.";
    }
    return null;
  }

  async function handleSubmit() {
    const validation = validate();
    if (validation) {
      setError(validation);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await createChangeOwnerWeightProposal(
        walletAddress!,
        selectedOwner,
        parsedWeight,
        description.trim(),
        BigInt(Math.floor(new Date(deadline).getTime() / 1000))
      );
      onSubmitted();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transaction failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Propose Weight Change"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-8"
    >
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-zinc-600">
              Governance
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-white">
              Propose Weight Change
            </h2>
            <p className="mt-1 text-sm text-zinc-400">
              Adjust an owner’s voting weight and preview the quorum impact.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-800 px-3 py-1.5 text-sm text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-white focus:outline-none focus:ring-2 focus:ring-zinc-400"
            aria-label="Close weight change modal"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        <div className="mt-5 grid gap-4">
          <label className="grid gap-2">
            <span className="text-xs uppercase tracking-[0.2em] text-zinc-600">
              Owner
            </span>
            <select
              value={selectedOwner}
              onChange={(e) => setSelectedOwner(e.target.value)}
              className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 font-mono text-sm text-white focus:outline-none focus:ring-2 focus:ring-zinc-400"
            >
              {loading && <option value="">Loading owners…</option>}
              {!loading &&
                owners.map((owner) => (
                  <option key={owner} value={owner}>
                    {owner.slice(0, 6)}…{owner.slice(-4)} (weight {ownerWeights[owner] ?? 0})
                  </option>
                ))}
            </select>
          </label>

          <label className="grid gap-2">
            <span className="text-xs uppercase tracking-[0.2em] text-zinc-600">
              New Weight
            </span>
            <input
              value={newWeight}
              onChange={(e) => setNewWeight(e.target.value)}
              type="number"
              min={MIN_OWNER_WEIGHT}
              max={MAX_OWNER_WEIGHT}
              step="1"
              placeholder="1"
              className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 font-mono text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
          </label>

          <label className="grid gap-2">
            <span className="text-xs uppercase tracking-[0.2em] text-zinc-600">
              Description
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Why is this weight change needed?"
              aria-label="Description"
              rows={4}
              maxLength={MAX_DESCRIPTION_LEN}
              className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
            <div className="text-right text-xs text-zinc-500">
              {descriptionCount} / {MAX_DESCRIPTION_LEN}
            </div>
          </label>

          <label className="grid gap-2">
            <span className="text-xs uppercase tracking-[0.2em] text-zinc-600">
              Deadline
            </span>
            <input
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              type="date"
              className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
            <p className="text-xs text-zinc-500">
              Submission deadline: {formatDeadlineDate(deadline)}
            </p>
          </label>
        </div>

        <section className="mt-5 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          <h3 className="text-sm font-semibold text-white">Quorum impact preview</h3>
          {loading ? (
            <p className="mt-3 text-sm text-zinc-500">Loading current weights…</p>
          ) : selectedOwner ? (
            <div className="mt-3 space-y-2 text-sm text-zinc-300">
              <p>Current owner weight: <span className="font-mono text-white">{currentOwnerWeight}</span></p>
              <p>Projected owner weight: <span className="font-mono text-white">{weightIsValid ? parsedWeight : "—"}</span></p>
              <p>Current total voting weight: <span className="font-mono text-white">{currentTotalWeight}</span></p>
              <p>Projected total voting weight: <span className="font-mono text-white">{projectedTotalWeight}</span></p>
              <p>Required quorum weight: <span className="font-mono text-white">{requiredQuorumWeight}</span></p>
              <p>Quorum share: <span className="font-mono text-white">{formatPct(currentQuorumShare)} → {formatPct(projectedQuorumShare)}</span></p>
            </div>
          ) : (
            <p className="mt-3 text-sm text-zinc-500">Select an owner to preview the effect.</p>
          )}
        </section>

        <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-900 hover:text-white focus:outline-none focus:ring-2 focus:ring-zinc-400"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || loading}
            className="rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-zinc-400 disabled:opacity-50"
          >
            {submitting ? "Submitting…" : "Submit Proposal"}
          </button>
        </div>
      </div>
    </div>
  );
}
