import { Keypair, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { expect, test, TEST_WALLET } from "./setup";

const RPC = "https://mock-rpc.test";

const OWNER_A = TEST_WALLET;
const OWNER_B = Keypair.fromRawEd25519Seed(
  Buffer.from("accord-protocol-owner-2-seed-12x", "ascii")
).publicKey();
const OWNER_C = Keypair.fromRawEd25519Seed(
  Buffer.from("accord-protocol-owner-3-seed-12x", "ascii")
).publicKey();

const INITIAL_WEIGHTS: Record<string, number> = {
  [OWNER_A]: 2,
  [OWNER_B]: 3,
  [OWNER_C]: 1,
};

type ProposalState = {
  id: number;
  proposer: string;
  targetOwner: string;
  newWeight: number;
  description: string;
  deadline: bigint;
  approvals: number;
  quorumWeight: number;
  status: "Pending" | "Ready" | "Executed";
  approvedOwners: Set<string>;
};

function getCallDetails(txBase64: string) {
  try {
    const env = xdr.TransactionEnvelope.fromXDR(txBase64, "base64");
    const invoke = env
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
    return { fn: "", args: [] as unknown[] };
  }
}

function ownerWeight(totalWeights: Record<string, number>, owner: string) {
  return totalWeights[owner] ?? 0;
}

function sumWeights(weights: Record<string, number>) {
  return Object.values(weights).reduce((total, weight) => total + weight, 0);
}

function proposalToNative(proposal: ProposalState, ownerWeights: Record<string, number>) {
  return {
    id: BigInt(proposal.id),
    proposer: proposal.proposer,
    description: proposal.description,
    deadline: proposal.deadline,
    approvals: proposal.approvals,
    status: proposal.status,
    kind: { ChangeOwnerWeight: [proposal.targetOwner, BigInt(proposal.newWeight)] },
    quorum_weight: proposal.quorumWeight,
    to: proposal.targetOwner,
    amount: String(proposal.newWeight),
    token: "Weight",
    owner_weight: ownerWeight(ownerWeights, proposal.targetOwner),
  };
}

test("weighted governance flow can propose, approve, and execute a weight change", async ({
  page,
}) => {
  const ownerWeights: Record<string, number> = { ...INITIAL_WEIGHTS };
  const approvedOwners = new Map<number, Set<string>>();
  const proposals: ProposalState[] = [];
  let nextProposalId = 1;

  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.text().startsWith("[STUB]")) {
      console.log(`[browser:${msg.type()}]`, msg.text());
    }
  });

  await page.route(`${RPC}/**`, async (route) => {
    const body = route.request().postDataJSON() as {
      id: unknown;
      method: string;
      params?: Record<string, string>;
    };
    const { method, id } = body;

    if (method === "getLedgerEntries") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { entries: [], latestLedger: 1000 },
        }),
      });
    }

    if (method === "simulateTransaction") {
      const call = getCallDetails(body.params?.transaction ?? "");
      let retval = xdr.ScVal.scvVoid();

      if (call.fn === "get_owners") {
        retval = xdr.ScVal.scvVec(
          Object.keys(ownerWeights).map((owner) =>
            nativeToScVal(owner, { type: "address" })
          )
        );
      } else if (call.fn === "get_threshold" || call.fn === "get_required_quorum_weight") {
        retval = xdr.ScVal.scvU32(4);
      } else if (call.fn === "get_total_weight") {
        retval = xdr.ScVal.scvU32(sumWeights(ownerWeights));
      } else if (call.fn === "get_total_proposals") {
        retval = nativeToScVal(BigInt(proposals.length), { type: "u64" });
      } else if (call.fn === "get_owner_weight") {
        const owner = String(call.args[0] ?? "");
        retval = xdr.ScVal.scvU32(ownerWeight(ownerWeights, owner));
      } else if (call.fn === "has_approved") {
        const proposalId = Number(call.args[1] ?? 0);
        const owner = String(call.args[0] ?? "");
        retval = xdr.ScVal.scvBool(approvedOwners.get(proposalId)?.has(owner) ?? false);
      } else if (call.fn === "get_proposals_paged" || call.fn === "get_proposal") {
        const payload = proposals.map((proposal) => proposalToNative(proposal, ownerWeights));
        retval = xdr.ScVal.scvVec(payload.map((proposal) => nativeToScVal(proposal)));
      }

      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            cost: { cpuInsns: "1000", memBytes: "1000" },
            results: [{ auth: [], xdr: retval.toXDR("base64") }],
            minResourceFee: "100",
            transactionData: xdr.ScVal.scvVoid().toXDR("base64"),
            events: [],
            latestLedger: 1000,
          },
        }),
      });
    }

    if (method === "sendTransaction") {
      const call = getCallDetails(body.params?.transaction ?? "");
      if (call.fn === "create_change_weight_proposal") {
        const proposer = String(call.args[0] ?? "");
        const targetOwner = String(call.args[1] ?? "");
        const newWeight = Number(call.args[2] ?? 0);
        const description = String(call.args[3] ?? "");
        const deadline = BigInt(call.args[4] ?? 0);

        proposals.push({
          id: nextProposalId++,
          proposer,
          targetOwner,
          newWeight,
          description,
          deadline,
          approvals: 0,
          quorumWeight: 4,
          status: "Pending",
          approvedOwners: new Set(),
        });
      } else if (call.fn === "approve") {
        const caller = String(call.args[0] ?? "");
        const proposalId = Number(call.args[1] ?? 0);
        const proposal = proposals.find((item) => item.id === proposalId);
        if (proposal && !proposal.approvedOwners.has(caller)) {
          proposal.approvedOwners.add(caller);
          approvedOwners.set(proposalId, proposal.approvedOwners);
          proposal.approvals += ownerWeight(ownerWeights, caller);
          if (proposal.approvals >= proposal.quorumWeight) {
            proposal.status = "Ready";
          }
        }
      } else if (call.fn === "execute") {
        const proposalId = Number(call.args[1] ?? 0);
        const proposal = proposals.find((item) => item.id === proposalId);
        if (proposal) {
          proposal.status = "Executed";
          ownerWeights[proposal.targetOwner] = proposal.newWeight;
        }
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
            envelopeXdr: body.params?.transaction ?? "",
            resultXdr: xdr.TransactionResult.fromXDR(
              Buffer.from([0, 0, 0, 0, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
            ).toXDR("base64"),
            resultMetaXdr: xdr.TransactionMeta.fromXDR(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0])).toXDR("base64"),
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

  await page.addInitScript((wallet) => {
    (window as any).__TEST_WALLET__ = wallet;
  }, OWNER_A);

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Multisig Owners" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Requires 4 of 6 voting weight")).toBeVisible({
    timeout: 15_000,
  });

  await page.getByRole("button", { name: "Change Weight" }).nth(2).click();
  await expect(page.getByRole("dialog", { name: "Propose Weight Change" })).toBeVisible();

  await page.getByLabel("New Weight").fill("4");
  await page.getByLabel("Description").fill("Raise signer weight");
  await page.getByRole("button", { name: "Submit Proposal" }).click();

  await page.getByRole("link", { name: "dashboard" }).click();
  await expect(page.getByRole("link", { name: /Change Owner Weight/i })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("0/4")).toBeVisible();

  await page.getByRole("button", { name: /Approve proposal/i }).click();
  await expect(page.getByText("2/4")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("status", { name: "Status: pending" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Execute" })).toHaveCount(0);

  await page.addInitScript((wallet) => {
    (window as any).__TEST_WALLET__ = wallet;
  }, OWNER_B);
  await page.reload();

  await expect(page.getByRole("link", { name: /Change Owner Weight/i })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: /Approve proposal/i }).click();

  await expect(page.getByText("5/4")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("status", { name: "Status: ready" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Execute" })).toBeVisible();

  await page.getByRole("button", { name: "Execute" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();

  await expect(page.getByText("No active proposals", { exact: true })).toBeVisible({
    timeout: 20_000,
  });

  await page.getByRole("link", { name: "owners" }).click();
  await expect(page.getByText("Requires 4 of 9 voting weight")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("Weight 4")).toBeVisible();
});
