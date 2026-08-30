import { Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { expect, test, TEST_WALLET } from "./setup";

const RPC = "https://mock-rpc.test";
const OWNERS = [
  "GA37572K2O4WHDGLI2UM4CNTMYZDZI4V5AZL4GJV7AQGR3HMVTVRXDKP",
  "GCOTL5HEOY6ZC453QWAAIYL2QTZWNXWWU4PF22TK22YBZE6XLBIQHUH2",
  "GCCZUKX7LI3MSLUA4MIIN3LSO43DTBPJMHBPSTUQISDLMZMPOJU3ANWJ",
];
const OWNER_WEIGHTS = [
  { owner: OWNERS[0], weight: 12 },
  { owner: OWNERS[1], weight: 7 },
  { owner: OWNERS[2], weight: 1 },
];

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
const KEY_B64 = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId })).toXDR("base64");
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

function getFunctionName(transaction: string): string {
  const envelope = xdr.TransactionEnvelope.fromXDR(transaction, "base64");
  const functionName = envelope
    .v1()
    .tx()
    .operations()[0]
    .body()
    .invokeHostFunctionOp()
    .hostFunction()
    .invokeContract()
    .functionName();
  return Buffer.from(functionName).toString();
}

function simulationResult(id: unknown, retval: string) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      cost: { cpuInsns: "1000", memBytes: "2000" },
      results: [{ auth: [], xdr: retval }],
      minResourceFee: "100",
      transactionData: TX_DATA_B64,
      events: [],
      latestLedger: 1000,
    },
  };
}

test("owners weight distribution chart visual regression", async ({ page }) => {
  await page.route(`${RPC}/**`, async (route) => {
    const body = route.request().postDataJSON() as {
      id: unknown;
      method: string;
      params?: { transaction?: string };
    };

    if (body.method === "getLedgerEntries") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { entries: [{ key: KEY_B64, xdr: ENTRY_B64, lastModifiedLedgerSeq: 100 }], latestLedger: 1000 },
        }),
      });
      return;
    }

    if (body.method !== "simulateTransaction") {
      await route.continue();
      return;
    }

    const functionName = getFunctionName(body.params?.transaction ?? "");
    const resultByFunction: Record<string, string> = {
      get_owners: xdr.ScVal.scvVec(OWNERS.map((owner) => nativeToScVal(owner, { type: "address" }))).toXDR("base64"),
      get_threshold: nativeToScVal(15, { type: "u32" }).toXDR("base64"),
      get_total_proposals: nativeToScVal(0n, { type: "u64" }).toXDR("base64"),
      get_owner_weights: xdr.ScVal.scvVec(
        OWNER_WEIGHTS.map(({ owner, weight }) => nativeToScVal({ owner, weight: BigInt(weight) })),
      ).toXDR("base64"),
      get_required_quorum_weight: nativeToScVal(15, { type: "u32" }).toXDR("base64"),
      get_active_delegations: xdr.ScVal.scvVec([]).toXDR("base64"),
      get_recurring_payments: xdr.ScVal.scvVec([]).toXDR("base64"),
      is_frozen: xdr.ScVal.scvBool(false).toXDR("base64"),
      get_spending_limit: nativeToScVal(-1n, { type: "i64" }).toXDR("base64"),
    };

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(simulationResult(body.id, resultByFunction[functionName] ?? xdr.ScVal.scvVoid().toXDR("base64"))),
    });
  });

  await page.goto("/app/owners");
  const chart = page.getByTestId("weight-distribution-chart");
  await expect(chart).toBeVisible();
  await expect(chart.getByRole("img")).toHaveCount(3);
  await expect(chart).toHaveScreenshot("owners-weight-distribution.png");
});
