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
 * Recurring-payment end-to-end coverage (issue #789).
 *
 * Part 1 creates a recurring payment through the dashboard modal and asserts
 * the contract receives `create_recurring_payment` with the recipient, amount
 * (in stroops), and interval the form was filled with.
 *
 * Part 2 seeds an active schedule, opens the Recurring page, and disburses it,
 * asserting the `disburse_recurring` entry point receives the schedule id.
 */

const OWNER_A = TEST_WALLET;

function scheduleNative() {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: 1n,
    proposer: OWNER_A,
    recipient: OWNER_A,
    token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    amount: 1_000_000_000n,
    interval_secs: 3600n,
    interval: 3600n,
    start_time: BigInt(now - 7200),
    end_time: BigInt(now + 86_400),
    cliff_time: 0n,
    total_cap: 10_000_000_000n,
    total_disbursed: 0n,
    last_disbursed_at: 0n,
    status: "Active",
    kind: { FixedAmountPerPeriod: null },
    category: { Ops: null },
    description: "Recurring E2E",
  };
}

test("recurring payments can be created and disbursed", async ({ page }) => {
  const state = { schedules: [] as ReturnType<typeof scheduleNative>[] };
  const sent: Array<{ fn: string; args: unknown[] }> = [];

  await installGovernanceRpc(page, {
    simulate: (fn): xdr.ScVal => {
      switch (fn) {
        case "get_owners":
          return addrVec([OWNER_A]);
        case "get_threshold":
          return u32(1);
        case "get_total_weight":
          return u32(1);
        case "get_total_proposals":
          return u64(0);
        case "get_proposals_paged":
          return emptyVec();
        case "get_owner_weight":
          return u32(1);
        case "get_owner_weights":
          return native([{ address: OWNER_A, weight: 1 }]);
        case "get_roles":
          return symbolVec(["Owner"]);
        case "get_total_recurring_payments":
          return u64(state.schedules.length);
        case "get_recurring_payments":
        case "get_recurring_payments_paged":
          return native(state.schedules);
        case "get_claimable_amount":
          return native(0n);
        default:
          return VOID;
      }
    },
    send: (fn, args) => {
      sent.push({ fn, args });
    },
  });

  await page.goto("/app");
  await expect(page.getByText("No active proposals")).toBeVisible({ timeout: 15_000 });

  // ─── Part 1: create a recurring payment ────────────────────────────────────
  await page.getByRole("button", { name: "Recurring" }).click();
  await expect(page.getByRole("dialog", { name: "Create Recurring Payment" })).toBeVisible();

  await page.getByLabel("Recipient Stellar address").fill(OWNER_A);
  await page.getByLabel("Payment amount").fill("10");
  await page.getByLabel("Payment interval in seconds").fill("3600");
  await page.getByRole("button", { name: "Review Recurring Payment" }).click();
  await page.getByRole("button", { name: "Confirm & Submit" }).click();

  await expect
    .poll(() => sent.filter((call) => call.fn === "create_recurring_payment").length, {
      timeout: 20_000,
    })
    .toBeGreaterThanOrEqual(1);

  const created = sent.find((call) => call.fn === "create_recurring_payment");
  expect(created, "create_recurring_payment was submitted").toBeTruthy();
  // Contract signature:
  // (proposer, recipient, amount, token, interval, start, cliff, end, cap, category, kind)
  expect(created!.args[1]).toBe(OWNER_A);
  expect(Number(created!.args[2])).toBe(100_000_000); // 10 tokens in stroops
  expect(Number(created!.args[4])).toBe(3600);

  // ─── Part 2: disburse an active schedule ───────────────────────────────────
  state.schedules = [scheduleNative()];

  await page.goto("/app/recurring");
  await expect(page.getByRole("heading", { name: "Recurring Schedules" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Schedule #1")).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Disburse schedule 1 now" }).click();

  await expect
    .poll(() => sent.filter((call) => call.fn === "disburse_recurring").length, {
      timeout: 20_000,
    })
    .toBeGreaterThanOrEqual(1);

  const disburse = sent.find((call) => call.fn === "disburse_recurring");
  expect(disburse, "disburse_recurring was submitted").toBeTruthy();
  expect(Number(disburse!.args[0])).toBe(1);
});
