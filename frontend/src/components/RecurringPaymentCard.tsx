import React, { useState, useEffect } from "react";
import type { RecurringSchedule, RecurringScheduleStatus } from "../types/accord";
import { formatInterval, shortenAddr, formatCountdown, stroopsToDisplay } from "../lib/soroban";
import { getClaimableAmount } from "../lib/contract";
import { useRecurringPayments } from "../hooks/useRecurringPayments";
import {
  PauseRecurringModal,
  ResumeRecurringModal,
  CancelRecurringModal,
  ModifyRecurringModal,
} from "./RecurringPaymentActionModals";

export type RecurringPaymentCardProps = {
  schedule: RecurringSchedule;
  walletAddress?: string | null;
  isDue?: boolean;
  onDisburse?: (id: number) => void;
  onPause?: (id: number) => void;
  onResume?: (id: number) => void;
  onCancel?: (id: number) => void;
  onModify?: (id: number) => void;
  onProposalSubmitted?: () => void;
};

const STATUS_BADGES: Record<RecurringScheduleStatus, { label: string; style: string }> = {
  active: {
    label: "Active",
    style: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  },
  paused: {
    label: "Paused",
    style: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  },
  completed: {
    label: "Completed",
    style: "bg-sky-500/10 text-sky-400 border-sky-500/20",
  },
  cancelled: {
    label: "Cancelled",
    style: "bg-rose-500/10 text-rose-400 border-rose-500/20",
  },
};

function CountdownTicker({ targetMs }: { targetMs: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const diff = targetMs - now;
  return (
    <span className={diff <= 0 ? "text-emerald-400" : "text-zinc-300"}>
      {formatCountdown(targetMs)}
    </span>
  );
}

function ProgressBar({ disbursed, cap }: { disbursed: string; cap: string }) {
  const parse = (v: string) => {
    const n = Number.parseFloat(v.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : 0;
  };
  const d = parse(disbursed);
  const c = parse(cap);
  const pct = c > 0 ? Math.min(100, (d / c) * 100) : 0;

  return (
    <div className="mt-2">
      <div className="flex justify-between text-xs text-zinc-500 mb-1">
        <span>Progress toward cap</span>
        <span className="text-zinc-300">{pct.toFixed(1)}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
        <div
          className="h-full rounded-full bg-emerald-500 transition-all duration-500"
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${pct.toFixed(1)}% of cap disbursed`}
        />
      </div>
      <div className="flex justify-between text-xs text-zinc-500 mt-1">
        <span>{disbursed} disbursed</span>
        <span>cap {cap}</span>
      </div>
    </div>
  );
}

function VestingProgressBar({
  scheduleId,
  disbursed,
  cap,
}: {
  scheduleId: number;
  disbursed: string;
  cap: string;
}) {
  const [claimable, setClaimable] = useState<string>("0");

  useEffect(() => {
    let cancelled = true;
    (async () => {
      try {
        const raw = await getClaimableAmount(scheduleId);
        if (!cancelled) setClaimable(stroopsToDisplay(raw));
      } catch {
        // silently ignore
      }
    })();
    return () => { cancelled = true; };
  }, [scheduleId]);

  const parse = (v: string) => {
    const n = Number.parseFloat(v.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : 0;
  };

  const claimed = parse(disbursed);
  const claimableNum = parse(claimable);
  const total = parse(cap);
  const unvested = Math.max(0, total - claimed - claimableNum);

  const claimedPct = total > 0 ? Math.min(100, (claimed / total) * 100) : 0;
  const claimablePct = total > 0 ? Math.min(100 - claimedPct, (claimableNum / total) * 100) : 0;
  const unvestedPct = Math.max(0, 100 - claimedPct - claimablePct);

  return (
    <div className="mt-2">
      <div className="flex justify-between text-xs text-zinc-500 mb-1">
        <span>Vesting progress</span>
        <span className="text-zinc-300">{(claimedPct + claimablePct).toFixed(1)}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden flex">
        {claimedPct > 0 && (
          <div
            className="h-full bg-emerald-500 transition-all duration-500"
            style={{ width: `${claimedPct}%` }}
            role="progressbar"
            aria-valuenow={claimedPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${claimedPct.toFixed(1)}% claimed`}
          />
        )}
        {claimablePct > 0 && (
          <div
            className="h-full bg-sky-500 transition-all duration-500"
            style={{ width: `${claimablePct}%` }}
            role="progressbar"
            aria-valuenow={claimablePct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${claimablePct.toFixed(1)}% claimable`}
          />
        )}
        {unvestedPct > 0 && (
          <div
            className="h-full bg-zinc-600 transition-all duration-500"
            style={{ width: `${unvestedPct}%` }}
            role="progressbar"
            aria-valuenow={unvestedPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${unvestedPct.toFixed(1)}% unvested`}
          />
        )}
      </div>
      <div className="flex justify-between text-xs text-zinc-500 mt-1 gap-2">
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
          {disbursed} claimed
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-sky-500" />
          {claimable} claimable
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-zinc-600" />
          {cap} total
        </span>
      </div>
    </div>
  );
}

type ActiveModal = "pause" | "resume" | "cancel" | "modify" | null;

export const RecurringPaymentCard = React.memo(function RecurringPaymentCard({
  schedule,
  walletAddress,
  isDue,
  onDisburse,
  onPause,
  onResume,
  onCancel,
  onModify,
  onProposalSubmitted,
}: RecurringPaymentCardProps) {
  const { disburse } = useRecurringPayments(walletAddress);
  const [activeModal, setActiveModal] = useState<ActiveModal>(null);
  const connected = !!walletAddress;

  const due =
    isDue !== undefined
      ? isDue
      : schedule.nextDisbursementTs !== undefined
      ? Date.now() >= schedule.nextDisbursementTs
      : true;

  const handleDisburse = () => {
    if (onDisburse) {
      onDisburse(schedule.id);
    } else {
      disburse(schedule.id);
    }
  };

  const handlePause = () => {
    if (onPause) {
      onPause(schedule.id);
    } else {
      setActiveModal("pause");
    }
  };

  const handleResume = () => {
    if (onResume) {
      onResume(schedule.id);
    } else {
      setActiveModal("resume");
    }
  };

  const handleCancel = () => {
    if (onCancel) {
      onCancel(schedule.id);
    } else {
      setActiveModal("cancel");
    }
  };

  const handleModify = () => {
    if (onModify) {
      onModify(schedule.id);
    } else {
      setActiveModal("modify");
    }
  };

  const handleModalSubmitted = () => {
    setActiveModal(null);
    onProposalSubmitted?.();
  };

  const badge = STATUS_BADGES[schedule.status] ?? {
    label: schedule.status,
    style: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
  };

  const cadenceText =
    schedule.cadence ??
    (schedule.interval !== undefined ? formatInterval(schedule.interval) : "—");

  const disburseTooltip = due
    ? undefined
    : schedule.nextDisbursementTs !== undefined
    ? `Next disbursement ${formatCountdown(schedule.nextDisbursementTs)}`
    : "Next disbursement not yet due";

  return (
    <div
      className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 transition-colors hover:border-zinc-700"
      aria-label={`Recurring payment schedule ${schedule.id}, ${badge.label}, ${schedule.amount} ${schedule.token ?? ""}`}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-xs text-zinc-500">Schedule #{schedule.id}</span>
            <span
              className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium uppercase tracking-wider ${badge.style}`}
              role="status"
              aria-label={`Status: ${badge.label}`}
            >
              {badge.label}
            </span>
          </div>
          <h3 className="text-base font-semibold text-white">
            {schedule.amount} {schedule.token ?? ""}
          </h3>
          <p className="font-mono text-sm text-zinc-400 mt-0.5">
            Recipient: {shortenAddr(schedule.recipient)}
          </p>
        </div>

        <div className="text-right text-xs text-zinc-500 space-y-1 shrink-0">
          <div>
            Cadence: <span className="text-zinc-300">{cadenceText}</span>
          </div>
          <div>
            Disbursed: <span className="text-zinc-300">{schedule.totalDisbursed}</span>
          </div>
          {schedule.nextDisbursementTs !== undefined && schedule.status === "active" && (
            <div>
              Next: <CountdownTicker targetMs={schedule.nextDisbursementTs} />
            </div>
          )}
        </div>
      </div>

      {/* Description */}
      {schedule.description && (
        <p className="text-xs text-zinc-500 mb-3 leading-relaxed">{schedule.description}</p>
      )}

      {/* Progress bar toward cap */}
      {schedule.cap && schedule.kind === "linear_vesting" && (
        <VestingProgressBar
          scheduleId={schedule.id}
          disbursed={schedule.totalDisbursed}
          cap={schedule.cap}
        />
      )}
      {schedule.cap && schedule.kind !== "linear_vesting" && (
        <ProgressBar disbursed={schedule.totalDisbursed} cap={schedule.cap} />
      )}

      {/* Footer: status label + action buttons */}
      <div className="flex items-center justify-between border-t border-zinc-800/60 pt-3 mt-3">
        <div className="text-xs text-zinc-500" aria-live="polite">
          {schedule.status === "active" &&
            (due ? (
              <span className="text-emerald-400">Payment is due</span>
            ) : (
              <span className="text-zinc-400">Next payment pending</span>
            ))}
        </div>

        <div className="flex items-center gap-2 flex-wrap justify-end">
          {schedule.status === "active" && (
            <>
              <div title={disburseTooltip}>
                <button
                  type="button"
                  onClick={handleDisburse}
                  disabled={!due}
                  aria-label={
                    due ? `Disburse schedule ${schedule.id} now` : "Next disbursement not yet due"
                  }
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-zinc-400"
                >
                  Disburse now
                </button>
              </div>

              {connected && (
                <>
                  <button
                    type="button"
                    onClick={handleModify}
                    aria-label="Modify schedule"
                    className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-medium text-sky-400 hover:bg-zinc-700 hover:text-sky-300 transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-400"
                  >
                    Modify
                  </button>
                  <button
                    type="button"
                    onClick={handlePause}
                    aria-label="Pause schedule"
                    className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-medium text-yellow-400 hover:bg-zinc-700 hover:text-yellow-300 transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-400"
                  >
                    Pause
                  </button>
                  <button
                    type="button"
                    onClick={handleCancel}
                    aria-label="Cancel schedule"
                    className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-medium text-rose-400 hover:bg-zinc-700 hover:text-rose-300 transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-400"
                  >
                    Cancel
                  </button>
                </>
              )}
            </>
          )}

          {schedule.status === "paused" && (
            <>
              <button
                type="button"
                onClick={handleResume}
                aria-label={`Resume schedule ${schedule.id}`}
                className="rounded-lg bg-yellow-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-yellow-500 transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-400"
              >
                Resume
              </button>
              {connected && (
                <button
                  type="button"
                  onClick={handleCancel}
                  aria-label={`Cancel schedule ${schedule.id}`}
                  className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-medium text-rose-400 hover:bg-zinc-700 hover:text-rose-300 transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-400"
                >
                  Cancel
                </button>
              )}
            </>
          )}

          {schedule.status === "completed" && (
            <span className="text-xs text-zinc-500 italic" role="status">
              Schedule completed
            </span>
          )}

          {schedule.status === "cancelled" && (
            <span className="text-xs text-zinc-500 italic" role="status">
              Schedule cancelled
            </span>
          )}
        </div>
      </div>

      {/* Governance-proposal modals */}
      {activeModal === "pause" && connected && (
        <PauseRecurringModal
          scheduleId={schedule.id}
          walletAddress={walletAddress!}
          onClose={() => setActiveModal(null)}
          onSubmitted={handleModalSubmitted}
        />
      )}
      {activeModal === "resume" && connected && (
        <ResumeRecurringModal
          scheduleId={schedule.id}
          walletAddress={walletAddress!}
          onClose={() => setActiveModal(null)}
          onSubmitted={handleModalSubmitted}
        />
      )}
      {activeModal === "cancel" && connected && (
        <CancelRecurringModal
          scheduleId={schedule.id}
          walletAddress={walletAddress!}
          onClose={() => setActiveModal(null)}
          onSubmitted={handleModalSubmitted}
        />
      )}
      {activeModal === "modify" && connected && (
        <ModifyRecurringModal
          scheduleId={schedule.id}
          walletAddress={walletAddress!}
          currentAmount={schedule.amount}
          currentInterval={schedule.interval}
          onClose={() => setActiveModal(null)}
          onSubmitted={handleModalSubmitted}
        />
      )}
    </div>
  );
});
