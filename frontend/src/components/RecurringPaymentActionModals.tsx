import { useEffect, useRef, useState } from "react";
import { displayToStroops } from "../lib/soroban";
import {
  createPauseRecurringProposal,
  createResumeRecurringProposal,
  createCancelRecurringProposal,
  createModifyRecurringProposal,
} from "../lib/submit";

// Default governance deadline: 7 days from now (seconds).
function defaultDeadlineTs(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 7 * 86_400);
}

// ─── Shared modal shell ───────────────────────────────────────────────────────

type ModalShellProps = {
  title: string;
  scheduleId: number;
  onClose: () => void;
  children: React.ReactNode;
};

function ModalShell({ title, scheduleId, onClose, children }: ModalShellProps) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${title} for schedule #${scheduleId}`}
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl p-6 w-full max-w-md">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-white font-semibold text-lg">{title}</h2>
            <p className="text-xs text-zinc-500 font-mono mt-0.5">Schedule #{scheduleId}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-zinc-500 hover:text-zinc-300 text-xl focus:ring-2 focus:ring-zinc-400 focus:outline-none rounded-md"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── Shared description + deadline fields ─────────────────────────────────────

type ProposalFieldsProps = {
  description: string;
  onDescriptionChange: (v: string) => void;
  deadlineDays: string;
  onDeadlineDaysChange: (v: string) => void;
};

function ProposalFields({
  description,
  onDescriptionChange,
  deadlineDays,
  onDeadlineDaysChange,
}: ProposalFieldsProps) {
  return (
    <>
      <div>
        <label className="text-xs text-zinc-400 block mb-1.5">
          Description <span className="text-zinc-600">(optional)</span>
        </label>
        <textarea
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          rows={2}
          placeholder="Reason for this proposal…"
          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500 resize-none"
        />
      </div>
      <div>
        <label className="text-xs text-zinc-400 block mb-1.5">Voting deadline (days)</label>
        <input
          type="number"
          min="1"
          max="90"
          value={deadlineDays}
          onChange={(e) => onDeadlineDaysChange(e.target.value)}
          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
        />
      </div>
    </>
  );
}

// ─── Pause Modal ──────────────────────────────────────────────────────────────

type ActionModalProps = {
  scheduleId: number;
  walletAddress: string;
  onClose: () => void;
  onSubmitted: () => void;
};

export function PauseRecurringModal({
  scheduleId,
  walletAddress,
  onClose,
  onSubmitted,
}: ActionModalProps) {
  const [description, setDescription] = useState("");
  const [deadlineDays, setDeadlineDays] = useState("7");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);
    try {
      const days = Math.max(1, Math.min(90, Number.parseInt(deadlineDays, 10) || 7));
      const deadlineTs = BigInt(Math.floor(Date.now() / 1000) + days * 86_400);
      await createPauseRecurringProposal(walletAddress, scheduleId, description.trim(), deadlineTs);
      onSubmitted();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transaction failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalShell title="Propose Pause" scheduleId={scheduleId} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-zinc-400">
          This creates a governance proposal to pause schedule{" "}
          <span className="text-white font-mono">#{scheduleId}</span>. It requires multisig
          approval before taking effect.
        </p>
        <ProposalFields
          description={description}
          onDescriptionChange={setDescription}
          deadlineDays={deadlineDays}
          onDeadlineDaysChange={setDeadlineDays}
        />
        {error && (
          <p className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{error}</p>
        )}
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-300 hover:bg-zinc-700 transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-400"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="flex-1 rounded-lg bg-yellow-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-yellow-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-400"
          >
            {submitting ? "Submitting…" : "Propose Pause"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ─── Resume Modal ─────────────────────────────────────────────────────────────

export function ResumeRecurringModal({
  scheduleId,
  walletAddress,
  onClose,
  onSubmitted,
}: ActionModalProps) {
  const [description, setDescription] = useState("");
  const [deadlineDays, setDeadlineDays] = useState("7");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);
    try {
      const days = Math.max(1, Math.min(90, Number.parseInt(deadlineDays, 10) || 7));
      const deadlineTs = BigInt(Math.floor(Date.now() / 1000) + days * 86_400);
      await createResumeRecurringProposal(walletAddress, scheduleId, description.trim(), deadlineTs);
      onSubmitted();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transaction failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalShell title="Propose Resume" scheduleId={scheduleId} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-zinc-400">
          This creates a governance proposal to resume schedule{" "}
          <span className="text-white font-mono">#{scheduleId}</span>. It requires multisig
          approval before taking effect.
        </p>
        <ProposalFields
          description={description}
          onDescriptionChange={setDescription}
          deadlineDays={deadlineDays}
          onDeadlineDaysChange={setDeadlineDays}
        />
        {error && (
          <p className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{error}</p>
        )}
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-300 hover:bg-zinc-700 transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-400"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="flex-1 rounded-lg bg-yellow-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-yellow-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-400"
          >
            {submitting ? "Submitting…" : "Propose Resume"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ─── Cancel Modal ─────────────────────────────────────────────────────────────

export function CancelRecurringModal({
  scheduleId,
  walletAddress,
  onClose,
  onSubmitted,
}: ActionModalProps) {
  const [description, setDescription] = useState("");
  const [deadlineDays, setDeadlineDays] = useState("7");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);
    try {
      const days = Math.max(1, Math.min(90, Number.parseInt(deadlineDays, 10) || 7));
      const deadlineTs = BigInt(Math.floor(Date.now() / 1000) + days * 86_400);
      await createCancelRecurringProposal(walletAddress, scheduleId, description.trim(), deadlineTs);
      onSubmitted();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transaction failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalShell title="Propose Cancellation" scheduleId={scheduleId} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-zinc-400">
          This creates a governance proposal to permanently cancel schedule{" "}
          <span className="text-white font-mono">#{scheduleId}</span>. Once approved and executed
          it cannot be undone.
        </p>
        <ProposalFields
          description={description}
          onDescriptionChange={setDescription}
          deadlineDays={deadlineDays}
          onDeadlineDaysChange={setDeadlineDays}
        />
        {error && (
          <p className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{error}</p>
        )}
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-300 hover:bg-zinc-700 transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-400"
          >
            Back
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="flex-1 rounded-lg bg-rose-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-400"
          >
            {submitting ? "Submitting…" : "Propose Cancel"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ─── Modify Modal ─────────────────────────────────────────────────────────────

type ModifyModalProps = ActionModalProps & {
  currentAmount?: string;
  currentInterval?: number;
};

export function ModifyRecurringModal({
  scheduleId,
  walletAddress,
  onClose,
  onSubmitted,
  currentAmount = "",
  currentInterval,
}: ModifyModalProps) {
  const [amount, setAmount] = useState(currentAmount);
  const [intervalSecs, setIntervalSecs] = useState(
    currentInterval !== undefined ? String(currentInterval) : "2592000"
  );
  const [description, setDescription] = useState("");
  const [deadlineDays, setDeadlineDays] = useState("7");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const firstInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  async function handleSubmit() {
    setError(null);

    const amountNum = Number.parseFloat(amount);
    const amountStroops = displayToStroops(amountNum);
    if (Number.isNaN(amountNum) || amountStroops < 1n) {
      setError("Enter an amount above the minimum.");
      return;
    }

    const intervalNum = Number.parseInt(intervalSecs, 10);
    if (!Number.isFinite(intervalNum) || intervalNum < 60 || intervalNum > 31_536_000) {
      setError("Interval must be between 60 and 31,536,000 seconds.");
      return;
    }

    setSubmitting(true);
    try {
      const days = Math.max(1, Math.min(90, Number.parseInt(deadlineDays, 10) || 7));
      const deadlineTs = BigInt(Math.floor(Date.now() / 1000) + days * 86_400);
      await createModifyRecurringProposal(
        walletAddress,
        scheduleId,
        amountStroops,
        BigInt(intervalNum),
        description.trim(),
        deadlineTs
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
    <ModalShell title="Propose Modification" scheduleId={scheduleId} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-zinc-400">
          Propose new parameters for schedule{" "}
          <span className="text-white font-mono">#{scheduleId}</span>. Changes take effect after
          multisig approval.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-xs text-zinc-400 block mb-1.5">New amount per period</label>
            <input
              ref={firstInputRef}
              type="number"
              min="0"
              step="any"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
            />
          </div>
          <div>
            <label className="text-xs text-zinc-400 block mb-1.5">New interval (seconds)</label>
            <input
              type="number"
              min="60"
              value={intervalSecs}
              onChange={(e) => setIntervalSecs(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
            />
          </div>
        </div>

        <ProposalFields
          description={description}
          onDescriptionChange={setDescription}
          deadlineDays={deadlineDays}
          onDeadlineDaysChange={setDeadlineDays}
        />

        {error && (
          <p className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{error}</p>
        )}

        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-300 hover:bg-zinc-700 transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-400"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="flex-1 rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-400"
          >
            {submitting ? "Submitting…" : "Propose Modify"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
