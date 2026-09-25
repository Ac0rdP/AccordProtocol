export type ProposalStatus = "pending" | "ready" | "executed" | "expired" | "revoked";

export type ProposalCategory = "Transfer" | "Payroll" | "Grant" | "Ops" | "Other";

export type Role = "Owner" | "Viewer" | "Guardian" | "SpendingLimit";

export type ProposalKind =
  | "transfer"
  | "add_owner"
  | "remove_owner"
  | "change_threshold"
  | "set_spending_limit"
  | "change_owner_weight";

export type Proposal = {
  id: number;
  kind: ProposalKind;
  to: string;
  amount: string;
  token: string;
  description: string;
  approvals: number;
  threshold: number;
  status: ProposalStatus;
  deadline: string;
  deadlineTs: number;
  createdAt: string;
  proposer: string;
  userHasApproved: boolean;
  approverAddresses: string[];
};

export type Owner = {
  address: string;
  fullAddress: string;
  label: string;
  roles: Role[];
  weight?: number;
};

export type DashboardStat = {
  label: string;
  value: string;
  sub: string;
};
