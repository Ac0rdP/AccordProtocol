import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import {
  CancelRecurringModal,
  ModifyRecurringModal,
  PauseRecurringModal,
  ResumeRecurringModal,
} from "./RecurringPaymentActionModals";
import { mockWallet } from "../stories/fixtures";

const sharedArgs = {
  scheduleId: 3,
  walletAddress: mockWallet,
  onClose: fn(),
  onSubmitted: fn(),
};

const meta = {
  title: "Components/RecurringPaymentActionModals",
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const Pause: Story = {
  render: () => <PauseRecurringModal {...sharedArgs} />,
};

export const Resume: Story = {
  render: () => <ResumeRecurringModal {...sharedArgs} />,
};

export const Cancel: Story = {
  render: () => <CancelRecurringModal {...sharedArgs} />,
};

export const Modify: Story = {
  render: () => (
    <ModifyRecurringModal
      {...sharedArgs}
      currentAmount="50"
      currentInterval={2_592_000}
    />
  ),
};
