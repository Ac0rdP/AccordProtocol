import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { RecurringPaymentCard } from "./RecurringPaymentCard";
import { mockWallet, sampleSchedule } from "../stories/fixtures";

const meta = {
  title: "Components/RecurringPaymentCard",
  component: RecurringPaymentCard,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof RecurringPaymentCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Active: Story = {
  args: {
    schedule: sampleSchedule,
    walletAddress: mockWallet,
    onDisburse: fn(),
    onPause: fn(),
    onResume: fn(),
    onCancel: fn(),
  },
};

export const Paused: Story = {
  args: {
    schedule: { ...sampleSchedule, status: "paused" },
    walletAddress: mockWallet,
  },
};
