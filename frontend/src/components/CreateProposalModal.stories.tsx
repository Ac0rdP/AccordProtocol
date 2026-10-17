import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { CreateProposalModal } from "./CreateProposalModal";
import { mockWallet } from "../stories/fixtures";

const meta = {
  title: "Components/CreateProposalModal",
  component: CreateProposalModal,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof CreateProposalModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TypeSelection: Story = {
  args: {
    walletAddress: mockWallet,
    onClose: fn(),
    onSubmitted: fn(),
  },
};
