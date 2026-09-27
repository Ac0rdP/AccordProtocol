# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: owners-weight-distribution.spec.ts >> owners weight distribution chart visual regression
- Location: e2e/owners-weight-distribution.spec.ts:76:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByTestId('weight-distribution-chart')
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByTestId('weight-distribution-chart')

```

# Test source

```ts
  24  |       numSubEntries: 0,
  25  |       inflationDest: null,
  26  |       flags: 0,
  27  |       homeDomain: Buffer.alloc(32),
  28  |       thresholds: Buffer.alloc(4),
  29  |       signers: [],
  30  |       ext: xdr.AccountEntryExt.fromXDR(Buffer.from([0, 0, 0, 0])),
  31  |     }),
  32  |   ),
  33  |   ext: xdr.LedgerEntryExt.fromXDR(Buffer.from([0, 0, 0, 0])),
  34  | }).toXDR("base64");
  35  | const KEY_B64 = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId })).toXDR("base64");
  36  | const TX_DATA_B64 = new xdr.SorobanTransactionData({
  37  |   ext: xdr.SorobanTransactionDataExt.fromXDR(Buffer.from([0, 0, 0, 0])),
  38  |   resources: new xdr.SorobanResources({
  39  |     footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
  40  |     instructions: 1_000_000,
  41  |     diskReadBytes: 0,
  42  |     writeBytes: 0,
  43  |   }),
  44  |   resourceFee: xdr.Int64.fromString("100"),
  45  | }).toXDR("base64");
  46  | 
  47  | function getFunctionName(transaction: string): string {
  48  |   const envelope = xdr.TransactionEnvelope.fromXDR(transaction, "base64");
  49  |   const functionName = envelope
  50  |     .v1()
  51  |     .tx()
  52  |     .operations()[0]
  53  |     .body()
  54  |     .invokeHostFunctionOp()
  55  |     .hostFunction()
  56  |     .invokeContract()
  57  |     .functionName();
  58  |   return Buffer.from(functionName).toString();
  59  | }
  60  | 
  61  | function simulationResult(id: unknown, retval: string) {
  62  |   return {
  63  |     jsonrpc: "2.0",
  64  |     id,
  65  |     result: {
  66  |       cost: { cpuInsns: "1000", memBytes: "2000" },
  67  |       results: [{ auth: [], xdr: retval }],
  68  |       minResourceFee: "100",
  69  |       transactionData: TX_DATA_B64,
  70  |       events: [],
  71  |       latestLedger: 1000,
  72  |     },
  73  |   };
  74  | }
  75  | 
  76  | test("owners weight distribution chart visual regression", async ({ page }) => {
  77  |   await page.route(`${RPC}/**`, async (route) => {
  78  |     const body = route.request().postDataJSON() as {
  79  |       id: unknown;
  80  |       method: string;
  81  |       params?: { transaction?: string };
  82  |     };
  83  | 
  84  |     if (body.method === "getLedgerEntries") {
  85  |       await route.fulfill({
  86  |         contentType: "application/json",
  87  |         body: JSON.stringify({
  88  |           jsonrpc: "2.0",
  89  |           id: body.id,
  90  |           result: { entries: [{ key: KEY_B64, xdr: ENTRY_B64, lastModifiedLedgerSeq: 100 }], latestLedger: 1000 },
  91  |         }),
  92  |       });
  93  |       return;
  94  |     }
  95  | 
  96  |     if (body.method !== "simulateTransaction") {
  97  |       await route.continue();
  98  |       return;
  99  |     }
  100 | 
  101 |     const functionName = getFunctionName(body.params?.transaction ?? "");
  102 |     const resultByFunction: Record<string, string> = {
  103 |       get_owners: xdr.ScVal.scvVec(OWNERS.map((owner) => nativeToScVal(owner, { type: "address" }))).toXDR("base64"),
  104 |       get_threshold: nativeToScVal(15, { type: "u32" }).toXDR("base64"),
  105 |       get_total_proposals: nativeToScVal(0n, { type: "u64" }).toXDR("base64"),
  106 |       get_owner_weights: xdr.ScVal.scvVec(
  107 |         OWNER_WEIGHTS.map(({ owner, weight }) => nativeToScVal({ owner, weight: BigInt(weight) })),
  108 |       ).toXDR("base64"),
  109 |       get_required_quorum_weight: nativeToScVal(15, { type: "u32" }).toXDR("base64"),
  110 |       get_active_delegations: xdr.ScVal.scvVec([]).toXDR("base64"),
  111 |       get_recurring_payments: xdr.ScVal.scvVec([]).toXDR("base64"),
  112 |       is_frozen: xdr.ScVal.scvBool(false).toXDR("base64"),
  113 |       get_spending_limit: nativeToScVal(-1n, { type: "i64" }).toXDR("base64"),
  114 |     };
  115 | 
  116 |     await route.fulfill({
  117 |       contentType: "application/json",
  118 |       body: JSON.stringify(simulationResult(body.id, resultByFunction[functionName] ?? xdr.ScVal.scvVoid().toXDR("base64"))),
  119 |     });
  120 |   });
  121 | 
  122 |   await page.goto("/app/owners");
  123 |   const chart = page.getByTestId("weight-distribution-chart");
> 124 |   await expect(chart).toBeVisible();
      |                       ^ Error: expect(locator).toBeVisible() failed
  125 |   await expect(chart.getByRole("img")).toHaveCount(3);
  126 |   await expect(chart).toHaveScreenshot("owners-weight-distribution.png");
  127 | });
  128 | 
```