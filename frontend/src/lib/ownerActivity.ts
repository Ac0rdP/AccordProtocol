import type { Proposal } from "../types/accord";
import { shortenAddr } from "./soroban";

export type OwnerActivitySummary = {
  ownerAddress: string;
  createdProposals: Proposal[];
  approvedProposals: Proposal[];
  createdCount: number;
  approvedCount: number;
  totalCount: number;
  hasActivity: boolean;
};

/**
 * Checks whether two addresses match, handling full Stellar public keys,
 * case insensitivity, or shortened representations (e.g. GDHU6W…QDNC).
 */
export function addressesMatch(addr1?: string | null, addr2?: string | null): boolean {
  if (!addr1 || !addr2) return false;
  const a = addr1.trim().toUpperCase();
  const b = addr2.trim().toUpperCase();
  if (a === b) return true;

  // Compare shortened forms
  const shortA = shortenAddr(a).toUpperCase();
  const shortB = shortenAddr(b).toUpperCase();
  if (shortA === shortB) return true;

  // Check if one is a shortened version of the other
  if (b.includes("…") || b.includes("...")) {
    const cleanB = b.replace("…", "...").replace(/\s+/g, "");
    const [start, end] = cleanB.split("...");
    if (start && end && a.startsWith(start) && a.endsWith(end)) return true;
  }
  if (a.includes("…") || a.includes("...")) {
    const cleanA = a.replace("…", "...").replace(/\s+/g, "");
    const [start, end] = cleanA.split("...");
    if (start && end && b.startsWith(start) && b.endsWith(end)) return true;
  }

  return false;
}

/**
 * Aggregates all proposals created by and approved by a specific multisig owner.
 */
export function aggregateOwnerActivity(
  ownerAddress: string,
  proposals: Proposal[],
): OwnerActivitySummary {
  const createdProposals: Proposal[] = [];
  const approvedProposals: Proposal[] = [];

  for (const proposal of proposals) {
    // Check if owner created proposal
    if (addressesMatch(ownerAddress, proposal.proposer)) {
      createdProposals.push(proposal);
    }

    // Check if owner approved proposal
    const approvers = proposal.approverAddresses ?? [];
    if (approvers.some((approver) => addressesMatch(ownerAddress, approver))) {
      approvedProposals.push(proposal);
    }
  }

  const createdCount = createdProposals.length;
  const approvedCount = approvedProposals.length;
  const totalCount = createdCount + approvedCount;

  return {
    ownerAddress,
    createdProposals,
    approvedProposals,
    createdCount,
    approvedCount,
    totalCount,
    hasActivity: totalCount > 0,
  };
}
