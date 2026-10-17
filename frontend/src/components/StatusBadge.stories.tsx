import type { Meta, StoryObj } from "@storybook/react-vite";
import { StatusBadge } from "./StatusBadge";

const meta = {
  title: "Components/StatusBadge",
  component: StatusBadge,
  tags: ["autodocs"],
} satisfies Meta<typeof StatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Pending: Story = { args: { status: "pending" } };
export const Ready: Story = { args: { status: "ready" } };
export const Executed: Story = { args: { status: "executed" } };
export const Expired: Story = { args: { status: "expired" } };
export const Revoked: Story = { args: { status: "revoked" } };
