import { useState, useEffect, useRef, type RefObject } from "react";
import {
  createProposal,
  createAddOwnerProposal,
  createRemoveOwnerProposal,
  createChangeThresholdProposal,
  estimateCreateProposalFee,
  createChangeOwnerWeightProposal,
} from "../lib/submit";
import {
  getOwners,
  getThreshold,
  getOwnerWeights,
  getTotalWeight,
  getRequiredQuorumWeight,
  getWeightCapPct,
} from "../lib/contract";
import { displayToStroops, formatWeightPercent } from "../lib/soroban";
import { VotingPowerPreview } from "./VotingPowerPreview";
import { AddressBookField } from "./AddressBookField";
import { ProposalTemplatePicker } from "./ProposalTemplatePicker";
import { previewTransferProposal, type BalanceDeltaRow } from "../lib/transactionPreview";
import { StrKey } from "@stellar/stellar-sdk";
import type { ProposalKind } from "../types/accord";
// Testnet token addresses — swap for mainnet when ready
const TOKEN_ADDRESSES: Record<string, string> = {
  XLM: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  USDC: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  EURC: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC",
};
const MAX_DESCRIPTION_LEN = 300;

type Props = {
  walletAddress: string | null;
  onClose: () => void;
  onSubmitted: () => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
};

type ProposalStep = "type" | "form" | "preview" | "confirm";

type FormType = ProposalKind;

type TransferFormData = {
  type: "transfer";
  recipient: string;
  tokenAddr: string;
  amountStroops: bigint;
  description: string;
  deadlineUnix: bigint;
};

type AddOwnerFormData = {
  type: "add_owner";
  newOwner: string;
  description: string;
  deadlineUnix: bigint;
};

type RemoveOwnerFormData = {
  type: "remove_owner";
  ownerToRemove: string;
  description: string;
  deadlineUnix: bigint;
};

type ChangeThresholdFormData = {
  type: "change_threshold";
  newThreshold: number;
  description: string;
  deadlineUnix: bigint;
};

type ChangeOwnerWeightFormData = {
  type: "change_owner_weight";
  targetOwner: string;
  newWeight: number;
  description: string;
  deadlineUnix: bigint;
};

type ValidatedFormData = TransferFormData | AddOwnerFormData | RemoveOwnerFormData | ChangeThresholdFormData | ChangeOwnerWeightFormData;

const FORM_OPTIONS: { kind: FormType; label: string }[] = [
  { kind: "transfer", label: "Transfer" },
  { kind: "add_owner", label: "Add Owner" },
  { kind: "remove_owner", label: "Remove Owner" },
  { kind: "change_threshold", label: "Change Threshold" },
  { kind: "change_owner_weight", label: "Propose Weight Change" },
];

function truncateAddress(address: string | null) {
  if (!address) return "Not connected";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatDeadlineDate(deadline: string) {
  return new Date(`${deadline}T00:00:00`).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function validateDeadline(deadline: string): string | null {
  const deadlineMs = new Date(deadline).getTime();
  const nowMs = Date.now();
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  if (deadlineMs <= todayMidnight.getTime()) return "Deadline must be in the future.";
  const maxMs = nowMs + 90 * 24 * 3600 * 1000;
  if (deadlineMs > maxMs) return "Deadline cannot be more than 90 days away.";
  return null;
}

export function CreateProposalModal({ walletAddress, onClose, onSubmitted, triggerRef }: Props) {
  const defaultDeadline = () => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  };

  // Flow
  const [step, setStep] = useState<ProposalStep>("type");
  const [formType, setFormType] = useState<FormType>("transfer");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Common fields
  const [description, setDescription] = useState("");
  const [deadline, setDeadline] = useState(defaultDeadline);

  // Transfer fields
  const [to, setTo] = useState("");
  const [recipientTouched, setRecipientTouched] = useState(false);
  const [amount, setAmount] = useState("");
  const [token, setToken] = useState("XLM");

  // Add/Remove Owner fields
  const [ownerAddress, setOwnerAddress] = useState("");
  const [ownerTouched, setOwnerTouched] = useState(false);
  const [availableOwners, setAvailableOwners] = useState<string[]>([]);
  const [selectedOwner, setSelectedOwner] = useState("");

  // Change Threshold fields
  const [newThreshold, setNewThreshold] = useState("");
  const [currentThreshold, setCurrentThreshold] = useState<number>(1);
  const [totalOwners, setTotalOwners] = useState<number>(1);

  // Proposal Weight Change fields
  const [newWeightInput, setNewWeightInput] = useState("");
  const [currentWeights, setCurrentWeights] = useState<Record<string, number>>({});
  const [totalWeight, setTotalWeight] = useState<number>(0);
  const [quorumWeight, setQuorumWeight] = useState<number>(0);
  const [weightCapPct, setWeightCapPct] = useState<number>(50);

  // Fee
  const [feeEstimate, setFeeEstimate] = useState<number | null>(null);
  const [feeLoading, setFeeLoading] = useState(false);
  const [feeError, setFeeError] = useState(false);

  // Transaction preview (transfer only): a blocking simulation that runs
  // automatically on entering the preview step, so the fee and balance
  // impact are known before the user can confirm.
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewFeeEstimate, setPreviewFeeEstimate] = useState<number | null>(null);
  const [previewFeeError, setPreviewFeeError] = useState<string | null>(null);
  const [previewBalances, setPreviewBalances] = useState<BalanceDeltaRow[]>([]);

  const firstInputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // Load contract data for governance proposals
  useEffect(() => {
    async function loadData() {
      try {
        const ownerAddrs = await getOwners();
        setAvailableOwners(ownerAddrs);
        setTotalOwners(ownerAddrs.length);

        const thresh = await getThreshold();
        setCurrentThreshold(thresh);
        setQuorumWeight(thresh);

        try {
          const cap = await getWeightCapPct();
          setWeightCapPct(cap);
        } catch (e) {
          console.warn("Failed to fetch weight cap", e);
        }

        try {
          const totalW = await getTotalWeight();
          setTotalWeight(totalW);
        } catch (e) {
          console.warn("Failed to fetch total weight", e);
        }

        try {
          const rq = await getRequiredQuorumWeight();
          setQuorumWeight(rq);
        } catch (e) {
          console.warn("Failed to fetch quorum weight", e);
        }

        const weightMap: Record<string, number> = {};
        let computedSum = 0;
        try {
          const ownerWeights = await getOwnerWeights();
          for (const entry of ownerWeights) {
            weightMap[entry.address] = entry.weight;
            computedSum += entry.weight;
          }
        } catch {
          for (const addr of ownerAddrs) {
            weightMap[addr] = 1;
            computedSum += 1;
          }
        }
        setCurrentWeights(weightMap);
        if (computedSum > 0) {
          setTotalWeight(computedSum);
        }
      } catch (err) {
        console.error("Failed to load contract state for modal", err);
      }
    }
    loadData();
  }, [formType]);

  // Initial focus
  useEffect(() => {
    const previousActiveElement = document.activeElement as HTMLElement | null;
    const currentTrigger = triggerRef?.current;
    if (firstInputRef.current) {
      firstInputRef.current.focus();
    }
    return () => {
      if (currentTrigger && typeof currentTrigger.focus === "function") {
        currentTrigger.focus();
      } else if (previousActiveElement && typeof previousActiveElement.focus === "function") {
        previousActiveElement.focus();
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus trap
  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;

    const FOCUSABLE_SELECTORS =
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      const focusable = Array.from(
        modal.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS),
      ).filter((el) => !el.closest('[aria-hidden="true"]'));

      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    modal.addEventListener("keydown", handleKeyDown);
    return () => modal.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function clearError() {
    setError(null);
  }

  // ─── Validation ──────────────────────────────────────────────────────────

  function getValidatedForm(): ValidatedFormData | null {
    if (!walletAddress) {
      setError("Connect your wallet first.");
      return null;
    }

    if (formType === "transfer") {
      if (!to.trim() || !amount.trim() || !description.trim()) {
        setError("Recipient, amount, and description are required.");
        return null;
      }
      if (!StrKey.isValidEd25519PublicKey(to.trim())) {
        setError("Enter a valid Stellar address");
        return null;
      }
      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum <= 0) {
        setError("Enter a valid amount.");
        return null;
      }
      const tokenAddr = TOKEN_ADDRESSES[token];
      if (!tokenAddr) {
        setError("Unknown token.");
        return null;
      }
      const dlErr = validateDeadline(deadline);
      if (dlErr) { setError(dlErr); return null; }

      return {
        type: "transfer",
        recipient: to.trim(),
        tokenAddr,
        amountStroops: displayToStroops(amountNum),
        description: description.trim(),
        deadlineUnix: BigInt(Math.floor(new Date(deadline).getTime() / 1000)),
      } satisfies TransferFormData;
    }

    if (formType === "add_owner") {
      if (!ownerAddress.trim() || !description.trim()) {
        setError("Owner address and description are required.");
        return null;
      }
      if (!StrKey.isValidEd25519PublicKey(ownerAddress.trim())) {
        setError("Enter a valid Stellar address");
        return null;
      }
      const dlErr = validateDeadline(deadline);
      if (dlErr) { setError(dlErr); return null; }

      return {
        type: "add_owner",
        newOwner: ownerAddress.trim(),
        description: description.trim(),
        deadlineUnix: BigInt(Math.floor(new Date(deadline).getTime() / 1000)),
      } satisfies AddOwnerFormData;
    }

    if (formType === "remove_owner") {
      if (!selectedOwner) {
        setError("Select an owner to remove.");
        return null;
      }
      if (!description.trim()) {
        setError("Description is required.");
        return null;
      }
      const dlErr = validateDeadline(deadline);
      if (dlErr) { setError(dlErr); return null; }

      return {
        type: "remove_owner",
        ownerToRemove: selectedOwner,
        description: description.trim(),
        deadlineUnix: BigInt(Math.floor(new Date(deadline).getTime() / 1000)),
      } satisfies RemoveOwnerFormData;
    }

    if (formType === "change_threshold") {
      const val = parseInt(newThreshold, 10);
      if (isNaN(val) || val < 1 || val > totalOwners) {
        setError(`Threshold must be between 1 and ${totalOwners}.`);
        return null;
      }
      if (!description.trim()) {
        setError("Description is required.");
        return null;
      }
      const dlErr = validateDeadline(deadline);
      if (dlErr) { setError(dlErr); return null; }

      return {
        type: "change_threshold",
        newThreshold: val,
        description: description.trim(),
        deadlineUnix: BigInt(Math.floor(new Date(deadline).getTime() / 1000)),
      } satisfies ChangeThresholdFormData;
    }

    if (formType === "change_owner_weight") {
      if (!selectedOwner) {
        setError("Select an owner to change weight.");
        return null;
      }
      const weightNum = parseInt(newWeightInput, 10);
      if (isNaN(weightNum) || weightNum < 1 || weightNum > 100000) {
        setError("New weight must be between 1 and 100,000.");
        return null;
      }
      if (!description.trim()) {
        setError("Description is required.");
        return null;
      }
      const dlErr = validateDeadline(deadline);
      if (dlErr) { setError(dlErr); return null; }

      return {
        type: "change_owner_weight",
        targetOwner: selectedOwner,
        newWeight: weightNum,
        description: description.trim(),
        deadlineUnix: BigInt(Math.floor(new Date(deadline).getTime() / 1000)),
      } satisfies ChangeOwnerWeightFormData;
    }

    setError("Unknown proposal type.");
    return null;
  }

  async function handleCalculateFee() {
    if (formType !== "transfer") return;
    if (!walletAddress || !to.trim() || !amount.trim() || !description.trim()) return;

    const tokenAddr = TOKEN_ADDRESSES[token];
    if (!tokenAddr) return;

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) return;

    const deadlineUnix = BigInt(Math.floor(new Date(deadline).getTime() / 1000));

    setFeeLoading(true);
    setFeeError(false);
    setFeeEstimate(null);

    try {
      const fee = await estimateCreateProposalFee(
        walletAddress,
        to.trim(),
        tokenAddr,
        displayToStroops(amountNum),
        description.trim(),
        deadlineUnix
      );
      setFeeEstimate(fee);
    } catch {
      setFeeError(true);
    } finally {
      setFeeLoading(false);
    }
  }

  function handleGoToForm(kind: FormType) {
    clearError();
    setFormType(kind);
    setStep("form");
  }

  async function runTransferPreview(data: TransferFormData) {
    setPreviewLoading(true);
    setPreviewFeeEstimate(null);
    setPreviewFeeError(null);
    setPreviewBalances([]);
    try {
      const preview = await previewTransferProposal({
        callerAddress: walletAddress!,
        recipient: data.recipient,
        tokenAddress: data.tokenAddr,
        tokenSymbol: token,
        amountStroops: data.amountStroops,
        description: data.description,
        deadlineUnix: data.deadlineUnix,
      });
      setPreviewFeeEstimate(preview.feeEstimate);
      setPreviewFeeError(preview.feeError);
      setPreviewBalances(preview.balances);
    } catch (e) {
      setPreviewFeeError(e instanceof Error ? e.message : "Transaction simulation failed. Please try again.");
    } finally {
      setPreviewLoading(false);
    }
  }

  function handleSubmit() {
    const data = getValidatedForm();
    if (!data) return;
    clearError();
    setStep("preview");
    if (data.type === "transfer") {
      void runTransferPreview(data);
    }
  }

  async function handleConfirmSubmit() {
    // If we're previewing a weight-change proposal, move to the final confirm step
    if (formType === "change_owner_weight" && step === "preview") {
      setStep("confirm");
      return;
    }

    const data = getValidatedForm();
    if (!data) return;

    clearError();
    setSubmitting(true);
    try {
      switch (data.type) {
        case "transfer":
          await createProposal(
            walletAddress!,
            data.recipient,
            data.tokenAddr,
            data.amountStroops,
            data.description,
            data.deadlineUnix
          );
          break;
        case "add_owner":
          await createAddOwnerProposal(
            walletAddress!,
            data.newOwner,
            data.description,
            data.deadlineUnix
          );
          break;
        case "remove_owner":
          await createRemoveOwnerProposal(
            walletAddress!,
            data.ownerToRemove,
            data.description,
            data.deadlineUnix
          );
          break;
        case "change_threshold":
          await createChangeThresholdProposal(
            walletAddress!,
            data.newThreshold,
            data.description,
            data.deadlineUnix
          );
          break;
        case "change_owner_weight":
          await createChangeOwnerWeightProposal(
            walletAddress!,
            data.targetOwner,
            data.newWeight,
            data.description,
            data.deadlineUnix
          );
          break;
      }
      onSubmitted();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transaction failed");
    } finally {
      setSubmitting(false);
    }
  }

  // Confirmation step for weight-change proposals
  function renderConfirm() {
    if (formType !== "change_owner_weight") return null;
    const target = selectedOwner;
    const oldWeight = currentWeights[target] ?? 1;
    const newWeight = parseInt(newWeightInput, 10);
    const currentTotal = totalWeight;
    const resultingTotal = currentTotal - oldWeight + (isNaN(newWeight) ? 0 : newWeight);
    const currentQuorum = quorumWeight;
    // If quorum is expressed as count, leave it; otherwise it may already be weight
    const resultingQuorum = currentQuorum; // Assuming quorum remains same weight in this implementation

    return (
      <>
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-zinc-200">Confirm Weight Change</h3>
          <dl className="space-y-3 rounded-lg border border-zinc-700 bg-zinc-800/50 p-3">
            <div>
              <dt className="text-xs text-zinc-600 dark:text-zinc-400">Target Owner</dt>
              <dd className="mt-1 text-sm text-zinc-200 font-mono break-all">{target}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-600 dark:text-zinc-400">Current Owner Weight</dt>
              <dd className="mt-1 text-sm text-zinc-200 font-mono">{oldWeight}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-600 dark:text-zinc-400">Proposed New Weight</dt>
              <dd className="mt-1 text-sm text-zinc-200 font-mono">{isNaN(newWeight) ? "—" : newWeight}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-600 dark:text-zinc-400">Current Total Weight</dt>
              <dd className="mt-1 text-sm text-zinc-200 font-mono">{currentTotal}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-600 dark:text-zinc-400">Resulting Total Weight</dt>
              <dd className="mt-1 text-sm text-zinc-200 font-mono">{resultingTotal}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-600 dark:text-zinc-400">Current Quorum Requirement</dt>
              <dd className="mt-1 text-sm text-zinc-200 font-mono">{currentQuorum}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-600 dark:text-zinc-400">Resulting Quorum Requirement</dt>
              <dd className="mt-1 text-sm text-zinc-200 font-mono">{resultingQuorum}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-600 dark:text-zinc-400">Description</dt>
              <dd className="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-200">{description.trim()}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-600 dark:text-zinc-400">Deadline</dt>
              <dd className="mt-1 text-sm text-zinc-200">{formatDeadlineDate(deadline)}</dd>
            </div>
          </dl>
        </div>

        {error && (
          <p className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={() => setStep("form")}
            disabled={submitting}
            className="flex-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-white min-h-[44px] py-2.5 rounded-lg font-medium transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none flex items-center justify-center"
          >
            Back
          </button>
          <button
            type="button"
            onClick={handleConfirmSubmit}
            disabled={submitting || !walletAddress}
            title={
              walletAddress ? undefined : "Connect your Freighter wallet to submit"
            }
            className="flex-1 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed text-white min-h-[44px] py-2.5 rounded-lg font-medium transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none flex items-center justify-center"
          >
            {submitting ? "Submitting…" : "Confirm & Submit"}
          </button>
        </div>
      </>
    );
  }

  // ─── Render steps ────────────────────────────────────────────────────────

  function renderTypeSelector() {
    return (
      <div className="space-y-4">
        <p className="text-sm text-zinc-400">Select the type of proposal to create:</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 sm:gap-3">
          {FORM_OPTIONS.map(({ kind, label }) => (
            <button
              key={kind}
              type="button"
              onClick={() => handleGoToForm(kind)}
              className="rounded-xl border border-zinc-700 bg-zinc-800/50 p-3.5 sm:p-4 min-h-[48px] text-sm font-medium text-zinc-200 transition-colors hover:border-emerald-500/50 hover:bg-zinc-800 disabled:opacity-50 focus:ring-2 focus:ring-zinc-400 focus:outline-none flex items-center justify-between sm:justify-center"
            >
              <span>{label}</span>
              <span className="text-zinc-600 dark:text-zinc-400 sm:hidden">→</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  function renderForm() {
    return (
      <>
        <div>
          <label className="text-xs text-zinc-400 block mb-1.5">Proposer</label>
          <div
            className={`w-full border rounded-lg px-3 py-2.5 text-sm ${
              walletAddress
                ? "bg-zinc-800/60 border-zinc-700/60 text-zinc-300 font-mono"
                : "bg-zinc-800/30 border-zinc-700/30 text-zinc-600 dark:text-zinc-400"
            } truncate`}
          >
            {truncateAddress(walletAddress)}
          </div>
        </div>

        {/* Transfer specific fields */}
        {formType === "transfer" && (
          <>
            <ProposalTemplatePicker
              idPrefix="proposal-template"
              fields={{ recipient: to, amount, token, description }}
              onApply={(fields) => {
                if (fields.recipient) {
                  setTo(fields.recipient);
                  setRecipientTouched(true);
                }
                if (fields.amount) setAmount(fields.amount);
                if (fields.token) setToken(fields.token);
                if (fields.description) setDescription(fields.description);
              }}
            />

            <div>
              <label
                htmlFor="proposal-recipient-input"
                className="text-xs text-zinc-400 block mb-1.5"
              >
                Recipient Address
              </label>
              <AddressBookField
                idPrefix="proposal-recipient"
                address={to}
                isValidAddress={StrKey.isValidEd25519PublicKey(to.trim())}
                onSelectAddress={(addr) => {
                  setTo(addr);
                  setRecipientTouched(true);
                }}
              />
              <input
                id="proposal-recipient-input"
                ref={firstInputRef}
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setRecipientTouched(true);
                }}
                onBlur={() => setRecipientTouched(true)}
                placeholder="G..."
                className="mt-1.5 w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-base sm:text-sm font-mono placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500 min-h-[44px]"
              />
              {recipientTouched && !StrKey.isValidEd25519PublicKey(to.trim()) && (
                <p className="text-xs text-red-400 mt-1">Enter a valid Stellar address</p>
              )}
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1">
                <label
                  htmlFor="proposal-amount-input"
                  className="text-xs text-zinc-400 block mb-1.5 font-sans"
                >
                  Amount
                </label>
                <input
                  id="proposal-amount-input"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-base sm:text-sm placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500 min-h-[44px]"
                />
              </div>
              <div className="w-full sm:w-36">
                <label className="text-xs text-zinc-400 block mb-1.5 font-sans">Token</label>
                <div className="grid grid-cols-3 gap-1.5">
                  {(["XLM", "USDC", "EURC"] as const).map((symbol) => {
                    const active = token === symbol;
                    return (
                      <button
                        key={symbol}
                        type="button"
                        onClick={() => setToken(symbol)}
                        aria-pressed={active}
                        className={`min-h-[44px] rounded-lg border px-2 py-2 text-xs font-medium transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none ${
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

            {walletAddress && to.trim() && amount.trim() && description.trim() && (
              <div className="flex items-center justify-between bg-zinc-800/50 p-3 rounded-lg border border-zinc-700/50">
                <div className="text-sm">
                  {feeLoading ? (
                    <span className="text-zinc-400">Estimating fee…</span>
                  ) : feeError ? (
                    <span className="text-red-400">Could not estimate fee</span>
                  ) : feeEstimate !== null ? (
                    <span className="text-zinc-300">
                      Estimated fee: <span className="text-white font-mono">~{feeEstimate.toFixed(7)} XLM</span>
                    </span>
                  ) : (
                    <span className="text-zinc-600 dark:text-zinc-400">No estimate yet</span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={handleCalculateFee}
                  disabled={feeLoading}
                  className="text-xs bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 text-white px-3 py-1.5 rounded-md transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none"
                >
                  Calculate fee
                </button>
              </div>
            )}
          </>
        )}

        {/* Add Owner fields */}
        {formType === "add_owner" && (
          <div>
            <label className="text-xs text-zinc-400 block mb-1.5">
              New Owner Address
            </label>
            <input
              ref={firstInputRef}
              value={ownerAddress}
              onChange={(e) => {
                setOwnerAddress(e.target.value);
                setOwnerTouched(true);
              }}
              onBlur={() => setOwnerTouched(true)}
              placeholder="G..."
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-base sm:text-sm font-mono placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500 min-h-[44px]"
            />
            {ownerTouched && !StrKey.isValidEd25519PublicKey(ownerAddress.trim()) && (
              <p className="text-xs text-red-400 mt-1">Enter a valid Stellar address</p>
            )}
            
            {/* Live Voting-Power Preview (MIN_OWNER_WEIGHT = 1) */}
            {ownerAddress && StrKey.isValidEd25519PublicKey(ownerAddress.trim()) && (
              <VotingPowerPreview
                beforeWeight={totalWeight}
                afterWeight={totalWeight + 1}
                totalWeight={totalWeight + 1}
                type="add_owner"
                note="Note: The contract assigns a minimum weight of 1 (MIN_OWNER_WEIGHT) to newly added owners. Custom weights are not supported during owner creation."
              />
            )}
          </div>
        )}

        {/* Remove Owner fields */}
        {formType === "remove_owner" && (
          <div>
            <label className="text-xs text-zinc-400 block mb-1.5 font-sans">
              Owner to Remove
            </label>
            <select
              ref={firstInputRef as unknown as React.Ref<HTMLSelectElement>}
              value={selectedOwner}
              onChange={(e) => setSelectedOwner(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-base sm:text-sm font-mono focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500 min-h-[44px]"
            >
              <option value="">Select an owner…</option>
              {availableOwners.map((addr) => (
                <option key={addr} value={addr}>
                  {truncateAddress(addr)}
                </option>
              ))}
            </select>
            
            {/* Live Quorum-Impact Warning */}
            {selectedOwner && (() => {
              const currentWeight = currentWeights[selectedOwner] ?? 1;
              const resultingTotalWeight = totalWeight - currentWeight;
              const isQuorumBroken = resultingTotalWeight < quorumWeight;
              return (
                <VotingPowerPreview
                  beforeWeight={currentWeight}
                  afterWeight={0}
                  totalWeight={resultingTotalWeight}
                  threshold={quorumWeight}
                  type="remove_owner"
                  warning={{
                    show: isQuorumBroken,
                    message: (
                      <p>
                        <strong>Warning:</strong> Removing this owner drops remaining total weight ({resultingTotalWeight}) below the required quorum threshold ({quorumWeight}). Future proposals will not be executable.
                      </p>
                    )
                  }}
                />
              );
            })()}
          </div>
        )}

        {/* Change Threshold fields */}
        {formType === "change_threshold" && (
          <div>
            <label className="text-xs text-zinc-400 block mb-1.5 font-sans">
              New Threshold (currently {currentThreshold} of {totalOwners})
            </label>
            <input
              ref={firstInputRef}
              value={newThreshold}
              onChange={(e) => setNewThreshold(e.target.value)}
              placeholder={`1 – ${totalOwners}`}
              type="number"
              inputMode="numeric"
              min={1}
              max={totalOwners}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-base sm:text-sm font-mono placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500 min-h-[44px]"
            />
            <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-1 font-sans">
              Threshold must be between 1 and {totalOwners}
            </p>
          </div>
        )}

        {/* Propose Weight Change fields */}
        {formType === "change_owner_weight" && (
          <div className="space-y-4">
            <div>
              <label className="text-xs text-zinc-400 block mb-1.5 font-sans">
                Target Owner
              </label>
              <select
                ref={firstInputRef as unknown as React.Ref<HTMLSelectElement>}
                value={selectedOwner}
                onChange={(e) => setSelectedOwner(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-base sm:text-sm font-mono focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500 min-h-[44px]"
              >
                <option value="">Select target owner…</option>
                {availableOwners.map((addr) => (
                  <option key={addr} value={addr}>
                    {truncateAddress(addr)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs text-zinc-400 block mb-1.5 font-sans">
                New Weight (1 – 100,000)
              </label>
              <input
                value={newWeightInput}
                onChange={(e) => setNewWeightInput(e.target.value)}
                placeholder="Enter new weight..."
                type="number"
                inputMode="numeric"
                min={1}
                max={100000}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-base sm:text-sm font-mono placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500 min-h-[44px]"
              />
            </div>

            {selectedOwner && newWeightInput && (() => {
              const wVal = parseInt(newWeightInput, 10);
              if (isNaN(wVal) || wVal < 1 || wVal > 100000) return null;
              const oldW = currentWeights[selectedOwner] ?? 1;
              const nextTotalW = totalWeight - oldW + wVal;
              const newSharePct = nextTotalW > 0 ? (wVal / nextTotalW) * 100 : 0;
              const exceedsCap = newSharePct > weightCapPct;

              return (
                <VotingPowerPreview
                  beforeWeight={oldW}
                  afterWeight={wVal}
                  totalWeight={nextTotalW}
                  weightCapPct={weightCapPct}
                  type="change_owner_weight"
                  warning={{
                    show: exceedsCap,
                    message: (
                      <p>
                        <strong>Warning:</strong> Resulting weight share ({newSharePct.toFixed(1)}%) exceeds the contract's configured max weight cap ({weightCapPct}%). This weight change proposal may be rejected by the contract upon execution.
                      </p>
                    )
                  }}
                />
              );
            })()}
          </div>
        )}

        {/* Common fields */}
        <div>
          <label
            htmlFor="proposal-description-input"
            className="text-xs text-zinc-400 block mb-1.5"
          >
            Description
          </label>
          <input
            id="proposal-description-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={MAX_DESCRIPTION_LEN}
            placeholder={formType === "transfer" ? "What is this payment for?" : "Reason for this change"}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-base sm:text-sm placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500 min-h-[44px]"
          />
          <p
            className={`mt-1 text-right text-xs ${
              description.length >= MAX_DESCRIPTION_LEN
                ? "text-red-400"
                : "text-zinc-600 dark:text-zinc-400"
            }`}
          >
            {description.length} / {MAX_DESCRIPTION_LEN}
          </p>
        </div>

        <div>
          <label className="text-xs text-zinc-400 block mb-1.5">
            Deadline
          </label>
          <input
            type="date"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-base sm:text-sm focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500 min-h-[44px]"
          />
        </div>

        {error && (
          <p className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={() => setStep("type")}
            className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-white min-h-[44px] py-2.5 rounded-lg font-medium transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none flex items-center justify-center"
          >
            Back
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || !walletAddress}
            title={
              walletAddress ? undefined : "Connect your Freighter wallet to submit"
            }
            className="flex-1 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed text-white min-h-[44px] py-2.5 rounded-lg font-medium transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none flex items-center justify-center"
          >
            Review Proposal
          </button>
        </div>
      </>
    );
  }

  function renderPreview() {
    const dl = formatDeadlineDate(deadline);
    const quorumPercentage = totalWeight > 0 ? formatWeightPercent(quorumWeight, totalWeight) : "—";
    
    return (
      <>
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-zinc-200">Preview Proposal</h3>
          <dl className="space-y-3 rounded-lg border border-zinc-700 bg-zinc-800/50 p-3">
            {formType === "transfer" && (
              <>
                <div>
                  <dt className="text-xs text-zinc-600 dark:text-zinc-400">Action</dt>
                  <dd className="mt-1 break-all text-sm text-zinc-200">Transfer {amount} {token} to {to}</dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-600 dark:text-zinc-400">Estimated Fee</dt>
                  <dd className="mt-1 text-sm text-zinc-200">
                    {previewLoading ? (
                      <span className="text-zinc-400">Simulating transaction…</span>
                    ) : previewFeeEstimate !== null ? (
                      <span className="font-mono">~{previewFeeEstimate.toFixed(7)} XLM</span>
                    ) : (
                      <span className="text-zinc-600 dark:text-zinc-400">—</span>
                    )}
                  </dd>
                </div>
                {!previewLoading && previewBalances.length > 0 && (
                  <div>
                    <dt className="text-xs text-zinc-600 dark:text-zinc-400">Balance Impact</dt>
                    <dd className="mt-1.5 space-y-2">
                      {previewBalances.map((row) => (
                        <div
                          key={`${row.label}-${row.address}`}
                          className="rounded-lg border border-zinc-700/60 bg-zinc-900/60 px-2.5 py-2 text-xs"
                        >
                          <div className="text-zinc-400">{row.label}</div>
                          <div className="mt-0.5 font-mono text-zinc-200">
                            {row.before} <span className="text-zinc-600 dark:text-zinc-400">→</span> {row.after} {row.token}
                          </div>
                        </div>
                      ))}
                    </dd>
                  </div>
                )}
              </>
            )}
            {formType === "add_owner" && (
              <>
                <div>
                  <dt className="text-xs text-zinc-600 dark:text-zinc-400">Action</dt>
                  <dd className="mt-1 text-sm text-zinc-200">Add new owner</dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-600 dark:text-zinc-400">New Owner Address</dt>
                  <dd className="mt-1 break-all font-mono text-sm text-zinc-200">{ownerAddress.trim()}</dd>
                </div>
              </>
            )}
            {formType === "remove_owner" && (
              <>
                <div>
                  <dt className="text-xs text-zinc-600 dark:text-zinc-400">Action</dt>
                  <dd className="mt-1 text-sm text-zinc-200">Remove owner</dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-600 dark:text-zinc-400">Owner to Remove</dt>
                  <dd className="mt-1 break-all font-mono text-sm text-zinc-200">{selectedOwner}</dd>
                </div>
              </>
            )}
            {formType === "change_threshold" && (
              <>
                <div>
                  <dt className="text-xs text-zinc-600 dark:text-zinc-400 font-sans">Action</dt>
                  <dd className="mt-1 text-sm text-zinc-200 font-sans">Change approval threshold to {newThreshold} of {totalOwners}</dd>
                </div>
              </>
            )}
            {formType === "change_owner_weight" && (
              <>
                <div>
                  <dt className="text-xs text-zinc-600 dark:text-zinc-400 font-sans">Action</dt>
                  <dd className="mt-1 text-sm text-zinc-200 font-sans font-medium">Propose owner weight change</dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-600 dark:text-zinc-400 font-sans">Target Owner</dt>
                  <dd className="mt-1 break-all font-mono text-sm text-zinc-200">{selectedOwner}</dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-600 dark:text-zinc-400 font-sans">New Weight</dt>
                  <dd className="mt-1 font-mono text-sm text-zinc-200 font-medium">{newWeightInput}</dd>
                </div>
              </>
            )}
            <div>
              <dt className="text-xs text-zinc-600 dark:text-zinc-400">Description</dt>
              <dd className="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-200">
                {description.trim()}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-600 dark:text-zinc-400">Deadline</dt>
              <dd className="mt-1 text-sm text-zinc-200">{dl}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-600 dark:text-zinc-400">Required Quorum</dt>
              <dd className="mt-1 text-sm text-zinc-200">
                {quorumWeight > 0 ? (
                  <>
                    <span className="font-mono">{quorumWeight}</span> weight ({quorumPercentage} of total voting power)
                  </>
                ) : (
                  <span className="text-zinc-400">Not available</span>
                )}
              </dd>
            </div>
          </dl>
        </div>

        {formType === "transfer" && previewFeeError && (
          <p className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2" role="alert">
            Could not simulate this transaction: {previewFeeError}
          </p>
        )}

        {error && (
          <p className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={() => setStep("form")}
            disabled={submitting}
            className="flex-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-white min-h-[44px] py-2.5 rounded-lg font-medium transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none flex items-center justify-center"
          >
            Back
          </button>
          <button
            type="button"
            onClick={handleConfirmSubmit}
            disabled={
              submitting ||
              !walletAddress ||
              (formType === "transfer" && (previewLoading || !!previewFeeError))
            }
            title={
              !walletAddress
                ? "Connect your Freighter wallet to submit"
                : formType === "transfer" && previewFeeError
                ? "Resolve the simulation error before submitting"
                : undefined
            }
            className="flex-1 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed text-white min-h-[44px] py-2.5 rounded-lg font-medium transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none flex items-center justify-center"
          >
            {submitting ? "Submitting…" : "Confirm & Submit"}
          </button>
        </div>
      </>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-3 sm:p-4 overflow-y-auto">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        className="bg-zinc-900 border border-zinc-700 rounded-2xl p-4 sm:p-6 w-full max-w-md max-h-[calc(100dvh-1.5rem)] sm:max-h-[90vh] overflow-y-auto my-auto shadow-2xl"
      >
        <div className="flex items-center justify-between mb-5 sm:mb-6">
          <h2 id="modal-title" className="text-white font-semibold text-lg">New Proposal</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="text-zinc-600 dark:text-zinc-400 hover:text-zinc-300 text-xl focus:ring-2 focus:ring-zinc-400 focus:outline-none rounded-lg min-h-[44px] min-w-[44px] flex items-center justify-center -mr-2"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4">
          {step === "type" && renderTypeSelector()}
          {step === "form" && renderForm()}
          {step === "preview" && renderPreview()}
          {step === "confirm" && renderConfirm()}
        </div>
      </div>
    </div>
  );
}
