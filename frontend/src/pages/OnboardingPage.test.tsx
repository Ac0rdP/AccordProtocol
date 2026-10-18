import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import {
  OnboardingPage,
  ONBOARDING_STORAGE_KEY,
  loadOnboardingProgress,
} from "./OnboardingPage";
import type { WalletState } from "../hooks/useWallet";

const mockWallet: WalletState = {
  installed: true,
  address: "GDEPLOYER111111111111111111111111111111111111111111111111111",
  connecting: false,
  networkMismatch: false,
  connect: vi.fn(),
  disconnect: vi.fn(),
};

describe("OnboardingPage", () => {
  let store: Record<string, string> = {};

  beforeEach(() => {
    store = {};
    const mockStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, val: string) => {
        store[key] = val;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
    };
    Object.defineProperty(window, "localStorage", {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  it("renders step 1 (Wallet Connect) and detects connected wallet", () => {
    render(
      <MemoryRouter>
        <OnboardingPage wallet={mockWallet} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("step-wallet")).toBeTruthy();
    expect(screen.getByText("Connected Wallet")).toBeTruthy();
    expect(screen.getByText(mockWallet.address!)).toBeTruthy();
  });

  it("navigates through steps and validates owner inputs", () => {
    render(
      <MemoryRouter>
        <OnboardingPage wallet={mockWallet} />
      </MemoryRouter>,
    );

    // Step 1 -> Step 2
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByTestId("step-owners")).toBeTruthy();

    // Owner address is auto-populated with deployer address
    const ownerInput = screen.getByLabelText("Owner 1 address") as HTMLInputElement;
    expect(ownerInput.value).toBe(mockWallet.address);

    // Add another owner
    fireEvent.click(screen.getByRole("button", { name: /add owner/i }));
    const ownerInputs = screen.getAllByPlaceholderText(/Stellar Public Key/i);
    expect(ownerInputs.length).toBe(2);

    // Try to advance with empty owner address
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Owner #2 address cannot be empty/i)).toBeTruthy();

    // Fill in second owner address
    fireEvent.change(ownerInputs[1], {
      target: { value: "GSECOND222222222222222222222222222222222222222222222222222" },
    });

    // Step 2 -> Step 3
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByTestId("step-threshold")).toBeTruthy();
  });

  it("validates threshold against total voting weight", () => {
    render(
      <MemoryRouter>
        <OnboardingPage wallet={mockWallet} />
      </MemoryRouter>,
    );

    // Advance to step 3
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));

    const thresholdInput = screen.getByLabelText("Required Quorum Weight") as HTMLInputElement;
    // Enter threshold greater than total weight (total is 1)
    fireEvent.change(thresholdInput, { target: { value: "5" } });

    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(/cannot exceed total voting weight/i)).toBeTruthy();
  });

  it("persists progress across sessions in localStorage", () => {
    const savedState = {
      currentStep: 3,
      owners: [{ address: "GSAVED111", weight: 2 }],
      threshold: 2,
      timeLockDelay: 3600,
      firstProposal: {
        recipient: "GRECIP",
        amount: "50",
        token: "XLM",
        description: "Test",
      },
      completed: false,
    };
    store[ONBOARDING_STORAGE_KEY] = JSON.stringify(savedState);

    render(
      <MemoryRouter>
        <OnboardingPage wallet={mockWallet} />
      </MemoryRouter>,
    );

    // Should resume directly on step 3
    expect(screen.getByTestId("step-threshold")).toBeTruthy();
    const thresholdInput = screen.getByLabelText("Required Quorum Weight") as HTMLInputElement;
    expect(thresholdInput.value).toBe("2");
  });

  it("completes setup on the final step and shows success screen", () => {
    const onComplete = vi.fn();
    render(
      <MemoryRouter>
        <OnboardingPage wallet={mockWallet} onComplete={onComplete} />
      </MemoryRouter>,
    );

    // Navigate to step 4
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));

    expect(screen.getByTestId("step-proposal")).toBeTruthy();

    // Complete setup
    fireEvent.click(screen.getByTestId("complete-onboarding-btn"));

    expect(screen.getByTestId("onboarding-completed")).toBeTruthy();
    expect(screen.getByText("Multisig Setup Complete!")).toBeTruthy();
    expect(onComplete).toHaveBeenCalled();
    expect(store["accord_onboarding_completed"]).toBe("true");
  });
});
