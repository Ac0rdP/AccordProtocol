import type { Meta, StoryObj } from "@storybook/react-vite";
import { describe, expect, test } from "vitest";
import { renderStory } from "./renderStory";

import BulkActionWorkflowMeta, * as BulkActionWorkflowStories from "../components/BulkActionWorkflow.stories";
import TemplateMarketplaceMeta, * as TemplateMarketplaceStories from "../components/TemplateMarketplace.stories";
import OwnerAvailabilityCalendarMeta, * as OwnerAvailabilityCalendarStories from "../components/OwnerAvailabilityCalendar.stories";
import NotificationScheduleFormMeta, * as NotificationScheduleFormStories from "../components/NotificationScheduleForm.stories";

// Several stories render dates/times; pin the zone so snapshots match on every machine.
process.env.TZ = "UTC";

type StoryModule = Record<string, unknown>;

const groups: Array<{ label: string; meta: Meta<unknown>; mod: StoryModule }> = [
  { label: "BulkActionWorkflow", meta: BulkActionWorkflowMeta as Meta<unknown>, mod: BulkActionWorkflowStories },
  { label: "TemplateMarketplace", meta: TemplateMarketplaceMeta as Meta<unknown>, mod: TemplateMarketplaceStories },
  { label: "OwnerAvailabilityCalendar", meta: OwnerAvailabilityCalendarMeta as Meta<unknown>, mod: OwnerAvailabilityCalendarStories },
  { label: "NotificationScheduleForm", meta: NotificationScheduleFormMeta as Meta<unknown>, mod: NotificationScheduleFormStories },
];

describe("feature-expansion story visual snapshots", () => {
  for (const { label, meta, mod } of groups) {
    for (const [id, story] of Object.entries(mod)) {
      if (id === "default") continue;
      test(`${label} / ${id}`, () => {
        const { container } = renderStory(meta, story as StoryObj<unknown>);
        expect(container.firstChild).toMatchSnapshot();
      });
    }
  }
});
