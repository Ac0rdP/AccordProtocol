import { useEffect, useState } from "react";
import type { Owner, Proposal } from "../types/accord";
import { OwnerAvailabilityCalendar } from "../components/OwnerAvailabilityCalendar";
import { PageState } from "../components/PageState";
import { useOwnerAvailability } from "../hooks/useOwnerAvailability";

type OwnerAvailabilityPageProps = {
  owners: Owner[];
  proposals: Proposal[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Injectable clock for tests; defaults to the current time, updated each minute. */
  now?: number;
};

/** Owner availability, approval rotation, and deadline coverage planning. */
export function OwnerAvailabilityPage({
  owners,
  proposals,
  loading = false,
  error = null,
  onRetry,
  now,
}: OwnerAvailabilityPageProps) {
  const availability = useOwnerAvailability();
  const [clock, setClock] = useState(() => Date.now());

  // Keep "available now" / "expires in" labels honest while the page is open.
  useEffect(() => {
    if (now !== undefined) return;
    const timer = setInterval(() => setClock(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [now]);

  let body;
  if (loading) {
    body = <PageState status="loading" title="Loading owner availability…" />;
  } else if (error) {
    body = (
      <PageState
        status="error"
        title="Could not load owner availability"
        description={error}
        onRetry={onRetry}
      />
    );
  } else if (availability.error) {
    body = (
      <div>
        <PageState
          status="error"
          title="Could not load owner availability"
          description={availability.error}
          onRetry={availability.retry}
        />
        <div className="flex justify-center pb-6">
          <button
            type="button"
            onClick={availability.reset}
            className="min-h-11 rounded-lg px-4 text-sm text-zinc-400 underline hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            Reset saved availability
          </button>
        </div>
      </div>
    );
  } else if (owners.length === 0) {
    body = (
      <PageState
        status="empty"
        title="No owners to schedule"
        description="Add owners to the multisig to plan availability and approval rotation."
      />
    );
  } else {
    body = (
      <OwnerAvailabilityCalendar
        owners={owners}
        proposals={proposals}
        availability={availability.availability}
        onSaveAvailability={availability.save}
        now={now ?? clock}
      />
    );
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-white">Owner availability</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          See when owners expect to be reachable, who is on approval rotation, and who can cover
          proposals that expire soon.
        </p>
      </header>
      {body}
    </div>
  );
}
