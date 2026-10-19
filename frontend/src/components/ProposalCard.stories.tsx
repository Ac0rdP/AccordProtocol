import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ProposalCard } from "./ProposalCard";
import { baseProposal, mockWallet } from "../stories/fixtures";

const meta = {
  title: "Components/ProposalCard",
  component: ProposalCard,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    onApprove: fn(),
    onExecute: fn(),
    onRevoke: fn(),
    walletRoles: ["Owner", "Approver", "Executor"],
  },
} satisfies Meta<typeof ProposalCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Pending: Story = {
  args: {
    proposal: baseProposal(),
    walletAddress: mockWallet,
  },
};

export const Ready: Story = {
  args: {
    proposal: baseProposal({ status: "ready", approvalWeight: 10, approvals: 2 }),
    walletAddress: mockWallet,
  },
};

export const Executed: Story = {
  args: {
    proposal: baseProposal({ status: "executed", executedAt: "Mar 1, 2026" }),
    walletAddress: null,
  },
};
