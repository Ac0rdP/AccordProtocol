import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { GrantRevokeRoleModal } from "./GrantRevokeRoleModal";
import { mockWallet } from "../stories/fixtures";

const meta = {
  title: "Components/GrantRevokeRoleModal",
  component: GrantRevokeRoleModal,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof GrantRevokeRoleModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Grant: Story = {
  args: {
    walletAddress: mockWallet,
    ownerAddresses: [mockWallet],
    threshold: 2,
    onClose: fn(),
    onSubmitted: fn(),
  },
};
