import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { StrKey } from "@stellar/stellar-sdk";
import { vi, describe, it, expect, beforeEach } from "vitest";
import { GrantRevokeRoleModal } from "./GrantRevokeRoleModal";
import {
  createGrantRoleProposal,
  createRevokeRoleProposal,
} from "../lib/submit";

vi.mock("../lib/submit", () => ({
  createGrantRoleProposal: vi.fn(),
  createRevokeRoleProposal: vi.fn(),
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

describe("GrantRevokeRoleModal", () => {
  const ownerAddress =
    "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC";
  const secondOwner =
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHB";
  const newOwner = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB4K";

  const defaultProps = {
    walletAddress: ownerAddress,
    ownerAddresses: [ownerAddress, secondOwner],
    threshold: 1,
    onClose: vi.fn(),
    onSubmitted: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (StrKey.isValidEd25519PublicKey as any).mockReturnValue(true);
  });

  function fillBaseFields(target = newOwner) {
    fireEvent.change(screen.getByPlaceholderText("G..."), {
      target: { value: target },
    });
    fireEvent.change(screen.getByPlaceholderText("Why should this role change?"), {
      target: { value: "Rotate signer set" },
    });
  }

  it("blocks granting the Owner role to an existing owner", () => {
    render(<GrantRevokeRoleModal {...defaultProps} />);

    fillBaseFields(secondOwner);
    fireEvent.click(screen.getByRole("button", { name: "Submit Role Proposal" }));

    expect(screen.getByText("That address already has the Owner role.")).toBeTruthy();
    expect(createGrantRoleProposal).not.toHaveBeenCalled();
    expect(createRevokeRoleProposal).not.toHaveBeenCalled();
  });

  it("blocks revoking the Owner role from an address that is not an owner", () => {
    render(<GrantRevokeRoleModal {...defaultProps} />);

    fillBaseFields(newOwner);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit Role Proposal" }));

    expect(
      screen.getByText("That address does not currently have the Owner role.")
    ).toBeTruthy();
    expect(createGrantRoleProposal).not.toHaveBeenCalled();
    expect(createRevokeRoleProposal).not.toHaveBeenCalled();
  });

  it("submits grant proposals through the grant wrapper", async () => {
    (createGrantRoleProposal as any).mockResolvedValue(undefined);
    render(<GrantRevokeRoleModal {...defaultProps} />);

    fillBaseFields(newOwner);
    fireEvent.change(screen.getByLabelText("Deadline"), {
      target: { value: "2026-09-30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit Role Proposal" }));

    await waitFor(() => {
      expect(createGrantRoleProposal).toHaveBeenCalledTimes(1);
    });
    expect(createGrantRoleProposal).toHaveBeenCalledWith(
      ownerAddress,
      newOwner,
      "Owner",
      "Rotate signer set",
      1790726400n
    );
    expect(createRevokeRoleProposal).not.toHaveBeenCalled();
    expect(defaultProps.onSubmitted).toHaveBeenCalledTimes(1);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it("submits revoke proposals through the revoke wrapper", async () => {
    (createRevokeRoleProposal as any).mockResolvedValue(undefined);
    render(<GrantRevokeRoleModal {...defaultProps} threshold={1} />);

    fillBaseFields(secondOwner);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    fireEvent.change(screen.getByLabelText("Deadline"), {
      target: { value: "2026-09-30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit Role Proposal" }));

    await waitFor(() => {
      expect(createRevokeRoleProposal).toHaveBeenCalledTimes(1);
    });
    expect(createRevokeRoleProposal).toHaveBeenCalledWith(
      ownerAddress,
      secondOwner,
      "Owner",
      "Rotate signer set",
      1790726400n
    );
    expect(createGrantRoleProposal).not.toHaveBeenCalled();
  });
});
