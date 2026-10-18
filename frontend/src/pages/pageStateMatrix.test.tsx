import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  PAGE_STATE_KINDS,
  PAGE_STATE_MATRIX,
  dataBackedPages,
  findMissingStates,
  type PageStateKind,
  type PageStateMatrixEntry,
} from "./pageStateMatrix";
import { DashboardPage } from "./DashboardPage";
import { HistoryPage } from "./HistoryPage";
import { RecurringPage } from "./RecurringPage";
import { AnalyticsPage } from "./AnalyticsPage";
import { OwnersPage } from "./OwnersPage";
import { SettingsPage } from "./SettingsPage";
import { ProposalDetailPage } from "./ProposalDetailPage";
import { useTreasuryAnalytics } from "../hooks/useTreasuryAnalytics";
import type { TreasuryAnalytics } from "../types/accord";

// ─── Mocks ───────────────────────────────────────────────────────────────────
// Every page under test reads contract data on mount. Mock the data layer so
// each case renders deterministically without touching the network.

vi.mock("../lib/contract", () => ({
  getTotalProposals: vi.fn().mockResolvedValue(0),
  getProposalsPaged: vi.fn().mockResolvedValue([]),
  getThreshold: vi.fn().mockResolvedValue(1),
  mapProposal: vi.fn((raw: unknown) => raw),
  getRecurringPaymentsPaged: vi.fn().mockResolvedValue([]),
  getTotalRecurringPayments: vi.fn().mockResolvedValue(0),
  getDueRecurring: vi.fn().mockResolvedValue([]),
  getOwnerWeightChangeEvents: vi.fn().mockResolvedValue([]),
  getOwnerWeights: vi.fn().mockResolvedValue([]),
  getActiveDelegations: vi.fn().mockResolvedValue([]),
  getSpendingLimit: vi.fn().mockResolvedValue(-1n),
  getContractXlmBalance: vi.fn().mockResolvedValue("0.00"),
  getContractUsdcBalance: vi.fn().mockResolvedValue("0.00"),
  getGuardian: vi.fn().mockResolvedValue("—"),
  isFrozen: vi.fn().mockResolvedValue(false),
  getRoleVersion: vi.fn().mockResolvedValue(0),
  getRoles: vi.fn().mockResolvedValue([]),
  getHistoricalWeightChangeEvents: vi.fn().mockResolvedValue([]),
  getOwners: vi.fn().mockResolvedValue([]),
  getProposalEvents: vi.fn().mockResolvedValue([]),
  getRequiredQuorumWeight: vi.fn().mockResolvedValue(0),
  reconstructTotalWeightHistory: vi.fn().mockReturnValue([]),
  getClaimableAmount: vi.fn().mockResolvedValue(0n),
}));

vi.mock("../hooks/useTreasuryAnalytics", () => ({
  useTreasuryAnalytics: vi.fn(),
}));

vi.mock("recharts", async () => {
  const original = await vi.importActual<typeof import("recharts")>("recharts");
  return {
    ...original,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
  };
});

vi.mock("jspdf", () => ({
  jsPDF: vi.fn().mockImplementation(() => ({
    setFontSize: vi.fn(),
    text: vi.fn(),
    save: vi.fn(),
  })),
}));

const noop = () => {};

const emptyAnalytics: TreasuryAnalytics = {
  summary: {
    totalDisbursed: {},
    totalInflows: {},
    activeProposals: 0,
    ownerCount: 0,
    largestOutflow: null,
  },
  balance: { balances: {} },
  spendByCategory: [],
  spendByOwner: [],
  flow: [],
};

function scoreAnalytics(kind: PageStateKind) {
  vi.mocked(useTreasuryAnalytics).mockReturnValue({
    data: kind === "empty" ? emptyAnalytics : null,
    loading: kind === "loading",
    error: kind === "error" ? "boom" : null,
    refresh: vi.fn(),
  });
}

// ─── Renderer registry ───────────────────────────────────────────────────────
// One entry per page in the matrix. `renderPage` is intentionally exhaustive:
// a page added to the matrix without a renderer fails the coverage test below.

const RENDERERS: Record<string, (kind: PageStateKind) => void> = {
  DashboardPage: (kind) => {
    render(
      <DashboardPage
        activeProposals={[]}
        owners={[]}
        dashboardStats={[]}
        walletAddress={null}
        onApprove={noop}
        onExecute={noop}
        onRevoke={noop}
        onCreateProposal={noop}
        onCreateRecurringPayment={noop}
        walletRoles={[]}
        roleBanner={null}
        loading={kind === "loading"}
        error={kind === "error" ? "boom" : null}
        onRetry={noop}
      />,
    );
  },
  HistoryPage: (kind) => {
    render(
      <MemoryRouter>
        <HistoryPage
          proposals={[]}
          onApprove={noop}
          loading={kind === "loading"}
          error={kind === "error" ? "boom" : null}
          onRetry={noop}
        />
      </MemoryRouter>,
    );
  },
  RecurringPage: (kind) => {
    render(
      <RecurringPage
        walletAddress={null}
        loading={kind === "loading"}
        error={kind === "error" ? "boom" : null}
        onRetry={noop}
      />,
    );
  },
  AnalyticsPage: (kind) => {
    scoreAnalytics(kind);
    render(<AnalyticsPage />);
  },
  OwnersPage: (kind) => {
    render(
      <OwnersPage
        owners={[]}
        ownerAddresses={[]}
        threshold={1}
        totalOwners={0}
        onManageRoles={noop}
        walletAddress={null}
        onProposalSubmitted={noop}
        loading={kind === "loading"}
        error={kind === "error" ? "boom" : null}
        onRetry={noop}
      />,
    );
  },
  SettingsPage: (kind) => {
    render(
      <SettingsPage
        stats={[]}
        walletAddress="GWALLET000000000000000000000000000000000000000000000000"
        ownerAddresses={[]}
        onProposalSubmitted={noop}
        loading={kind === "loading"}
        error={kind === "error" ? "boom" : null}
        onRetry={noop}
      />,
    );
  },
  ProposalDetailPage: (kind) => {
    render(
      <MemoryRouter>
        <ProposalDetailPage
          proposals={[]}
          walletAddress={null}
          onApprove={noop}
          onExecute={noop}
          loading={kind === "loading"}
          error={kind === "error" ? "boom" : null}
          onRetry={noop}
        />
      </MemoryRouter>,
    );
  },
};

async function assertState(entry: PageStateMatrixEntry, kind: PageStateKind) {
  const expectation = entry.states?.[kind];
  if (!expectation) {
    throw new Error(`${entry.page} has no ${kind} expectation`);
  }

  const renderPage = RENDERERS[entry.page];
  if (!renderPage) {
    throw new Error(`${entry.page} has no renderer`);
  }

  renderPage(kind);

  if (expectation.multiple) {
    const matches = await screen.findAllByText(expectation.message);
    expect(matches.length).toBeGreaterThan(0);
  } else {
    expect(await screen.findByText(expectation.message)).toBeInTheDocument();
  }

  if (expectation.retry) {
    const retryButtons = await screen.findAllByRole("button", {
      name: /retry/i,
    });
    expect(retryButtons.length).toBeGreaterThan(0);
  }
}

describe("page state matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scoreAnalytics("empty");
  });

  afterEach(() => {
    cleanup();
  });

  test("lists every matrix page exactly once", () => {
    const pages = PAGE_STATE_MATRIX.map((entry) => entry.page);
    expect(new Set(pages).size).toBe(pages.length);
  });

  test("no data-backed page is missing a loading, empty, or error state", () => {
    expect(findMissingStates()).toEqual([]);
  });

  test("every data-backed matrix page has a renderer registered", () => {
    for (const entry of dataBackedPages()) {
      expect(
        RENDERERS[entry.page],
        `no renderer registered for ${entry.page}`,
      ).toBeTypeOf("function");
    }
  });

  test("data-backed pages declare all three states", () => {
    const backed = dataBackedPages();
    expect(backed.length).toBeGreaterThan(0);
    for (const entry of backed) {
      for (const kind of PAGE_STATE_KINDS) {
        expect(
          entry.states?.[kind],
          `${entry.page} is missing its ${kind} state`,
        ).toBeTruthy();
      }
    }
  });

  for (const entry of dataBackedPages()) {
    describe(entry.page, () => {
      for (const kind of PAGE_STATE_KINDS) {
        test(`renders the ${kind} state`, async () => {
          await assertState(entry, kind);
        });
      }
    });
  }
});
