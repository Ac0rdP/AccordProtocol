import type { Meta, StoryObj } from "@storybook/react-vite";
import { WalletSessionSwitcher } from "./WalletSessionSwitcher";
import type { WalletState } from "../hooks/useWallet";
import type { WalletSession } from "../lib/walletProviders";

const noop = () => {};
const noopAsync = async () => {};

const baseWallet: WalletState = {
  installed: true,
  address: null,
  connecting: false,
  connectingProvider: null,
  networkMismatch: false,
  connect: noopAsync,
  disconnect: noop,
  sessions: [],
  activeSession: null,
  activeProvider: null,
  error: null,
  clearError: noop,
  connectProvider: async () => null,
  switchSession: noop,
  removeSession: noop,
};

const demoSessions: WalletSession[] = [
  {
    id: "freighter:GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
    provider: "freighter",
    address: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
    label: "Freighter",
    connectedAt: 1700000000000,
  },
  {
    id: "ledger:GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR",
    provider: "ledger",
    address: "GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR",
    label: "Ledger (44'/148'/0')",
    derivationPath: "44'/148'/0'",
    connectedAt: 1700000001000,
  },
  {
    id: "passkey:CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    provider: "passkey",
    address: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    label: "Treasury Passkey",
    credentialId: "demo-cred-1",
    connectedAt: 1700000002000,
  },
];

const meta: Meta<typeof WalletSessionSwitcher> = {
  title: "Components/WalletSessionSwitcher",
  component: WalletSessionSwitcher,
  parameters: {
    layout: "padded",
  },
};

export default meta;
type Story = StoryObj<typeof WalletSessionSwitcher>;

export const Empty: Story = {
  args: {
    wallet: baseWallet,
    defaultOpen: true,
  },
};

export const MultiSessionConnected: Story = {
  args: {
    wallet: {
      ...baseWallet,
      address: demoSessions[0].address,
      sessions: demoSessions,
      activeSession: demoSessions[0],
      activeProvider: "freighter",
    },
    defaultOpen: true,
  },
};

export const ConnectingLedger: Story = {
  args: {
    wallet: {
      ...baseWallet,
      connecting: true,
      connectingProvider: "ledger",
    },
    defaultOpen: true,
  },
};

export const ConnectionError: Story = {
  args: {
    wallet: {
      ...baseWallet,
      error: "Ledger device locked. Unlock your device and open the Stellar app.",
    },
    defaultOpen: true,
  },
};
