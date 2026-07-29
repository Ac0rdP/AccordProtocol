import { useEffect, useMemo, useState } from "react";
import { getRequiredQuorumWeight, getSpendingLimit } from "../lib/contract";
import { createSpendingLimitProposal } from "../lib/submit";
import {
  displayToStroops,
  shortenAddr,
} from "../lib/soroban";
import { StrKey } from "@stellar/stellar-sdk";
import type { Owner } from "../types/accord";
import { useOwnerWeights } from "../hooks/useOwnerWeights";

const CHART_COLORS = [
  "bg-emerald-500",
  "bg-blue-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-indigo-500",
  "bg-violet-500",
  "bg-orange-500",
  "bg-cyan-500",
  "bg-fuchsia-500",
  "bg-teal-500",
  "bg-purple-500",
  "bg-pink-500",
  "bg-lime-500",
  "bg-red-400",
  "bg-purple-400",
  "bg-sky-500",
  "bg-emerald-400",
  "bg-amber-400",
  "bg-rose-400",
  "bg-indigo-400",
];

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
  totalOwners: number;
  walletAddress: string | null;
  onProposalSubmitted: () => void;
};

export function OwnersPage({
  owners,
  ownerAddresses,
  threshold,
  totalOwners: _totalOwners,
  walletAddress,
  onProposalSubmitted,
}: OwnersPageProps) {
  const {
    weights,
    totalWeight,
    loading: weightsLoading,
    error: weightsError,
  } = useOwnerWeights(ownerAddresses);
  const [_spendingLimits, setSpendingLimits] = useState<SpendingLimitMap>({});
  const [_limitsLoading, setLimitsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [sortByWeightDesc, setSortByWeightDesc] = useState(false);
  const [filterMode, setFilterMode] = useState<"all" | "above" | "below">(
    "all",
  );
  const [shareThreshold, setShareThreshold] = useState("0");

  // Quorum simulator state
  const [selectedAddresses, setSelectedAddresses] = useState<Set<string>>(
    new Set(),
  );
  const [requiredQuorumWeight, setRequiredQuorumWeight] = useState(0);
  const [quorumLoading, setQuorumLoading] = useState(true);

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

  // Derived state for weight display
  const hasOwnerWeights =
    !weightsLoading && Object.keys(weights).length > 0 && !weightsError;
  const ownerWeightsLoading = weightsLoading;
  const weightsUnavailable = !weightsLoading && !!weightsError;
  const ownerCountLabel = `${ownerAddresses.length} ${ownerAddresses.length === 1 ? "owner" : "owners"}`;
  const quorumPercent =
    totalWeight > 0
      ? ((threshold / totalWeight) * 100).toFixed(1)
      : "0";
  const weightsStale = false;

  // Load required quorum weight for the simulator
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setQuorumLoading(true);
      try {
        const weight = await getRequiredQuorumWeight();
        if (!cancelled) {
          setRequiredQuorumWeight(weight);
          setQuorumLoading(false);
        }
      } catch {
        if (!cancelled) {
          setRequiredQuorumWeight(0);
          setQuorumLoading(false);
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Quorum simulator computed values
  const selectedWeight = useMemo(() => {
    let sum = 0;
    for (const addr of selectedAddresses) {
      sum += weights[addr] ?? 0;
    }
    return sum;
  }, [selectedAddresses, weights]);

  const quorumMet =
    requiredQuorumWeight > 0 && selectedWeight >= requiredQuorumWeight;

  function toggleSelection(address: string) {
    setSelectedAddresses((prev) => {
      const next = new Set(prev);
      if (next.has(address)) {
        next.delete(address);
      } else {
        next.add(address);
      }
      return next;
    });
  }

  function resetSelection() {
    setSelectedAddresses(new Set());
  }

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
    return () => {
      cancelled = true;
    };
  }, [ownerAddresses]);

  const visibleOwners = owners
    .map((owner, idx) => {
      const fullAddress = ownerAddresses[idx] ?? owner.address;
      const weight = weights[fullAddress] ?? (weightsLoading ? null : 1);
      const percentage = totalWeight > 0 && weight !== null
        ? (weight / totalWeight) * 100
        : 0;
      return { ...owner, fullAddress, weight, percentage };
    })
    .sort((left, right) => {
      if (!sortByWeightDesc) return 0;
      return (right.weight ?? 0) - (left.weight ?? 0);
    })
    .filter((owner) => {
      if (filterMode === "all") return true;

      const thresholdVal = Number(shareThreshold);
      if (!Number.isFinite(thresholdVal)) return true;

      if (filterMode === "above") return owner.percentage > thresholdVal;
      return owner.percentage < thresholdVal;
    });



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
        BigInt(Math.floor(deadlineMs / 1000)),
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

  const selectedCount = selectedAddresses.size;

  return (
    <>
      <div className="mb-8">
        <h1 className="mb-2 text-2xl font-semibold">Multisig Owners</h1>
        <div className="space-y-1 text-sm text-zinc-400">
          <p>
            {hasOwnerWeights
              ? `Requires ${threshold} of ${totalWeight} voting weight`
              : `Requires ${threshold} voting weight`}
          </p>
          <p>
            {ownerWeightsLoading
              ? `Loading voting power across ${ownerCountLabel}...`
              : weightsUnavailable
                ? "Voting power unavailable; owners remain visible."
                : `${quorumPercent}% of voting power must approve.`}
          </p>
          {weightsStale && (
            <p className="text-amber-400">Voting weights may be stale.</p>
          )}
          {weightsUnavailable && (
            <p className="text-amber-400">Voting weights unavailable.</p>
          )}
        </div>
      </div>

      {/* Quorum Simulator */}
      <div className="mb-8 bg-zinc-900 border border-zinc-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-zinc-400">
            Quorum Simulator
          </h2>
          {selectedCount > 0 && (
            <button
              type="button"
              onClick={resetSelection}
              className="text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 px-2.5 py-1 rounded-lg transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none"
            >
              Reset selection
            </button>
          )}
        </div>

        {quorumLoading ? (
          <div className="h-5 bg-zinc-800 animate-pulse rounded-lg w-full" />
        ) : selectedCount === 0 ? (
          <p className="text-xs text-zinc-500">
            Select owners below to check if their combined weight meets the
            quorum requirement.
          </p>
        ) : (
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <p className="text-sm text-zinc-300">
                <span className="font-medium text-zinc-100">
                  {selectedCount}
                </span>{" "}
                owner{selectedCount !== 1 ? "s" : ""} selected &mdash; combined
                weight{" "}
                <span className="font-mono font-medium text-zinc-100">
                  {selectedWeight}
                </span>{" "}
                of{" "}
                <span className="font-mono font-medium text-zinc-100">
                  {requiredQuorumWeight}
                </span>{" "}
                required
              </p>
            </div>
            <div
              className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium ${
                quorumMet
                  ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                  : "bg-amber-500/20 text-amber-400 border border-amber-500/30"
              }`}
            >
              {quorumMet ? "Quorum met" : "Quorum not met"}
            </div>
          </div>
        )}
      </div>

      {/* Weight Distribution Chart */}
      <div className="mb-8 bg-zinc-900 border border-zinc-800 rounded-xl p-5">
        <h2 className="text-sm font-medium text-zinc-400 mb-3">
          Voting Weight Distribution
        </h2>
        {weightsLoading ? (
          <div className="h-6 bg-zinc-800 animate-pulse rounded-lg w-full" />
        ) : ownerAddresses.length === 0 ? (
          <div className="h-6 bg-zinc-850 rounded-lg flex items-center justify-center text-xs text-zinc-500">
            No voting power registered.
          </div>
        ) : (
          <div>
            <div
              role="region"
              aria-label={`Voting weight distribution across ${ownerAddresses.length} owners, total weight ${totalWeight}`}
              className="flex h-6 rounded-lg overflow-hidden border border-zinc-800 bg-zinc-950 w-full mb-3"
            >
              {ownerAddresses.map((addr, idx) => {
                const weight = weights[addr] ?? 1;
                const pct = totalWeight > 0 ? (weight / totalWeight) * 100 : 0;
                const ownerInfo = owners.find((o) => o.address === addr) || {
                  label: `Signer ${idx + 1}`,
                  address: addr,
                };
                const labelText = `${ownerInfo.label} (${addr.slice(0, 6)}...${addr.slice(-4)})`;
                const titleStr = `${labelText}: weight ${weight} (${pct.toFixed(1)}%)`;

                if (pct <= 0) return null;

                return (
                  <div
                    key={addr}
                    title={titleStr}
                    style={{ width: `${pct}%` }}
                    className={`${CHART_COLORS[idx % CHART_COLORS.length]} h-full transition-all duration-300 relative group cursor-pointer hover:brightness-110`}
                    tabIndex={0}
                    role="img"
                    aria-label={titleStr}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                      }
                    }}
                  />
                );
              })}
            </div>
            {/* Legend */}
            <div className="flex flex-wrap gap-x-4 gap-y-2 mt-2">
              {ownerAddresses.map((addr, idx) => {
                const weight = weights[addr] ?? 1;
                const pct = totalWeight > 0 ? (weight / totalWeight) * 100 : 0;
                const ownerInfo = owners.find((o) => o.address === addr) || {
                  label: `Signer ${idx + 1}`,
                  address: addr,
                };
                const legendLabel = `${ownerInfo.label} ${addr.slice(0, 6)}…${addr.slice(-4)}: ${weight} weight (${pct.toFixed(0)}%)`;
                return (
                  <div
                    key={addr}
                    className="flex items-center gap-1.5 text-xs text-zinc-400"
                    aria-label={legendLabel}
                  >
                    <span
                      aria-hidden
                      className={`w-2.5 h-2.5 rounded-full ${CHART_COLORS[idx % CHART_COLORS.length]}`}
                    />
                    <span className="font-medium text-zinc-300">
                      {ownerInfo.label}
                    </span>
                    <span className="font-mono text-zinc-500">
                      ({addr.slice(0, 6)}…{addr.slice(-4)})
                    </span>
                    <span className="font-medium text-zinc-300">
                      ({weight} w, {pct.toFixed(0)}%)
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between mb-6">
        <label className="flex items-center gap-2 text-sm text-zinc-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={sortByWeightDesc}
            onChange={(e) => setSortByWeightDesc(e.target.checked)}
            className="accent-emerald-500"
          />
          Weight descending
        </label>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="text-sm text-zinc-400 flex flex-col gap-1.5">
            <span>Show owners</span>
            <select
              value={filterMode}
              onChange={(e) =>
                setFilterMode(e.target.value as "all" | "above" | "below")
              }
              aria-label="Show owners"
              className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:ring-2 focus:ring-zinc-400 focus:outline-none"
            >
              <option value="all">All</option>
              <option value="above">Above</option>
              <option value="below">Below</option>
            </select>
          </label>

          <label className="text-sm text-zinc-400 flex flex-col gap-1.5">
            <span>Share threshold (%)</span>
            <input
              id="share-threshold"
              type="number"
              min="0"
              max="100"
              step="1"
              value={shareThreshold}
              onChange={(e) => setShareThreshold(e.target.value)}
              aria-label="Share threshold"
              disabled={filterMode === "all"}
              className="w-28 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:ring-2 focus:ring-zinc-400 focus:outline-none disabled:opacity-60 disabled:cursor-not-allowed"
            />
          </label>
        </div>
      </div>

      {/* Owners list with checkboxes and spending limits */}
      {owners.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-sm text-zinc-600">No owners found.</p>
        </div>
      ) : visibleOwners.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-zinc-600 text-sm">
            No owners match the current filters.
          </p>
        </div>
      ) : (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl divide-y divide-zinc-800 mb-8">
          {visibleOwners.map((owner) => {
            const isSelected = selectedAddresses.has(owner.fullAddress);
            return (
              <div
                key={owner.fullAddress}
                className={`flex items-center gap-3 px-4 py-4 transition-colors ${
                  isSelected ? "bg-zinc-800/50" : ""
                }`}
              >
                <label className="flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelection(owner.fullAddress)}
                    className="accent-emerald-500 w-4 h-4"
                    aria-label={`Select ${owner.label} for quorum simulation`}
                  />
                </label>
                <div className="w-7 h-7 rounded-full bg-zinc-700 flex items-center justify-center text-xs text-zinc-400">
                  {owner.label[0]}
                </div>
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-zinc-300">{owner.label}</p>
                    {ownerWeightsLoading ? (
                      <span className="text-xs text-zinc-500">
                        Loading weight...
                      </span>
                    ) : weightsUnavailable ? (
                      <span className="text-xs text-red-400">
                        Weight unavailable
                      </span>
                    ) : (
                      <span className="text-xs text-zinc-400 bg-zinc-800 border border-zinc-700 px-2 py-0.5 rounded-full font-mono">
                        Weight {owner.weight}
                      </span>
                    )}
                  </div>
                  <p className="font-mono text-xs text-zinc-500">
                    {shortenAddr(owner.address)}
                    {!ownerWeightsLoading && !weightsUnavailable && (
                      <span className="text-xs text-zinc-400 ml-2">
                        &middot; {owner.percentage.toFixed(1)}% of voting power
                      </span>
                    )}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Spending limit proposal form */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Spending Limits</h2>
          <button
            type="button"
            onClick={() => setShowForm(!showForm)}
            aria-expanded={showForm}
            aria-controls="spending-limit-form"
            aria-label={
              showForm
                ? "Close spending limit form"
                : "Open spending limit form"
            }
            className="text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-3 py-1.5 rounded-lg transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none"
          >
            {showForm ? "Cancel" : "Set Spending Limit"}
          </button>
        </div>

        {showForm && (
          <div
            id="spending-limit-form"
            className="space-y-4 border-t border-zinc-800 pt-4"
          >
            <p className="text-xs text-zinc-400">
              Propose a per-owner, per-token spending limit. Set to 0 to block
              spending for that token.
            </p>

            <div>
              <label
                htmlFor="sl-owner"
                className="text-xs text-zinc-400 block mb-1.5"
              >
                Owner Address
              </label>
              <input
                id="sl-owner"
                value={slOwner}
                onChange={(e) => setSlOwner(e.target.value)}
                placeholder="G..."
                aria-label="Owner Stellar address"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm font-mono placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
              />
            </div>

            <div className="flex gap-3">
              <div className="flex-1">
                <label
                  htmlFor="sl-amount"
                  className="text-xs text-zinc-400 block mb-1.5"
                >
                  Limit Amount
                </label>
                <input
                  id="sl-amount"
                  value={slAmount}
                  onChange={(e) => setSlAmount(e.target.value)}
                  placeholder="0.00"
                  type="number"
                  min="0"
                  step="any"
                  aria-label="Spending limit amount"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
                />
              </div>
              <div className="w-28">
                <label className="text-xs text-zinc-400 block mb-1.5">
                  Token
                </label>
                <div
                  className="grid grid-cols-3 gap-1"
                  role="group"
                  aria-label="Token selector"
                >
                  {TOKEN_SYMBOLS.map((symbol) => {
                    const active = slToken === symbol;
                    return (
                      <button
                        key={symbol}
                        type="button"
                        onClick={() => setSlToken(symbol)}
                        aria-pressed={active}
                        aria-label={`Select token ${symbol}`}
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
              <label
                htmlFor="sl-description"
                className="text-xs text-zinc-400 block mb-1.5"
              >
                Description
              </label>
              <input
                id="sl-description"
                value={slDescription}
                onChange={(e) => setSlDescription(e.target.value)}
                placeholder="Reason for spending limit"
                maxLength={300}
                aria-label="Spending limit description"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
              />
            </div>

            <div>
              <label
                htmlFor="sl-deadline"
                className="text-xs text-zinc-400 block mb-1.5"
              >
                Deadline
              </label>
              <input
                id="sl-deadline"
                type="date"
                value={slDeadline}
                onChange={(e) => setSlDeadline(e.target.value)}
                aria-label="Spending limit deadline"
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
              aria-label="Create spending limit proposal"
              disabled={slSubmitting || !walletAddress}
              className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white py-2.5 rounded-lg font-medium transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none"
            >
              {slSubmitting ? "Submitting…" : "Create Spending Limit Proposal"}
            </button>
          </div>
        )}

        {!showForm && (
          <p className="text-xs text-zinc-500">
            Configure per-owner spending limits for specific tokens. All changes
            require multisig approval.
          </p>
        )}
      </div>
    </>
  );
}
