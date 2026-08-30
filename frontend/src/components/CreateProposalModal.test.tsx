import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateProposalModal } from "./CreateProposalModal";
import { vi, describe, it, expect, beforeEach } from "vitest";
import { estimateCreateProposalFee, createProposal } from "../lib/submit";
import { getOwners, getThreshold } from "../lib/contract";
import { StrKey } from "@stellar/stellar-sdk";

// Mock the submit logic
vi.mock("../lib/submit", () => ({
  createProposal: vi.fn(),
  createAddOwnerProposal: vi.fn(),
  createRemoveOwnerProposal: vi.fn(),
  createChangeThresholdProposal: vi.fn(),
  estimateCreateProposalFee: vi.fn(),
}));

// Mock contract reads
vi.mock("../lib/contract", () => ({
  getOwners: vi.fn().mockResolvedValue([
    "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC",
    "GBPLX2P3VWYKPQ7L5RI5OGXQ6T4G7QZMJ3HPQD7FZX5KJ3H2Z4YK5ABC",
  ]),
  getThreshold: vi.fn().mockResolvedValue(2),
  getRequiredQuorumWeight: vi.fn().mockResolvedValue(2),
  getOwnerWeight: vi.fn().mockResolvedValue(1),
  getWeightCapPct: vi.fn().mockResolvedValue(50),
  getTotalWeight: vi.fn().mockResolvedValue(2),
}));

// Mock StrKey to avoid validation issues with dummy addresses
vi.mock("@stellar/stellar-sdk", async () => {
  const original = await vi.importActual("@stellar/stellar-sdk") as any;
  return {
    ...original,
    StrKey: {
      ...original.StrKey,
      isValidEd25519PublicKey: vi.fn().mockReturnValue(true),
    },
  };
});

type Act = (e: React.ReactElement) => void;

describe("CreateProposalModal", () => {
  const defaultProps = {
    walletAddress: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC",
    onClose: vi.fn(),
    onSubmitted: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (StrKey.isValidEd25519PublicKey as any).mockReturnValue(true);
  });

  const selectTransfer = () => {
    fireEvent.click(screen.getByText("Transfer"));
  };

  const fillTransferFields = () => {
    selectTransfer();
    fireEvent.change(screen.getByPlaceholderText("G..."), { target: { value: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC" } });
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "10" } });
    fireEvent.change(screen.getByPlaceholderText("What is this payment for?"), { target: { value: "Test payment" } });
  };

  it("Empty untouched field does not show validation message", () => {
    render(<CreateProposalModal {...defaultProps} />);
    expect(screen.queryByText("Enter a valid Stellar address")).toBeNull();
  });

  it("Typing text should not show error if mocked valid", () => {
    render(<CreateProposalModal {...defaultProps} />);
    selectTransfer();
    const input = screen.getByPlaceholderText("G...");
    fireEvent.change(input, { target: { value: "abc123" } });
    expect(screen.queryByText("Enter a valid Stellar address")).toBeNull();
  });

  it("Calculate fee button hidden when wallet disconnected", () => {
    render(<CreateProposalModal {...defaultProps} walletAddress={null} />);
    fillTransferFields();
    expect(screen.queryByText("Calculate fee")).toBeNull();
  });

  it("Button appears when all required fields are present", () => {
    render(<CreateProposalModal {...defaultProps} />);
    fillTransferFields();
    expect(screen.getByText("Calculate fee")).toBeDefined();
  });

  it("shows description count, caps input at 300 characters, and marks the limit in red", async () => {
    render(<CreateProposalModal {...defaultProps} />);
    selectTransfer();

    const descriptionInput = screen.getByPlaceholderText(
      "What is this payment for?"
    ) as HTMLInputElement;

    expect(screen.getByText("0 / 300")).toBeDefined();
    expect(descriptionInput.maxLength).toBe(300);

    fireEvent.change(descriptionInput, { target: { value: "a".repeat(300) } });

    expect(descriptionInput.value).toHaveLength(300);
    expect(screen.queryByText("301 / 300")).toBeNull();
    expect(screen.getByText("300 / 300").className).toContain("text-red-400");
  });

  it("Clicking button shows 'Estimating fee…' and successful simulation displays estimated XLM fee", async () => {
    (estimateCreateProposalFee as any).mockResolvedValue(0.012345);

    render(<CreateProposalModal {...defaultProps} />);
    fillTransferFields();

    const calcBtn = screen.getByText("Calculate fee");
    fireEvent.click(calcBtn);

    expect(screen.getByText("Estimating fee…")).toBeDefined();

    await waitFor(() => {
      expect(screen.getByText(/0\.0123450 XLM/)).toBeDefined();
    });
  });

  it("Submission still works after estimation failure", async () => {
    (estimateCreateProposalFee as any).mockRejectedValue(new Error("Sim Failed"));
    (createProposal as any).mockResolvedValue(undefined);

    render(<CreateProposalModal {...defaultProps} />);
    fillTransferFields();

    const calcBtn = screen.getByText("Calculate fee");
    fireEvent.click(calcBtn);

    await waitFor(() => {
      expect(screen.getByText("Could not estimate fee")).toBeDefined();
    });

    const submitBtn = screen.getByText("Review Proposal");
    fireEvent.click(submitBtn);

    expect(screen.getByText("Preview Proposal")).toBeDefined();
    expect(createProposal).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Confirm & Submit"));

    await waitFor(() => {
      expect(createProposal).toHaveBeenCalled();
      expect(defaultProps.onSubmitted).toHaveBeenCalled();
    });
  });

  it("shows a preview with entered values before submitting", () => {
    render(<CreateProposalModal {...defaultProps} />);
    fillTransferFields();

    const deadlineInput = document.querySelector(
      'input[type="date"]'
    ) as HTMLInputElement;
    const expectedDeadline = new Date(
      `${deadlineInput.value}T00:00:00`
    ).toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    fireEvent.click(screen.getByText("Review Proposal"));

    expect(screen.getByText("Preview Proposal")).toBeDefined();
    expect(screen.getByText("Transfer 10 XLM to GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC")).toBeDefined();
    expect(screen.getByText("Test payment")).toBeDefined();
    expect(screen.getByText(expectedDeadline)).toBeDefined();
    expect(createProposal).not.toHaveBeenCalled();
  });

  it("Back returns to the form with entered values preserved", () => {
    render(<CreateProposalModal {...defaultProps} />);
    fillTransferFields();

    fireEvent.click(screen.getByText("Review Proposal"));
    fireEvent.click(screen.getByText("Back"));

    expect(screen.queryByText("Preview Proposal")).toBeNull();
    expect(screen.getByPlaceholderText("G...")).toHaveValue(
      "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC"
    );
    expect(screen.getByPlaceholderText("0.00")).toHaveValue(10);
    expect(screen.getByPlaceholderText("What is this payment for?")).toHaveValue(
      "Test payment"
    );
  });

  it("Close button works from the preview step", () => {
    render(<CreateProposalModal {...defaultProps} />);
    fillTransferFields();

    fireEvent.click(screen.getByText("Review Proposal"));
    fireEvent.click(screen.getByText("✕"));

    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("Connected wallet opens modal and shows Proposer field", () => {
    render(<CreateProposalModal {...defaultProps} />);
    selectTransfer();
    expect(screen.getByText("Proposer")).toBeDefined();
  });

  it("Address is truncated to first 6 and last 4", () => {
    render(<CreateProposalModal {...defaultProps} />);
    selectTransfer();
    // Truncated version: GDHU6W…QDNC
    expect(screen.getByText("GDHU6W…QDNC")).toBeDefined();
  });

  it("shows type selector on mount", () => {
    render(<CreateProposalModal {...defaultProps} />);
    expect(screen.getByText("Transfer")).toBeDefined();
    expect(screen.getByText("Add Owner")).toBeDefined();
    expect(screen.getByText("Remove Owner")).toBeDefined();
    expect(screen.getByText("Change Threshold")).toBeDefined();
  });

  it("Add Owner flow shows owner address input", () => {
    render(<CreateProposalModal {...defaultProps} />);
    fireEvent.click(screen.getByText("Add Owner"));
    expect(screen.getByText("New Owner Address")).toBeDefined();
  });

  it("Change Threshold flow shows threshold input with owner count", () => {
    render(<CreateProposalModal {...defaultProps} />);
    fireEvent.click(screen.getByText("Change Threshold"));
    expect(screen.getByText(/New Threshold/)).toBeDefined();
  });
});
