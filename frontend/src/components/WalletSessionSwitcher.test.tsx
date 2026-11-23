import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WalletSessionSwitcher } from "./WalletSessionSwitcher";
import type { WalletState } from "../hooks/useWallet";
import { ACCEPTANCE_VIEWPORTS, setViewport } from "../test/viewport";
import type { WalletSession } from "../lib/walletProviders";

function makeWallet(overrides: Partial<WalletState> = {}): WalletState {
  return {
    installed: true,
    address: null,
    connecting: false,
    connectingProvider: null,
    networkMismatch: false,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    sessions: [],
    activeSession: null,
    activeProvider: null,
    error: null,
    clearError: vi.fn(),
    connectProvider: vi.fn().mockResolvedValue(null),
    switchSession: vi.fn(),
    removeSession: vi.fn(),
    ...overrides,
  };
}

const SAMPLE_SESSIONS: WalletSession[] = [
  {
    id: "freighter:GAAA1111111111111111",
    provider: "freighter",
    address: "GAAA1111111111111111",
    label: "Freighter Main",
    connectedAt: 1,
  },
  {
    id: "ledger:GBBB2222222222222222",
    provider: "ledger",
    address: "GBBB2222222222222222",
    label: "Ledger (44'/148'/0')",
    derivationPath: "44'/148'/0'",
    connectedAt: 2,
  },
];

describe("WalletSessionSwitcher", () => {
  it("renders empty, loading, and error states", () => {
    const clearError = vi.fn();
    const wallet = makeWallet({
      connecting: true,
      connectingProvider: "ledger",
      error: "Ledger device locked",
      clearError,
    });

    render(<WalletSessionSwitcher wallet={wallet} defaultOpen />);

    expect(screen.getByTestId("wallet-sessions-empty")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Connecting Ledger/i);
    expect(screen.getByRole("alert")).toHaveTextContent("Ledger device locked");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(clearError).toHaveBeenCalledTimes(1);
  });

  it("switches and removes sessions without reconnecting Freighter", () => {
    const switchSession = vi.fn();
    const removeSession = vi.fn();
    const wallet = makeWallet({
      address: SAMPLE_SESSIONS[0].address,
      sessions: SAMPLE_SESSIONS,
      activeSession: SAMPLE_SESSIONS[0],
      activeProvider: "freighter",
      switchSession,
      removeSession,
    });

    render(<WalletSessionSwitcher wallet={wallet} defaultOpen />);

    fireEvent.click(screen.getByText("Ledger (44'/148'/0')"));
    expect(switchSession).toHaveBeenCalledWith(SAMPLE_SESSIONS[1].id);

    fireEvent.click(screen.getByRole("button", { name: "Remove Freighter Main session" }));
    expect(removeSession).toHaveBeenCalledWith(SAMPLE_SESSIONS[0].id);
  });

  it("supports keyboard navigation across provider tabs and closes on Escape", () => {
    const connectProvider = vi.fn().mockResolvedValue(null);
    const wallet = makeWallet({ connectProvider });

    render(<WalletSessionSwitcher wallet={wallet} />);

    const trigger = screen.getByRole("button", { name: /Connect Wallet/i });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: /Wallet sessions and providers/i })).toBeInTheDocument();

    const freighterTab = screen.getByRole("tab", { name: /Freighter/i });
    fireEvent.keyDown(freighterTab, { key: "ArrowRight" });
    expect(screen.getByText(/Secret keys are never exposed/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Connect Ledger Device/i }));
    expect(connectProvider).toHaveBeenCalledWith("ledger", { derivationPath: "44'/148'/0'" });

    fireEvent.click(screen.getByRole("tab", { name: /WC/i }));
    fireEvent.click(screen.getByRole("button", { name: /Connect via WalletConnect/i }));
    expect(connectProvider).toHaveBeenCalledWith(
      "walletconnect",
      expect.objectContaining({ pairingUri: expect.stringMatching(/^wc:/) })
    );

    fireEvent.click(screen.getByRole("tab", { name: /Passkey/i }));
    fireEvent.click(screen.getByRole("button", { name: /Sign in with Passkey/i }));
    expect(connectProvider).toHaveBeenCalledWith("passkey", {
      passkeyMode: "login",
      label: undefined,
    });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(ACCEPTANCE_VIEWPORTS)("renders cleanly at %ipx viewport", (width) => {
    setViewport(width);
    const wallet = makeWallet({
      address: SAMPLE_SESSIONS[0].address,
      sessions: SAMPLE_SESSIONS,
      activeSession: SAMPLE_SESSIONS[0],
      activeProvider: "freighter",
    });

    render(<WalletSessionSwitcher wallet={wallet} defaultOpen />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Wallet Sessions")).toBeInTheDocument();
  });
});
