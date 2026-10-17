import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { TreasuryBalanceChart } from "./TreasuryBalanceChart";
import { treasuryBalanceSample } from "../stories/fixtures";

const meta = {
  title: "Components/TreasuryBalanceChart",
  component: TreasuryBalanceChart,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof TreasuryBalanceChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithData: Story = { args: { data: treasuryBalanceSample } };
export const Loading: Story = { args: { data: [], loading: true } };
export const Error: Story = {
  args: {
    data: [],
    error: "Failed to fetch treasury balances",
    onRetry: fn(),
  },
};
