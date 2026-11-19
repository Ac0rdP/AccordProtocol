import { useEffect, useRef, useState } from "react";
import type { Proposal } from "../types/accord";

/** Announces newly observed governance changes without moving keyboard focus. */
export function LiveUpdatesAnnouncer({ proposals }: { proposals: Proposal[] }) {
  const previous = useRef<Map<number, Pick<Proposal, "approvals" | "status">>>(new Map());
  const seeded = useRef(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    const current = new Map(proposals.map((proposal) => [proposal.id, { approvals: proposal.approvals, status: proposal.status }]));
    if (!seeded.current) {
      previous.current = current;
      seeded.current = true;
      return;
    }

    const changes: string[] = [];
    for (const proposal of proposals) {
      const before = previous.current.get(proposal.id);
      if (!before) changes.push(`New proposal #${proposal.id}: ${proposal.description || proposal.kind}.`);
      else if (proposal.status === "executed" && before.status !== "executed") changes.push(`Proposal #${proposal.id} was executed.`);
      else if (proposal.approvals > before.approvals) changes.push(`Proposal #${proposal.id} received an approval.`);
    }
    previous.current = current;
    if (changes.length) {
      // Defer the DOM announcement until after React has committed this data update.
      queueMicrotask(() => {
        if (active) setMessage(changes.join(" "));
      });
    }
    return () => { active = false; };
  }, [proposals]);

  return <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{message}</div>;
}
