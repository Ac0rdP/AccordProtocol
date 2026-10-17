import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProposalCardSkeleton } from "./ProposalCardSkeleton";

const meta = {
  title: "Components/ProposalCardSkeleton",
  component: ProposalCardSkeleton,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof ProposalCardSkeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
