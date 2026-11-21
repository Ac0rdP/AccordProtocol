import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { proposalFixture } from "../test/contractFixtures";
import { ProposalInboxPage } from "./ProposalInboxPage";
import { getWorkspaceInbox, type ProposalInboxEntry } from "../lib/proposalInbox";

vi.mock("../lib/proposalInbox", () => ({
  getWorkspaceInbox: vi.fn(),
}));

const firstWorkspace = {
  id: `C${"A".repeat(55)}`,
  name: "Operations",
  contractId: `C${"A".repeat(55)}`,
};
const secondWorkspace = {
  id: `C${"B".repeat(55)}`,
  name: "Grants",
  contractId: `C${"B".repeat(55)}`,
};

function saveWorkspaces(workspaces: typeof firstWorkspace[]) {
  localStorage.setItem("accord.proposal-workspaces.v1", JSON.stringify(workspaces));
}

function entry(workspace: typeof firstWorkspace, id: number): ProposalInboxEntry {
  const proposal = proposalFixture({
    id,
    description: `Proposal ${id}`,
    amount: `${id}.00`,
    status: "pending",
  });
  return {
    workspace,
    proposal,
    history: [proposal],
  };
}

const props = {
  walletAddress: "GOWNER",
  onConnect: vi.fn(),
  onApprove: vi.fn().mockResolvedValue(undefined),
  onExecute: vi.fn().mockResolvedValue(undefined),
};

describe("ProposalInboxPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  test("shows the loading state while workspace proposals are loading", async () => {
    saveWorkspaces([firstWorkspace]);
    let finish!: (entries: ProposalInboxEntry[]) => void;
    vi.mocked(getWorkspaceInbox).mockReturnValueOnce(
      new Promise((resolve) => { finish = resolve; }),
    );

    render(<ProposalInboxPage {...props} />);
    expect(screen.getByText("Loading proposals across workspaces…")).toBeTruthy();

    finish([]);
    await screen.findByText("You're all caught up");
  });

  test("shows the empty state when no proposal needs action", async () => {
    saveWorkspaces([firstWorkspace]);
    vi.mocked(getWorkspaceInbox).mockResolvedValue([]);

    render(<ProposalInboxPage {...props} />);
    expect(await screen.findByText("You're all caught up")).toBeTruthy();
  });

  test("compares proposals from different workspaces with keyboard-operable checkboxes", async () => {
    saveWorkspaces([firstWorkspace, secondWorkspace]);
    vi.mocked(getWorkspaceInbox).mockImplementation(async (workspace) => [
      entry(workspace, workspace.contractId === firstWorkspace.contractId ? 1 : 2),
    ]);

    render(<ProposalInboxPage {...props} />);
    const first = await screen.findByRole("checkbox", {
      name: "Compare proposal 1 in Operations",
    });
    const second = screen.getByRole("checkbox", {
      name: "Compare proposal 2 in Grants",
    });
    fireEvent.click(first);
    fireEvent.click(second);

    expect(screen.getByRole("heading", { name: "Side-by-side comparison" })).toBeTruthy();
    expect(screen.getByText("1.00 XLM")).toBeTruthy();
    expect(screen.getByText("2.00 XLM")).toBeTruthy();
    expect(screen.getByText("Risk signals")).toBeTruthy();
  });

  test("surfaces workspace loading failures with retry", async () => {
    saveWorkspaces([firstWorkspace]);
    vi.mocked(getWorkspaceInbox).mockRejectedValue(new Error("RPC unavailable"));

    render(<ProposalInboxPage {...props} />);
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("Operations: RPC unavailable");
    });
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
