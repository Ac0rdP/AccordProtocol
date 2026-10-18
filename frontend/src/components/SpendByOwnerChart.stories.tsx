import type { Meta, StoryObj } from "@storybook/react-vite";
import { SpendByOwnerChart } from "./SpendByOwnerChart";
import { spendByOwnerSample } from "../stories/fixtures";

const meta = {
  title: "Components/SpendByOwnerChart",
  component: SpendByOwnerChart,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof SpendByOwnerChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithData: Story = { args: { data: spendByOwnerSample } };
export const Loading: Story = { args: { data: [], loading: true } };
export const Empty: Story = { args: { data: [] } };
