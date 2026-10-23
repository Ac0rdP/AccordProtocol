import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { PWAInstallBanner } from "./PWAInstallBanner";

const pwa = vi.hoisted(() => ({
  promptInstall: vi.fn(),
  dismiss: vi.fn(),
  canInstall: true,
}));

vi.mock("../lib/pwa", () => ({
  usePWAInstall: () => ({
    canInstall: pwa.canInstall,
    promptInstall: pwa.promptInstall,
    dismiss: pwa.dismiss,
  }),
}));

describe("PWAInstallBanner", () => {
  it("renders nothing when the app cannot be installed", () => {
    pwa.canInstall = false;
    render(<PWAInstallBanner />);
    expect(screen.queryByTestId("pwa-install-banner")).toBeNull();
  });

  it("prompts install and dismisses the banner", () => {
    pwa.canInstall = true;
    render(<PWAInstallBanner />);

    expect(screen.getByTestId("pwa-install-banner")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(pwa.promptInstall).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss install prompt" }));
    expect(pwa.dismiss).toHaveBeenCalledTimes(1);
  });
});
