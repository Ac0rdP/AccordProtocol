import type {
  Delegation,
  OwnerWeightChangeEvent,
  Proposal,
  ProposalEvent,
  RecurringSchedule,
} from "../types/accord";

/**
 * Realistic contract responses for the shared test harness.
 *
 * These mirror what `lib/contract.ts` returns *after* it has decoded a
 * simulation result, so hook and component tests exercise the same shapes the
 * app sees in production instead of hand-rolled stubs that drift apart.
 *
 * Keeping them in one module is what makes "the mocks stay in sync with the
 * real contract" achievable: when the contract adds or renames a field, it is
 * changed here once and every test that relies on it fails until updated.
 */

export const HARNESS_ACCOUNT = {
  /** Funded testnet stand-in for the simulation source account. */
  simSource: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  owner: "GOWNER11111111111111111111111111111111111111111111111",
  secondOwner: "GOWNER22222222222222222222222222222222222222222222222",
  viewer: "GVIEWER1111111111111111111111111111111111111111111111",
  guardian: "GGUARDIAN1111111111111111111111111111111111111111111",
  stranger: "GSTRANGER111111111111111111111111111111111111111111",
  token: "CTOKEN1111111111111111111111111111111111111111111111",
} as const;

/** 1 XLM / USDC expressed in stroops, the unit the contract stores. */
export const STROOPS_PER_UNIT = 10_000_000n;

export function proposalFixture(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 1,
    kind: "transfer",
    to: HARNESS_ACCOUNT.secondOwner,
    amount: "12.50",
    rawAmount: String(125_000_000n),
    token: HARNESS_ACCOUNT.token,
    description: "Fund audit",
    approvals: 1,
    threshold: 2,
    quorumWeight: 5,
    approvalWeight: 3,
    totalWeight: 10,
    status: "pending",
    deadline: "2026-10-01T00:00:00.000Z",
    deadlineTs: 1_790_851_200,
    createdAt: "proposal #1",
    proposer: HARNESS_ACCOUNT.owner,
    userHasApproved: false,
    approverAddresses: [HARNESS_ACCOUNT.owner],
    approverWeights: { [HARNESS_ACCOUNT.owner]: 3 },
    executedAt: null,
    category: "Transfer",
    ...overrides,
  };
}

export function ownerWeightsFixture(): Array<{ address: string; weight: number }> {
  return [
    { address: HARNESS_ACCOUNT.owner, weight: 6 },
    { address: HARNESS_ACCOUNT.secondOwner, weight: 4 },
  ];
}

export function proposalEventsFixture(count = 2): ProposalEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `evt-${index}`,
    proposalId: 1,
    type: index === 0 ? "created" : "approved",
    actor: index === 0 ? HARNESS_ACCOUNT.owner : HARNESS_ACCOUNT.secondOwner,
    ledger: 1_000 + index,
    occurredAt: "2026-09-27T12:00:00.000Z",
  })) as ProposalEvent[];
}

export function ownerWeightChangeEventsFixture(count = 2): OwnerWeightChangeEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `weight-${index}`,
    owner: HARNESS_ACCOUNT.owner,
    previousWeight: 4,
    newWeight: 6,
    ledger: 900 + index,
    occurredAt: "2026-09-26T12:00:00.000Z",
  })) as OwnerWeightChangeEvent[];
}

export function recurringSchedulesFixture(): RecurringSchedule[] {
  return [
    {
      id: 1,
      payee: HARNESS_ACCOUNT.secondOwner,
      amount: "5.00",
      rawAmount: String(50_000_000n),
      token: HARNESS_ACCOUNT.token,
      period: "monthly",
      nextDueTs: Math.floor(Date.now() / 1000) + 86_400,
      status: "active",
      kind: "fixed_amount_per_period",
      scheduleStatus: "active",
    },
  ] as RecurringSchedule[];
}

export function delegationsFixture(): { outgoing: Delegation | null; incoming: Delegation[] } {
  return {
    outgoing: null,
    incoming: [],
  };
}

/**
 * The full set of contract responses the harness serves by default.
 *
 * Every entry is a *read*. Writes are handled separately by the harness
 * because they resolve to a submitted-transaction receipt rather than a value.
 */
export interface ContractReadFixtures {
  getOwners: string[];
  getOwnerWeights: Array<{ address: string; weight: number }>;
  getOwnerWeight: bigint;
  getApproverWeight: number;
  getTotalWeight: number;
  getThreshold: number;
  getRequiredQuorumWeight: number;
  getWeightCapPct: number;
  getProposal: Proposal;
  getProposalsPaged: Proposal[];
  getTotalProposals: number;
  getProposalApprovalProgress: { approvalWeight: number; quorumWeight: number; totalWeight: number };
  hasApproved: boolean;
  getApprovers: string[];
  getLatestLedger: number;
  getContractEvents: number;
  getContractXlmBalance: string;
  getContractUsdcBalance: string;
  getGuardian: string;
  isFrozen: boolean;
  getRoleVersion: number;
  getRoles: string[];
  hasRole: boolean;
  getRoleMembers: string[];
  getSpendingLimit: { spent: string; limit: string; remaining: string };
  getDelegations: { outgoing: Delegation | null; incoming: Delegation[] };
  getActiveDelegations: Delegation[];
  getRecurringPayments: RecurringSchedule[];
  getRecurringPaymentsPaged: RecurringSchedule[];
  getDueRecurring: RecurringSchedule[];
  getTotalRecurringPayments: number;
  getRecurringPayment: RecurringSchedule | null;
  getClaimableAmount: bigint;
  getNextDisbursementTime: number;
  getProposalEvents: ProposalEvent[];
  getOwnerWeightChangeEvents: OwnerWeightChangeEvent[];
  getHistoricalWeightChangeEvents: OwnerWeightChangeEvent[];
}

/** The default world the harness serves unless a test overrides it. */
export function defaultReadFixtures(): ContractReadFixtures {
  const ownerWeights = ownerWeightsFixture();
  const totalWeight = ownerWeights.reduce((sum, { weight }) => sum + weight, 0);
  const proposal = proposalFixture();
  return {
    getOwners: ownerWeights.map(({ address }) => address),
    getOwnerWeights: ownerWeights,
    getOwnerWeight: 6n,
    getApproverWeight: 6,
    getTotalWeight: totalWeight,
    getThreshold: 2,
    getRequiredQuorumWeight: Math.ceil(totalWeight / 2),
    getWeightCapPct: 30,
    getProposal: proposal,
    getProposalsPaged: [proposal],
    getTotalProposals: 1,
    getProposalApprovalProgress: {
      approvalWeight: proposal.approvalWeight ?? 0,
      quorumWeight: proposal.quorumWeight ?? 0,
      totalWeight,
    },
    hasApproved: false,
    getApprovers: [HARNESS_ACCOUNT.owner],
    getLatestLedger: 1_050,
    getContractEvents: 1_050,
    getContractXlmBalance: "1,000.000000",
    getContractUsdcBalance: "250.000000",
    getGuardian: HARNESS_ACCOUNT.guardian,
    isFrozen: false,
    getRoleVersion: 7,
    getRoles: [],
    hasRole: false,
    getRoleMembers: [],
    getSpendingLimit: {
      spent: String(25_000_000n),
      limit: String(100_000_000n),
      remaining: String(75_000_000n),
    },
    getDelegations: delegationsFixture(),
    getActiveDelegations: [],
    getRecurringPayments: recurringSchedulesFixture(),
    getRecurringPaymentsPaged: recurringSchedulesFixture(),
    getDueRecurring: [],
    getTotalRecurringPayments: 1,
    getRecurringPayment: recurringSchedulesFixture()[0],
    getClaimableAmount: 50_000_000n,
    getNextDisbursementTime: Math.floor(Date.now() / 1000) + 86_400,
    getProposalEvents: proposalEventsFixture(),
    getOwnerWeightChangeEvents: ownerWeightChangeEventsFixture(),
    getHistoricalWeightChangeEvents: ownerWeightChangeEventsFixture(),
  };
}

/**
 * A submitted-transaction receipt, the shape a successful write resolves to.
 * Writes in `lib/submit.ts` resolve to `void`, so the receipt exists to give
 * tests something assertable without pretending the contract returned a value.
 */
export interface ContractTxReceipt {
  txHash: string;
  ledger: number;
  status: "SUCCESS";
  submittedAt: string;
}

export function txReceiptFixture(overrides: Partial<ContractTxReceipt> = {}): ContractTxReceipt {
  return {
    txHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    ledger: 1_051,
    status: "SUCCESS",
    submittedAt: "2026-09-27T12:00:00.000Z",
    ...overrides,
  };
}
