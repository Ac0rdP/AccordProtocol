export type ProposalStatus = "pending" | "ready" | "executed" | "expired" | "revoked";

export type Role =
  | "Owner"
  | "Viewer"
  | "Guardian"
  | "SpendingLimit"
  | "Proposer"
  | "Approver"
  | "Executor";

export type ProposalCategory = "Transfer" | "Payroll" | "Grant" | "Ops" | "Other";

export type ProposalKind =
  | "transfer"
  | "add_owner"
  | "remove_owner"
  | "change_threshold"
  | "set_spending_limit"
  | "change_owner_weight"
  | "grant_role"
  | "revoke_role"
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
  approverWeights?: Record<string, number>;
  executedAt?: string | null;
  category?: ProposalCategory;
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

export type OwnerWeightChangeEvent = {
  /** Full address of the owner whose voting weight changed. */
  owner: string;
  oldWeight: number;
  newWeight: number;
  /** Total voting weight after the change, when the event reports it. */
  newTotalWeight?: number;
  ledger?: number;
  /** Human-readable time (or ledger) the change was recorded. */
  timestamp: string;
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

/** Analytics amounts are decimal token units, serialized as strings to preserve precision. */
export type AnalyticsAmount = string;
export type AnalyticsGranularity = "day" | "week" | "month";

export type AnalyticsQuery = {
  /** Inclusive ISO date/date-time range. Empty strings omit the bound. */
  startDate?: string;
  endDate?: string;
  token?: string;
  category?: ProposalCategory;
  owner?: string;
  status?: ProposalStatus;
  limit?: number;
  offset?: number;
  sort?: "deadline" | "amount" | "createdAt";
  order?: "asc" | "desc";
  granularity?: AnalyticsGranularity;
  timeSeries?: boolean;
};

export type AnalyticsTimeSeriesPoint = {
  /** ISO 8601 UTC timestamp. */
  timestamp: string;
  /** Token identifier to balance in decimal token units. */
  values: Record<string, AnalyticsAmount>;
};

export type TreasuryBalance = {
  balances: Record<string, AnalyticsAmount>;
  timeSeries?: AnalyticsTimeSeriesPoint[];
};

/** An indexed treasury balance snapshot. `timestamp` is Unix seconds. */
export type BalanceSnapshot = {
  timestamp: number;
  balances: Record<string, AnalyticsAmount>;
};

/** An indexed treasury deposit (inflow). `timestamp` is Unix seconds. */
export type TreasuryDeposit = {
  timestamp: number;
  token: string;
  amount: AnalyticsAmount;
};

export type CategorySpendBucket = {
  category: ProposalCategory;
  token: string;
  total: AnalyticsAmount;
  count: number;
  /** Percentage points, 0–100 (not a fraction). */
  share: number;
};

export type OwnerSpendBucket = {
  owner: string;
  token: string;
  total: AnalyticsAmount;
  count: number;
};

export type TreasuryFlowBucket = {
  /** ISO 8601 UTC start of the bucket. */
  timestamp: string;
  token: string;
  inflow: AnalyticsAmount;
  outflow: AnalyticsAmount;
};

export type TreasurySummary = {
  totalDisbursed: Record<string, AnalyticsAmount>;
  totalInflows: Record<string, AnalyticsAmount>;
  activeProposals: number;
  ownerCount: number;
  largestOutflow: { token: string; amount: AnalyticsAmount } | null;
};

export type AnalyticsProposalPage = {
  proposals: Proposal[];
  total: number;
  limit: number;
  offset: number;
};

export type AnalyticsProposalDetail = {
  proposal: Proposal;
  timeline: ProposalEvent[];
};

export type TreasuryAnalytics = {
  summary: TreasurySummary;
  balance: TreasuryBalance;
  spendByCategory: CategorySpendBucket[];
  spendByOwner: OwnerSpendBucket[];
  flow: TreasuryFlowBucket[];
};

export type AnalyticsApiErrorCode =
  | "VALIDATION_ERROR"
  | "INVALID_PARAMETER"
  | "NOT_FOUND"
  | "INTERNAL_ERROR"
  | "BAD_REQUEST";

export type AnalyticsApiErrorDetail = {
  field?: string;
  message: string;
  code?: string;
};

export type AnalyticsApiErrorResponse = {
  error: {
    code: AnalyticsApiErrorCode | string;
    message: string;
    details?: AnalyticsApiErrorDetail[];
  };
};

export type ParsedAnalyticsQuery = {
  startDate?: string;
  endDate?: string;
  token?: string;
  category?: ProposalCategory;
  owner?: string;
  status?: ProposalStatus;
  limit: number;
  offset: number;
  sort: "deadline" | "amount" | "createdAt";
  order: "asc" | "desc";
  granularity?: AnalyticsGranularity;
  timeSeries?: boolean;
};
