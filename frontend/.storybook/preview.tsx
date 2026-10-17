import type { Preview } from "@storybook/react-vite";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import "../src/index.css";

const preview: Preview = {
  parameters: {
    layout: "centered",
    backgrounds: {
      default: "zinc-dark",
      values: [
        { name: "zinc-dark", value: "#09090b" },
        { name: "black", value: "#000000" },
      ],
    },
    docs: {
      toc: true,
    },
  },
  decorators: [
    (Story) => (
      <MemoryRouter>
        <div className="dark min-w-[320px] bg-zinc-950 p-4 text-zinc-100">
          <Story />
        </div>
      </MemoryRouter>
    ),
  ],
};

export default preview;
