import type { Meta, StoryObj } from "@storybook/react-vite";
import { ErrorBoundary } from "./ErrorBoundary";

function BrokenChild(): never {
  throw new Error("Storybook demo failure");
}

const meta = {
  title: "Components/ErrorBoundary",
  component: ErrorBoundary,
  tags: ["autodocs"],
} satisfies Meta<typeof ErrorBoundary>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Fallback: Story = {
  args: {
    children: <BrokenChild />,
  },
  parameters: {
    docs: {
      description: {
        story:
          "When a child throws, the boundary renders the reload fallback UI.",
      },
    },
  },
};

export const HealthyChild: Story = {
  args: {
    children: (
      <p className="text-sm text-zinc-400">Child rendered successfully.</p>
    ),
  },
};
