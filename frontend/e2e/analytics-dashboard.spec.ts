import { Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { expect, test } from "./setup";
import { EXPECTED } from "./analytics-fixture";

const RPC = "https://mock-rpc.test";
const TEST_G = "GDJSB22NWBU7IV44SHHG6WO6AJTUED2KNKWL2DYNJJ5X7M5SG7UVC7JD";

const accountId = Keypair.fromPublicKey(TEST_G).xdrAccountId();
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
  return Buffer.from(
    envelope
      .v1()
      .tx()
      .operations()[0]
      .body()
      .invokeHostFunctionOp()
      .hostFunction()
      .invokeContract()
      .functionName(),
  ).toString();
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

// Everything the dashboard chrome around the analytics page needs from the
// (unrelated) Soroban RPC on mount, so it loads without errors while the
// analytics page itself is served by the fixture API from global-setup.ts.
const RPC_RESULT_BY_FUNCTION: Record<string, string> = {
  get_owners: xdr.ScVal.scvVec([]).toXDR("base64"),
  get_threshold: nativeToScVal(2, { type: "u32" }).toXDR("base64"),
  get_total_proposals: nativeToScVal(0n, { type: "u64" }).toXDR("base64"),
  get_total_weight: nativeToScVal(0, { type: "u32" }).toXDR("base64"),
  get_recurring_payments: xdr.ScVal.scvVec([]).toXDR("base64"),
  is_frozen: xdr.ScVal.scvBool(false).toXDR("base64"),
};

test("analytics page renders stat cards and charts from indexed treasury events", async ({ page }) => {
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
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        simulationResult(body.id, RPC_RESULT_BY_FUNCTION[functionName] ?? xdr.ScVal.scvVoid().toXDR("base64")),
      ),
    });
  });

  await page.goto("/app/analytics");

  // Stat cards, fed by GET /stats/summary against the indexed fixture events.
  await expect(page.getByText(EXPECTED.totalDisbursed, { exact: true })).toBeVisible();
  await expect(page.getByText(EXPECTED.totalInflows, { exact: true })).toBeVisible();
  const activeProposalsValue = page
    .getByText("Active Proposals", { exact: true })
    .locator("xpath=following-sibling::p[1]");
  await expect(activeProposalsValue).toHaveText(EXPECTED.activeProposals);

  // Spend-by-category chart: real <svg> renders, and its text alternative
  // reports values derived from the indexed events (GET /spend/by-category).
  const categoryChart = page.getByRole("img", { name: "Spend by category chart with 3 categories" });
  await expect(categoryChart).toBeVisible();
  await expect(categoryChart.locator("svg")).toHaveCount(1);
  await expect(page.getByText(EXPECTED.categorySummary, { exact: true })).toHaveText(EXPECTED.categorySummary);

  // Spend-by-owner chart (GET /spend/by-owner).
  const ownerChart = page.getByRole("img", { name: "Spend by proposing owner chart with 4 owners" });
  await expect(ownerChart).toBeVisible();
  await expect(ownerChart.locator("svg")).toHaveCount(1);
  await expect(page.getByText(EXPECTED.ownerSummary, { exact: true })).toHaveText(EXPECTED.ownerSummary);

  // Treasury outflow chart (GET /treasury/flow), cumulative across the one
  // indexed month.
  const flowChart = page.getByRole("img", { name: "Treasury outflow over time chart. 1 data points shown." });
  await expect(flowChart).toBeVisible();
  await expect(flowChart.locator("svg")).toHaveCount(1);
  await expect(page.getByText(EXPECTED.cumulativeOutflow, { exact: true })).toHaveText(EXPECTED.cumulativeOutflow);
});
