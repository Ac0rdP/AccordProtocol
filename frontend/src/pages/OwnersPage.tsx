import { useEffect, useState } from "react";
import { UserCog } from "lucide-react";
import { Link, useInRouterContext } from "react-router-dom";
import { StrKey } from "@stellar/stellar-sdk";
import { getSpendingLimit } from "../lib/contract";
import { createSpendingLimitProposal } from "../lib/submit";
import { displayToStroops } from "../lib/soroban";
import { useOwnerWeights } from "../hooks/useOwnerWeights";
import { useDelegations } from "../hooks/useDelegations";
import { DelegateModal } from "../components/DelegateModal";
import { CreateWeightChangeProposalModal } from "../components/CreateWeightChangeProposalModal";
import { PageState } from "../components/PageState";
import { EmptyState } from "../components/EmptyState";
import { GovernanceHealthWidget } from "../components/GovernanceHealthWidget";
import { EditableOwnerLabel } from "../components/EditableOwnerLabel";
import type { Owner, Role } from "../types/accord";

function OwnerLink({
  to,
  className,
  children,
}: {
  to: string;
  className?: string;
  children: React.ReactNode;
}) {
  const inRouter = useInRouterContext();
  if (inRouter) {
    return <Link to={to} className={className}>{children}</Link>;
  }
  return <a href={to} className={className}>{children}</a>;
}

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
  /** Defaults to each owner's full on-chain address. */
  ownerAddresses?: string[];
  threshold: number;
  totalOwners: number;
  onManageRoles: (ownerAddress: string) => void;
  walletAddress?: string | null;
  onProposalSubmitted?: () => void;
  /** Optional overrides so the page-state matrix can force loading/error. */
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
};

const ROLE_STYLES: Record<Role, string> = {
  Owner: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
  Viewer: "border-sky-500/20 bg-sky-500/10 text-sky-300",
  Guardian: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  SpendingLimit: "border-violet-500/20 bg-violet-500/10 text-violet-300",
  Proposer: "border-cyan-500/20 bg-cyan-500/10 text-cyan-300",
  Approver: "border-rose-500/20 bg-rose-500/10 text-rose-300",
  Executor: "border-orange-500/20 bg-orange-500/10 text-orange-300",
};

const ROLE_LABELS: Record<Role, string> = {
  Owner: "Owner",
  Viewer: "Viewer",
  Guardian: "Guardian",
  SpendingLimit: "Spending Limit",
  Proposer: "Proposer",
  Approver: "Approver",
  Executor: "Executor",
};

function RoleBadge({ role }: { role: Role }) {
  return (
    <span
      className={`rounded-md border px-2 py-0.5 text-xs font-medium ${ROLE_STYLES[role]}`}
    >
      {ROLE_LABELS[role]}
    </span>
  );
}

export function OwnersPage({
  owners,
  ownerAddresses = owners.map((owner) => owner.fullAddress || owner.address),
  threshold,
  totalOwners,
  onManageRoles,
  walletAddress = null,
  onProposalSubmitted = () => {},
  loading = false,
  error = null,
  onRetry,
}: OwnersPageProps) {
  const {
    weights: liveWeights,
    totalWeight: liveTotal,
    loading: weightsLoading,
  } = useOwnerWeights(ownerAddresses);
  const { refetch: refetchDelegations } = useDelegations(ownerAddresses);
  const [delegateModalOpen, setDelegateModalOpen] = useState(false);
  const [weightModalOwner, setWeightModalOwner] = useState<string | null>(null);
  const [, setSpendingLimits] = useState<SpendingLimitMap>({});
  const [, setLimitsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

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
    return () => {
      cancelled = true;
    };
  }, [ownerAddresses]);

  // Fall back to each owner's own `weight` field when the live contract
  // query has nothing yet (e.g. not mocked in tests, or still loading).
  const fallbackWeights: Record<string, number> = {};
  let fallbackTotal = 0;
  for (const o of owners) {
    const w = typeof o.weight === "number" ? o.weight : 1;
    fallbackWeights[o.fullAddress] = w;
    fallbackTotal += w;
  }

  const weights =
    Object.keys(liveWeights).length > 0 ? liveWeights : fallbackWeights;
  const totalWeight = liveTotal > 0 ? liveTotal : fallbackTotal;

  if (loading) {
    return <PageState status="loading" title="Loading owners…" />;
  }

  if (error) {
    return (
      <PageState
        status="error"
        title="Could not load owners"
        description={error}
        onRetry={onRetry}
      />
    );
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
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    if (deadlineMs <= todayMidnight.getTime()) {
      setSlError("Deadline must be in the future.");
      return;
    }
    const maxMs = Date.now() + 90 * 24 * 3600 * 1000;
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

  return (
    <>
      <div className="mb-8">
        <h1 className="mb-2 text-2xl font-semibold">Multisig Owners</h1>
        <p className="text-sm text-zinc-400">
          Requires {threshold} of {totalWeight} voting weight
        </p>
      </div>

      {owners.length > 0 && (
        <GovernanceHealthWidget
          weights={weights}
          totalWeight={totalWeight}
          threshold={threshold}
          totalOwners={totalOwners}
          loading={weightsLoading && Object.keys(weights).length === 0}
        />
      )}

      {owners.length > 0 && (
        <div
          data-testid="weight-distribution-chart"
          className="mb-8 bg-zinc-900 border border-zinc-800 rounded-xl p-5"
        >
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
                  const ownerInfo = owners.find((o) => o.fullAddress === addr) || {
                    label: `Signer ${idx + 1}`,
                    address: addr,
                    fullAddress: addr,
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
              <div className="flex flex-wrap gap-x-4 gap-y-2 mt-2">
                {ownerAddresses.map((addr, idx) => {
                  const weight = weights[addr] ?? 1;
                  const pct = totalWeight > 0 ? (weight / totalWeight) * 100 : 0;
                  const ownerInfo = owners.find((o) => o.fullAddress === addr) || {
                    label: `Signer ${idx + 1}`,
                    address: addr,
                    fullAddress: addr,
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
      )}

      {owners.length === 0 ? (
        <EmptyState
          title="No owners found"
          description="Owners will appear here once the multisig is initialized."
        />
      ) : (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl divide-y divide-zinc-800">
          {owners.map((owner) => (
            <div
              key={owner.fullAddress}
              className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex items-start gap-3">
                <div className="w-7 h-7 shrink-0 rounded-full bg-zinc-700 flex items-center justify-center text-xs text-zinc-400">
                  {owner.label[0]}
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <EditableOwnerLabel
                      address={owner.fullAddress}
                      label={owner.label}
                      onSaved={onProposalSubmitted}
                      className="text-sm text-zinc-300 font-medium"
                    />
                    {typeof owner.weight === "number" && (
                      <span className="rounded-md border border-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                        Weight {owner.weight}
                      </span>
                    )}
                  </div>
                  <OwnerLink
                    to={`/app/owners/${encodeURIComponent(owner.fullAddress)}`}
                    className="font-mono text-xs text-zinc-400 hover:text-zinc-300 transition-colors block"
                  >
                    {owner.address}
                  </OwnerLink>
                  <div
                    className="mt-2 flex flex-wrap gap-1.5"
                    aria-label={`${owner.label} roles`}
                  >
                    {owner.roles.length > 0 ? (
                      owner.roles.map((role) => (
                        <RoleBadge key={role} role={role} />
                      ))
                    ) : (
                      <span className="rounded-md border border-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                        No roles
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 sm:self-center">
                <button
                  type="button"
                  onClick={() => setWeightModalOwner(owner.fullAddress)}
                  className="inline-flex items-center justify-center rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-400"
                >
                  Change Weight
                </button>
                {walletAddress === owner.fullAddress && (
                  <button
                    type="button"
                    onClick={() => setDelegateModalOpen(true)}
                    aria-label={`Delegate ${owner.label} voting weight`}
                    className="inline-flex items-center justify-center rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-400"
                  >
                    Delegate
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onManageRoles(owner.fullAddress)}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-400"
                >
                  <UserCog size={14} />
                  Manage Roles
                </button>
              </div>
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
            aria-expanded={showForm}
            aria-controls="spending-limit-form"
            aria-label={
              showForm ? "Cancel spending limit form" : "Set Spending Limit"
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
              className="w-full bg-emerald-700 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white py-2.5 rounded-lg font-medium transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none"
            >
              {slSubmitting ? "Submitting…" : "Create Spending Limit Proposal"}
            </button>
          </div>
        )}

        {!showForm && (
          <p className="text-xs text-zinc-400">
            Configure per-owner spending limits for specific tokens. All changes
            require multisig approval.
          </p>
        )}
      </div>

      {weightModalOwner && (
        <CreateWeightChangeProposalModal
          walletAddress={walletAddress}
          initialOwnerAddress={weightModalOwner}
          onClose={() => setWeightModalOwner(null)}
          onSubmitted={() => {
            setWeightModalOwner(null);
            onProposalSubmitted();
          }}
        />
      )}

      {delegateModalOpen && walletAddress && (
        <DelegateModal
          walletAddress={walletAddress}
          ownerWeight={weights[walletAddress] ?? 1}
          candidates={owners
            .map((o, idx) => ({
              address: ownerAddresses[idx] ?? o.address,
              label: o.label,
            }))
            .filter((o) => o.address !== walletAddress)}
          onClose={() => setDelegateModalOpen(false)}
          onSubmitted={() => {
            refetchDelegations();
            onProposalSubmitted();
          }}
        />
      )}
    </>
  );
}
