import { defineConfig } from "@playwright/test";

const TEST_G = "GDJSB22NWBU7IV44SHHG6WO6AJTUED2KNKWL2DYNJJ5X7M5SG7UVC7JD";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    env: {
      VITE_SOROBAN_RPC_URL: "https://mock-rpc.test",
      VITE_CONTRACT_ADDRESS: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      VITE_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      VITE_SIM_SOURCE: TEST_G,
    },
  },
});
