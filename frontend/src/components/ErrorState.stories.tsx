import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ErrorState } from "./ErrorState";

const meta = {
  title: "Components/ErrorState",
  component: ErrorState,
  tags: ["autodocs"],
} satisfies Meta<typeof ErrorState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Page: Story = {
  args: {
    message: "Failed to load proposals.",
    onRetry: fn(),
    variant: "page",
  },
};

export const Banner: Story = {
  args: {
    message: "Indexer unreachable — showing cached data.",
    onDismiss: fn(),
    variant: "banner",
  },
};
