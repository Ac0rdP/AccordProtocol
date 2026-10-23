import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CreateProposalModal } from "./CreateProposalModal";
import { vi, describe, it, expect, beforeEach } from "vitest";
import { createProposal } from "../lib/submit";
import { StrKey } from "@stellar/stellar-sdk";

vi.mock("../lib/submit", () => ({
  createProposal: vi.fn(),
  createAddOwnerProposal: vi.fn(),
  createRemoveOwnerProposal: vi.fn(),
  createChangeThresholdProposal: vi.fn(),
  estimateCreateProposalFee: vi.fn(),
  createChangeOwnerWeightProposal: vi.fn(),
}));

vi.mock("../lib/contract", () => ({
  getOwners: vi.fn().mockResolvedValue([
    "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC",
    "GBPLX2P3VWYKPQ7L5RI5OGXQ6T4G7QZMJ3HPQD7FZX5KJ3H2Z4YK5ABC",
  ]),
  getThreshold: vi.fn().mockResolvedValue(2),
  getRequiredQuorumWeight: vi.fn().mockResolvedValue(2),
  getOwnerWeights: vi.fn().mockResolvedValue({
    GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC: 1,
    GBPLX2P3VWYKPQ7L5RI5OGXQ6T4G7QZMJ3HPQD7FZX5KJ3H2Z4YK5ABC: 1,
  }),
  getTotalWeight: vi.fn().mockResolvedValue(2),
  getWeightCapPct: vi.fn().mockResolvedValue(50),
}));

vi.mock("../lib/transactionPreview", () => ({
  previewTransferProposal: vi.fn().mockResolvedValue({
    feeEstimate: 0.0001,
    feeError: null,
    balances: [],
  }),
}));

vi.mock("@stellar/stellar-sdk", async () => {
  const original = (await vi.importActual("@stellar/stellar-sdk")) as any;
  return {
    ...original,
    StrKey: {
      ...original.StrKey,
      isValidEd25519PublicKey: vi.fn().mockReturnValue(true),
    },
  };
});

describe("CreateProposalModal - 375px Mobile Viewport", () => {
  const defaultProps = {
    walletAddress: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC",
    onClose: vi.fn(),
    onSubmitted: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (StrKey.isValidEd25519PublicKey as any).mockReturnValue(true);
    // Simulate 375px mobile viewport dimensions
    window.innerWidth = 375;
    window.innerHeight = 667;
  });

  it("renders mobile-optimized close button and type options with accessible touch targets", () => {
    render(<CreateProposalModal {...defaultProps} />);

    const closeBtn = screen.getByRole("button", { name: /close modal/i });
    expect(closeBtn).toBeDefined();
    expect(closeBtn.className).toContain("min-h-[44px]");
    expect(closeBtn.className).toContain("min-w-[44px]");

    // Verify type options have minimum 48px touch targets
    const transferBtn = screen.getByRole("button", { name: /transfer/i });
    expect(transferBtn.className).toContain("min-h-[48px]");
  });

  it("provides mobile-friendly keyboards and minimum 44px height on form inputs", () => {
    render(<CreateProposalModal {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: /transfer/i }));

    const recipientInput = screen.getByPlaceholderText("G...");
    expect(recipientInput.className).toContain("min-h-[44px]");
    expect(recipientInput.className).toContain("text-base");

    const amountInput = screen.getByPlaceholderText("0.00");
    expect(amountInput.className).toContain("min-h-[44px]");
    expect(amountInput.getAttribute("inputmode")).toBe("decimal");

    // Token buttons have 44px touch targets
    const xlmBtn = screen.getByRole("button", { name: "XLM" });
    expect(xlmBtn.className).toContain("min-h-[44px]");
  });

  it("completes full mobile proposal creation flow without breaking", async () => {
    vi.mocked(createProposal).mockResolvedValue(1 as any);
    render(<CreateProposalModal {...defaultProps} />);

    // Step 1: Select Type on mobile
    fireEvent.click(screen.getByRole("button", { name: /transfer/i }));

    // Step 2: Fill Form on mobile
    fireEvent.change(screen.getByPlaceholderText("G..."), {
      target: { value: "GBPLX2P3VWYKPQ7L5RI5OGXQ6T4G7QZMJ3HPQD7FZX5KJ3H2Z4YK5ABC" },
    });
    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "100" },
    });
    fireEvent.change(screen.getByPlaceholderText("What is this payment for?"), {
      target: { value: "Mobile Treasury Disbursement" },
    });

    const reviewBtn = screen.getByRole("button", { name: /review proposal/i });
    expect(reviewBtn.className).toContain("min-h-[44px]");
    fireEvent.click(reviewBtn);

    // Step 3: Review Preview on mobile
    expect(screen.getByText("Preview Proposal")).toBeDefined();
    expect(screen.getByText(/Mobile Treasury Disbursement/i)).toBeDefined();

    const submitBtn = screen.getByRole("button", { name: /confirm & submit/i });
    expect(submitBtn.className).toContain("min-h-[44px]");
    await waitFor(() => expect(submitBtn).not.toBeDisabled());
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(createProposal).toHaveBeenCalled();
      expect(defaultProps.onSubmitted).toHaveBeenCalled();
      expect(defaultProps.onClose).toHaveBeenCalled();
    });
  });

  it("handles Change Threshold mobile inputs with numeric keyboard", () => {
    render(<CreateProposalModal {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: /change threshold/i }));

    const thresholdInput = screen.getByPlaceholderText("1 – 1");
    expect(thresholdInput.getAttribute("inputmode")).toBe("numeric");
    expect(thresholdInput.className).toContain("min-h-[44px]");
  });
});
