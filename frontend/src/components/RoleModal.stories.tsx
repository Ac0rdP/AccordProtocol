import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { RoleModal } from "./RoleModal";
import { mockWallet } from "../stories/fixtures";

const meta = {
  title: "Components/RoleModal",
  component: RoleModal,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof RoleModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  args: {
    isOpen: true,
    targetAddress: mockWallet,
    targetLabel: "Alice",
    currentRoles: ["Owner", "Approver"],
    onClose: fn(),
    onGrantRole: fn(),
    onRevokeRole: fn(),
  },
};
