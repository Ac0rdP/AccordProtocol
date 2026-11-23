import { defineConfig } from "vitest/config";

// Pin the config to this package so a vite/vitest config in a parent
// directory is never picked up when running the SDK suite.
export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
  },
});
