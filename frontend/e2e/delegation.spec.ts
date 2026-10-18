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
 * Voting-weight delegation end-to-end coverage (issue #789).
 *
 * The UI exposes a "Delegate" action on the connected owner's row. Submitting
 * it must call the contract's `create_delegation(delegator, delegate, weight,
 * expiry)` entry point with the delegator's full voting weight.
 *
 * There is no dedicated "undelegate" control: revocation happens on-chain and
 * the delegation disappears from `get_active_delegations`. The second half of
 * this test models that by clearing the active delegation and reloading, then
 * asserting the Owners page still renders (the record is simply gone).
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

test("an owner can delegate their voting weight to another owner", async ({ page }) => {
  const state = { delegated: false };
  const sent: Array<{ fn: string; args: unknown[] }> = [];
  let activeDelegationReads = 0;

  await installGovernanceRpc(page, {
    simulate: (fn, args): xdr.ScVal => {
      switch (fn) {
        case "get_owners":
          return addrVec(OWNERS);
        case "get_threshold":
          return u32(QUORUM);
        case "get_total_weight":
          return u32(6);
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
        case "get_roles":
          return symbolVec(["Owner"]);
        case "get_recurring_payments":
          return emptyVec();
        case "get_active_delegations": {
          activeDelegationReads += 1;
          if (!state.delegated) return emptyVec();
          return native([
            {
              delegator: OWNER_A,
              delegate: OWNER_B,
              weight: WEIGHTS[OWNER_A],
              expiry: BigInt(Math.floor(Date.now() / 1000) + 365 * 86_400),
            },
          ]);
        }
        default:
          return VOID;
      }
    },
    send: (fn, args) => {
      sent.push({ fn, args });
      if (fn === "create_delegation") {
        state.delegated = true;
      }
    },
  });

  await page.goto("/app/owners");
  await expect(page.getByRole("heading", { name: "Multisig Owners" })).toBeVisible({
    timeout: 15_000,
  });

  // The Delegate control only appears on the connected wallet's own row.
  await page.getByRole("button", { name: "Delegate You voting weight" }).click();
  await expect(
    page.getByRole("heading", { name: "Delegate Voting Weight" }),
  ).toBeVisible();

  // Defaults to the first available candidate (OWNER_B).
  await expect(page.getByLabel("Delegate to owner")).toHaveValue(OWNER_B);

  await page.getByRole("button", { name: "Create delegation" }).click();

  await expect
    .poll(() => sent.filter((call) => call.fn === "create_delegation").length, {
      timeout: 20_000,
    })
    .toBeGreaterThanOrEqual(1);

  const delegation = sent.find((call) => call.fn === "create_delegation");
  expect(delegation, "create_delegation was submitted").toBeTruthy();
  // Contract signature: (delegator, delegate, weight, expiry)
  expect(delegation!.args[0]).toBe(OWNER_A);
  expect(delegation!.args[1]).toBe(OWNER_B);
  expect(Number(delegation!.args[2])).toBe(WEIGHTS[OWNER_A]);
  expect(Number(delegation!.args[3])).toBeGreaterThan(Math.floor(Date.now() / 1000));

  // ─── Undelegate (on-chain revocation) ──────────────────────────────────────
  // The app has no explicit undelegate button; when the delegation lapses or is
  // revoked the contract stops returning it from get_active_delegations.
  state.delegated = false;
  const readsBefore = activeDelegationReads;
  await page.reload();

  await expect(page.getByRole("heading", { name: "Multisig Owners" })).toBeVisible({
    timeout: 15_000,
  });
  await expect
    .poll(() => activeDelegationReads, { timeout: 15_000 })
    .toBeGreaterThan(readsBefore);
});
