import { xdr, nativeToScVal, Keypair } from "@stellar/stellar-sdk";
import { test, expect } from "./setup";
import { getCallDetails } from "./gov-harness";

const RPC = "https://mock-rpc.test";
const XLM_TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

// Deterministic keypair — must match VITE_SIM_SOURCE in playwright.config.ts
// and the TEST_WALLET string in setup.ts.
const KP = Keypair.fromRawEd25519Seed(
  Buffer.from("accord-protocol-e2e-test-seed-12", "ascii")
);
const G = KP.publicKey();

// ─── Pre-computed XDR values ──────────────────────────────────────────────────

const accountId = KP.xdrAccountId();

// Ledger entry returned by getLedgerEntries for the simulation source account.
const ENTRY_B64 = xdr.LedgerEntryData.account(
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
  })
).toXDR("base64");

const KEY_B64 = xdr.LedgerKey.account(
  new xdr.LedgerKeyAccount({ accountId })
).toXDR("base64");

// SorobanTransactionData injected into every simulation success response so
// rpc.assembleTransaction can inject resource estimates into the built TX.
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

// Minimal successful TransactionResult XDR used in getTransaction responses.
// Layout: feeCharged(int64) + txSUCCESS discriminant(0) + results[](len=0) + ext(v=0)
const TX_RESULT_B64 = xdr.TransactionResult.fromXDR(
  Buffer.from([0, 0, 0, 0, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
).toXDR("base64");

// Minimal TransactionMeta XDR: v=0 union discriminant, empty OperationMeta array.
const TX_META_B64 = xdr.TransactionMeta.fromXDR(
  Buffer.from([0, 0, 0, 0, 0, 0, 0, 0])
).toXDR("base64");

const THRESH_B64 = xdr.ScVal.scvU32(1).toXDR("base64");
const VOID_B64 = xdr.ScVal.scvVoid().toXDR("base64");

// ─── XDR builders (called at route-intercept time) ────────────────────────────

function ownersXdr(): string {
  return xdr.ScVal.scvVec([nativeToScVal(G, { type: "address" })]).toXDR("base64");
}

function totalXdr(n: number): string {
  return nativeToScVal(BigInt(n), { type: "u64" }).toXDR("base64");
}

function proposalsXdr(status: string, approvals: number): string {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 7 * 86_400);
  return xdr.ScVal.scvVec([
    nativeToScVal({
      amount: 100_000_000n,
      approvals,
      deadline,
      description: "Test Proposal",
      id: 1n,
      proposer: G,
      status,
      to: G,
      token: XLM_TOKEN,
    }),
  ]).toXDR("base64");
}

function hasApprovedXdr(val: boolean): string {
  return xdr.ScVal.scvBool(val).toXDR("base64");
}

function rolesXdr(): string {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Owner")]).toXDR("base64");
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

// ─── Test ─────────────────────────────────────────────────────────────────────

test("create then approve then execute a proposal", async ({ page }) => {
  // Capture browser console for debugging.
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.text().startsWith("[STUB]")) {
      console.log(`[browser:${msg.type()}]`, msg.text());
    }
  });

  // Mutable state machine drives all RPC mock responses.
  const state = { total: 0, status: "Pending", approvals: 0, hasApproved: false };
  // Capture the last submitted envelope so getTransaction can echo it back
  // (stellar-sdk parses envelopeXdr in the SUCCESS response).
  let lastEnvXdr = "";

  // Debug: log every request to understand which URLs are used.
  page.on("request", (req) => {
    if (req.url().includes("mock-rpc") || req.method() === "POST") {
      console.log(`[req] ${req.method()} ${req.url()}`);
    }
  });

  await page.route(`${RPC}/**`, async (route) => {
    const body = route.request().postDataJSON() as {
      jsonrpc: string;
      id: unknown;
      method: string;
      params?: Record<string, string>;
    };
    const { method, id } = body;
    console.log(`[mock] ${method}`);

    if (method === "getLedgerEntries") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            entries: [{ key: KEY_B64, xdr: ENTRY_B64, lastModifiedLedgerSeq: 100 }],
            latestLedger: 1000,
          },
        }),
      });
    }

    if (method === "simulateTransaction") {
      const fn = getCallDetails(body.params?.transaction ?? "").fn;
      let retval = VOID_B64;
      if (fn === "get_threshold") retval = THRESH_B64;
      else if (fn === "get_owners") retval = ownersXdr();
      else if (fn === "get_total_proposals") retval = totalXdr(state.total);
      else if (fn === "get_proposals_paged") retval = proposalsXdr(state.status, state.approvals);
      else if (fn === "has_approved") retval = hasApprovedXdr(state.hasApproved);
      else if (fn === "get_roles") retval = rolesXdr();
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(simResult(id, retval)),
      });
    }

    if (method === "sendTransaction") {
      const txBase64 = body.params?.transaction ?? "";
      lastEnvXdr = txBase64;
      const fn = getCallDetails(txBase64).fn;
      if (fn === "create_proposal") {
        Object.assign(state, { total: 1, status: "Pending", approvals: 0, hasApproved: false });
      } else if (fn === "approve") {
        Object.assign(state, { status: "Ready", approvals: 1, hasApproved: true });
      } else if (fn === "execute") {
        Object.assign(state, { status: "Executed" });
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { hash: "mock-tx-hash", status: "PENDING" },
        }),
      });
    }

    if (method === "getTransaction") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            status: "SUCCESS",
            ledger: 1000,
            createdAt: Math.floor(Date.now() / 1000),
            envelopeXdr: lastEnvXdr,
            resultXdr: TX_RESULT_B64,
            resultMetaXdr: TX_META_B64,
            latestLedger: 1000,
            latestLedgerCloseTime: Math.floor(Date.now() / 1000),
          },
        }),
      });
    }

    if (method === "getLatestLedger") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { id: "mock-ledger", sequence: 1000, protocolVersion: "22" },
        }),
      });
    }

    if (method === "getEvents") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { events: [], latestLedger: 1000 },
        }),
      });
    }

    await route.continue();
  });

  // Intercept all unhandled promise rejections to surface hidden errors.
  await page.addInitScript(() => {
    window.addEventListener("unhandledrejection", (e) => {
      console.error("[UNHANDLED]", e.reason?.message ?? String(e.reason));
    });
  });

  await page.goto("/app");

  // Dashboard renders with empty proposal list once wallet and contract data load.
  await expect(page.getByRole("heading", { name: "Active Proposals", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("No active proposals", { exact: true })).toBeVisible({ timeout: 10_000 });

  // ─── Step 1: Create a proposal ───────────────────────────────────────────

  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByText("New Proposal")).toBeVisible();
  await page.getByRole("button", { name: "Transfer" }).click();

  await page.getByPlaceholder("G...").fill(G);
  await page.getByPlaceholder("0.00").fill("10");
  await page.getByPlaceholder("What is this payment for?").fill("Test Proposal");

  // Review button is disabled until the form is valid.
  await expect(
    page.getByRole("button", { name: "Review Proposal" })
  ).not.toBeDisabled({ timeout: 10_000 });
  await page.getByRole("button", { name: "Review Proposal" }).click();
  await page.getByRole("button", { name: "Confirm & Submit" }).click();

  // buildAndSubmit polls getTransaction every 2 s before resolving; allow time.
  await expect(page.getByText("Test Proposal")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible({
    timeout: 5_000,
  });

  // ─── Step 2: Approve the proposal ────────────────────────────────────────

  await page.getByRole("button", { name: "Approve" }).click();

  // After approve refresh: approvals=1/threshold=1, status→ready → Execute visible.
  await expect(page.getByText("1 / 1 weight")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Execute" })).toBeVisible({
    timeout: 5_000,
  });

  // ─── Step 3: Execute the proposal ────────────────────────────────────────

  await page.getByRole("button", { name: "Execute" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();

  // Executed proposals are filtered out of activeProposals → empty state returns.
  await expect(page.getByText("No active proposals", { exact: true })).toBeVisible({ timeout: 20_000 });
});
