import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { BulkActionWorkflow } from "./BulkActionWorkflow";
import { baseProposal, mockWallet } from "../stories/fixtures";

const proposals = [
  baseProposal({ id: 11, status: "ready", description: "Pay Q4 audit invoice", amount: "4,500", token: "USDC" }),
  baseProposal({ id: 12, status: "ready", description: "Grant tranche — Stellar tooling", amount: "10,000", token: "XLM" }),
  baseProposal({ id: 13, status: "ready", description: "RPC provider, November", amount: "450", token: "USDC" }),
  baseProposal({ id: 14, status: "pending", description: "Contributor payroll", amount: "2,500", token: "USDC" }),
  baseProposal({ id: 15, status: "pending", description: "Event sponsorship", amount: "750", token: "XLM" }),
];

const meta = {
  title: "Components/BulkActionWorkflow",
  component: BulkActionWorkflow,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-3xl">
        <Story />
      </div>
    ),
  ],
  args: {
    proposals,
    walletAddress: mockWallet,
    onApprove: fn(async () => {}),
    onExecute: fn(async () => {}),
    onBatchComplete: fn(),
    onConnectWallet: fn(),
  },
} satisfies Meta<typeof BulkActionWorkflow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ExecuteReadyProposals: Story = {};

export const ApprovePending: Story = { args: { initialAction: "approve" } };

export const NothingEligible: Story = {
  args: {
    proposals: [baseProposal({ id: 20, status: "pending" })],
    initialAction: "execute",
  },
};

export const WalletDisconnected: Story = { args: { walletAddress: null } };
