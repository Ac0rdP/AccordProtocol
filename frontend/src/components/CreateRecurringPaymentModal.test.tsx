import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";
import { CreateRecurringPaymentModal } from "./CreateRecurringPaymentModal";
import { createRecurringPaymentProposal } from "../lib/submit";

vi.mock("../lib/submit", () => ({
  createRecurringPaymentProposal: vi.fn(),
}));

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

describe("CreateRecurringPaymentModal", () => {
  const defaultProps = {
    walletAddress: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC",
    onClose: vi.fn(),
    onSubmitted: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (StrKey.isValidEd25519PublicKey as any).mockReturnValue(true);
  });

  function fillBaseFields(container: HTMLElement) {
    fireEvent.change(screen.getByPlaceholderText("G..."), {
      target: { value: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHB" },
    });
    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByPlaceholderText("2592000"), {
      target: { value: "604800" },
    });

    const dateInputs = container.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: "2026-09-01" } });
    fireEvent.change(dateInputs[1], { target: { value: "" } });
    fireEvent.change(dateInputs[2], { target: { value: "" } });
  }

  it("rejects an invalid recipient address", async () => {
    (StrKey.isValidEd25519PublicKey as any).mockReturnValue(false);
    const { container } = render(<CreateRecurringPaymentModal {...defaultProps} />);

    fillBaseFields(container);
    fireEvent.click(screen.getByRole("button", { name: "Create Recurring Payment" }));

    expect(screen.getAllByText("Enter a valid Stellar address.")).toHaveLength(2);
    expect(createRecurringPaymentProposal).not.toHaveBeenCalled();
  });

  it("rejects an end date before the start date", async () => {
    const { container } = render(<CreateRecurringPaymentModal {...defaultProps} />);

    fillBaseFields(container);
    const dateInputs = container.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[2], { target: { value: "2026-08-30" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Recurring Payment" }));

    expect(screen.getByText("End must be after start.")).toBeTruthy();
    expect(createRecurringPaymentProposal).not.toHaveBeenCalled();
  });

  it("submits the recurring payment proposal with converted values", async () => {
    const { container } = render(<CreateRecurringPaymentModal {...defaultProps} />);

    fillBaseFields(container);
    fireEvent.click(screen.getByRole("button", { name: "Create Recurring Payment" }));

    await waitFor(() => {
      expect(createRecurringPaymentProposal).toHaveBeenCalledTimes(1);
    });

    expect(createRecurringPaymentProposal).toHaveBeenCalledWith(
      defaultProps.walletAddress,
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHB",
      "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      100000000n,
      604800n,
      1788220800n,
      null,
      null,
      null,
      "Payroll"
    );
    expect(defaultProps.onSubmitted).toHaveBeenCalledTimes(1);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });
});
