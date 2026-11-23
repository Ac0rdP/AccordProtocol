import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { LiveUpdatesAnnouncer } from "./LiveUpdatesAnnouncer";
import type { Proposal } from "../types/accord";

const proposal = (overrides: Partial<Proposal> = {}): Proposal => ({
  id: 1, kind: "transfer", to: "GRECIPIENT", amount: "10", token: "XLM", description: "Payroll",
  approvals: 1, threshold: 2, status: "pending", deadline: "Tomorrow", deadlineTs: 1,
  createdAt: "Today", proposer: "GPROPOSER", userHasApproved: false, approverAddresses: [], ...overrides,
});

describe("LiveUpdatesAnnouncer", () => {
  test("does not announce initial data and politely announces later changes", async () => {
    const view = render(<LiveUpdatesAnnouncer proposals={[proposal()]} />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveTextContent("");

    view.rerender(<LiveUpdatesAnnouncer proposals={[proposal({ approvals: 2 })]} />);
    await waitFor(() => expect(region).toHaveTextContent("Proposal #1 received an approval."));

    view.rerender(<LiveUpdatesAnnouncer proposals={[proposal({ id: 2, description: "New grant" })]} />);
    await waitFor(() => expect(region).toHaveTextContent("New proposal #2: New grant."));
  });
});
