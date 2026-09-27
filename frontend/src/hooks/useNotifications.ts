import { useEffect, useRef, useState } from "react";
import type { Proposal } from "../types/accord";
import { getOwnerWeightChangeEvents } from "../lib/contract";

export function useNotifications(
  walletAddress: string | null,
  proposals: Proposal[]
) {
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const notifiedIds = useRef<Set<number>>(new Set());
  const notifiedWeightChanges = useRef<Set<string>>(new Set());
  const lastWalletAddress = useRef<string | null>(null);

  // Request/Check permission on mount
  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window) {
      if (Notification.permission === "default") {
        Notification.requestPermission().then((res) => {
          setPermission(res);
        });
      } else {
        setPermission(Notification.permission);
      }
    }
  }, []);

  // Clear notified IDs if the connected wallet address changes
  useEffect(() => {
    if (walletAddress !== lastWalletAddress.current) {
      notifiedIds.current.clear();
      notifiedWeightChanges.current.clear();
      lastWalletAddress.current = walletAddress;
    }
  }, [walletAddress]);

  // Monitor proposals and notify if new pending ones appear
  useEffect(() => {
    if (!walletAddress || permission !== "granted" || proposals.length === 0) {
      return;
    }

    const pendingProposals = proposals.filter((p) => p.status === "pending");
    if (pendingProposals.length === 0) {
      return;
    }

    // Check if there are any new pending proposals that haven't been notified yet
    const newPendingProposals = pendingProposals.filter(
      (p) => !notifiedIds.current.has(p.id)
    );

    if (newPendingProposals.length > 0) {
      // Add all current pending proposal IDs to the notified set to avoid duplicates
      pendingProposals.forEach((p) => notifiedIds.current.add(p.id));

      const title = "Pending Approval";
      const body = `You have ${pendingProposals.length} proposal${
        pendingProposals.length === 1 ? "" : "s"
      } waiting for approval.`;

      try {
        new Notification(title, { body });
      } catch (err) {
        console.error("Failed to trigger notification", err);
      }
    }
  }, [proposals, walletAddress, permission]);

  // Notify the connected owner when their own voting weight is changed by an
  // executed governance proposal. Other owners' changes are ignored, and each
  // change is only announced once.
  useEffect(() => {
    if (!walletAddress || permission !== "granted") {
      return;
    }

    let cancelled = false;
    getOwnerWeightChangeEvents(10)
      .then((events) => {
        if (cancelled) return;

        const mine = events.filter((e) => e.owner === walletAddress);
        for (const change of mine) {
          const key = `${change.owner}|${change.oldWeight}|${change.newWeight}|${
            change.ledger ?? ""
          }`;
          if (notifiedWeightChanges.current.has(key)) continue;
          notifiedWeightChanges.current.add(key);

          try {
            new Notification("Voting Weight Updated", {
              body: `Your voting weight changed from ${change.oldWeight} to ${change.newWeight}.`,
            });
          } catch (err) {
            console.error("Failed to trigger notification", err);
          }
        }
      })
      .catch(() => {
        /* ignore — nothing to notify if events can't be read */
      });

    return () => {
      cancelled = true;
    };
  }, [proposals, walletAddress, permission]);
}
