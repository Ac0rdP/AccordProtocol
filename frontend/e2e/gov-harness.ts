import { Keypair, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { Page } from "@playwright/test";
import { TEST_WALLET } from "./setup";

/**
 * Shared Soroban RPC mock used by the governance E2E specs.
 *
 * Every spec drives the app against `https://mock-rpc.test` (see
 * `playwright.config.ts`). This module owns the XDR boilerplate — the account
 * ledger entry, simulation envelope, and the transaction-result shell — and
 * exposes small handlers so each scenario only describes the contract calls it
 * cares about.
 */

export const RPC = "https://mock-rpc.test";
export const XLM_TOKEN =
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const accountId = Keypair.fromPublicKey(TEST_WALLET).xdrAccountId();

const ENTRY_B64 = new xdr.LedgerEntry({
  lastModifiedLedgerSeq: 100,
  data: xdr.LedgerEntryData.account(
    new xdr.AccountEntry({
      accountId,
      balance: xdr.Int64.fromString("100000000000"),
      seqNum: xdr.Int64.fromString("1000000000000"),
      numSubEntries: 0,
      inflationDest: null,
      flags: 0,
      homeDomain: Buffer.alloc(32),
      thresholds: Buffer.alloc(4),
      signers: [],
      ext: xdr.AccountEntryExt.fromXDR(Buffer.from([0, 0, 0, 0])),
    }),
  ),
  ext: xdr.LedgerEntryExt.fromXDR(Buffer.from([0, 0, 0, 0])),
}).toXDR("base64");

const KEY_B64 = xdr.LedgerKey.account(
  new xdr.LedgerKeyAccount({ accountId }),
).toXDR("base64");

const TX_DATA_B64 = new xdr.SorobanTransactionData({
  ext: xdr.SorobanTransactionDataExt.fromXDR(Buffer.from([0, 0, 0, 0])),
  resources: new xdr.SorobanResources({
    footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
    instructions: 1_000_000,
    diskReadBytes: 0,
    writeBytes: 0,
  }),
  resourceFee: xdr.Int64.fromString("100"),
}).toXDR("base64");

// feeCharged(int64=100) + txSUCCESS(0) + results[](len=0) + ext(v=0)
const TX_RESULT_B64 = xdr.TransactionResult.fromXDR(
  Buffer.from([0, 0, 0, 0, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
).toXDR("base64");

const TX_META_B64 = xdr.TransactionMeta.fromXDR(
  Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]),
).toXDR("base64");

export const VOID = xdr.ScVal.scvVoid();

// ─── ScVal convenience builders ─────────────────────────────────────────────
// Short aliases so each scenario reads like the contract interface it mocks.

export const u32 = (value: number): xdr.ScVal => xdr.ScVal.scvU32(value);
export const u64 = (value: number | bigint): xdr.ScVal =>
  nativeToScVal(BigInt(value), { type: "u64" });
export const i64 = (value: number | bigint): xdr.ScVal =>
  nativeToScVal(BigInt(value), { type: "i64" });
export const bool = (value: boolean): xdr.ScVal => xdr.ScVal.scvBool(value);
export const address = (value: string): xdr.ScVal =>
  nativeToScVal(value, { type: "address" });
export const native = (value: unknown): xdr.ScVal => nativeToScVal(value);
export const addrVec = (addresses: string[]): xdr.ScVal =>
  xdr.ScVal.scvVec(addresses.map(address));
export const emptyVec = (): xdr.ScVal => xdr.ScVal.scvVec([]);
export const symbolVec = (symbols: string[]): xdr.ScVal =>
  xdr.ScVal.scvVec(symbols.map((symbol) => xdr.ScVal.scvSymbol(symbol)));

export function b64(value: xdr.ScVal): string {
  return value.toXDR("base64");
}

export function getCallDetails(txBase64: string): {
  fn: string;
  args: unknown[];
} {
  try {
    const envelope = xdr.TransactionEnvelope.fromXDR(txBase64, "base64");
    const invoke = envelope
      .v1()
      .tx()
      .operations()[0]
      .body()
      .invokeHostFunctionOp()
      .hostFunction()
      .invokeContract();
    return {
      fn: Buffer.from(invoke.functionName()).toString(),
      args: invoke.args().map((arg) => scValToNative(arg)),
    };
  } catch {
    return { fn: "", args: [] };
  }
}

function simResult(id: unknown, retvalB64: string) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      cost: { cpuInsns: "1000", memBytes: "2000" },
      results: [{ auth: [], xdr: retvalB64 }],
      minResourceFee: "100",
      transactionData: TX_DATA_B64,
      events: [],
      latestLedger: 1000,
    },
  };
}

export type SimulateHandler = (fn: string, args: unknown[]) => xdr.ScVal;
export type SendHandler = (fn: string, args: unknown[]) => void;

/**
 * Installs the mock RPC. `simulate` maps a read-only contract call to its
 * return value; `send` observes state-changing calls submitted to the network.
 */
export async function installGovernanceRpc(
  page: Page,
  handlers: {
    simulate: SimulateHandler;
    send?: SendHandler;
    events?: unknown[];
  },
): Promise<void> {
  let lastEnvelopeXdr = "";

  await page.route(`${RPC}/**`, async (route) => {
    const body = route.request().postDataJSON() as {
      id: unknown;
      method: string;
      params?: { transaction?: string };
    };

    if (body.method === "getLedgerEntries") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            entries: [
              { key: KEY_B64, xdr: ENTRY_B64, lastModifiedLedgerSeq: 100 },
            ],
            latestLedger: 1000,
          },
        }),
      });
    }

    if (body.method === "simulateTransaction") {
      const { fn, args } = getCallDetails(body.params?.transaction ?? "");
      const retval = handlers.simulate(fn, args) ?? VOID;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(simResult(body.id, b64(retval))),
      });
    }

    if (body.method === "sendTransaction") {
      const { fn, args } = getCallDetails(body.params?.transaction ?? "");
      lastEnvelopeXdr = body.params?.transaction ?? "";
      handlers.send?.(fn, args);
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { hash: "mock-tx-hash", status: "PENDING" },
        }),
      });
    }

    if (body.method === "getTransaction") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            status: "SUCCESS",
            ledger: 1000,
            createdAt: Math.floor(Date.now() / 1000),
            envelopeXdr: lastEnvelopeXdr,
            resultXdr: TX_RESULT_B64,
            resultMetaXdr: TX_META_B64,
            latestLedger: 1000,
            latestLedgerCloseTime: Math.floor(Date.now() / 1000),
          },
        }),
      });
    }

    if (body.method === "getLatestLedger") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { id: "mock-ledger", sequence: 1000, protocolVersion: "22" },
        }),
      });
    }

    if (body.method === "getEvents") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { events: handlers.events ?? [], latestLedger: 1000 },
        }),
      });
    }

    await route.continue();
  });
}
