import { useEffect, useRef, useState } from "react";
import type { Proposal } from "../types/accord";
import { getOwnerWeightChangeEvents } from "../lib/contract";
import { addNotification } from "../lib/notificationCenter";
import { isNotificationEnabled, type NotificationEventType } from "../lib/notificationPreferences";
import {
  enqueueDigestItem,
  getDeliveryMode,
  getNotificationSchedule,
  summarizeDigest,
  takeDueDigest,
} from "../lib/notificationSchedule";

/** How often queued quiet-hours / digest alerts are checked for delivery. */
const DIGEST_CHECK_INTERVAL_MS = 60_000;

function raiseBrowserNotification(permission: NotificationPermission, title: string, body: string) {
  if (permission !== "granted") return;
  try {
    new Notification(title, { body });
  } catch (err) {
    console.error("Failed to trigger notification", err);
  }
}

/**
 * Logs to the in-app notification center (if that event type is enabled) and
 * raises a browser notification — immediately, or later when the user's
 * notification schedule holds it for quiet hours or batches it into a digest.
 */
function notify(
  type: NotificationEventType,
  title: string,
  body: string,
  permission: NotificationPermission
) {
  if (!isNotificationEnabled(type)) return;
  addNotification({ type, title, body });
  if (permission !== "granted") return;

  const mode = getDeliveryMode(getNotificationSchedule(), new Date());
  if (mode === "immediate") {
    raiseBrowserNotification(permission, title, body);
  } else {
    enqueueDigestItem({ type, title, body, reason: mode });
  }
}

function initialPermission(): NotificationPermission {
  return typeof window !== "undefined" && "Notification" in window
    ? Notification.permission
    : "default";
}

export function useNotifications(
  walletAddress: string | null,
  proposals: Proposal[]
) {
  const [permission, setPermission] = useState<NotificationPermission>(initialPermission);
  const notifiedIds = useRef<Set<number>>(new Set());
  const notifiedWeightChanges = useRef<Set<string>>(new Set());
  const prevProposalState = useRef<Map<number, { status: Proposal["status"]; approvals: number }>>(new Map());
  const lastWalletAddress = useRef<string | null>(null);

  // Request permission on mount when the user has not decided yet
  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      "Notification" in window &&
      Notification.permission === "default"
    ) {
      Notification.requestPermission().then((res) => {
        setPermission(res);
      });
    }
  }, []);

  // Release alerts held for quiet hours, and send digests when they fall due.
  useEffect(() => {
    if (permission !== "granted") return;
    function deliverDue() {
      const due = takeDueDigest(getNotificationSchedule(), new Date());
      if (!due) return;
      if (due.length === 1) {
        raiseBrowserNotification(permission, due[0].title, due[0].body);
      } else {
        const summary = summarizeDigest(due);
        raiseBrowserNotification(permission, summary.title, summary.body);
      }
    }
    deliverDue();
    const timer = setInterval(deliverDue, DIGEST_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [permission]);

  // Clear notified IDs if the connected wallet address changes
  useEffect(() => {
    if (walletAddress !== lastWalletAddress.current) {
      notifiedIds.current.clear();
      notifiedWeightChanges.current.clear();
      prevProposalState.current.clear();
      lastWalletAddress.current = walletAddress;
    }
  }, [walletAddress]);

  // Monitor proposals and notify if new pending ones appear
  useEffect(() => {
    if (!walletAddress || proposals.length === 0) {
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

      notify("proposal_created", title, body, permission);
    }
  }, [proposals, walletAddress, permission]);

  // Diff proposal status/approval counts across renders to notify on approval,
  // ready-to-execute, and executed transitions. The first time a proposal is
  // seen it only seeds `prevProposalState`, so loading an already-settled
  // proposal never fires a stale "just happened" notification.
  useEffect(() => {
    if (!walletAddress || proposals.length === 0) return;
    const previous = prevProposalState.current;

    for (const proposal of proposals) {
      const before = previous.get(proposal.id);
      previous.set(proposal.id, { status: proposal.status, approvals: proposal.approvals });
      if (!before) continue;

      if (proposal.approvals > before.approvals) {
        notify(
          "proposal_approved",
          "Proposal Approved",
          `Proposal #${proposal.id} received a new approval (${proposal.approvals}/${proposal.threshold}).`,
          permission
        );
      }

      if (before.status !== "ready" && proposal.status === "ready") {
        notify(
          "proposal_ready",
          "Proposal Ready",
          `Proposal #${proposal.id} has reached quorum and is ready to execute.`,
          permission
        );
      }

      if (before.status !== "executed" && proposal.status === "executed") {
        notify(
          "proposal_executed",
          "Proposal Executed",
          `Proposal #${proposal.id} has been executed.`,
          permission
        );
      }
    }
  }, [proposals, walletAddress, permission]);

  // Notify the connected owner when their own voting weight is changed by an
  // executed governance proposal. Other owners' changes are ignored, and each
  // change is only announced once.
  useEffect(() => {
    if (!walletAddress) {
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

          notify(
            "owner_weight_changed",
            "Voting Weight Updated",
            `Your voting weight changed from ${change.oldWeight} to ${change.newWeight}.`,
            permission
          );
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
