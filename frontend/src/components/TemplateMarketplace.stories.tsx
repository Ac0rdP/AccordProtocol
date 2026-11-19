import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { TemplateMarketplace, TemplatePreviewDialog } from "./TemplateMarketplace";
import { BUNDLED_MARKETPLACE_CATALOG } from "../lib/templateMarketplace";

const [payroll, grant] = BUNDLED_MARKETPLACE_CATALOG;

const meta = {
  title: "Components/TemplateMarketplace",
  component: TemplateMarketplace,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-5xl">
        <Story />
      </div>
    ),
  ],
  args: {
    templates: BUNDLED_MARKETPLACE_CATALOG,
    installs: {},
    onInstall: fn(),
    onUninstall: fn(),
  },
} satisfies Meta<typeof TemplateMarketplace>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Catalog: Story = {};

export const InstalledAndUpdates: Story = {
  args: {
    installs: {
      [payroll.id]: {
        marketplaceId: payroll.id,
        version: "1.0.0",
        localTemplateId: "local-1",
        installedAt: "2026-08-01T00:00:00.000Z",
      },
      [grant.id]: {
        marketplaceId: grant.id,
        version: grant.version,
        localTemplateId: "local-2",
        installedAt: "2026-10-04T00:00:00.000Z",
      },
    },
  },
};

export const NoMatches: Story = { args: { templates: [] } };

export const Preview: Story = {
  render: () => (
    <TemplatePreviewDialog
      template={payroll}
      state="update_available"
      installedVersion="1.0.0"
      onInstall={fn()}
      onUninstall={fn()}
      onClose={fn()}
    />
  ),
};
