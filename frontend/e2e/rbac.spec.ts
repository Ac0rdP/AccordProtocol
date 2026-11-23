import { Keypair, xdr } from "@stellar/stellar-sdk";
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
 * RBAC end-to-end coverage (issue #789).
 *
 * Drives the "Manage Roles" flow on the Owners page and asserts the exact
 * contract entry points the UI submits: `create_grant_role_proposal` when
 * granting and `create_revoke_role_proposal` when revoking. The mock RPC
 * records every `sendTransaction` so the arguments can be verified, and
 * projects the resulting proposal back into the dashboard feed.
 */

const OWNER_A = TEST_WALLET;
const OWNER_B = Keypair.fromRawEd25519Seed(
  Buffer.from("accord-protocol-owner-2-seed-12x", "ascii"),
).publicKey();
const OWNER_C = Keypair.fromRawEd25519Seed(
  Buffer.from("accord-protocol-owner-3-seed-12x", "ascii"),
).publicKey();
const NEW_OWNER = Keypair.fromRawEd25519Seed(
  Buffer.from("accord-protocol-owner-4-seed-12x", "ascii"),
).publicKey();

const OWNERS = [OWNER_A, OWNER_B, OWNER_C];
const THRESHOLD = 1;

type RoleProposal = {
  id: number;
  action: "grant" | "revoke";
  target: string;
  description: string;
  deadline: bigint;
};

function proposalToNative(proposal: RoleProposal) {
  return {
    id: BigInt(proposal.id),
    proposer: OWNER_A,
    description: proposal.description,
    deadline: proposal.deadline,
    approvals: 0,
    status: "Pending",
    quorum_weight: THRESHOLD,
    kind:
      proposal.action === "grant"
        ? { GrantRole: [proposal.target, "Owner"] }
        : { RevokeRole: [proposal.target, "Owner"] },
    to: proposal.target,
    amount: "—",
    token: "Owner",
  };
}

test("owners can grant and revoke the Owner role via role proposals", async ({ page }) => {
  const proposals: RoleProposal[] = [];
  const sent: Array<{ fn: string; args: unknown[] }> = [];

  await installGovernanceRpc(page, {
    simulate: (fn, args): xdr.ScVal => {
      switch (fn) {
        case "get_owners":
          return addrVec(OWNERS);
        case "get_threshold":
          return u32(THRESHOLD);
        case "get_total_weight":
          return u32(OWNERS.length);
        case "get_total_proposals":
          return u64(proposals.length);
        case "get_proposals_paged":
          return xdr.ScVal.scvVec(proposals.map(proposalToNative).map(native));
        case "get_owner_weight":
          return u32(1);
        case "get_owner_weights":
          return native(OWNERS.map((owner) => ({ address: owner, weight: 1 })));
        case "get_roles":
          return symbolVec(["Owner"]);
        case "has_approved":
          return native(false);
        case "get_recurring_payments":
          return emptyVec();
        case "get_spending_limit":
          return VOID;
        case "get_active_delegations":
          return emptyVec();
        default:
          return VOID;
      }
    },
    send: (fn, args) => {
      sent.push({ fn, args });
      if (fn === "create_grant_role_proposal") {
        proposals.push({
          id: proposals.length + 1,
          action: "grant",
          target: String(args[1] ?? ""),
          description: String(args[3] ?? ""),
          deadline: BigInt(String(args[4] ?? 0)),
        });
      }
      if (fn === "create_revoke_role_proposal") {
        proposals.push({
          id: proposals.length + 1,
          action: "revoke",
          target: String(args[1] ?? ""),
          description: String(args[3] ?? ""),
          deadline: BigInt(String(args[4] ?? 0)),
        });
      }
    },
  });

  await page.goto("/app/owners");
  await expect(page.getByRole("heading", { name: "Multisig Owners" })).toBeVisible({
    timeout: 15_000,
  });
  // Threshold is read from the "Threshold" dashboard stat: "1 of 3".
  await expect(page.getByText("Requires 1 of 3 voting weight")).toBeVisible();

  // ─── Grant ────────────────────────────────────────────────────────────────
  // The first "Manage Roles" button targets OWNER_A (an existing owner), so the
  // target is changed to a brand-new address to exercise the grant path.
  await page.getByRole("button", { name: "Manage Roles" }).first().click();
  await expect(page.getByRole("heading", { name: "Manage Role" })).toBeVisible();

  await page.getByPlaceholder("G...").fill(NEW_OWNER);
  await page.getByPlaceholder("Why should this role change?").fill("Add a fourth signer");
  await page.getByRole("button", { name: "Submit Role Proposal" }).click();

  await expect
    .poll(() => sent.filter((call) => call.fn === "create_grant_role_proposal").length, {
      timeout: 20_000,
    })
    .toBeGreaterThanOrEqual(1);

  const grant = sent.find((call) => call.fn === "create_grant_role_proposal");
  expect(grant, "grant-role proposal was submitted").toBeTruthy();
  // Contract signature: (proposer, target, role, description, deadline)
  expect(grant!.args[0]).toBe(OWNER_A);
  expect(grant!.args[1]).toBe(NEW_OWNER);
  expect(grant!.args[2]).toBe("Owner");

  // The new proposal is projected into the dashboard feed.
  await page.getByRole("link", { name: "dashboard" }).click();
  await expect(page.getByText("Grant Role", { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // ─── Revoke ───────────────────────────────────────────────────────────────
  await page.getByRole("link", { name: "owners" }).click();
  await expect(page.getByRole("heading", { name: "Multisig Owners" })).toBeVisible();

  await page.getByRole("button", { name: "Manage Roles" }).nth(1).click();
  await expect(page.getByRole("heading", { name: "Manage Role" })).toBeVisible();
  // The modal is pre-filled with the row's owner (OWNER_B); switch to revoke.
  await expect(page.getByPlaceholder("G...")).toHaveValue(OWNER_B);

  await page.getByRole("button", { name: "Revoke" }).click();
  await page.getByPlaceholder("Why should this role change?").fill("Remove a signer");
  await page.getByRole("button", { name: "Submit Role Proposal" }).click();

  await expect
    .poll(() => sent.filter((call) => call.fn === "create_revoke_role_proposal").length, {
      timeout: 20_000,
    })
    .toBeGreaterThanOrEqual(1);

  const revoke = sent.find((call) => call.fn === "create_revoke_role_proposal");
  expect(revoke, "revoke-role proposal was submitted").toBeTruthy();
  expect(revoke!.args[0]).toBe(OWNER_A);
  expect(revoke!.args[1]).toBe(OWNER_B);
  expect(revoke!.args[2]).toBe("Owner");
});
