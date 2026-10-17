import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { CreateWeightChangeProposalModal } from "./CreateWeightChangeProposalModal";
import { mockWallet } from "../stories/fixtures";

const meta = {
  title: "Components/CreateWeightChangeProposalModal",
  component: CreateWeightChangeProposalModal,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof CreateWeightChangeProposalModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    walletAddress: mockWallet,
    onClose: fn(),
    onSubmitted: fn(),
  },
};
