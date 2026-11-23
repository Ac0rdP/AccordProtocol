import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationMarketplacePage } from "./IntegrationMarketplacePage";
import {
  BUNDLED_INTEGRATIONS,
  fetchIntegrationMarketplace,
  getInstalledIntegrations,
} from "../lib/integrationMarketplace";

vi.mock("../lib/integrationMarketplace", async () => {
  const actual = await vi.importActual<typeof import("../lib/integrationMarketplace")>(
    "../lib/integrationMarketplace",
  );
  return { ...actual, fetchIntegrationMarketplace: vi.fn() };
});

const fetchMock = vi.mocked(fetchIntegrationMarketplace);

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
});

describe("IntegrationMarketplacePage", () => {
  it("shows a loading state, then the reviewed catalog with permissions and data boundaries", async () => {
    let resolve!: (value: {
      catalog: typeof BUNDLED_INTEGRATIONS;
      installs: Record<string, never>;
    }) => void;
    fetchMock.mockReturnValue(new Promise((r) => (resolve = r)));

    render(<IntegrationMarketplacePage />);
    expect(screen.getByText("Loading integration marketplace…")).toBeInTheDocument();

    resolve({ catalog: BUNDLED_INTEGRATIONS, installs: {} });
    expect(await screen.findByText("Slack Notifications")).toBeInTheDocument();
    expect(screen.getAllByText(/Permissions:/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Data boundary:/i).length).toBeGreaterThan(0);
  });

  it("shows an empty state when no integrations are returned", async () => {
    fetchMock.mockResolvedValue({ catalog: [], installs: {} });
    render(<IntegrationMarketplacePage />);
    expect(await screen.findByText("No reviewed integrations available")).toBeInTheDocument();
  });

  it("shows an error state with retry that recovers", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("Integration marketplace responded with 503"))
      .mockResolvedValueOnce({ catalog: BUNDLED_INTEGRATIONS, installs: {} });

    const user = userEvent.setup();
    render(<IntegrationMarketplacePage />);

    expect(
      await screen.findByText("Could not load the integration marketplace"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText("Slack Notifications")).toBeInTheDocument();
  });

  it("validates required configuration and installs/uninstalls without operator intervention", async () => {
    fetchMock.mockResolvedValue({ catalog: BUNDLED_INTEGRATIONS, installs: {} });
    const user = userEvent.setup();
    render(<IntegrationMarketplacePage />);

    await user.click(await screen.findByRole("button", { name: "Install: Slack Notifications" }));
    await user.click(screen.getByRole("button", { name: "Save & enable Slack Notifications" }));

    expect(await screen.findByText("Slack channel label is required.")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("#treasury-alerts"), "#ops-alerts");
    await user.click(screen.getByRole("button", { name: "Save & enable Slack Notifications" }));

    expect(
      await screen.findByRole("button", { name: "Uninstall: Slack Notifications" }),
    ).toBeInTheDocument();
    expect(getInstalledIntegrations()["slack-notifications"]?.config.channelLabel).toBe(
      "#ops-alerts",
    );

    await user.click(screen.getByRole("button", { name: "Uninstall: Slack Notifications" }));
    expect(
      await screen.findByRole("button", { name: "Install: Slack Notifications" }),
    ).toBeInTheDocument();
  });

  it("filters integrations by category", async () => {
    fetchMock.mockResolvedValue({ catalog: BUNDLED_INTEGRATIONS, installs: {} });
    const user = userEvent.setup();
    render(<IntegrationMarketplacePage />);

    await screen.findByText("Slack Notifications");
    await user.click(screen.getByRole("tab", { name: "Accounting" }));
    expect(screen.getByText("QuickBooks Accounting Sync")).toBeInTheDocument();
    expect(screen.queryByText("Slack Notifications")).not.toBeInTheDocument();
  });
});
