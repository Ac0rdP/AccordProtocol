import type { Meta, StoryObj } from "@storybook/react-vite";
import { GovernanceImpactBadge } from "./GovernanceImpactBadge";

const meta = {
  title: "Components/GovernanceImpactBadge",
  component: GovernanceImpactBadge,
  tags: ["autodocs"],
} satisfies Meta<typeof GovernanceImpactBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Low: Story = { args: { impact: "low" } };
export const Medium: Story = { args: { impact: "medium" } };
export const High: Story = { args: { impact: "high" } };
export const Critical: Story = { args: { impact: "critical" } };
