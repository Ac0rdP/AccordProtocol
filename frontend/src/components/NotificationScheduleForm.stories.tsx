import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { NotificationScheduleForm } from "./NotificationScheduleForm";
import { DEFAULT_NOTIFICATION_SCHEDULE } from "../lib/notificationSchedule";

// Fixed clock so stories and visual snapshots are deterministic.
const NOW = Date.UTC(2026, 10, 19, 12);

const meta = {
  title: "Components/NotificationScheduleForm",
  component: NotificationScheduleForm,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-2xl">
        <Story />
      </div>
    ),
  ],
  args: {
    schedule: DEFAULT_NOTIFICATION_SCHEDULE,
    onSave: fn(),
    queue: [],
    onClearQueue: fn(),
    now: NOW,
  },
} satisfies Meta<typeof NotificationScheduleForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Defaults: Story = {};

export const QuietHoursAndWeeklyDigest: Story = {
  args: {
    schedule: {
      quietHours: { enabled: true, start: "22:00", end: "07:00" },
      digest: { frequency: "weekly", time: "08:30", weekday: 1 },
    },
  },
};

export const WithQueuedAlerts: Story = {
  args: {
    schedule: {
      quietHours: { enabled: true, start: "22:00", end: "07:00" },
      digest: { frequency: "daily", time: "09:00", weekday: 1 },
    },
    queue: [
      {
        id: "q1",
        type: "proposal_ready",
        title: "Proposal Ready",
        body: "Proposal #12 has reached quorum and is ready to execute.",
        createdAt: "2026-11-19T23:10:00.000Z",
        reason: "quiet",
      },
      {
        id: "q2",
        type: "proposal_approved",
        title: "Proposal Approved",
        body: "Proposal #14 received a new approval (2/3).",
        createdAt: "2026-11-19T10:05:00.000Z",
        reason: "digest",
      },
    ],
  },
};
