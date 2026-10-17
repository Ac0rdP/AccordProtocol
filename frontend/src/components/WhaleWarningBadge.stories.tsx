import type { Meta, StoryObj } from "@storybook/react-vite";
import { WhaleWarningBadge } from "./WhaleWarningBadge";

const meta = {
  title: "Components/WhaleWarningBadge",
  component: WhaleWarningBadge,
  tags: ["autodocs"],
} satisfies Meta<typeof WhaleWarningBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Balanced: Story = { args: { triggered: false } };
export const Triggered: Story = {
  args: { triggered: true, sharePct: 55, thresholdPct: 33.3 },
};
