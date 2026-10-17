import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, nativeToScVal, StrKey, xdr } from "@stellar/stellar-sdk";
import { openLedgerStore } from "../src/ledger.js";

const tempDirectories = [];

export const sender = Keypair.random().publicKey();

export function contractAddress(byte) {
  return StrKey.encodeContract(Buffer.alloc(32, byte));
}

export function encoded(value, type) {
  return xdr.ScVal.fromXDR(nativeToScVal(value, { type }).toXDR("base64"), "base64");
}

export function target({
  id = "testnet-a",
  network = "testnet",
  contractId = contractAddress(1),
  tokens = [{ name: "USDC", address: contractAddress(2) }],
  startLedger = 40,
} = {}) {
  return {
    id,
    network,
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://example.invalid",
    contractId,
    simulationSource: sender,
    startLedger,
    tokens,
    key: `${network}/${contractId}`,
  };
}

export function transferEvent({
  id = "event-1",
  contractId,
  from = sender,
  to,
  amount = 125n,
  ledger = 42,
  ledgerClosedAt = "2026-09-27T12:00:00Z",
} = {}) {
  return {
    id,
    contractId,
    ledger,
    ledgerClosedAt,
    txHash: "transaction-hash",
    topic: [encoded("transfer", "symbol"), encoded(from, "address"), encoded(to, "address")],
    value: encoded(amount, "i128"),
  };
}

export function createTempDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "accord-indexer-"));
  tempDirectories.push(directory);
  return directory;
}

export function createStore(options) {
  return openLedgerStore(join(createTempDirectory(), "ledger.sqlite"), options);
}

export function cleanupTempDirectories() {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** A stubbed RPC server that replays a fixed list of getEvents responses. */
export function stubStellar(responses) {
  const requests = [];
  return {
    requests,
    getEvents: async (request) => {
      requests.push(request);
      const response = responses.shift();
      if (!response) throw new Error("stub ran out of getEvents responses");
      return response;
    },
  };
}
