import "@testing-library/jest-dom";
import "vitest-axe/extend-expect";
import { vi } from "vitest";

HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as unknown as HTMLCanvasElement["getContext"];

// Provide Soroban env defaults so modules that construct rpc.Server at import
// time do not crash during unit tests that pull in contract/submit.
vi.stubEnv("VITE_SOROBAN_RPC_URL", "https://mock-rpc.test");
vi.stubEnv(
  "VITE_CONTRACT_ADDRESS",
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M",
);
vi.stubEnv("VITE_NETWORK_PASSPHRASE", "Test SDF Network ; September 2015");
vi.stubEnv(
  "VITE_SIM_SOURCE",
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
);
