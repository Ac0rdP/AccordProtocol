export type ProposalStatus =
  | "pending"
  | "ready"
  | "executed"
  | "expired"
  | "revoked"
  | "cancelled";

/** UI-facing proposal model. Mirrors `frontend/src/types/accord.ts`. */
export interface Proposal {
  id: number;
  kind: string;
  to: string;
  amount: string;
  token: string;
  description: string;
  approvals: number;
  approvalWeight: number;
  quorumWeight: number;
  threshold: number;
  status: ProposalStatus;
  /** Unix timestamp in seconds (0 when the contract returns no deadline). */
  deadlineTs: number;
  proposer: string;
  userHasApproved: boolean;
}

export interface ApprovalState {
  approvalWeight: number;
  quorumWeight: number;
  totalWeight: number;
}

export interface WalletSession {
  address: string;
  connectedAt: number;
}

/** A transaction prepared for external signing via a Stellar wallet deep link. */
export interface PreparedApproval {
  proposalId: number;
  /** Base64 XDR of the assembled (unsigned) transaction. */
  xdr: string;
  /** Hex hash of the exact transaction the wallet must sign. */
  hash: string;
  sourceAccount: string;
  contractId: string;
}
