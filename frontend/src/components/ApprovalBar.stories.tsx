import type { Meta, StoryObj } from "@storybook/react-vite";
import { ApprovalBar } from "./ApprovalBar";

const meta = {
  title: "Components/ApprovalBar",
  component: ApprovalBar,
  tags: ["autodocs"],
} satisfies Meta<typeof ApprovalBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PartialApproval: Story = {
  args: {
    approvalWeight: 5,
    quorumWeight: 10,
    totalWeight: 10,
    approvals: 5,
    threshold: 10,
  },
};

export const QuorumReached: Story = {
  args: {
    approvalWeight: 10,
    quorumWeight: 10,
    totalWeight: 10,
    approvals: 10,
    approverAddresses: Array.from({ length: 10 }, (_, i) => `GADDR${i}`),
  },
};
