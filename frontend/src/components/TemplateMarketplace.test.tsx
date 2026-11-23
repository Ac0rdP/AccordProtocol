import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateMarketplace } from "./TemplateMarketplace";
import {
  BUNDLED_MARKETPLACE_CATALOG,
  type InstalledMarketplaceTemplate,
} from "../lib/templateMarketplace";
import { ACCEPTANCE_VIEWPORTS, setViewport } from "../test/viewport";

const templates = BUNDLED_MARKETPLACE_CATALOG;
const payroll = templates[0];

function setup(
  overrides: Partial<React.ComponentProps<typeof TemplateMarketplace>> = {},
) {
  const props = {
    templates,
    installs: {} as Record<string, InstalledMarketplaceTemplate>,
    onInstall: vi.fn(),
    onUninstall: vi.fn(),
    ...overrides,
  };
  const user = userEvent.setup();
  const utils = render(<TemplateMarketplace {...props} />);
  return { user, props, ...utils };
}

beforeEach(() => localStorage.clear());

describe("TemplateMarketplace", () => {
  it("shows every template with category and version metadata", () => {
    setup();
    expect(screen.getByText(`Showing ${templates.length} of ${templates.length} templates`)).toBeInTheDocument();
    const card = screen.getByRole("heading", { name: payroll.name }).closest("li")!;
    expect(within(card).getByText(payroll.category)).toBeInTheDocument();
    expect(within(card).getByText(`v${payroll.version}`)).toBeInTheDocument();
    expect(within(card).getByText(new RegExp(`By ${payroll.author}`))).toBeInTheDocument();
  });

  it("filters by search text and category, with an empty state and reset", async () => {
    const { user } = setup();
    await user.selectOptions(screen.getByLabelText("Category"), "Grant");
    expect(screen.getAllByRole("heading", { level: 3 }).length).toBe(
      templates.filter((t) => t.category === "Grant").length,
    );
    await user.type(screen.getByLabelText("Search templates"), "no such template");
    expect(screen.getByText("No templates match your filters")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByLabelText("Search templates")).toHaveValue("");
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(templates.length);
  });

  it("installs a template and announces where to find it", async () => {
    const { user, props } = setup();
    await user.click(screen.getByRole("button", { name: `Install: ${payroll.name}` }));
    expect(props.onInstall).toHaveBeenCalledWith(payroll);
    expect(screen.getByRole("status")).toHaveTextContent(/New Proposal template picker/);
  });

  it("shows installed and update-available states", () => {
    const installs = {
      [payroll.id]: {
        marketplaceId: payroll.id,
        version: "1.0.0",
        localTemplateId: "t1",
        installedAt: "",
      },
      [templates[1].id]: {
        marketplaceId: templates[1].id,
        version: templates[1].version,
        localTemplateId: "t2",
        installedAt: "",
      },
    };
    setup({ installs });
    expect(
      screen.getByRole("button", { name: `Update to v${payroll.version}: ${payroll.name}` }),
    ).toBeEnabled();
    expect(screen.getByText("v1.0.0 installed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Installed: ${templates[1].name}` })).toBeDisabled();
  });

  it("reports install errors", async () => {
    const onInstall = vi.fn(() => {
      throw new Error("Could not save the template. Browser storage is unavailable.");
    });
    const { user } = setup({ onInstall });
    await user.click(screen.getByRole("button", { name: `Install: ${payroll.name}` }));
    expect(screen.getByRole("alert")).toHaveTextContent("Browser storage is unavailable");
  });

  describe("preview dialog", () => {
    it("shows pre-filled fields and version details, and installs from the dialog", async () => {
      const { user, props } = setup();
      await user.click(screen.getByRole("button", { name: `Preview ${payroll.name}` }));
      const dialog = screen.getByRole("dialog", { name: payroll.name });
      expect(within(dialog).getByText(payroll.description)).toBeInTheDocument();
      expect(within(dialog).getByText(payroll.fields.amount!)).toBeInTheDocument();
      expect(within(dialog).getByText("Not installed")).toBeInTheDocument();
      expect(within(dialog).getByText(payroll.changelog!)).toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "Install" }));
      expect(props.onInstall).toHaveBeenCalledWith(payroll);
    });

    it("offers uninstall for installed templates", async () => {
      const installs = {
        [payroll.id]: { marketplaceId: payroll.id, version: payroll.version, localTemplateId: "t", installedAt: "" },
      };
      const { user, props } = setup({ installs });
      await user.click(screen.getByRole("button", { name: `Preview ${payroll.name}` }));
      await user.click(screen.getByRole("button", { name: "Uninstall" }));
      expect(props.onUninstall).toHaveBeenCalledWith(payroll.id);
    });

    it("traps focus, closes on Escape, and returns focus to the trigger", async () => {
      const { user } = setup();
      const trigger = screen.getByRole("button", { name: `Preview ${payroll.name}` });
      trigger.focus();
      await user.keyboard("{Enter}");

      const dialog = screen.getByRole("dialog");
      const close = within(dialog).getByRole("button", { name: "Close preview" });
      expect(close).toHaveFocus();

      await user.tab({ shift: true });
      expect(within(dialog).getByRole("button", { name: "Install" })).toHaveFocus();
      await user.tab();
      expect(close).toHaveFocus();

      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });

    it("does not let app-wide shortcuts fire underneath the dialog", async () => {
      const onWindowKey = vi.fn();
      window.addEventListener("keydown", onWindowKey);
      const { user } = setup();
      await user.click(screen.getByRole("button", { name: `Preview ${payroll.name}` }));
      await user.keyboard("n");
      expect(onWindowKey).not.toHaveBeenCalled();
      window.removeEventListener("keydown", onWindowKey);
    });
  });

  it.each(ACCEPTANCE_VIEWPORTS)("browses, previews and installs with the keyboard at %ipx", async (width) => {
    setViewport(width);
    const { user, props } = setup();

    await user.tab();
    expect(screen.getByLabelText("Search templates")).toHaveFocus();
    await user.keyboard("bounty");
    await user.tab();
    expect(screen.getByLabelText("Category")).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: /preview bug bounty payout/i })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Bug bounty payout" })).toBeInTheDocument();
    await user.tab(); // Install inside dialog
    await user.keyboard("{Enter}");
    expect(props.onInstall).toHaveBeenCalledWith(
      expect.objectContaining({ id: "bug-bounty-payout" }),
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("has no axe violations in the grid or the preview dialog", async () => {
    const { user, container } = setup();
    expect((await axe(container)).violations).toEqual([]);
    await user.click(screen.getByRole("button", { name: `Preview ${payroll.name}` }));
    expect((await axe(container)).violations).toEqual([]);
  });
});
