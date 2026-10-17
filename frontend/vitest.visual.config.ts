import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // @ts-expect-error - Tailwind 4 types may mismatch with Vitest's Vite types
  plugins: [react(), tailwindcss()],
  test: {
    include: ["src/visual/**/*.visual.test.{ts,tsx}"],
    setupFiles: ["./src/visual/setup.ts"],
    environment: "jsdom",
    globals: true,
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
