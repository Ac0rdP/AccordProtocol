import type { Meta, StoryObj } from "@storybook/react-vite";
import { GovernanceHealthWidget } from "./GovernanceHealthWidget";

const meta = {
  title: "Components/GovernanceHealthWidget",
  component: GovernanceHealthWidget,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof GovernanceHealthWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Balanced: Story = {
  args: {
    weights: { G1: 8, G2: 7, G3: 5 },
    totalWeight: 20,
  },
};

export const Concentrated: Story = {
  args: {
    weights: { G1: 14, G2: 4, G3: 2 },
    totalWeight: 20,
    warningThresholdPct: 33.33,
  },
};

export const Loading: Story = {
  args: {
    weights: {},
    totalWeight: 0,
    loading: true,
  },
};
