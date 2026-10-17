import { Keypair } from "@stellar/stellar-sdk";
import type { xdr } from "@stellar/stellar-sdk";
import { expect, test, TEST_WALLET } from "./setup";
import {
  VOID,
  addrVec,
  address,
  emptyVec,
  installGovernanceRpc,
  native,
  symbolVec,
  u32,
  u64,
} from "./gov-harness";

/**
 * Migrated-contract-schema end-to-end coverage (issue #789).
 *
 * A contract that has been migrated to the role-aware, weighted-governance
 * schema reports `get_role_version == 2`, capability roles from `get_roles`
 * (Proposer/Approver/Executor/Viewer) and a weighted quorum from
 * `get_required_quorum_weight`. This test renders the app against that schema
 * and asserts the RBAC summary, capability roles, and weighted threshold are
 * all surfaced correctly rather than falling back to their empty defaults.
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
const ROLE_VERSION = 2;
const QUORUM = 3;
const TOTAL_WEIGHT = 6;

test("the app renders a contract migrated to the role-aware weighted schema", async ({ page }) => {
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
        case "get_total_proposals":
          return u64(0);
        case "get_proposals_paged":
          return emptyVec();
        case "get_owner_weight":
          return u32(WEIGHTS[String(args[0] ?? "")] ?? 0);
        case "get_owner_weights":
          return native(
            OWNERS.map((owner) => ({ address: owner, weight: WEIGHTS[owner] })),
          );
        case "get_role_version":
          return u32(ROLE_VERSION);
        // Migrated contracts store capability roles; the connected wallet holds
        // the Approver role even though it is also a multisig owner.
        case "get_roles":
          return symbolVec(["Approver"]);
        case "get_guardian":
          return address(OWNER_A);
        case "is_frozen":
          return native(false);
        case "get_recurring_payments":
          return emptyVec();
        default:
          return VOID;
      }
    },
  });

  // ─── Settings surfaces the migrated RBAC + weighted threshold ───────────────
  await page.goto("/app/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible({
    timeout: 15_000,
  });

  const rbac = page.locator("div.rounded-2xl", { hasText: "Role & RBAC Summary" }).first();
  await expect(rbac).toContainText("Contract Role Version");
  await expect(rbac.getByText(String(ROLE_VERSION), { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(rbac.getByText("Approver")).toBeVisible();
  await expect(rbac.getByText("No active roles")).toHaveCount(0);

  // Weighted quorum from get_required_quorum_weight is shown as "3 of 6".
  await expect(page.getByText(`${QUORUM} of ${TOTAL_WEIGHT}`)).toBeVisible();

  // ─── Owners page renders the weighted owner set ─────────────────────────────
  await page.goto("/app/owners");
  await expect(page.getByRole("heading", { name: "Multisig Owners" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(`Requires ${QUORUM} of ${OWNERS.length} signers`)).toBeVisible();
  await expect(page.getByText("Weight 2")).toBeVisible();
  await expect(page.getByText("Weight 3")).toBeVisible();
  await expect(page.getByText("Weight 1")).toBeVisible();
});
