import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateMarketplacePage } from "./TemplateMarketplacePage";
import { BUNDLED_MARKETPLACE_CATALOG, fetchMarketplaceTemplates } from "../lib/templateMarketplace";
import { getProposalTemplates } from "../lib/proposalTemplates";

vi.mock("../lib/templateMarketplace", async () => {
  const actual = await vi.importActual<typeof import("../lib/templateMarketplace")>(
    "../lib/templateMarketplace",
  );
  return { ...actual, fetchMarketplaceTemplates: vi.fn() };
});

const fetchMock = vi.mocked(fetchMarketplaceTemplates);

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
});

describe("TemplateMarketplacePage", () => {
  it("shows a loading state, then the catalog", async () => {
    let resolve!: (value: typeof BUNDLED_MARKETPLACE_CATALOG) => void;
    fetchMock.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<TemplateMarketplacePage />);
    expect(screen.getByText("Loading template marketplace…")).toBeInTheDocument();
    resolve(BUNDLED_MARKETPLACE_CATALOG);
    expect(await screen.findByText(BUNDLED_MARKETPLACE_CATALOG[0].name)).toBeInTheDocument();
  });

  it("shows an empty state when the catalog has no templates", async () => {
    fetchMock.mockResolvedValue([]);
    render(<TemplateMarketplacePage />);
    expect(await screen.findByText("No community templates yet")).toBeInTheDocument();
  });

  it("shows an error with retry that recovers", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("Template marketplace responded with 503"))
      .mockResolvedValueOnce(BUNDLED_MARKETPLACE_CATALOG);
    const user = userEvent.setup();
    render(<TemplateMarketplacePage />);

    expect(await screen.findByText("Could not load the template marketplace")).toBeInTheDocument();
    expect(screen.getByText("Template marketplace responded with 503")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText(BUNDLED_MARKETPLACE_CATALOG[0].name)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("installs into the saved templates used by the New Proposal picker", async () => {
    fetchMock.mockResolvedValue(BUNDLED_MARKETPLACE_CATALOG);
    const user = userEvent.setup();
    render(<TemplateMarketplacePage />);
    const template = BUNDLED_MARKETPLACE_CATALOG[2];
    await user.click(await screen.findByRole("button", { name: `Install: ${template.name}` }));

    expect(getProposalTemplates().map((t) => t.name)).toEqual([template.name]);
    expect(screen.getByRole("button", { name: `Installed: ${template.name}` })).toBeDisabled();
  });
});
