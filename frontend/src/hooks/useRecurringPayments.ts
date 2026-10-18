import { useState, useCallback, useEffect, useRef } from "react";
import type { RecurringSchedule } from "../types/accord";
import { getRecurringPaymentsPaged, getLatestLedger, getContractEvents } from "../lib/contract";
import { disburseRecurringPayment, createCancelRecurringProposal } from "../lib/submit";

// Backoff config: start at 1 s, double each failure, cap at 30 s.
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const PAGE_SIZE = 20;

/**
 * Fetches and watches recurring-payment schedules, using the same
 * ledger-event polling pattern as useEventPolling but with an
 * exponential backoff (1 s → 2 s → 4 s … capped at 30 s) on RPC failure.
 *
 * The hook also exposes `disburse`, `cancel`, and a `refresh` imperative
 * that callers can invoke after submitting a governance proposal.
 */
export function useRecurringPayments(walletAddress?: string | null) {
  const [schedules, setSchedules] = useState<RecurringSchedule[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // --- polling state (held in refs to avoid stale-closure issues) ----------
  const lastSeenLedger = useRef<number | null>(null);
  const backoffMs = useRef<number>(BACKOFF_INITIAL_MS);
  const timeoutId = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);

  // -------------------------------------------------------------------------

  const fetchSchedules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetch first page — contract caps at 20 per page.
      const page = await getRecurringPaymentsPaged(0, PAGE_SIZE);
      if (!cancelled.current) {
        setSchedules(page);
      }
    } catch (err) {
      if (!cancelled.current) {
        setError(err instanceof Error ? err.message : "Failed to load schedules");
      }
      throw err; // re-throw so the polling loop can apply backoff
    } finally {
      if (!cancelled.current) {
        setLoading(false);
      }
    }
  }, []);

  /**
   * Public refresh — resets backoff and immediately re-fetches.
   */
  const refresh = useCallback(async () => {
    backoffMs.current = BACKOFF_INITIAL_MS;
    try {
      await fetchSchedules();
    } catch {
      // swallow — error is already set in state
    }
  }, [fetchSchedules]);

  // ── Polling loop ──────────────────────────────────────────────────────────

  useEffect(() => {
    cancelled.current = false;

    // 1. Snapshot the current ledger so we can detect new events.
    async function init() {
      try {
        const ledger = await getLatestLedger();
        if (!cancelled.current) {
          lastSeenLedger.current = ledger;
        }
      } catch (err) {
        console.error("[useRecurringPayments] Failed to initialise ledger checkpoint", err);
      }
    }

    // 2. Single poll tick — checks for new contract events and refreshes if
    //    any are found.  On success the backoff is reset to the initial value;
    //    on failure it is doubled (capped at BACKOFF_MAX_MS) and the next tick
    //    is scheduled at the new interval.
    async function poll() {
      if (cancelled.current) return;

      if (lastSeenLedger.current === null) {
        // Ledger not yet initialised — retry after the base interval.
        scheduleNext(BACKOFF_INITIAL_MS);
        return;
      }

      try {
        const latest = await getContractEvents(lastSeenLedger.current);

        if (latest > lastSeenLedger.current && !cancelled.current) {
          await fetchSchedules();
          lastSeenLedger.current = latest;
        }

        // Success: reset backoff.
        backoffMs.current = BACKOFF_INITIAL_MS;
      } catch (err) {
        console.error("[useRecurringPayments] Polling error", err);
        // Failure: double the interval, capped at max.
        backoffMs.current = Math.min(backoffMs.current * 2, BACKOFF_MAX_MS);
      }

      scheduleNext(backoffMs.current);
    }

    function scheduleNext(delayMs: number) {
      if (cancelled.current) return;
      timeoutId.current = setTimeout(poll, delayMs);
    }

    // Kick off: initial data load + ledger snapshot, then begin polling.
    init();
    fetchSchedules().catch(() => {
      // Ignore initial load errors; error state is already set.
    });
    scheduleNext(BACKOFF_INITIAL_MS);

    return () => {
      cancelled.current = true;
      if (timeoutId.current !== null) {
        clearTimeout(timeoutId.current);
        timeoutId.current = null;
      }
    };
  }, [fetchSchedules]);

  // ── Action helpers ────────────────────────────────────────────────────────

  const disburse = useCallback(
    async (scheduleId: number) => {
      if (!walletAddress) throw new Error("Wallet not connected");
      await disburseRecurringPayment(walletAddress, scheduleId);
      await refresh();
    },
    [walletAddress, refresh]
  );

  /**
   * Cancel via a governance proposal.  The deadline defaults to 7 days from now.
   */
  const cancel = useCallback(
    async (scheduleId: number, description = "", deadlineDays = 7) => {
      if (!walletAddress) throw new Error("Wallet not connected");
      const deadlineTs = BigInt(Math.floor(Date.now() / 1000) + deadlineDays * 86_400);
      await createCancelRecurringProposal(walletAddress, scheduleId, description, deadlineTs);
      await refresh();
    },
    [walletAddress, refresh]
  );

  // pause and resume are governance-proposal operations; the contract entry
  // points are `create_recurring_proposal` variants.  Placeholder hooks
  // expose the same signature so callers can wire them to a modal later.
  const pause = useCallback(
    async (_scheduleId: number) => {
      // Implemented by the governance-modal layer (Issue #484).
    },
    []
  );

  const resume = useCallback(
    async (_scheduleId: number) => {
      // Implemented by the governance-modal layer (Issue #484).
    },
    []
  );

  return {
    schedules,
    loading,
    error,
    setSchedules,
    refresh,
    disburse,
    pause,
    resume,
    cancel,
  };
}
