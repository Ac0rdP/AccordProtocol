import type { Meta, StoryObj } from "@storybook/react-vite";
import { EmptyState } from "./EmptyState";

const meta = {
  title: "Components/EmptyState",
  component: EmptyState,
  tags: ["autodocs"],
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Page: Story = {
  args: {
    title: "No proposals yet",
    description: "Create a proposal to kick off treasury governance.",
    variant: "page",
  },
};

export const Section: Story = {
  args: {
    title: "No matching results",
    variant: "section",
  },
};
