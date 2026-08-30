import { useEffect, useState } from "react";
import { getSpendingLimit } from "../lib/contract";
import { createSpendingLimitProposal } from "../lib/submit";
import { displayToStroops, stroopsToDisplay } from "../lib/soroban";
import { StrKey } from "@stellar/stellar-sdk";
import type { Owner } from "../types/accord";
import { CreateWeightChangeProposalModal } from "../components/CreateWeightChangeProposalModal";

const TOKEN_ADDRESSES: Record<string, string> = {
  XLM: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  USDC: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  EURC: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC",
};

const TOKEN_SYMBOLS = ["XLM", "USDC", "EURC"] as const;

type SpendingLimitMap = Record<string, Record<string, bigint>>;

type OwnersPageProps = {
  owners: Owner[];
  ownerAddresses: string[];
  threshold: number;
  totalWeight: number;
  walletAddress: string | null;
  onProposalSubmitted: () => void;
};

export function OwnersPage({
  owners,
  ownerAddresses,
  threshold,
  totalWeight,
  walletAddress,
  onProposalSubmitted,
}: OwnersPageProps) {
  const [spendingLimits, setSpendingLimits] = useState<SpendingLimitMap>({});
  const [limitsLoading, setLimitsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [showWeightForm, setShowWeightForm] = useState(false);
  const [weightTargetOwner, setWeightTargetOwner] = useState<string>("");

  // Spending limit proposal form state
  const [slOwner, setSlOwner] = useState("");
  const [slToken, setSlToken] = useState("XLM");
  const [slAmount, setSlAmount] = useState("");
  const [slDescription, setSlDescription] = useState("");
  const [slDeadline, setSlDeadline] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  });
  const [slSubmitting, setSlSubmitting] = useState(false);
  const [slError, setSlError] = useState<string | null>(null);

  // Load spending limits for all owners and tokens
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLimitsLoading(true);
      const map: SpendingLimitMap = {};
      for (const addr of ownerAddresses) {
        map[addr] = {};
        for (const symbol of TOKEN_SYMBOLS) {
          const tokenAddr = TOKEN_ADDRESSES[symbol];
          const limit = await getSpendingLimit(addr, tokenAddr);
          if (!cancelled) {
            map[addr][symbol] = limit;
          }
        }
      }
      if (!cancelled) {
        setSpendingLimits(map);
        setLimitsLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [ownerAddresses]);

  function formatLimit(limit: bigint, symbol: string): { text: string; variant: "unrestricted" | "zero" | "configured" } {
    if (limit < 0n) return { text: "Unrestricted", variant: "unrestricted" };
    if (limit === 0n) return { text: `0 ${symbol}`, variant: "zero" };
    return { text: `${stroopsToDisplay(limit)} ${symbol}`, variant: "configured" };
  }

  async function handleCreateSpendingLimit() {
    if (!walletAddress) {
      setSlError("Connect your wallet first.");
      return;
    }
    if (!slOwner.trim() || !slAmount.trim() || !slDescription.trim()) {
      setSlError("Owner, amount, and description are required.");
      return;
    }
    if (!StrKey.isValidEd25519PublicKey(slOwner.trim())) {
      setSlError("Enter a valid Stellar address for the owner.");
      return;
    }
    const tokenAddr = TOKEN_ADDRESSES[slToken];
    if (!tokenAddr) {
      setSlError("Unknown token.");
      return;
    }
    const amountNum = parseFloat(slAmount);
    if (isNaN(amountNum) || amountNum < 0) {
      setSlError("Enter a valid amount (0 to block spending).");
      return;
    }
    const deadlineMs = new Date(slDeadline).getTime();
    const nowMs = Date.now();
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    if (deadlineMs <= todayMidnight.getTime()) {
      setSlError("Deadline must be in the future.");
      return;
    }
    const maxMs = nowMs + 90 * 24 * 3600 * 1000;
    if (deadlineMs > maxMs) {
      setSlError("Deadline cannot be more than 90 days away.");
      return;
    }

    setSlSubmitting(true);
    setSlError(null);
    try {
      await createSpendingLimitProposal(
        walletAddress,
        slOwner.trim(),
        tokenAddr,
        displayToStroops(amountNum),
        slDescription.trim(),
        BigInt(Math.floor(deadlineMs / 1000))
      );
      onProposalSubmitted();
      setShowForm(false);
      setSlAmount("");
      setSlDescription("");
    } catch (e) {
      setSlError(e instanceof Error ? e.message : "Transaction failed");
    } finally {
      setSlSubmitting(false);
    }
  }

  return (
    <>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold mb-2">Multisig Owners</h1>
        <p className="text-zinc-400 text-sm">
          Requires {threshold} of {totalWeight} voting weight
        </p>
      </div>

      {/* Owners list with spending limits */}
      {owners.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-zinc-600 text-sm">No owners found.</p>
        </div>
      ) : (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl divide-y divide-zinc-800 mb-8">
          {owners.map((owner, index) => (
            <div key={owner.address}>
              <div className="flex items-center gap-3 px-4 py-4">
                <div className="w-7 h-7 rounded-full bg-zinc-700 flex items-center justify-center text-xs text-zinc-400">
                  {owner.label[0]}
                </div>
                <div className="flex-1">
                  <p className="text-sm text-zinc-300">{owner.label}</p>
                  <p className="font-mono text-xs text-zinc-500">{owner.address}</p>
                  <p className="mt-1 font-mono text-xs text-emerald-400">
                    Weight {owner.weight}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const fullAddress = ownerAddresses[index] ?? "";
                    setWeightTargetOwner(fullAddress);
                    setShowWeightForm(true);
                  }}
                  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-zinc-400"
                >
                  Change Weight
                </button>
              </div>

              {/* Spending limits per token */}
              {limitsLoading ? (
                <div className="px-4 pb-4">
                  <div className="h-4 w-32 bg-zinc-800 animate-pulse rounded" />
                </div>
              ) : (
                <div className="px-4 pb-4 pl-14 grid grid-cols-3 gap-2">
                  {TOKEN_SYMBOLS.map((symbol) => {
                    const rawAddr = ownerAddresses[index];
                    const limit = rawAddr ? spendingLimits[rawAddr]?.[symbol] : undefined;
                    const info = limit !== undefined
                      ? formatLimit(limit, symbol)
                      : { text: "—", variant: "unrestricted" as const };

                    const variantStyles = {
                      unrestricted: "text-zinc-500",
                      zero: "text-red-400",
                      configured: "text-emerald-400",
                    };

                    return (
                      <div key={symbol} className="text-xs">
                        <span className="text-zinc-600">{symbol}: </span>
                        <span className={`font-mono ${variantStyles[info.variant]}`}>
                          {info.text}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Spending limit proposal form */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Spending Limits</h2>
          <button
            type="button"
            onClick={() => setShowForm(!showForm)}
            className="text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-3 py-1.5 rounded-lg transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none"
          >
            {showForm ? "Cancel" : "Set Spending Limit"}
          </button>
        </div>

        {showForm && (
          <div className="space-y-4 border-t border-zinc-800 pt-4">
            <p className="text-xs text-zinc-400">
              Propose a per-owner, per-token spending limit. Set to 0 to block spending for that token.
            </p>

            <div>
              <label className="text-xs text-zinc-400 block mb-1.5">Owner Address</label>
              <input
                value={slOwner}
                onChange={(e) => setSlOwner(e.target.value)}
                placeholder="G..."
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm font-mono placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
              />
            </div>

            <div className="flex gap-3">
              <div className="flex-1">
                <label className="text-xs text-zinc-400 block mb-1.5">
                  Limit Amount
                </label>
                <input
                  value={slAmount}
                  onChange={(e) => setSlAmount(e.target.value)}
                  placeholder="0.00"
                  type="number"
                  min="0"
                  step="any"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
                />
              </div>
              <div className="w-28">
                <label className="text-xs text-zinc-400 block mb-1.5">Token</label>
                <div className="grid grid-cols-3 gap-1">
                  {TOKEN_SYMBOLS.map((symbol) => {
                    const active = slToken === symbol;
                    return (
                      <button
                        key={symbol}
                        type="button"
                        onClick={() => setSlToken(symbol)}
                        aria-pressed={active}
                        className={`rounded-lg border px-1.5 py-2 text-xs font-medium transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none ${
                          active
                            ? "border-emerald-500 bg-emerald-500/20 text-emerald-300"
                            : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                        }`}
                      >
                        {symbol}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div>
              <label className="text-xs text-zinc-400 block mb-1.5">Description</label>
              <input
                value={slDescription}
                onChange={(e) => setSlDescription(e.target.value)}
                placeholder="Reason for spending limit"
                maxLength={300}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
              />
            </div>

            <div>
              <label className="text-xs text-zinc-400 block mb-1.5">Deadline</label>
              <input
                type="date"
                value={slDeadline}
                onChange={(e) => setSlDeadline(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
              />
            </div>

            {slError && (
              <p className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
                {slError}
              </p>
            )}

            <button
              type="button"
              onClick={handleCreateSpendingLimit}
              disabled={slSubmitting || !walletAddress}
              className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white py-2.5 rounded-lg font-medium transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none"
            >
              {slSubmitting ? "Submitting…" : "Create Spending Limit Proposal"}
            </button>
          </div>
        )}

        {!showForm && (
          <p className="text-xs text-zinc-500">
            Configure per-owner spending limits for specific tokens. All changes require multisig approval.
          </p>
        )}
      </div>

      {showWeightForm && (
        <CreateWeightChangeProposalModal
          walletAddress={walletAddress}
          onClose={() => setShowWeightForm(false)}
          onSubmitted={onProposalSubmitted}
          initialOwnerAddress={weightTargetOwner}
        />
      )}
    </>
  );
}
