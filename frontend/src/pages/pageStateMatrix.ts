/**
 * Page state matrix.
 *
 * Every data-backed page must render a loading, empty, and error state so no
 * page silently shows a blank screen while fetching, after a failed fetch, or
 * when the backend honestly has nothing to return.
 *
 * This module is the single list of pages and the user-visible message each
 * state must produce. `pageStateMatrix.test.tsx` renders every page in every
 * state and fails when a page is missing a case or renders the wrong message.
 * The `findMissingStates` guard below makes "a page lacks a state" a failing
 * test rather than a silent gap.
 *
 * The generated contract types are covered separately by
 * `src/types/contract.generated.test.ts`; see `docs/CONTRACT_TYPES.md`.
 */

export type PageStateKind = "loading" | "empty" | "error";

export type PageStateExpectation = {
  /** Substring that must be visible to the user in this state. */
  message: string;
  /** Whether the state must offer a Retry control. */
  retry: boolean;
  /** True when the message legitimately appears more than once on the page. */
  multiple?: boolean;
};

export type PageStateMatrixEntry = {
  /** Component name, matched against the renderer registry in the test. */
  page: string;
  /** Route the page is reached at. */
  route: string;
  /** What the page reads to decide its state. */
  dataSource: string;
  /**
   * Data-backed pages must define all three states. Reference/informational
   * pages set this to false and explain why in `note`.
   */
  dataBacked: boolean;
  states?: Partial<Record<PageStateKind, PageStateExpectation>>;
  note?: string;
};

export const PAGE_STATE_KINDS: PageStateKind[] = ["loading", "empty", "error"];

export const PAGE_STATE_MATRIX: PageStateMatrixEntry[] = [
  {
    page: "DashboardPage",
    route: "/app",
    dataSource: "useContract(proposals/owners/stats) + useOwnerWeights",
    dataBacked: true,
    states: {
      loading: { message: "Loading proposals…", retry: false },
      empty: { message: "No active proposals", retry: false },
      error: { message: "Could not load dashboard data", retry: true },
    },
  },
  {
    page: "HistoryPage",
    route: "/app/history",
    dataSource: "getTotalProposals / getProposalsPaged",
    dataBacked: true,
    states: {
      loading: { message: "Loading proposal history…", retry: false },
      empty: { message: "No proposals found", retry: false },
      error: { message: "Could not load proposal history", retry: true },
    },
  },
  {
    page: "RecurringPage",
    route: "/app/recurring",
    dataSource: "getTotalRecurringPayments / getRecurringPaymentsPaged",
    dataBacked: true,
    states: {
      loading: { message: "Loading recurring schedules…", retry: false },
      empty: { message: "No schedules found", retry: false },
      error: { message: "Could not load recurring schedules", retry: true },
    },
  },
  {
    page: "AnalyticsPage",
    route: "/app/analytics",
    dataSource: "useTreasuryAnalytics",
    dataBacked: true,
    states: {
      loading: { message: "Loading...", retry: false, multiple: true },
      empty: {
        message: "No spend data available for the selected filters.",
        retry: false,
        multiple: true,
      },
      error: { message: "boom", retry: true, multiple: true },
    },
  },
  {
    page: "OwnersPage",
    route: "/app/owners",
    dataSource: "useOwnerWeights / useDelegations / getSpendingLimit",
    dataBacked: true,
    states: {
      loading: { message: "Loading owners…", retry: false },
      empty: { message: "No owners found", retry: false },
      error: { message: "Could not load owners", retry: true },
    },
  },
  {
    page: "SettingsPage",
    route: "/app/settings",
    dataSource: "getRoleVersion / getRoles / getGuardian / isFrozen",
    dataBacked: true,
    states: {
      loading: { message: "Loading settings…", retry: false },
      empty: { message: "No active roles", retry: false },
      error: { message: "Could not load settings", retry: true },
    },
  },
  {
    page: "ProposalDetailPage",
    route: "/proposals/:id",
    dataSource: "getProposalEvents / getOwners / getRequiredQuorumWeight",
    dataBacked: true,
    states: {
      loading: { message: "Loading proposal…", retry: false },
      empty: { message: "Proposal not found", retry: false },
      error: { message: "Could not load proposal", retry: true },
    },
  },
  {
    page: "LandingPage",
    route: "/",
    dataSource: "getTotalProposals / getRequiredQuorumWeight / getTotalWeight",
    dataBacked: false,
    note: "Marketing page: counts degrade to placeholder values and it never blocks on a loading or error state.",
  },
  {
    page: "DocsPage",
    route: "/docs",
    dataSource: "static content",
    dataBacked: false,
    note: "Static documentation with no data dependencies.",
  },
  {
    page: "NotFoundPage",
    route: "*",
    dataSource: "none",
    dataBacked: false,
    note: "Static 404 page reached only for unmatched routes.",
  },
];

/**
 * Returns a human-readable problem for every entry that violates the matrix
 * contract. An empty array means the matrix is complete.
 */
export function findMissingStates(
  matrix: PageStateMatrixEntry[] = PAGE_STATE_MATRIX,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const entry of matrix) {
    if (seen.has(entry.page)) {
      problems.push(`${entry.page}: listed more than once`);
    }
    seen.add(entry.page);

    if (!entry.dataBacked) {
      if (entry.states) {
        problems.push(
          `${entry.page}: non-data page must not declare loading/empty/error states`,
        );
      }
      if (!entry.note) {
        problems.push(`${entry.page}: non-data page must explain why in note`);
      }
      continue;
    }

    for (const kind of PAGE_STATE_KINDS) {
      const expectation = entry.states?.[kind];
      if (!expectation) {
        problems.push(`${entry.page}: missing ${kind} state`);
        continue;
      }
      if (!expectation.message.trim()) {
        problems.push(`${entry.page}: ${kind} state has an empty message`);
      }
    }
  }

  return problems;
}

/** The set of pages the test suite must be able to render. */
export function dataBackedPages(
  matrix: PageStateMatrixEntry[] = PAGE_STATE_MATRIX,
): PageStateMatrixEntry[] {
  return matrix.filter((entry) => entry.dataBacked);
}
