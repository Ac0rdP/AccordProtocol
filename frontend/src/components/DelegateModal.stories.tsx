import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { DelegateModal } from "./DelegateModal";
import { mockWallet } from "../stories/fixtures";

const meta = {
  title: "Components/DelegateModal",
  component: DelegateModal,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof DelegateModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    walletAddress: mockWallet,
    ownerWeight: 8,
    candidates: [
      { address: "GBPLX2P3VWYKPQ7L5RI5OGXQ6T4G7QZMJ3HPQD7FZX5KJ3H2Z4YK5ABC", label: "Bob" },
    ],
    onClose: fn(),
    onSubmitted: fn(),
  },
};
