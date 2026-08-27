export type ProposalStatus = "pending" | "ready" | "executed" | "expired" | "revoked";

export type ProposalCategory = "Transfer" | "Payroll" | "Grant" | "Ops" | "Other";

export type ProposalKind =
  | "transfer"
  | "add_owner"
  | "remove_owner"
  | "change_threshold"
  | "set_spending_limit"
  | "change_owner_weight"
  | "recurring";

export type Proposal = {
  id: number;
  kind: ProposalKind;
  to: string;
  amount: string;
  token: string;
  description: string;
  approvals: number;
  threshold: number;
  quorumWeight?: number;
  approvalWeight?: number;
  totalWeight?: number;
  status: ProposalStatus;
  deadline: string;
  deadlineTs: number;
  createdAt: string;
  proposer: string;
  userHasApproved: boolean;
  approverAddresses: string[];
  executedAt?: string | null;
};

export type Owner = {
  address: string;
  label: string;
  weight?: number;
};

export type OwnerWeight = {
  address: string;
  weight: number;
};

export type DashboardStat = {
  label: string;
  value: string;
  sub: string;
};

export type ProposalEventType =
  | "approved"
  | "revoked"
  | "executed"
  | "owner_weight_changed"
  | "recurring_payment_created"
  | "recurring_payment_disbursed"
  | "recurring_payment_paused"
  | "recurring_payment_cancelled"
  | (string & {});

export type ProposalEvent = {
  type: ProposalEventType;
  actor: string;
  timestamp: string;
  ledger?: number;
  scheduleId?: number | string;
  amount?: string;
  token?: string;
  recipient?: string;
  details?: string;
};

export type RecurringStatus = "active" | "paused" | "completed" | "cancelled";

export type RecurringKind = "fixed_amount_per_period" | "linear_vesting";

export type RecurringPayment = {
  id: number;
  proposer: string;
  recipient: string;
  token: string;
  amount: string;
  intervalSecs: number;
  startTime: number;
  endTime?: number;
  cliffTime?: number;
  totalCap?: string;
  totalDisbursed: string;
  lastDisbursedAt: number;
  status: RecurringStatus;
  kind: RecurringKind;
  category: ProposalCategory;
  description: string;
};

export type RecurringScheduleStatus = "active" | "paused" | "completed" | "cancelled";

export type RecurringSchedule = {
  id: number;
  recipient: string;
  amount: string;
  token?: string;
  cadence?: string;
  interval?: number;
  totalDisbursed: string;
  status: RecurringScheduleStatus;
  kind?: RecurringKind;
  cliff?: number | string;
  endDate?: number | string;
  cap?: string;
  nextDisbursementTs?: number;
  description?: string;
};

export type Delegation = {
  delegator: string;
  delegate: string;
  weight: number;
  expiry: string;
  expiryTs: number;
  active: boolean;
};

export type OwnerDelegations = {
  outgoing: Delegation | null;
  incoming: Delegation[];
};

