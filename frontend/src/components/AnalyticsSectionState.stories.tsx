import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { AnalyticsSectionState } from "./AnalyticsSectionState";

const meta = {
  title: "Components/AnalyticsSectionState",
  component: AnalyticsSectionState,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof AnalyticsSectionState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  args: {
    loading: true,
    error: null,
    empty: false,
    emptyMessage: "",
    children: null,
  },
};

export const Error: Story = {
  args: {
    loading: false,
    error: "Analytics API unavailable",
    empty: false,
    emptyMessage: "",
    onRetry: fn(),
    children: null,
  },
};

export const Empty: Story = {
  args: {
    loading: false,
    error: null,
    empty: true,
    emptyMessage: "No data for this range.",
    children: null,
  },
};

export const WithContent: Story = {
  args: {
    loading: false,
    error: null,
    empty: false,
    emptyMessage: "",
    children: (
      <div className="h-48 flex items-center justify-center text-sm text-zinc-400">
        Chart content
      </div>
    ),
  },
};
