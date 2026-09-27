import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi, beforeEach } from "vitest";
import { CreateWeightChangeProposalModal } from "./CreateWeightChangeProposalModal";
import { createChangeOwnerWeightProposal } from "../lib/submit";
import {
  getOwnerWeight,
  getOwners,
  getRequiredQuorumWeight,
  getTotalWeight,
} from "../lib/contract";

vi.mock("../lib/submit", () => ({
  createChangeOwnerWeightProposal: vi.fn(),
}));

vi.mock("../lib/contract", () => ({
  getOwners: vi.fn(),
  getOwnerWeight: vi.fn(),
  getTotalWeight: vi.fn(),
  getRequiredQuorumWeight: vi.fn(),
}));

const OWNER_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OWNER_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("CreateWeightChangeProposalModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(getOwners).mockResolvedValue([OWNER_A, OWNER_B]);
    vi.mocked(getOwnerWeight).mockImplementation(async (owner: string) =>
      owner === OWNER_A ? 2n : 4n
    );
    vi.mocked(getTotalWeight).mockResolvedValue(6);
    vi.mocked(getRequiredQuorumWeight).mockResolvedValue(4);
    vi.mocked(createChangeOwnerWeightProposal).mockResolvedValue(undefined);
  });

  function renderModal() {
    return render(
      <CreateWeightChangeProposalModal
        walletAddress={OWNER_A}
        initialOwnerAddress={OWNER_A}
        onClose={vi.fn()}
        onSubmitted={vi.fn()}
      />
    );
  }

  test("blocks a weight below the minimum", async () => {
    const user = userEvent.setup();
    renderModal();

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /propose weight change/i })).toBeTruthy();
    });

    await user.clear(screen.getByLabelText("New Weight"));
    await user.type(screen.getByLabelText("New Weight"), "0");
    await user.click(screen.getByRole("button", { name: "Submit Proposal" }));

    expect(screen.getByText("Weight must be at least 1.")).toBeTruthy();
    expect(createChangeOwnerWeightProposal).not.toHaveBeenCalled();
  });

  test("blocks a weight above the maximum", async () => {
    const user = userEvent.setup();
    renderModal();

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /propose weight change/i })).toBeTruthy();
    });

    await user.clear(screen.getByLabelText("New Weight"));
    await user.type(screen.getByLabelText("New Weight"), "100001");
    await user.click(screen.getByRole("button", { name: "Submit Proposal" }));

    expect(screen.getByText("Weight must be no more than 100000.")).toBeTruthy();
    expect(createChangeOwnerWeightProposal).not.toHaveBeenCalled();
  });

  test("updates the quorum preview and submits a valid proposal", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSubmitted = vi.fn();

    render(
      <CreateWeightChangeProposalModal
        walletAddress={OWNER_A}
        initialOwnerAddress={OWNER_A}
        onClose={onClose}
        onSubmitted={onSubmitted}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Current owner weight:")).toBeTruthy();
    });

    await user.clear(screen.getByLabelText("New Weight"));
    await user.type(screen.getByLabelText("New Weight"), "4");
    await user.type(screen.getByLabelText("Description"), "Raise signer weight");

    expect(screen.getByText("Projected owner weight:").parentElement).toHaveTextContent(
      "4"
    );
    expect(
      screen.getByText("Projected total voting weight:").parentElement
    ).toHaveTextContent("8");

    await user.click(screen.getByRole("button", { name: "Submit Proposal" }));

    expect(createChangeOwnerWeightProposal).toHaveBeenCalledTimes(1);
    const call = vi.mocked(createChangeOwnerWeightProposal).mock.calls[0];
    expect(call[0]).toBe(OWNER_A);
    expect(call[1]).toBe(OWNER_A);
    expect(call[2]).toBe(4);
    expect(call[3]).toBe("Raise signer weight");
    expect(typeof call[4]).toBe("bigint");
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
