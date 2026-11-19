/**
 * @accord-protocol/sdk
 * Official TypeScript SDK for Accord Protocol Multisig Smart Contracts
 */

export { AccordClient } from "./client.js";
export type { AccordClientConfig } from "./client.js";

export * from "./types.js";
export * from "./errors.js";
export * from "./validation.js";
export * from "./conversion.js";

// Developer tooling. These modules do not import AccordClient or
// @stellar/stellar-sdk, so they tree-shake independently (see bundle-budgets.json).
export * from "./abi.js";
export * from "./codegen.js";
export * from "./release.js";
export * from "./bundle-budget.js";
export * from "./resilience.js";
export * from "./events.js";
export * from "./cli.js";
export * from "./react.js";
