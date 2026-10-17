import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { CreateRecurringPaymentModal } from "./CreateRecurringPaymentModal";
import { mockWallet } from "../stories/fixtures";

const meta = {
  title: "Components/CreateRecurringPaymentModal",
  component: CreateRecurringPaymentModal,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof CreateRecurringPaymentModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    walletAddress: mockWallet,
    onClose: fn(),
    onSubmitted: fn(),
  },
};
