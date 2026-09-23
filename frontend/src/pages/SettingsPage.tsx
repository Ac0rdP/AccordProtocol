import { useEffect, useState } from "react";
import {
  getContractXlmBalance,
  getContractUsdcBalance,
  getGuardian,
  isFrozen,
  getRoleVersion,
  getRoles,
} from "../lib/contract";
import {
  freeze,
  createSetGuardianProposal,
  createUnfreezeProposal,
} from "../lib/submit";
import { StrKey } from "@stellar/stellar-sdk";
import type { DashboardStat } from "../types/accord";

const MAX_DESCRIPTION_LEN = 300;

type SettingsPageProps = {
  stats: DashboardStat[];
  walletAddress: string | null;
  ownerAddresses: string[];
  onProposalSubmitted: () => void;
};

export function SettingsPage({ stats, walletAddress, ownerAddresses, onProposalSubmitted }: SettingsPageProps) {
  const contractId = import.meta.env.VITE_CONTRACT_ADDRESS ?? "Unknown";
  const network = import.meta.env.VITE_NETWORK_PASSPHRASE ?? "Unknown";
  const threshold = stats.find((stat) => stat.label === "Threshold")?.value ?? "Unknown";

  const [xlmBalance, setXlmBalance] = useState<string>("—");
  const [usdcBalance, setUsdcBalance] = useState<string>("—");
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  // Guardian / Freeze state
  const [guardian, setGuardian] = useState<string>("—");
  const [frozen, setFrozen] = useState(false);
  const [guardianLoading, setGuardianLoading] = useState(true);

  // RBAC state
  const [roleVersion, setRoleVersion] = useState<string>("v1");
  const [userRoles, setUserRoles] = useState<string[]>([]);
  const [rolesLoading, setRolesLoading] = useState(true);

  // Freeze control
  const [showFreezeConfirm, setShowFreezeConfirm] = useState(false);
  const [freezing, setFreezing] = useState(false);
  const [freezeError, setFreezeError] = useState<string | null>(null);

  // Set Guardian proposal form
  const [showSetGuardian, setShowSetGuardian] = useState(false);
  const [sgNewGuardian, setSgNewGuardian] = useState("");
  const [sgDescription, setSgDescription] = useState("");
  const [sgDeadline, setSgDeadline] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  });
  const [sgSubmitting, setSgSubmitting] = useState(false);
  const [sgError, setSgError] = useState<string | null>(null);

  // Unfreeze proposal form
  const [showUnfreeze, setShowUnfreeze] = useState(false);
  const [ufDescription, setUfDescription] = useState("");
  const [ufDeadline, setUfDeadline] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  });
  const [ufSubmitting, setUfSubmitting] = useState(false);
  const [ufError, setUfError] = useState<string | null>(null);

  const isOwner = walletAddress && ownerAddresses.includes(walletAddress);
  const isGuardian = walletAddress && guardian === walletAddress;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setBalanceLoading(true);
      setRolesLoading(true);
      const [xlm, usdc, g, f, rv, roles] = await Promise.all([
        getContractXlmBalance().catch(() => "—"),
        getContractUsdcBalance().catch(() => "—"),
        getGuardian().catch(() => "—"),
        isFrozen().catch(() => false),
        getRoleVersion().catch(() => "v1"),
        getRoles(walletAddress).catch(() => []),
      ]);
      if (!cancelled) {
        setXlmBalance(xlm);
        setUsdcBalance(usdc);
        setGuardian(g);
        setFrozen(f);
        setRoleVersion(rv);
        setUserRoles(roles);
        setBalanceLoading(false);
        setGuardianLoading(false);
        setRolesLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [walletAddress]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(contractId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API not available
    }
  }

  // ─── Freeze (single-sig, guardian only) ──────────────────────────────────

  async function handleFreeze() {
    if (!walletAddress || !isGuardian) return;
    setFreezing(true);
    setFreezeError(null);
    try {
      await freeze(walletAddress);
      setFrozen(true);
      setShowFreezeConfirm(false);
      onProposalSubmitted();
    } catch (e) {
      setFreezeError(e instanceof Error ? e.message : "Freeze failed");
    } finally {
      setFreezing(false);
    }
  }

  // ─── Set Guardian proposal ───────────────────────────────────────────────

  async function handleSetGuardian() {
    if (!walletAddress || !isOwner) {
      setSgError("Only owners can submit this proposal.");
      return;
    }
    if (!sgNewGuardian.trim() || !sgDescription.trim()) {
      setSgError("Guardian address and description are required.");
      return;
    }
    if (!StrKey.isValidEd25519PublicKey(sgNewGuardian.trim())) {
      setSgError("Enter a valid Stellar address.");
      return;
    }
    const deadlineMs = new Date(sgDeadline).getTime();
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    if (deadlineMs <= todayMidnight.getTime()) {
      setSgError("Deadline must be in the future.");
      return;
    }

    setSgSubmitting(true);
    setSgError(null);
    try {
      await createSetGuardianProposal(
        walletAddress,
        sgNewGuardian.trim(),
        sgDescription.trim(),
        BigInt(Math.floor(deadlineMs / 1000))
      );
      onProposalSubmitted();
      setShowSetGuardian(false);
      setSgNewGuardian("");
      setSgDescription("");
    } catch (e) {
      setSgError(e instanceof Error ? e.message : "Transaction failed");
    } finally {
      setSgSubmitting(false);
    }
  }

  // ─── Unfreeze proposal ───────────────────────────────────────────────────

  async function handleUnfreeze() {
    if (!walletAddress || !isOwner) {
      setUfError("Only owners can submit this proposal.");
      return;
    }
    if (!ufDescription.trim()) {
      setUfError("Description is required.");
      return;
    }
    const deadlineMs = new Date(ufDeadline).getTime();
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    if (deadlineMs <= todayMidnight.getTime()) {
      setUfError("Deadline must be in the future.");
      return;
    }

    setUfSubmitting(true);
    setUfError(null);
    try {
      await createUnfreezeProposal(
        walletAddress,
        ufDescription.trim(),
        BigInt(Math.floor(deadlineMs / 1000))
      );
      onProposalSubmitted();
      setShowUnfreeze(false);
      setUfDescription("");
    } catch (e) {
      setUfError(e instanceof Error ? e.message : "Transaction failed");
    } finally {
      setUfSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-2 text-sm text-zinc-400">
          Reference information for your deployed contract and connected network.
        </p>
      </div>

      <div className="space-y-4">
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
          <div className="text-sm text-zinc-500 mb-2">Contract ID</div>
          <div className="flex items-center gap-2">
            <div className="font-mono text-sm text-zinc-100 break-all flex-1">{contractId}</div>
            <button
              type="button"
              onClick={handleCopy}
              className="shrink-0 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
          <div className="text-sm text-zinc-500 mb-2">Network</div>
          <div className="text-sm text-zinc-100">{network}</div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
          <div className="text-sm text-zinc-500 mb-2">Threshold</div>
          <div className="text-sm text-zinc-100">{threshold}</div>
        </div>
      </div>

      {/* Role & RBAC Summary */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
        <h2 className="text-lg font-semibold mb-4">Role & RBAC Summary</h2>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-zinc-500 mb-1">Contract Role Version</p>
              <p className="font-mono text-sm text-zinc-100">{roleVersion}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-zinc-500 mb-1">Connected Wallet Roles</p>
              {rolesLoading ? (
                <div className="h-5 w-24 bg-zinc-800 animate-pulse rounded" />
              ) : !walletAddress ? (
                <p className="text-xs text-zinc-400 italic">Disconnected — connect wallet to view permissions</p>
              ) : userRoles.length === 0 ? (
                <p className="text-xs text-zinc-400">No active roles</p>
              ) : (
                <div className="flex items-center gap-1.5 justify-end">
                  {userRoles.map((role) => (
                    <span
                      key={role}
                      className="text-xs px-2.5 py-0.5 rounded-full font-medium bg-emerald-500/10 text-emerald-300 border border-emerald-500/20"
                    >
                      {role}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Guardian & Freeze Status */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
        <h2 className="text-lg font-semibold mb-4">Guardian & Emergency Controls</h2>

        {guardianLoading ? (
          <div className="space-y-3">
            <div className="h-5 w-48 bg-zinc-800 animate-pulse rounded" />
            <div className="h-5 w-32 bg-zinc-800 animate-pulse rounded" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-zinc-500 mb-1">Current Guardian</p>
                <p className="font-mono text-sm text-zinc-200">
                  {guardian === "—" ? "—" : `${guardian.slice(0, 6)}...${guardian.slice(-4)}`}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-zinc-500 mb-1">Contract Status</p>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full font-mono ${
                    frozen
                      ? "bg-red-500/10 text-red-400 border border-red-500/20"
                      : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                  }`}
                >
                  {frozen ? "Frozen" : "Active"}
                </span>
              </div>
            </div>

            {/* Freeze button — guardian only */}
            {!frozen && isGuardian && (
              <div className="pt-2">
                {!showFreezeConfirm ? (
                  <button
                    type="button"
                    onClick={() => setShowFreezeConfirm(true)}
                    className="bg-red-600 hover:bg-red-500 text-white text-sm px-4 py-2 rounded-lg font-medium transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none"
                  >
                    Freeze Contract
                  </button>
                ) : (
                  <div className="space-y-3 rounded-xl border border-red-500/20 bg-red-500/10 p-4">
                    <p className="text-sm text-red-300 font-medium">
                      Warning: Freezing will halt all proposal creation and execution until unfrozen.
                    </p>
                    <div className="flex gap-3">
                      <button
                        type="button"
                        onClick={handleFreeze}
                        disabled={freezing}
                        className="bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg font-medium transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none"
                      >
                        {freezing ? "Freezing…" : "Confirm Freeze"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowFreezeConfirm(false)}
                        disabled={freezing}
                        className="bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg font-medium transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none"
                      >
                        Cancel
                      </button>
                    </div>
                    {freezeError && (
                      <p className="text-xs text-red-400">{freezeError}</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Set Guardian — proposal flow */}
      {isOwner && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Set Guardian</h2>
            <button
              type="button"
              onClick={() => setShowSetGuardian(!showSetGuardian)}
              className="text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-3 py-1.5 rounded-lg transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none"
            >
              {showSetGuardian ? "Cancel" : "Propose Change"}
            </button>
          </div>

          {showSetGuardian && (
            <div className="space-y-4 border-t border-zinc-800 pt-4">
              <p className="text-xs text-zinc-400">
                Propose a new guardian address. This requires multisig approval.
              </p>

              <div>
                <label className="text-xs text-zinc-400 block mb-1.5">New Guardian Address</label>
                <input
                  value={sgNewGuardian}
                  onChange={(e) => setSgNewGuardian(e.target.value)}
                  placeholder="G..."
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm font-mono placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
                />
              </div>

              <div>
                <label className="text-xs text-zinc-400 block mb-1.5">Description</label>
                <input
                  value={sgDescription}
                  onChange={(e) => setSgDescription(e.target.value)}
                  placeholder="Reason for guardian change"
                  maxLength={MAX_DESCRIPTION_LEN}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
                />
              </div>

              <div>
                <label className="text-xs text-zinc-400 block mb-1.5">Deadline</label>
                <input
                  type="date"
                  value={sgDeadline}
                  onChange={(e) => setSgDeadline(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
                />
              </div>

              {sgError && (
                <p className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{sgError}</p>
              )}

              <button
                type="button"
                onClick={handleSetGuardian}
                disabled={sgSubmitting}
                className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white py-2.5 rounded-lg font-medium transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none"
              >
                {sgSubmitting ? "Submitting…" : "Create Set Guardian Proposal"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Unfreeze — proposal flow */}
      {frozen && isOwner && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Unfreeze Contract</h2>
            <button
              type="button"
              onClick={() => setShowUnfreeze(!showUnfreeze)}
              className="text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-3 py-1.5 rounded-lg transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none"
            >
              {showUnfreeze ? "Cancel" : "Propose Unfreeze"}
            </button>
          </div>

          {showUnfreeze && (
            <div className="space-y-4 border-t border-zinc-800 pt-4">
              <p className="text-xs text-zinc-400">
                Propose to unfreeze the contract. This requires multisig approval.
              </p>

              <div>
                <label className="text-xs text-zinc-400 block mb-1.5">Description</label>
                <input
                  value={ufDescription}
                  onChange={(e) => setUfDescription(e.target.value)}
                  placeholder="Reason for unfreezing"
                  maxLength={MAX_DESCRIPTION_LEN}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
                />
              </div>

              <div>
                <label className="text-xs text-zinc-400 block mb-1.5">Deadline</label>
                <input
                  type="date"
                  value={ufDeadline}
                  onChange={(e) => setUfDeadline(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
                />
              </div>

              {ufError && (
                <p className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{ufError}</p>
              )}

              <button
                type="button"
                onClick={handleUnfreeze}
                disabled={ufSubmitting}
                className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white py-2.5 rounded-lg font-medium transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none"
              >
                {ufSubmitting ? "Submitting…" : "Create Unfreeze Proposal"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Fund Contract */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
        <h2 className="text-lg font-semibold mb-4">Fund Contract</h2>
        <p className="text-sm text-zinc-400 mb-4">
          Deposit tokens to this contract address to enable proposal payouts.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="text-xs text-zinc-500 mb-1">XLM Balance</div>
            <div className="text-xl font-mono font-semibold text-zinc-100">
              {balanceLoading ? (
                <span className="inline-block h-5 w-16 animate-pulse rounded bg-zinc-800" />
              ) : xlmBalance === "—" ? (
                <span className="text-zinc-500">—</span>
              ) : (
                <>{xlmBalance} XLM</>
              )}
            </div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="text-xs text-zinc-500 mb-1">USDC Balance</div>
            <div className="text-xl font-mono font-semibold text-zinc-100">
              {balanceLoading ? (
                <span className="inline-block h-5 w-16 animate-pulse rounded bg-zinc-800" />
              ) : usdcBalance === "—" || usdcBalance === "N/A" ? (
                <span className="text-zinc-500">{usdcBalance}</span>
              ) : (
                <>{usdcBalance} USDC</>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
