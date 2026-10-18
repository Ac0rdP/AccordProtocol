import type { Meta, StoryObj } from "@storybook/react-vite";
import { SpendByCategoryChart } from "./SpendByCategoryChart";
import { spendByCategorySample } from "../stories/fixtures";

const meta = {
  title: "Components/SpendByCategoryChart",
  component: SpendByCategoryChart,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof SpendByCategoryChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithData: Story = { args: { data: spendByCategorySample } };
export const Loading: Story = { args: { data: [], loading: true } };
export const Empty: Story = { args: { data: [] } };
