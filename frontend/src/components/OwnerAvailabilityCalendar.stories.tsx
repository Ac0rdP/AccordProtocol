import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { AvailabilityEditorDialog, OwnerAvailabilityCalendar } from "./OwnerAvailabilityCalendar";
import { baseProposal } from "../stories/fixtures";
import { DEFAULT_WINDOWS } from "../lib/ownerAvailability";
import type { Owner } from "../types/accord";

// Fixed clock so stories and visual snapshots are deterministic: Thu 2026-11-19 12:00 UTC.
const NOW = Date.UTC(2026, 10, 19, 12);
const inHours = (h: number) => Math.floor((NOW + h * 3_600_000) / 1000);

const owners: Owner[] = [
  { address: "GAAA…0001", fullAddress: "GAAA0001", label: "Alice", roles: ["Owner"], weight: 4 },
  { address: "GBBB…0002", fullAddress: "GBBB0002", label: "Bob", roles: ["Owner"], weight: 3 },
  { address: "GCCC…0003", fullAddress: "GCCC0003", label: "Cara", roles: ["Owner"], weight: 2 },
];

const meta = {
  title: "Components/OwnerAvailabilityCalendar",
  component: OwnerAvailabilityCalendar,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-4xl">
        <Story />
      </div>
    ),
  ],
  args: {
    owners,
    proposals: [],
    availability: {
      GBBB0002: [
        { day: 2, start: 14, end: 22 },
        { day: 4, start: 14, end: 22 },
        { day: 6, start: 10, end: 14 },
      ],
    },
    onSaveAvailability: fn(),
    now: NOW,
  },
} satisfies Meta<typeof OwnerAvailabilityCalendar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ThisWeek: Story = {};

export const WithTimeSensitiveProposals: Story = {
  args: {
    proposals: [
      baseProposal({
        id: 31,
        description: "Emergency RPC failover payment",
        deadlineTs: inHours(8),
        quorumWeight: 6,
        approvalWeight: 2,
        approverAddresses: ["GCCC0003"],
      }),
      baseProposal({
        id: 32,
        description: "Weekend grant release",
        deadlineTs: inHours(40),
        quorumWeight: 20,
        approvalWeight: 0,
        approverAddresses: [],
      }),
    ],
  },
};

export const EditHours: Story = {
  render: () => (
    <AvailabilityEditorDialog
      ownerName="Alice"
      initial={DEFAULT_WINDOWS}
      onSave={fn()}
      onCancel={fn()}
    />
  ),
};
