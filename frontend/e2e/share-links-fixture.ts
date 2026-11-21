import type { Page } from "@playwright/test";
import { Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";

export const MOCK_RPC_URL = "https://mock-rpc.test";
export const XLM_TOKEN =
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
export const SIM_SOURCE =
  "GDJSB22NWBU7IV44SHHG6WO6AJTUED2KNKWL2DYNJJ5X7M5SG7UVC7JD";
export const CO_OWNER =
  "GCOTL5HEOY6ZC453QWAAIYL2QTZWNXWWU4PF22TK22YBZE6XLBIQHUH2";

export const SHARE_REGRESSION_FIXTURE = {
  id: "regression-path-traversal-query-deep-link",
  description:
    "Ensures a signed-out deep link with a relative path traversal payload (?proposal=../settings) is neutralized to /app/proposals/invalid (Proposal not found) and never navigates to /app/settings.",
  maliciousUrl: "/app?proposal=../settings",
  expectedSafePath: "/app/proposals/invalid",
};

const accountId = Keypair.fromPublicKey(SIM_SOURCE).xdrAccountId();

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

function extractContractFunctionName(transactionXdr: string): string {
  const envelope = xdr.TransactionEnvelope.fromXDR(transactionXdr, "base64");
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

function buildProposalsVecXdr(): string {
  const futureDeadline = BigInt(Math.floor(Date.now() / 1000) + 14 * 86_400);
  return xdr.ScVal.scvVec([
    nativeToScVal({
      amount: 2_500_000_000n,
      approvals: 1,
      deadline: futureDeadline,
      description: "Public Share Grant Payout",
      id: 1n,
      proposer: SIM_SOURCE,
      status: "Pending",
      to: CO_OWNER,
      token: XLM_TOKEN,
    }),
    nativeToScVal({
      amount: 5_000_000_000n,
      approvals: 2,
      deadline: futureDeadline,
      description: "Deep Link Ready Treasury Transfer",
      id: 2n,
      proposer: CO_OWNER,
      status: "Ready",
      to: SIM_SOURCE,
      token: XLM_TOKEN,
    }),
  ]).toXDR("base64");
}

function buildSimulationResponse(id: unknown, retvalB64: string) {
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

/**
 * Installs a deterministic Soroban RPC mock on the given Playwright `Page`
 * without injecting any Freighter extension stub, so tests run in a true
 * signed-out browser.
 */
export async function mockSignedOutSorobanRpc(
  page: Page,
  options: { failRpcWithSecret?: string } = {},
) {
  const proposalsVecB64 = buildProposalsVecXdr();
  const ownersVecB64 = xdr.ScVal.scvVec([
    nativeToScVal(SIM_SOURCE, { type: "address" }),
    nativeToScVal(CO_OWNER, { type: "address" }),
  ]).toXDR("base64");

  const retvalByFn: Record<string, string> = {
    get_owners: ownersVecB64,
    get_threshold: nativeToScVal(2, { type: "u32" }).toXDR("base64"),
    get_total_proposals: nativeToScVal(2n, { type: "u64" }).toXDR("base64"),
    get_total_weight: nativeToScVal(2, { type: "u32" }).toXDR("base64"),
    get_required_quorum_weight: nativeToScVal(2, { type: "u32" }).toXDR(
      "base64",
    ),
    get_proposals_paged: proposalsVecB64,
    get_approvers: xdr.ScVal.scvVec([
      nativeToScVal(SIM_SOURCE, { type: "address" }),
    ]).toXDR("base64"),
    get_approver_weight: nativeToScVal(1, { type: "u32" }).toXDR("base64"),
    get_owner_weight: nativeToScVal(1, { type: "u32" }).toXDR("base64"),
    get_roles: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Owner")]).toXDR(
      "base64",
    ),
    get_recurring_payments: xdr.ScVal.scvVec([]).toXDR("base64"),
    is_frozen: xdr.ScVal.scvBool(false).toXDR("base64"),
  };

  await page.route(`${MOCK_RPC_URL}/**`, async (route) => {
    const body = route.request().postDataJSON() as {
      id: unknown;
      method: string;
      params?: { transaction?: string };
    };

    if (options.failRpcWithSecret) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            error: `Upstream RPC failure with Bearer ${options.failRpcWithSecret}`,
            latestLedger: 1000,
          },
        }),
      });
      return;
    }

    if (body.method === "getLedgerEntries") {
      await route.fulfill({
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
      return;
    }

    if (body.method === "getLatestLedger") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { id: "ledger-1000", protocolVersion: 21, sequence: 1000 },
        }),
      });
      return;
    }

    if (body.method === "getEvents") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { events: [], latestLedger: 1000 },
        }),
      });
      return;
    }

    if (body.method !== "simulateTransaction") {
      await route.continue();
      return;
    }

    const fnName = extractContractFunctionName(body.params?.transaction ?? "");
    const retval =
      retvalByFn[fnName] ?? xdr.ScVal.scvVoid().toXDR("base64");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(buildSimulationResponse(body.id, retval)),
    });
  });
}
