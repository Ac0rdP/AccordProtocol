import { useEffect, useRef, useState } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { ShieldMinus, ShieldPlus, X } from "lucide-react";
import {
  createGrantRoleProposal,
  createRevokeRoleProposal,
} from "../lib/submit";
import type { Role } from "../types/accord";

type RoleAction = "grant" | "revoke";

type Props = {
  walletAddress: string | null;
  ownerAddresses: string[];
  threshold: number;
  initialTargetAddress?: string;
  onClose: () => void;
  onSubmitted: () => void;
};

const ROLE_OPTIONS: Role[] = ["Owner"];
const MAX_OWNERS = 20;
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_PROPOSAL_DURATION_DAYS = 90;

function truncateAddress(address: string | null) {
  if (!address) return "Not connected";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function defaultDeadline() {
  const date = new Date();
  date.setDate(date.getDate() + 7);
  return date.toISOString().slice(0, 10);
}

function toUnixSeconds(dateValue: string): bigint | null {
  const ts = new Date(dateValue).getTime();
  if (Number.isNaN(ts)) return null;
  return BigInt(Math.floor(ts / 1000));
}

export function GrantRevokeRoleModal({
  walletAddress,
  ownerAddresses,
  threshold,
  initialTargetAddress = "",
  onClose,
  onSubmitted,
}: Props) {
  const [targetAddress, setTargetAddress] = useState(initialTargetAddress);
  const [targetTouched, setTargetTouched] = useState(Boolean(initialTargetAddress));
  const [role, setRole] = useState<Role>("Owner");
  const [action, setAction] = useState<RoleAction>("grant");
  const [description, setDescription] = useState("");
  const [deadline, setDeadline] = useState(defaultDeadline);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targetInputRef = useRef<HTMLInputElement>(null);
  const trimmedTarget = targetAddress.trim();
  const currentOwners = new Set(ownerAddresses);
  const targetHasRole = currentOwners.has(trimmedTarget);

  useEffect(() => {
    setTargetAddress(initialTargetAddress);
    setTargetTouched(Boolean(initialTargetAddress));
  }, [initialTargetAddress]);

  useEffect(() => {
    const previousActiveElement = document.activeElement as HTMLElement | null;
    targetInputRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (previousActiveElement && typeof previousActiveElement.focus === "function") {
        previousActiveElement.focus();
      }
    };
  }, [onClose]);

  function validate(): string | null {
    if (!walletAddress) {
      return "Connect your wallet first.";
    }

    if (!currentOwners.has(walletAddress)) {
      return "Only a current owner can create role proposals.";
    }

    if (!trimmedTarget || !description.trim()) {
      return "Target address and description are required.";
    }

    if (!StrKey.isValidEd25519PublicKey(trimmedTarget)) {
      return "Enter a valid Stellar address.";
    }

    if (role !== "Owner") {
      return "Unsupported role.";
    }

    if (description.trim().length > MAX_DESCRIPTION_LENGTH) {
      return `Description cannot exceed ${MAX_DESCRIPTION_LENGTH} characters.`;
    }

    const deadlineTs = toUnixSeconds(deadline);
    if (deadlineTs === null) {
      return "Enter a valid deadline.";
    }

    const deadlineMs = Number(deadlineTs) * 1000;
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    if (deadlineMs <= todayMidnight.getTime()) {
      return "Deadline must be in the future.";
    }

    const maxDeadlineMs =
      Date.now() + MAX_PROPOSAL_DURATION_DAYS * 24 * 3600 * 1000;
    if (deadlineMs > maxDeadlineMs) {
      return `Deadline cannot be more than ${MAX_PROPOSAL_DURATION_DAYS} days away.`;
    }

    if (action === "grant") {
      if (targetHasRole) {
        return "That address already has the Owner role.";
      }
      if (ownerAddresses.length >= MAX_OWNERS) {
        return `Owner role cannot be granted because the multisig already has ${MAX_OWNERS} owners.`;
      }
    }

    if (action === "revoke") {
      if (!targetHasRole) {
        return "That address does not currently have the Owner role.";
      }
      if (ownerAddresses.length <= threshold) {
        return "Revoking this role would break the required threshold.";
      }
    }

    return null;
  }

  async function handleSubmit() {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    const deadlineTs = toUnixSeconds(deadline);
    if (deadlineTs === null || !walletAddress) {
      setError("Unable to prepare the role proposal.");
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      if (action === "grant") {
        await createGrantRoleProposal(
          walletAddress,
          trimmedTarget,
          role,
          description.trim(),
          deadlineTs
        );
      } else {
        await createRevokeRoleProposal(
          walletAddress,
          trimmedTarget,
          role,
          description.trim(),
          deadlineTs
        );
      }
      onSubmitted();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transaction failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          onClose();
        }
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-6">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Manage Role</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close role modal"
            className="rounded-md text-zinc-500 hover:text-zinc-300 focus:outline-none focus:ring-2 focus:ring-zinc-400"
          >
            <X size={20} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs text-zinc-400">
              Proposer
            </label>
            <div
              className={`w-full truncate rounded-lg border px-3 py-2.5 text-sm ${
                walletAddress
                  ? "border-zinc-700/60 bg-zinc-800/60 font-mono text-zinc-300"
                  : "border-zinc-700/30 bg-zinc-800/30 text-zinc-500"
              }`}
            >
              {truncateAddress(walletAddress)}
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs text-zinc-400">
              Target Address
            </label>
            <input
              ref={targetInputRef}
              value={targetAddress}
              onChange={(e) => {
                setTargetAddress(e.target.value);
                setTargetTouched(true);
              }}
              onBlur={() => setTargetTouched(true)}
              placeholder="G..."
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 font-mono text-sm text-white placeholder-zinc-600 focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
            {targetTouched &&
              trimmedTarget &&
              !StrKey.isValidEd25519PublicKey(trimmedTarget) && (
                <p className="mt-1 text-xs text-red-400">
                  Enter a valid Stellar address.
                </p>
              )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs text-zinc-400">Role</label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-sm text-white focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-400"
              >
                {ROLE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1.5 block text-xs text-zinc-400">
                Action
              </label>
              <div className="grid grid-cols-2 gap-1">
                <button
                  type="button"
                  onClick={() => setAction("grant")}
                  aria-pressed={action === "grant"}
                  className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-400 ${
                    action === "grant"
                      ? "border-emerald-500 bg-emerald-500/20 text-emerald-300"
                      : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                  }`}
                >
                  <ShieldPlus size={14} />
                  Grant
                </button>
                <button
                  type="button"
                  onClick={() => setAction("revoke")}
                  aria-pressed={action === "revoke"}
                  className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-400 ${
                    action === "revoke"
                      ? "border-red-500 bg-red-500/20 text-red-300"
                      : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                  }`}
                >
                  <ShieldMinus size={14} />
                  Revoke
                </button>
              </div>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs text-zinc-400">
              Description
            </label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={MAX_DESCRIPTION_LENGTH}
              placeholder="Why should this role change?"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-sm text-white placeholder-zinc-600 focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs text-zinc-400">
              Deadline
            </label>
            <input
              aria-label="Deadline"
              type="date"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-sm text-white focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
          </div>

          {error && (
            <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {error}
            </p>
          )}

          <div className="pt-2">
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || !walletAddress}
              title={
                walletAddress ? undefined : "Connect your Freighter wallet to submit"
              }
              className="w-full rounded-lg bg-emerald-600 py-2.5 font-medium text-white transition-colors hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-zinc-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Submitting..." : "Submit Role Proposal"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
