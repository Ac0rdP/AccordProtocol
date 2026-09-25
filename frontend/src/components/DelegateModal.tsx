import { useState } from "react";
import { createDelegation } from "../lib/submit";
import { contractErrorMessage, shortenAddr } from "../lib/soroban";

// No expiry chosen in the form falls back to a 1-year delegation window —
// the contract requires a concrete, future expiry timestamp.
const DEFAULT_EXPIRY_DAYS = 365;

type Props = {
  walletAddress: string;
  ownerWeight: number;
  candidates: Array<{ address: string; label: string }>;
  onClose: () => void;
  onSubmitted: () => void;
};

export function DelegateModal({
  walletAddress,
  ownerWeight,
  candidates,
  onClose,
  onSubmitted,
}: Props) {
  const [delegate, setDelegate] = useState(candidates[0]?.address ?? "");
  const [expiry, setExpiry] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!delegate) {
      setError("Choose an owner to delegate to.");
      return;
    }

    let expiryTs: bigint;
    if (expiry.trim()) {
      const ms = new Date(expiry).getTime();
      if (isNaN(ms) || ms <= Date.now()) {
        setError("Expiry must be a valid date in the future.");
        return;
      }
      expiryTs = BigInt(Math.floor(ms / 1000));
    } else {
      expiryTs = BigInt(Math.floor(Date.now() / 1000) + DEFAULT_EXPIRY_DAYS * 24 * 3600);
    }

    setSubmitting(true);
    setError(null);
    try {
      await createDelegation(walletAddress, delegate, ownerWeight, expiryTs);
      onSubmitted();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? contractErrorMessage(e.message) : "Transaction failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      aria-hidden="true"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delegate-modal-title"
        className="bg-zinc-900 border border-zinc-700 rounded-2xl p-4 sm:p-6 w-full max-w-md"
      >
        <div className="flex items-center justify-between mb-6">
          <h2 id="delegate-modal-title" className="text-white font-semibold text-lg">
            Delegate Voting Weight
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close delegate modal"
            className="text-zinc-500 hover:text-zinc-300 text-xl focus:ring-2 focus:ring-zinc-400 focus:outline-none rounded-md"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4">
          <p className="text-xs text-zinc-400">
            Delegate your full voting weight ({ownerWeight}) to another owner.
            They can vote with it until the delegation expires or you revoke it.
          </p>

          <div>
            <label htmlFor="delegate-address" className="text-xs text-zinc-400 block mb-1.5">
              Delegate To
            </label>
            <select
              id="delegate-address"
              value={delegate}
              onChange={(e) => setDelegate(e.target.value)}
              aria-label="Delegate to owner"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
            >
              {candidates.length === 0 && <option value="">No other owners available</option>}
              {candidates.map((c) => (
                <option key={c.address} value={c.address}>
                  {c.label} ({shortenAddr(c.address)})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="delegate-expiry" className="text-xs text-zinc-400 block mb-1.5">
              Expiry (optional)
            </label>
            <input
              id="delegate-expiry"
              type="date"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              aria-label="Delegation expiry"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
            />
            <p className="text-xs text-zinc-500 mt-1">
              Leave blank for a {DEFAULT_EXPIRY_DAYS}-day delegation.
            </p>
          </div>

          {error && (
            <p className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{error}</p>
          )}

          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || candidates.length === 0}
            aria-label="Create delegation"
            className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white py-2.5 rounded-lg font-medium transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none"
          >
            {submitting ? "Submitting…" : "Delegate"}
          </button>
        </div>
      </div>
    </div>
  );
}
