import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_RPC_URL,
  DEFAULT_TESTNET_CONTRACT_ID,
  PUBLIC_PASSPHRASE,
  TESTNET_PASSPHRASE,
  readConfig,
} from "./config";

describe("mobile configuration", () => {
  it("defaults to the same testnet contract and RPC as the web app", () => {
    const config = readConfig({});
    assert.equal(config.contractId, DEFAULT_TESTNET_CONTRACT_ID);
    assert.equal(
      config.contractId,
      "CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS",
    );
    assert.equal(config.rpcUrl, DEFAULT_RPC_URL);
    assert.equal(config.networkPassphrase, TESTNET_PASSPHRASE);
    assert.equal(config.network, "TESTNET");
  });

  it("honours public EXPO_PUBLIC_* overrides", () => {
    const config = readConfig({
      EXPO_PUBLIC_SOROBAN_RPC_URL: " https://rpc.example ",
      EXPO_PUBLIC_NETWORK_PASSPHRASE: PUBLIC_PASSPHRASE,
      EXPO_PUBLIC_CONTRACT_ADDRESS: " CUSTOM_CONTRACT ",
      EXPO_PUBLIC_SIM_SOURCE: "GSIM",
      EXPO_PUBLIC_WALLET_CALLBACK_URL: "accord://custom",
    });
    assert.deepEqual(config, {
      rpcUrl: "https://rpc.example",
      networkPassphrase: PUBLIC_PASSPHRASE,
      contractId: "CUSTOM_CONTRACT",
      simSource: "GSIM",
      walletCallbackUrl: "accord://custom",
      network: "PUBLIC",
    });
  });

  it("ignores blank overrides", () => {
    const config = readConfig({
      EXPO_PUBLIC_CONTRACT_ADDRESS: "   ",
      EXPO_PUBLIC_SOROBAN_RPC_URL: "",
    });
    assert.equal(config.contractId, DEFAULT_TESTNET_CONTRACT_ID);
    assert.equal(config.rpcUrl, DEFAULT_RPC_URL);
  });
});
