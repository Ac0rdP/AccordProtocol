import type { AnalyticsContext } from "../src/lib/analyticsApi";
import type { Proposal, TreasuryDeposit } from "../src/types/accord";

/**
 * Fixed set of "indexed" treasury events for the analytics end-to-end test.
 * Stands in for what a real indexer would have persisted from testnet
 * contract events by the time the analytics API is queried.
 */

function ts(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

export const OWNER_A = "GA37572K2O4WHDGLI2UM4CNTMYZDZI4V5AZL4GJV7AQGR3HMVTVRXDKP";
export const OWNER_B = "GCOTL5HEOY6ZC453QWAAIYL2QTZWNXWWU4PF22TK22YBZE6XLBIQHUH2";
export const OWNER_C = "GCCZUKX7LI3MSLUA4MIIN3LSO43DTBPJMHBPSTUQISDLMZMPOJU3ANWJ";
const RECIPIENT = "GRECIPIENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export const PROPOSALS: Proposal[] = [
  {
    id: 1,
    kind: "transfer",
    to: RECIPIENT,
    amount: "1500",
    token: "USDC",
    description: "Grant payout",
    approvals: 2,
    threshold: 2,
    status: "executed",
    deadline: "2026-09-05",
    deadlineTs: ts("2026-09-05T00:00:00Z"),
    createdAt: "2026-09-01T00:00:00Z",
    proposer: OWNER_A,
    userHasApproved: false,
    approverAddresses: [OWNER_B, OWNER_C],
    category: "Grant",
  },
  {
    id: 2,
    kind: "transfer",
    to: RECIPIENT,
    amount: "500",
    token: "XLM",
    description: "Payroll run",
    approvals: 2,
    threshold: 2,
    status: "executed",
    deadline: "2026-09-10",
    deadlineTs: ts("2026-09-10T00:00:00Z"),
    createdAt: "2026-09-02T00:00:00Z",
    proposer: OWNER_B,
    userHasApproved: false,
    approverAddresses: [OWNER_A, OWNER_C],
    category: "Payroll",
  },
  {
    id: 3,
    kind: "transfer",
    to: RECIPIENT,
    amount: "250",
    token: "XLM",
    description: "Ops spend",
    approvals: 2,
    threshold: 2,
    status: "executed",
    deadline: "2026-09-15",
    deadlineTs: ts("2026-09-15T00:00:00Z"),
    createdAt: "2026-09-03T00:00:00Z",
    proposer: OWNER_A,
    userHasApproved: false,
    approverAddresses: [OWNER_B, OWNER_C],
    category: "Ops",
  },
  {
    id: 4,
    kind: "transfer",
    to: RECIPIENT,
    amount: "1000",
    token: "XLM",
    description: "Pending transfer",
    approvals: 1,
    threshold: 2,
    status: "pending",
    deadline: "2026-10-01",
    deadlineTs: ts("2026-10-01T00:00:00Z"),
    createdAt: "2026-09-20T00:00:00Z",
    proposer: OWNER_C,
    userHasApproved: false,
    approverAddresses: [OWNER_C],
    category: "Transfer",
  },
  {
    id: 5,
    kind: "transfer",
    to: RECIPIENT,
    amount: "300",
    token: "USDC",
    description: "Ready grant",
    approvals: 2,
    threshold: 2,
    status: "ready",
    deadline: "2026-10-05",
    deadlineTs: ts("2026-10-05T00:00:00Z"),
    createdAt: "2026-09-22T00:00:00Z",
    proposer: OWNER_B,
    userHasApproved: false,
    approverAddresses: [OWNER_A, OWNER_B],
    category: "Grant",
  },
];

export const DEPOSITS: TreasuryDeposit[] = [
  { timestamp: ts("2026-09-03T00:00:00Z"), token: "USDC", amount: "2000" },
  { timestamp: ts("2026-09-20T00:00:00Z"), token: "XLM", amount: "800" },
];

export const ANALYTICS_CONTEXT: AnalyticsContext = {
  proposals: PROPOSALS,
  ownerCount: 3,
  owners: [OWNER_A, OWNER_B, OWNER_C],
  deposits: DEPOSITS,
};

export const ANALYTICS_API_PORT = 4311;
export const ANALYTICS_API_BASE_URL = `http://localhost:${ANALYTICS_API_PORT}`;

/** Values derived from the fixture above, asserted in analytics-dashboard.spec.ts. */
export const EXPECTED = {
  totalDisbursed: "1,500.00 USDC · 750.00 XLM",
  totalInflows: "2,000.00 USDC · 800.00 XLM",
  activeProposals: "2",
  categorySummary:
    "Category spend chart with 3 categories. Grant: 1500.00 (100.0%); Payroll: 500.00 (66.7%); Ops: 250.00 (33.3%).",
  ownerSummary:
    `Owner spend chart with 4 owners. ${OWNER_A}: 1500.00 across 1 transactions; ` +
    `${OWNER_B}: 500.00 across 1 transactions; ${OWNER_A}: 250.00 across 1 transactions; ` +
    `${OWNER_C}: 0.00 across 0 transactions.`,
  cumulativeOutflow: "Cumulative outflow ends at 2250.00.",
};
