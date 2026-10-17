import type { Meta, StoryObj } from "@storybook/react-vite";
import { VotingPowerPreview } from "./VotingPowerPreview";

const meta = {
  title: "Components/VotingPowerPreview",
  component: VotingPowerPreview,
  tags: ["autodocs"],
} satisfies Meta<typeof VotingPowerPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AddOwner: Story = {
  args: {
    beforeWeight: 20,
    afterWeight: 21,
    totalWeight: 21,
    type: "add_owner",
  },
};

export const RemoveOwner: Story = {
  args: {
    beforeWeight: 5,
    afterWeight: 0,
    totalWeight: 15,
    type: "remove_owner",
    threshold: 10,
  },
};

export const ChangeWeightWithWarning: Story = {
  args: {
    beforeWeight: 4,
    afterWeight: 12,
    totalWeight: 28,
    type: "change_owner_weight",
    weightCapPct: 50,
    warning: {
      show: true,
      message: "This change would exceed the configured weight cap.",
    },
  },
};
