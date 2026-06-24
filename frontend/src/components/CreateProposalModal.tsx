import { useState } from "react";
import { createProposal } from "../lib/submit";
import { displayToStroops } from "../lib/soroban";
// Testnet token addresses — swap for mainnet when ready
const TOKEN_ADDRESSES: Record<string, string> = {
  XLM: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  USDC: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  EURC: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC",
};

type Props = {
  walletAddress: string | null;
  onClose: () => void;
  onSubmitted: () => void;
};

function truncateAddress(address: string | null) {
  if (!address) return "Not connected";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function CreateProposalModal({ walletAddress, onClose, onSubmitted }: Props) {
  const defaultDeadline = () => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  };

  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [token, setToken] = useState("XLM");
  const [description, setDescription] = useState("");
  const [deadline, setDeadline] = useState(defaultDeadline);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!walletAddress) {
      setError("Connect your wallet first.");
      return;
    }
    if (!to.trim() || !amount.trim() || !description.trim()) {
      setError("Recipient, amount, and description are required.");
      return;
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setError("Enter a valid amount.");
      return;
    }

    const tokenAddr = TOKEN_ADDRESSES[token];
    if (!tokenAddr) {
      setError("Unknown token.");
      return;
    }

    const amountStroops = displayToStroops(amountNum);

    // Deadline validation
    const deadlineMs = new Date(deadline).getTime();
    const nowMs = Date.now();
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    if (deadlineMs <= todayMidnight.getTime()) {
      setError("Deadline must be in the future.");
      return;
    }
    const maxMs = nowMs + 90 * 24 * 3600 * 1000;
    if (deadlineMs > maxMs) {
      setError("Deadline cannot be more than 90 days away.");
      return;
    }

    // Deadline: Unix seconds
    const deadlineUnix = BigInt(Math.floor(deadlineMs / 1000));

    setError(null);
    setSubmitting(true);
    try {
      await createProposal(
        walletAddress,
        to.trim(),
        tokenAddr,
        amountStroops,
        description.trim(),
        deadlineUnix
      );
      onSubmitted();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transaction failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl p-6 w-full max-w-md">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-white font-semibold text-lg">New Proposal</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300 text-xl"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-xs text-zinc-400 block mb-1.5">
              Proposer
            </label>
            <div
              className={`w-full border rounded-lg px-3 py-2.5 text-sm ${
                walletAddress
                  ? "bg-zinc-800/60 border-zinc-700/60 text-zinc-300 font-mono"
                  : "bg-zinc-800/30 border-zinc-700/30 text-zinc-500"
              } truncate`}
            >
              {truncateAddress(walletAddress)}
            </div>
          </div>

          <div>
            <label className="text-xs text-zinc-400 block mb-1.5">
              Recipient Address
            </label>
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="G..."
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm font-mono placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
            />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs text-zinc-400 block mb-1.5">Amount</label>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                type="number"
                min="0"
                step="any"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
              />
            </div>
            <div className="w-28">
              <label className="text-xs text-zinc-400 block mb-1.5">Token</label>
              <select
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-zinc-500"
              >
                <option>XLM</option>
                <option>USDC</option>
                <option>EURC</option>
              </select>
            </div>
          </div>

          <div>
            <label className="text-xs text-zinc-400 block mb-1.5">
              Description
            </label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this payment for?"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
            />
          </div>

          <div>
            <label className="text-xs text-zinc-400 block mb-1.5">
              Deadline
            </label>
            <input
              type="date"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-zinc-500"
            />
          </div>

          {error && (
            <p className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <div className="pt-2">
            {!walletAddress && (
              <p className="text-xs text-amber-400 mb-3">
                Connect your Freighter wallet to submit.
              </p>
            )}
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting}
              className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white py-2.5 rounded-lg font-medium transition-colors"
            >
              {submitting ? "Submitting…" : "Submit Proposal"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
