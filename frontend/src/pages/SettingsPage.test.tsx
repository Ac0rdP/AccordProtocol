import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SettingsPage } from "./SettingsPage";

const OWNER = "GA2SBKSJNRPXIK664GBTV2C62HPFAXKJDR7EZFRTCFLEGBNRRYTRDANN";
const OTHER = "GDCLLWCKG4SP2WM6NVU65KQKZECPHQHDUEPUSOUJ2XXONAGCH7FLXHHU";
const NEW_GUARDIAN = "GCFYHZM6G2D47EOGJS6LV6R7MHMW2EXFZ7HRFB3B3OGKNRCIM6BRJGFQ";
const NON_OWNER = "GCH3RIWQM5DUCDWK5TSBB42WT2GOZJD5WKMR5GZO2MHFXCJGDFOBTR6U";

const mocks = vi.hoisted(() => ({
  getContractXlmBalance: vi.fn(),
  getContractUsdcBalance: vi.fn(),
  getGuardian: vi.fn(),
  isFrozen: vi.fn(),
  getRoleVersion: vi.fn(),
  getRoles: vi.fn(),
  freeze: vi.fn(),
  createSetGuardianProposal: vi.fn(),
  createUnfreezeProposal: vi.fn(),
  listNotificationDestinations: vi.fn(),
}));

vi.mock("../lib/contract", () => ({
  getContractXlmBalance: mocks.getContractXlmBalance,
  getContractUsdcBalance: mocks.getContractUsdcBalance,
  getGuardian: mocks.getGuardian,
  isFrozen: mocks.isFrozen,
  getRoleVersion: mocks.getRoleVersion,
  getRoles: mocks.getRoles,
}));

vi.mock("../lib/submit", () => ({
  freeze: mocks.freeze,
  createSetGuardianProposal: mocks.createSetGuardianProposal,
  createUnfreezeProposal: mocks.createUnfreezeProposal,
}));

vi.mock("../lib/notificationDestinations", () => ({
  listNotificationDestinations: mocks.listNotificationDestinations,
  saveNotificationDestination: vi.fn(),
  deleteNotificationDestination: vi.fn(),
  testNotificationDestination: vi.fn(),
}));

const defaultProps = {
  stats: [{ label: "Threshold", value: "2" }],
  walletAddress: OWNER,
  ownerAddresses: [OWNER, OTHER],
  onProposalSubmitted: vi.fn(),
};

describe("SettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getContractXlmBalance.mockResolvedValue("1,000.000000");
    mocks.getContractUsdcBalance.mockResolvedValue("250.000000");
    mocks.getGuardian.mockResolvedValue(OWNER);
    mocks.isFrozen.mockResolvedValue(false);
    mocks.getRoleVersion.mockResolvedValue(2);
    mocks.getRoles.mockResolvedValue(["Owner"]);
    mocks.freeze.mockResolvedValue(undefined);
    mocks.createSetGuardianProposal.mockResolvedValue(undefined);
    mocks.createUnfreezeProposal.mockResolvedValue(undefined);
    mocks.listNotificationDestinations.mockResolvedValue([]);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("loads contract details, roles and balances", async () => {
    render(<SettingsPage {...defaultProps} />);

    expect(await screen.findByText("1,000.000000 XLM")).toBeDefined();
    expect(screen.getByText("250.000000 USDC")).toBeDefined();
    expect(await screen.findByText("Owner")).toBeDefined();
    expect(screen.getByText("Active")).toBeDefined();
  });

  it("copies the contract id", async () => {
    render(<SettingsPage {...defaultProps} />);
    await screen.findByText("1,000.000000 XLM");

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        import.meta.env.VITE_CONTRACT_ADDRESS,
      );
    });
    expect(await screen.findByText("Copied!")).toBeDefined();
  });

  it("freezes the contract after confirmation when the wallet is the guardian", async () => {
    render(<SettingsPage {...defaultProps} />);
    await screen.findByText("1,000.000000 XLM");

    fireEvent.click(screen.getByRole("button", { name: "Freeze Contract" }));
    expect(screen.getByText(/Freezing will halt all proposal creation/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Confirm Freeze" }));

    await waitFor(() => expect(mocks.freeze).toHaveBeenCalledWith(OWNER));
    expect(defaultProps.onProposalSubmitted).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Frozen")).toBeDefined();
  });

  it("surfaces a freeze failure", async () => {
    mocks.freeze.mockRejectedValueOnce(new Error("Freeze rejected"));
    render(<SettingsPage {...defaultProps} />);
    await screen.findByText("1,000.000000 XLM");

    fireEvent.click(screen.getByRole("button", { name: "Freeze Contract" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Freeze" }));

    expect(await screen.findByText("Freeze rejected")).toBeDefined();
  });

  it("validates and submits a set-guardian proposal", async () => {
    render(<SettingsPage {...defaultProps} />);
    await screen.findByText("1,000.000000 XLM");

    fireEvent.click(screen.getByRole("button", { name: "Propose Change" }));
    fireEvent.click(screen.getByRole("button", { name: "Create Set Guardian Proposal" }));
    expect(await screen.findByText("Guardian address and description are required.")).toBeDefined();

    fireEvent.change(screen.getByPlaceholderText("G..."), {
      target: { value: NEW_GUARDIAN },
    });
    fireEvent.change(screen.getByPlaceholderText("Reason for guardian change"), {
      target: { value: "Rotate guardian" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Set Guardian Proposal" }));

    await waitFor(() => {
      expect(mocks.createSetGuardianProposal).toHaveBeenCalledTimes(1);
    });
    expect(mocks.createSetGuardianProposal.mock.calls[0][0]).toBe(OWNER);
    expect(mocks.createSetGuardianProposal.mock.calls[0][1]).toBe(NEW_GUARDIAN);
    expect(mocks.createSetGuardianProposal.mock.calls[0][2]).toBe("Rotate guardian");
    expect(defaultProps.onProposalSubmitted).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid guardian address", async () => {
    render(<SettingsPage {...defaultProps} />);
    await screen.findByText("1,000.000000 XLM");

    fireEvent.click(screen.getByRole("button", { name: "Propose Change" }));
    fireEvent.change(screen.getByPlaceholderText("G..."), { target: { value: "not-a-key" } });
    fireEvent.change(screen.getByPlaceholderText("Reason for guardian change"), {
      target: { value: "Rotate guardian" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Set Guardian Proposal" }));

    expect(await screen.findByText("Enter a valid Stellar address.")).toBeDefined();
    expect(mocks.createSetGuardianProposal).not.toHaveBeenCalled();
  });

  it("submits an unfreeze proposal when the contract is frozen", async () => {
    mocks.isFrozen.mockResolvedValue(true);
    render(<SettingsPage {...defaultProps} />);
    await screen.findByText("1,000.000000 XLM");
    expect(screen.getByText("Frozen")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Propose Unfreeze" }));
    fireEvent.change(screen.getByPlaceholderText("Reason for unfreezing"), {
      target: { value: "Incident resolved" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Unfreeze Proposal" }));

    await waitFor(() => {
      expect(mocks.createUnfreezeProposal).toHaveBeenCalledTimes(1);
    });
    expect(mocks.createUnfreezeProposal.mock.calls[0][0]).toBe(OWNER);
    expect(mocks.createUnfreezeProposal.mock.calls[0][1]).toBe("Incident resolved");
    expect(defaultProps.onProposalSubmitted).toHaveBeenCalledTimes(1);
  });

  it("hides privileged controls from non-owners", async () => {
    render(
      <SettingsPage
        {...defaultProps}
        walletAddress={NON_OWNER}
        ownerAddresses={[OWNER]}
      />,
    );
    await screen.findByText("1,000.000000 XLM");

    expect(screen.queryByRole("button", { name: "Freeze Contract" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Propose Change" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Propose Unfreeze" })).toBeNull();
  });
});
