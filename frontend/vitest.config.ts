import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "src/visual/**",
    ],
    coverage: {
      provider: "v8",
      // `all` is what makes untested code visible: a module with no test at
      // all still shows up at 0% instead of being silently omitted.
      all: true,
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        // Entry points, type-only files and dev wiring carry no testable logic.
        "src/main.tsx",
        "src/vite-env.d.ts",
        "src/**/*.d.ts",
        "src/types/**",
        // Story files and visual-regression sources are exercised by the
        // Storybook workflow, not by this suite.
        "src/**/*.stories.{ts,tsx}",
        "src/visual/**",
        // The harness and its fixtures are test infrastructure; harness.test.ts
        // covers them directly, so counting them here would double-count.
        "src/test/**",
        // Test files themselves.
        "src/**/*.{test,spec}.{ts,tsx}",
      ],
      // Reporting: text in the CI log for humans, lcov + html for artefacts,
      // and json-summary so the threshold policy can be diffed per area.
      reporter: ["text-summary", "lcov", "html", "json-summary"],
      reportsDirectory: "coverage",
      // Thresholds are the enforcement half of issue #796. They fail the run
      // (and therefore CI) when coverage regresses.
      //
      // Every number below is a *ratchet*, set just under what the suite
      // measured when this policy landed (see frontend/docs/testing.md for the
      // recorded measurements). The contract is one-directional: these numbers
      // may only go up, and only in a PR that raises real coverage to match.
      thresholds: {
        lines: 50,
        functions: 55,
        statements: 50,
        branches: 68,
        // Per-area floors. Areas are governed individually so a gain in one
        // area cannot mask a regression in another.
        "src/lib/**": { lines: 52, functions: 54, statements: 52, branches: 70 },
        "src/hooks/**": { lines: 40, functions: 68, statements: 40, branches: 80 },
        "src/components/**": { lines: 60, functions: 57, statements: 60, branches: 62 },
        "src/pages/**": { lines: 37, functions: 48, statements: 37, branches: 70 },
      },
    },
  },
});
