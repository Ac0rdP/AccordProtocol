import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProposalActivityChart } from "./ProposalActivityChart";
import { baseProposal } from "../stories/fixtures";

const meta = {
  title: "Components/ProposalActivityChart",
  component: ProposalActivityChart,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof ProposalActivityChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithProposals: Story = {
  args: {
    proposals: [
      baseProposal({ id: 1, createdAt: "2026-01-05" }),
      baseProposal({ id: 2, status: "executed", createdAt: "2026-01-12" }),
    ],
  },
};

export const Loading: Story = { args: { proposals: [], loading: true } };
export const Empty: Story = { args: { proposals: [] } };
