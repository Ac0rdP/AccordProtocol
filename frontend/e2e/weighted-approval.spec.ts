import { Keypair } from "@stellar/stellar-sdk";
import type { xdr } from "@stellar/stellar-sdk";
import { expect, test, TEST_WALLET } from "./setup";
import {
  VOID,
  addrVec,
  emptyVec,
  installGovernanceRpc,
  native,
  symbolVec,
  u32,
  u64,
} from "./gov-harness";

/**
 * Weighted-approval end-to-end coverage (issue #789).
 *
 * Owners hold different voting weights (A=2, B=3, C=1) and the quorum is 4.
 * The test creates a transfer proposal, approves it as A (2/4 — not yet ready),
 * switches wallets and approves as B (5/4 — ready), then executes it.
 * Approval progress is asserted through the weight bar the UI renders.
 */

const OWNER_A = TEST_WALLET;
const OWNER_B = Keypair.fromRawEd25519Seed(
  Buffer.from("accord-protocol-owner-2-seed-12x", "ascii"),
).publicKey();
const OWNER_C = Keypair.fromRawEd25519Seed(
  Buffer.from("accord-protocol-owner-3-seed-12x", "ascii"),
).publicKey();

const OWNERS = [OWNER_A, OWNER_B, OWNER_C];
const WEIGHTS: Record<string, number> = {
  [OWNER_A]: 2,
  [OWNER_B]: 3,
  [OWNER_C]: 1,
};
const QUORUM = 4;
const TOTAL_WEIGHT = 6;
const XLM_TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

type ProposalState = {
  id: number;
  proposer: string;
  to: string;
  amount: bigint;
  approvalWeight: number;
  approvals: number;
  status: "Pending" | "Ready" | "Executed";
  approvedBy: Set<string>;
};

function proposalToNative(proposal: ProposalState) {
  return {
    id: BigInt(proposal.id),
    proposer: proposal.proposer,
    description: "Weighted E2E transfer",
    deadline: BigInt(Math.floor(Date.now() / 1000) + 7 * 86_400),
    approvals: proposal.approvals,
    approval_weight: proposal.approvalWeight,
    quorum_weight: QUORUM,
    status: proposal.status,
    kind: { Transfer: [proposal.to, proposal.amount, XLM_TOKEN] },
    to: proposal.to,
    amount: proposal.amount,
    token: XLM_TOKEN,
  };
}

test("weighted approvals accumulate across owners until quorum is reached", async ({ page }) => {
  const proposals: ProposalState[] = [];
  const sent: Array<{ fn: string; args: unknown[] }> = [];
  let nextProposalId = 1;

  const findProposal = (id: number) => proposals.find((p) => p.id === id);

  await installGovernanceRpc(page, {
    simulate: (fn, args): xdr.ScVal => {
      switch (fn) {
        case "get_owners":
          return addrVec(OWNERS);
        case "get_threshold":
          return u32(QUORUM);
        case "get_total_weight":
          return u32(TOTAL_WEIGHT);
        case "get_required_quorum_weight":
          return u32(QUORUM);
        case "get_weight_cap_pct":
          return u32(50);
        case "get_total_proposals":
          return u64(proposals.length);
        case "get_proposals_paged":
          return native(proposals.map(proposalToNative));
        case "get_owner_weight":
          return u32(WEIGHTS[String(args[0] ?? "")] ?? 0);
        case "get_owner_weights":
          return native(
            OWNERS.map((owner) => ({ address: owner, weight: WEIGHTS[owner] })),
          );
        case "get_roles":
          return symbolVec(["Owner"]);
        case "has_approved": {
          const owner = String(args[0] ?? "");
          const id = Number(args[1] ?? 0);
          return native(findProposal(id)?.approvedBy.has(owner) ?? false);
        }
        case "get_recurring_payments":
          return emptyVec();
        default:
          return VOID;
      }
    },
    send: (fn, args) => {
      sent.push({ fn, args });
      if (fn === "create_proposal") {
        proposals.push({
          id: nextProposalId++,
          proposer: String(args[0] ?? ""),
          to: String(args[1] ?? ""),
          amount: BigInt(String(args[2] ?? 0)),
          approvalWeight: 0,
          approvals: 0,
          status: "Pending",
          approvedBy: new Set(),
        });
      } else if (fn === "approve") {
        const owner = String(args[0] ?? "");
        const id = Number(args[1] ?? 0);
        const proposal = findProposal(id);
        if (proposal && !proposal.approvedBy.has(owner)) {
          proposal.approvedBy.add(owner);
          proposal.approvals += 1;
          proposal.approvalWeight += WEIGHTS[owner] ?? 0;
          if (proposal.approvalWeight >= QUORUM) proposal.status = "Ready";
        }
      } else if (fn === "execute") {
        const id = Number(args[1] ?? 0);
        const proposal = findProposal(id);
        if (proposal) proposal.status = "Executed";
      }
    },
  });

  await page.goto("/app");
  await expect(page.getByText("No active proposals")).toBeVisible({ timeout: 15_000 });

  // ─── Create a transfer proposal ────────────────────────────────────────────
  await page.getByRole("button", { name: "New" }).click();
  await expect(page.getByRole("dialog", { name: "New Proposal" })).toBeVisible();
  await page.getByRole("button", { name: "Transfer" }).click();

  await page.getByLabel("Recipient Address").fill(OWNER_C);
  await page.getByLabel("Amount").fill("1");
  await page.getByLabel("Description").fill("Pay vendor");
  await page.getByRole("button", { name: "Review Proposal" }).click();
  await page.getByRole("button", { name: "Confirm & Submit" }).click();

  await expect(page.getByText("0 / 4 weight")).toBeVisible({ timeout: 20_000 });
  const created = sent.find((call) => call.fn === "create_proposal");
  expect(created, "create_proposal was submitted").toBeTruthy();
  expect(created!.args[1]).toBe(OWNER_C);

  // ─── Approve as A (weight 2 of 4) ──────────────────────────────────────────
  await page.getByRole("button", { name: "Approve proposal #1" }).click();
  await expect(page.getByText("2 / 4 weight")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Execute proposal #1" })).toHaveCount(0);

  // ─── Switch to B (weight 3) — combined weight 5 exceeds the quorum ─────────
  await page.addInitScript((wallet) => {
    (window as unknown as { __TEST_WALLET__: string }).__TEST_WALLET__ = wallet;
  }, OWNER_B);
  await page.reload();

  await expect(page.getByText("2 / 4 weight")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Approve proposal #1" }).click();
  await expect(page.getByText("5 / 4 weight")).toBeVisible({ timeout: 20_000 });

  // ─── Execute once the quorum is met ────────────────────────────────────────
  await page.getByRole("button", { name: "Execute proposal #1" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();

  await expect(page.getByText("No active proposals")).toBeVisible({ timeout: 20_000 });
  expect(sent.some((call) => call.fn === "execute")).toBe(true);
});
