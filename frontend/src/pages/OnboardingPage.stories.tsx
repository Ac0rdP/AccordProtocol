import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { MemoryRouter } from "react-router-dom";
import { OnboardingPage } from "./OnboardingPage";
import type { WalletState } from "../hooks/useWallet";
import i18n from "../i18n";

const connectedWallet: WalletState = {
  installed: true,
  address: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC",
  connecting: false,
  networkMismatch: false,
  connect: fn(),
  disconnect: fn(),
};

const disconnectedWallet: WalletState = {
  installed: true,
  address: null,
  connecting: false,
  networkMismatch: false,
  connect: fn(),
  disconnect: fn(),
};

const meta = {
  title: "Pages/OnboardingPage",
  component: OnboardingPage,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <MemoryRouter>
        <div className="min-h-screen bg-black text-white p-6">
          <Story />
        </div>
      </MemoryRouter>
    ),
  ],
  args: {
    wallet: connectedWallet,
    onComplete: fn(),
  },
} satisfies Meta<typeof OnboardingPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    wallet: connectedWallet,
  },
};

export const Disconnected: Story = {
  args: {
    wallet: disconnectedWallet,
  },
};

export const Loading: Story = {
  args: {
    wallet: connectedWallet,
    loading: true,
  },
};

export const ErrorState: Story = {
  args: {
    wallet: connectedWallet,
    error: "Failed to initialize wallet connection or multisig parameters.",
    onRetry: fn(),
  },
};

export const ArabicRTL: Story = {
  args: {
    wallet: connectedWallet,
  },
  decorators: [
    (Story) => {
      void i18n.changeLanguage("ar");
      return (
        <div dir="rtl" lang="ar">
          <Story />
        </div>
      );
    },
  ],
};
