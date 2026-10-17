import type { Meta, StoryObj } from "@storybook/react-vite";
import { TreasuryFlowChart } from "./TreasuryFlowChart";
import { treasuryFlowSample } from "../stories/fixtures";

const meta = {
  title: "Components/TreasuryFlowChart",
  component: TreasuryFlowChart,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof TreasuryFlowChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithData: Story = { args: { data: treasuryFlowSample } };
export const Loading: Story = { args: { data: [], loading: true } };
export const Empty: Story = { args: { data: [] } };
