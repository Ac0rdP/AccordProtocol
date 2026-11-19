import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { AuditLogPage } from "./AuditLogPage";
import type { Proposal } from "../types/accord";

vi.mock("../lib/contract", () => ({ getProposalEvents: vi.fn() }));
import { getProposalEvents } from "../lib/contract";

const proposal: Proposal = {
  id: 7, kind: "grant_role", to: "GOWNER", amount: "0", token: "XLM", description: "Grant executor role",
  approvals: 2, threshold: 2, status: "executed", deadline: "Tomorrow", deadlineTs: 1,
  createdAt: "Today", proposer: "GPROPOSER", userHasApproved: true, approverAddresses: [],
};

describe("AuditLogPage", () => {
  test("shows, filters, and exports contract audit events", async () => {
    vi.mocked(getProposalEvents).mockResolvedValue([{ type: "executed", actor: "GADMIN", timestamp: "2026-01-02T10:00:00Z", ledger: 12, details: "Executor role granted" }]);
    global.URL.createObjectURL = vi.fn(() => "blob:audit");
    global.URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<AuditLogPage proposals={[proposal]} />);

    await waitFor(() => expect(screen.getByText("Executed")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Filter audit log by actor"), { target: { value: "other" } });
    expect(screen.getByText("No audit events match these filters")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter audit log by actor"), { target: { value: "admin" } });
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(click).toHaveBeenCalled();
  });
});
