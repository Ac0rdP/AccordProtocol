export type ProposalStatus = "pending" | "ready" | "executed" | "expired" | "revoked";

export type Proposal = {
  id: number;
  to: string;
  amount: string;
  token: string;
  description: string;
  approvals: number;
  threshold: number;
  status: ProposalStatus;
  deadline: string;
  createdAt: string;
  proposer: string;
};

export type Owner = {
  address: string;
  label: string;
};

export type DashboardStat = {
  label: string;
  value: string;
  sub: string;
};
