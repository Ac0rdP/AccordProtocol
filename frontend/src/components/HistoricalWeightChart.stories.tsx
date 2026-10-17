import type { Meta, StoryObj } from "@storybook/react-vite";
import { HistoricalWeightChart } from "./HistoricalWeightChart";

const meta = {
  title: "Components/HistoricalWeightChart",
  component: HistoricalWeightChart,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof HistoricalWeightChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithHistory: Story = {
  args: { currentTotalWeight: 20 },
};

export const Loading: Story = {
  args: { currentTotalWeight: 20, loading: true },
};
