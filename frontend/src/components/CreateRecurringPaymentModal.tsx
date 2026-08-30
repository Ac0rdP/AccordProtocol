import { useEffect, useMemo, useRef, useState } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { createRecurringPaymentProposal } from "../lib/submit";
import { displayToStroops, formatInterval } from "../lib/soroban";
import type { ProposalCategory } from "../types/accord";

const TOKEN_ADDRESSES: Record<string, string> = {
  XLM: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  USDC: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  EURC: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC",
};

const CATEGORY_OPTIONS: ProposalCategory[] = ["Payroll", "Grant", "Ops", "Transfer", "Other"];

const FOCUSABLE_SELECTORS =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
type RecurringKind = "FixedAmountPerPeriod" | "LinearVesting";

type Props = {
  walletAddress: string | null;
  onClose: () => void;
  onSubmitted: () => void;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
};

function truncateAddress(address: string | null) {
  if (!address) return "Not connected";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function toUnixSeconds(dateValue: string): bigint | null {
  const ts = new Date(dateValue).getTime();
  if (Number.isNaN(ts)) return null;
  return BigInt(Math.floor(ts / 1000));
}

export function CreateRecurringPaymentModal({ walletAddress, onClose, onSubmitted, triggerRef }: Props) {
// ─── Live Schedule Preview ────────────────────────────────────────────────────

type PreviewProps = {
  kind: RecurringKind;
  amount: string;
  intervalSecs: number;
  startDate: string;
  endDate: string;
  cap: string;
};

function SchedulePreview({ kind, amount, intervalSecs, startDate, endDate, cap }: PreviewProps) {
  const preview = useMemo(() => {
    const amountNum = Number.parseFloat(amount);
    if (Number.isNaN(amountNum) || amountNum <= 0) return null;
    if (intervalSecs <= 0) return null;

    const startMs = new Date(startDate).getTime();
    if (Number.isNaN(startMs)) return null;

    const endMs = endDate ? new Date(endDate).getTime() : null;
    const capNum = cap ? Number.parseFloat(cap) : null;

    let lifetimeTotal: number | null = null;
    let periodsCount: number | null = null;
    let projectedEndDate: string | null = null;
    let perPeriod: number | null = null;

    if (kind === "FixedAmountPerPeriod") {
      perPeriod = amountNum;

      if (capNum !== null && capNum >= amountNum) {
        periodsCount = Math.floor(capNum / amountNum);
        lifetimeTotal = periodsCount * amountNum;
        if (!endMs) {
          const projMs = startMs + periodsCount * intervalSecs * 1000;
          projectedEndDate = new Date(projMs).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          });
        }
      } else if (endMs !== null && endMs > startMs) {
        const durationSecs = (endMs - startMs) / 1000;
        periodsCount = Math.floor(durationSecs / intervalSecs);
        lifetimeTotal = periodsCount * amountNum;
      }
    } else {
      // LinearVesting: amount is total cap; per-period = cap / periods
      if (endMs !== null && endMs > startMs) {
        const durationSecs = (endMs - startMs) / 1000;
        periodsCount = Math.floor(durationSecs / intervalSecs);
        lifetimeTotal = capNum ?? amountNum;
        perPeriod = periodsCount > 0 ? lifetimeTotal / periodsCount : lifetimeTotal;
      } else if (capNum !== null) {
        lifetimeTotal = capNum;
        perPeriod = null; // can't compute without end date
      }
    }

    return { lifetimeTotal, periodsCount, projectedEndDate, perPeriod };
  }, [kind, amount, intervalSecs, startDate, endDate, cap]);

  if (!preview) return null;

  const { lifetimeTotal, periodsCount, projectedEndDate, perPeriod } = preview;

  return (
    <div className="rounded-lg border border-zinc-700/50 bg-zinc-800/40 px-4 py-3 space-y-2">
      <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
        Schedule preview
      </p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        {perPeriod !== null && (
          <>
            <span className="text-zinc-500">Per period</span>
            <span className="text-zinc-200 font-mono text-right">
              {perPeriod.toFixed(2)}
            </span>
          </>
        )}
        {periodsCount !== null && (
          <>
            <span className="text-zinc-500">Total periods</span>
            <span className="text-zinc-200 font-mono text-right">{periodsCount}</span>
          </>
        )}
        {lifetimeTotal !== null && (
          <>
            <span className="text-zinc-500">Lifetime total</span>
            <span className="text-emerald-400 font-mono text-right font-medium">
              {lifetimeTotal.toFixed(2)}
            </span>
          </>
        )}
        {projectedEndDate && (
          <>
            <span className="text-zinc-500">Projected end</span>
            <span className="text-zinc-200 text-right">{projectedEndDate}</span>
          </>
        )}
        {intervalSecs > 0 && (
          <>
            <span className="text-zinc-500">Cadence</span>
            <span className="text-zinc-200 text-right">{formatInterval(intervalSecs)}</span>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────

export function CreateRecurringPaymentModal({ walletAddress, onClose, onSubmitted }: Props) {
  const [kind, setKind] = useState<RecurringKind>("FixedAmountPerPeriod");
  const [recipient, setRecipient] = useState("");
  const [recipientTouched, setRecipientTouched] = useState(false);
  const [amount, setAmount] = useState("");
  const [token, setToken] = useState("USDC");
  const [interval, setInterval] = useState("2592000");
  const [start, setStart] = useState(() => new Date().toISOString().slice(0, 10));
  const [cliff, setCliff] = useState("");
  const [end, setEnd] = useState("");
  const [cap, setCap] = useState("");
  const [category, setCategory] = useState<ProposalCategory>("Payroll");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const modalRef = useRef<HTMLDivElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);

  // Focus trap + initial focus + restore on unmount
  useEffect(() => {
    const previousActiveElement = document.activeElement as HTMLElement | null;
    const currentTrigger = triggerRef?.current;
    if (firstInputRef.current) {
      firstInputRef.current.focus();
    }

    const modal = modalRef.current;
    if (!modal) return;

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

      if (focusable.length === 0) { e.preventDefault(); return; }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
      if (e.key === "Escape") onClose();
    };

    modal.addEventListener("keydown", handleKeyDown);

    return () => {
      modal.removeEventListener("keydown", handleKeyDown);
      if (currentTrigger && typeof currentTrigger.focus === "function") {
        currentTrigger.focus();
      } else if (previousActiveElement && typeof previousActiveElement.focus === "function") {
        previousActiveElement.focus();
      }
    };
  }, [onClose, triggerRef]);

  const intervalSecs = Number.parseInt(interval, 10);
  const intervalSecsValid = Number.isFinite(intervalSecs) && intervalSecs >= 1;

  async function handleSubmit() {
    if (!walletAddress) {
      setError("Connect your wallet first.");
      return;
    }
    if (!recipient.trim() || !amount.trim() || !interval.trim() || !start.trim()) {
      setError("Recipient, amount, interval, and start date are required.");
      return;
    }
    if (!StrKey.isValidEd25519PublicKey(recipient.trim())) {
      setError("Enter a valid Stellar address.");
      return;
    }

    const amountNum = Number.parseFloat(amount);
    const amountStroops = displayToStroops(amountNum);
    if (Number.isNaN(amountNum) || amountStroops < 1n) {
      setError("Enter an amount above the minimum.");
      return;
    }

    if (!Number.isFinite(intervalSecs) || intervalSecs < 1 || intervalSecs > 31_536_000) {
      setError("Interval must be between 1 and 31,536,000 seconds.");
      return;
    }

    const startTs = toUnixSeconds(start);
    if (startTs === null) {
      setError("Enter a valid start date.");
      return;
    }

    const cliffTs = cliff.trim() ? toUnixSeconds(cliff) : null;
    const endTs = end.trim() ? toUnixSeconds(end) : null;
    if (endTs !== null && endTs <= startTs) {
      setError("End must be after start.");
      return;
    }
    if (cliffTs !== null && endTs !== null && cliffTs > endTs) {
      setError("Cliff must be on or before end.");
      return;
    }

    const capTrimmed = cap.trim();
    const capNum = capTrimmed ? Number.parseFloat(capTrimmed) : null;
    const capStroops = capNum === null ? null : displayToStroops(capNum);
    if (capTrimmed && (capNum === null || Number.isNaN(capNum) || capStroops === null || capStroops < amountStroops)) {
      setError("Cap must be at least the amount.");
      return;
    }

    // For LinearVesting end date is required
    if (kind === "LinearVesting" && !end.trim()) {
      setError("End date is required for linear vesting.");
      return;
    }

    const tokenAddr = TOKEN_ADDRESSES[token];
    if (!tokenAddr) {
      setError("Unknown token.");
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      await createRecurringPaymentProposal(
        walletAddress,
        recipient.trim(),
        tokenAddr,
        amountStroops,
        BigInt(intervalSecs),
        startTs,
        cliffTs,
        endTs,
        capStroops,
        category,
        kind
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
    <>
      <div
        aria-hidden="true"
        className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50"
      />
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="recurring-modal-title"
        className="fixed inset-0 flex items-center justify-center z-50 p-4"
      >
        <div className="bg-zinc-900 border border-zinc-700 rounded-2xl p-6 w-full max-w-lg">
          <div className="flex items-center justify-between mb-6">
          <h2 id="recurring-modal-title" className="text-white font-semibold text-lg">Create Recurring Payment</h2>
    <div
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4"
    >
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-white font-semibold text-lg">Create Recurring Payment</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="text-zinc-500 hover:text-zinc-300 text-xl focus:ring-2 focus:ring-zinc-400 focus:outline-none rounded-md"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4">
          {/* ── Mode toggle ── */}
          <div>
            <label className="text-xs text-zinc-400 block mb-1.5">Payment mode</label>
            <div className="grid grid-cols-2 gap-1 rounded-lg border border-zinc-700 bg-zinc-800/60 p-1">
              {(["FixedAmountPerPeriod", "LinearVesting"] as const).map((m) => {
                const active = kind === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setKind(m)}
                    aria-pressed={active}
                    className={`rounded-md px-3 py-2 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-400 ${
                      active
                        ? "bg-zinc-700 text-white shadow-sm"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    {m === "FixedAmountPerPeriod" ? "Fixed" : "Linear Vesting"}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-zinc-500 mt-1.5">
              {kind === "FixedAmountPerPeriod"
                ? "Same amount disbursed each period."
                : "Total cap distributed linearly across the schedule duration."}
            </p>
          </div>

          {/* ── Proposer ── */}
          <div>
            <label className="text-xs text-zinc-400 block mb-1.5">Proposer</label>
            <div
              className={`w-full border rounded-lg px-3 py-2.5 text-sm truncate ${
                walletAddress
                  ? "bg-zinc-800/60 border-zinc-700/60 text-zinc-300 font-mono"
                  : "bg-zinc-800/30 border-zinc-700/30 text-zinc-500"
              }`}
            >
              {truncateAddress(walletAddress)}
            </div>
          </div>

           <div>
            <label htmlFor="recurring-recipient" className="text-xs text-zinc-400 block mb-1.5">Recipient Address</label>
          {/* ── Recipient ── */}
          <div>
            <label className="text-xs text-zinc-400 block mb-1.5">Recipient Address</label>
            <input
              id="recurring-recipient"
              ref={firstInputRef}
              value={recipient}
              onChange={(e) => { setRecipient(e.target.value); setRecipientTouched(true); }}
              onBlur={() => setRecipientTouched(true)}
              placeholder="G..."
              aria-label="Recipient Stellar address"
              aria-invalid={recipientTouched && !StrKey.isValidEd25519PublicKey(recipient.trim())}
              aria-describedby={recipientTouched && !StrKey.isValidEd25519PublicKey(recipient.trim()) ? "recurring-recipient-error" : undefined}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm font-mono placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
            />
            {recipientTouched && !StrKey.isValidEd25519PublicKey(recipient.trim()) && (
              <p id="recurring-recipient-error" className="text-xs text-red-400 mt-1" role="alert">Enter a valid Stellar address.</p>
            )}
          </div>

          {/* ── Amount + Token ── */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="recurring-amount" className="text-xs text-zinc-400 block mb-1.5">Amount</label>
              <label className="text-xs text-zinc-400 block mb-1.5">
                {kind === "LinearVesting" ? "Total cap (vesting amount)" : "Amount per period"}
              </label>
              <input
                id="recurring-amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                type="number"
                min="0"
                step="any"
                aria-label="Payment amount"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
              />
            </div>
            <div>
              <label className="text-xs text-zinc-400 block mb-1.5">Token</label>
              <div className="grid grid-cols-3 gap-1" role="group" aria-label="Select token">
                {(["XLM", "USDC", "EURC"] as const).map((symbol) => {
                  const active = token === symbol;
                  return (
                    <button
                      key={symbol}
                      type="button"
                      onClick={() => setToken(symbol)}
                      aria-pressed={active}
                      aria-label={`Select ${symbol} token`}
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

          {/* ── Interval + Category ── */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="recurring-interval" className="text-xs text-zinc-400 block mb-1.5">Interval (seconds)</label>
              <input
                id="recurring-interval"
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
                placeholder="2592000"
                type="number"
                min="1"
                aria-label="Payment interval in seconds"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
              />
              {intervalSecsValid && (
                <p className="text-xs text-zinc-500 mt-1">{formatInterval(intervalSecs)}</p>
              )}
            </div>
            <div>
              <label htmlFor="recurring-category" className="text-xs text-zinc-400 block mb-1.5">Category</label>
              <select
                id="recurring-category"
                value={category}
                onChange={(e) => setCategory(e.target.value as ProposalCategory)}
                aria-label="Payment category"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
              >
                {CATEGORY_OPTIONS.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </div>
          </div>

          {/* ── Dates ── */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="recurring-start" className="text-xs text-zinc-400 block mb-1.5">Start</label>
              <input
                id="recurring-start"
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                aria-label="Payment start date"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
              />
            </div>
            <div>
              <label htmlFor="recurring-cliff" className="text-xs text-zinc-400 block mb-1.5">Cliff</label>
              <input
                id="recurring-cliff"
                type="date"
                value={cliff}
                onChange={(e) => setCliff(e.target.value)}
                aria-label="Payment cliff date"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
              />
            </div>
            <div>
              <label htmlFor="recurring-end" className="text-xs text-zinc-400 block mb-1.5">End</label>
              <label className="text-xs text-zinc-400 block mb-1.5">
                End{kind === "LinearVesting" && <span className="text-red-400 ml-0.5">*</span>}
              </label>
              <input
                id="recurring-end"
                type="date"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                aria-label="Payment end date"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
              />
            </div>
          </div>

          <div>
            <label htmlFor="recurring-cap" className="text-xs text-zinc-400 block mb-1.5">Cap</label>
            <input
              id="recurring-cap"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              placeholder="Optional total cap"
              type="number"
              min="0"
              step="any"
              aria-label="Optional payment cap"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
            />
          </div>

          {error && (
            <p className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2" role="alert">
              {error}
            </p>
          {/* ── Cap (hidden for LinearVesting — amount IS the cap) ── */}
          {kind === "FixedAmountPerPeriod" && (
            <div>
              <label className="text-xs text-zinc-400 block mb-1.5">Cap (optional total)</label>
              <input
                value={cap}
                onChange={(e) => setCap(e.target.value)}
                placeholder="Optional total cap"
                type="number"
                min="0"
                step="any"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
              />
            </div>
          )}

          {/* ── Live preview ── */}
          <SchedulePreview
            kind={kind}
            amount={amount}
            intervalSecs={intervalSecsValid ? intervalSecs : 0}
            startDate={start}
            endDate={end}
            cap={kind === "LinearVesting" ? amount : cap}
          />

          {error && (
            <p className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{error}</p>
          )}

          <div className="pt-2">
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || !walletAddress}
              title={
                walletAddress ? undefined : "Connect your Freighter wallet to submit"
              }
              aria-label={submitting ? "Submitting recurring payment" : "Create Recurring Payment"}
              title={walletAddress ? undefined : "Connect your Freighter wallet to submit"}
              className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white py-2.5 rounded-lg font-medium transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none"
            >
              {submitting ? "Submitting…" : "Create Recurring Payment"}
            </button>
          </div>
        </div>
      </div>
      </div>
    </>
  );
}
