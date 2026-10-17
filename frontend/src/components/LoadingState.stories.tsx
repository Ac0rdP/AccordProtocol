import type { Meta, StoryObj } from "@storybook/react-vite";
import { LoadingState } from "./LoadingState";

const meta = {
  title: "Components/LoadingState",
  component: LoadingState,
  tags: ["autodocs"],
} satisfies Meta<typeof LoadingState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Page: Story = { args: { variant: "page" } };
export const Section: Story = { args: { variant: "section", message: "Loading analytics…" } };
export const Inline: Story = { args: { variant: "inline" } };
