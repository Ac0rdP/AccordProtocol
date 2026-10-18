import "../index.css";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { vi } from "vitest";

// Story CSF files use the automatic JSX runtime in Storybook, but when Vitest
// collects them as plain modules some files still need a global React symbol.
(globalThis as unknown as { React: typeof React }).React = React;

vi.mock("../lib/submit", () => ({
  estimateCreateProposalFee: vi.fn().mockResolvedValue(100),
  createProposal: vi.fn(),
  createAddOwnerProposal: vi.fn(),
  createRemoveOwnerProposal: vi.fn(),
  createChangeThresholdProposal: vi.fn(),
  createChangeOwnerWeightProposal: vi.fn(),
  createDelegation: vi.fn(),
  createGrantRoleProposal: vi.fn(),
  createRevokeRoleProposal: vi.fn(),
  createRecurringPaymentProposal: vi.fn(),
  createPauseRecurringProposal: vi.fn(),
  createResumeRecurringProposal: vi.fn(),
  createCancelRecurringProposal: vi.fn(),
  createModifyRecurringProposal: vi.fn(),
}));

vi.mock("../lib/contract", () => import("./mocks/contract"));
vi.mock("../hooks/useRecurringPayments", () =>
  import("./mocks/useRecurringPayments"),
);

vi.mock("recharts", async (importOriginal) => {
  const original = await importOriginal<typeof import("recharts")>();
  return {
    ...original,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", { "data-testid": "recharts-container" }, children),
  };
});
