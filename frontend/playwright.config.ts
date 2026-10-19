import { defineConfig, devices } from "@playwright/test";
import { ANALYTICS_API_BASE_URL } from "./e2e/analytics-fixture";

const TEST_G = "GDJSB22NWBU7IV44SHHG6WO6AJTUED2KNKWL2DYNJJ5X7M5SG7UVC7JD";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: true,
  reporter: process.env.CI
    ? [
        ["list"],
        ["html", { outputFolder: "playwright-report", open: "never" }],
        ["json", { outputFile: "playwright-report/results.json" }],
      ]
    : [["list"], ["html", { open: "on-failure" }]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    // Cross-browser matrix
    {
      name: "chromium",
      testIgnore: /responsive-screenshots\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      testIgnore: /responsive-screenshots\.spec\.ts/,
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      testIgnore: /responsive-screenshots\.spec\.ts/,
      use: { ...devices["Desktop Safari"] },
    },
    // Backwards compatibility alias for single project runs
    {
      name: "e2e",
      testIgnore: /responsive-screenshots\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    // Responsive viewport testing
    {
      name: "responsive-375",
      testMatch: /responsive-screenshots\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 900 } },
    },
    {
      name: "responsive-768",
      testMatch: /responsive-screenshots\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 900 } },
    },
    {
      name: "responsive-1440",
      testMatch: /responsive-screenshots\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    env: {
      VITE_SOROBAN_RPC_URL: "https://mock-rpc.test",
      VITE_CONTRACT_ADDRESS: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      VITE_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      VITE_SIM_SOURCE: TEST_G,
      VITE_API_BASE_URL: ANALYTICS_API_BASE_URL,
    },
  },
});
