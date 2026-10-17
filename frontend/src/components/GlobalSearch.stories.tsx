import type { Meta, StoryObj } from "@storybook/react-vite";
import { GlobalSearch } from "./GlobalSearch";
import { baseProposal, sampleOwners } from "../stories/fixtures";

const meta = {
  title: "Components/GlobalSearch",
  component: GlobalSearch,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof GlobalSearch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    proposals: [baseProposal({ description: "Ops stipend", id: 7 })],
    owners: sampleOwners,
  },
};

export const WithQuery: Story = {
  args: {
    proposals: [baseProposal({ description: "Ops stipend", id: 7 })],
    owners: sampleOwners,
  },
  render: (args) => {
    return (
      <div className="w-full max-w-md">
        <GlobalSearch {...args} />
      </div>
    );
  },
};
