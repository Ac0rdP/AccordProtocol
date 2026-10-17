import type { Owner, Proposal, RecurringSchedule } from "../types/accord";
import type { SpendByCategoryRow, SpendByOwner } from "../lib/analytics";
import type { TreasuryBalancePoint } from "../lib/analytics";
import type { TreasuryFlowBucket } from "../types/accord";

export const noop = () => undefined;

export const mockWallet =
  "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC";

export function baseProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 42,
    kind: "transfer",
    to: "GABCDE1234567890WXYZ",
    amount: "100",
    token: "USDC",
    description: "Treasury ops stipend for Q1",
    approvals: 1,
    threshold: 2,
    quorumWeight: 10,
    approvalWeight: 5,
    totalWeight: 20,
    status: "pending",
    deadline: "Jun 24, 2026",
    deadlineTs: 1782259200,
    createdAt: "proposal #42",
    proposer: "GPROPOSER1234567890",
    userHasApproved: false,
    approverAddresses: ["GAPPROVER123456789"],
    category: "Ops",
    ...overrides,
  };
}

export const sampleOwners: Owner[] = [
  {
    address: "GOWNER0001",
    fullAddress: "GOWNER0001FULLADDRESS00000000000000001",
    label: "Alice",
    roles: ["Owner", "Approver"],
    weight: 8,
  },
  {
    address: "GOWNER0002",
    fullAddress: "GOWNER0002FULLADDRESS00000000000000002",
    label: "Bob",
    roles: ["Owner"],
    weight: 12,
  },
];

export const sampleSchedule: RecurringSchedule = {
  id: 3,
  recipient: "GBPLX2P3VWYKPQ7L5RI5OGXQ6T4G7QZMJ3HPQD7FZX5KJ3H2Z4YK5ABC",
  amount: "50 XLM",
  cadence: "Monthly",
  interval: 2_592_000,
  totalDisbursed: "150 XLM",
  status: "active",
  description: "Developer grant monthly allowance",
  nextDisbursementTs: Math.floor(Date.now() / 1000) + 86_400,
};

export const spendByCategorySample: SpendByCategoryRow[] = [
  { category: "Grant", total: 600, count: 3, share: 60 },
  { category: "Payroll", total: 300, count: 2, share: 30 },
  { category: "Ops", total: 100, count: 1, share: 10 },
];

export const spendByOwnerSample: SpendByOwner[] = [
  { owner: "GOWNER0001", shortOwner: "GOWNER...0001", total: 420.5, count: 4 },
  { owner: "GOWNER0002", shortOwner: "GOWNER...0002", total: 180.25, count: 2 },
];

export const treasuryBalanceSample: TreasuryBalancePoint[] = [
  { timestamp: "2026-01-01", xlm: 1200, usdc: 800 },
  { timestamp: "2026-02-01", xlm: 1100, usdc: 950 },
  { timestamp: "2026-03-01", xlm: 1050, usdc: 1020 },
];

export const treasuryFlowSample: TreasuryFlowBucket[] = [
  {
    timestamp: "2026-01-01T00:00:00.000Z",
    token: "XLM",
    inflow: "500",
    outflow: "200",
  },
  {
    timestamp: "2026-02-01T00:00:00.000Z",
    token: "XLM",
    inflow: "300",
    outflow: "450",
  },
];
