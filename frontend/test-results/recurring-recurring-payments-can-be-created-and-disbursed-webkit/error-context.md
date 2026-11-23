# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: recurring.spec.ts >> recurring payments can be created and disbursed
- Location: e2e/recurring.spec.ts:50:1

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: locator.click: Test timeout of 60000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'Confirm & Submit' })
    - locator resolved to <button disabled type="button" aria-label="Confirm & Submit" title="Resolve the simulation error before submitting" class="flex-1 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed text-white py-2.5 rounded-lg font-medium transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none">Confirm & Submit</button>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
      - waiting 100ms
    87 × waiting for element to be visible, enabled and stable
       - element is not enabled
     - retrying click action
       - waiting 500ms
    - waiting for element to be visible, enabled and stable

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - banner [ref=e4]:
    - generic [ref=e5]:
      - link "A Accord testnet" [ref=e6]:
        - /url: /
        - generic [ref=e7]: A
        - generic [ref=e8]: Accord
        - generic [ref=e9]: testnet
      - generic [ref=e10]:
        - generic [ref=e11]: Search proposals, owners, and recipients
        - generic [ref=e12]:
          - img
          - combobox "Search proposals, owners, and recipients" [ref=e13]
          - generic: ⌘K
      - navigation [ref=e14]:
        - link "dashboard" [ref=e15]:
          - /url: /app
        - link "recurring" [ref=e16]:
          - /url: /app/recurring
        - link "history" [ref=e17]:
          - /url: /app/history
        - link "analytics" [ref=e18]:
          - /url: /app/analytics
        - link "owners" [ref=e19]:
          - /url: /app/owners
        - link "settings" [ref=e20]:
          - /url: /app/settings
        - link "docs" [ref=e21]:
          - /url: /docs
        - radiogroup "Theme selection" [ref=e22]:
          - radio "Light theme" [ref=e23]:
            - img [ref=e24]
            - generic [ref=e30]: Light
          - radio "System theme" [checked] [ref=e31]:
            - img [ref=e32]
            - generic [ref=e34]: System
          - radio "Dark theme" [ref=e35]:
            - img [ref=e36]
            - generic [ref=e38]: Dark
        - combobox "Language" [ref=e39]:
          - option "English" [selected]
          - option "Español"
          - option "العربية"
      - button "What's new, 29 unread entries" [ref=e41]:
        - img [ref=e42]
        - generic [ref=e45]: "29"
      - button "Send feedback" [ref=e46]:
        - img [ref=e47]
        - generic [ref=e49]: Feedback
      - button "Notifications" [ref=e51]:
        - img [ref=e52]
      - button "GDJSB2…C7JD" [ref=e55]
  - main [ref=e56]:
    - generic [ref=e57]:
      - generic [ref=e58]:
        - paragraph [ref=e59]: Threshold
        - paragraph [ref=e60]: 1 of 1
        - paragraph [ref=e61]: voting weight required
      - generic [ref=e62]:
        - paragraph [ref=e63]: Total Voting Power
        - paragraph [ref=e64]: "1"
        - paragraph [ref=e65]: 1 owner
      - generic [ref=e66]:
        - paragraph [ref=e67]: Active
        - paragraph [ref=e68]: "0"
        - paragraph [ref=e69]: proposals
      - generic [ref=e70]:
        - paragraph [ref=e71]: Total
        - paragraph [ref=e72]: "0"
        - paragraph [ref=e73]: proposals created
      - generic [ref=e74]:
        - paragraph [ref=e75]: Executed
        - paragraph [ref=e76]: "0"
        - paragraph [ref=e77]: all time
      - generic [ref=e78]:
        - paragraph [ref=e79]: Recurring Outflows
        - paragraph [ref=e80]: $0.00
        - paragraph [ref=e81]: per month
    - generic [ref=e82]:
      - alert [ref=e83]:
        - paragraph [ref=e84]: Could not load dashboard data
        - paragraph [ref=e85]: Load failed
        - button "Retry" [ref=e86]
      - button "Dismiss dashboard error" [ref=e88]: Dismiss
    - region "Governance Health" [ref=e89]:
      - generic [ref=e90]:
        - heading "Governance Health" [level=3] [ref=e92]
        - status "No whale warning active" [ref=e93]:
          - generic [ref=e95]: Balanced Voting Power
      - paragraph [ref=e98]: Fetching owner weights…
    - generic [ref=e99]:
      - heading "Voting Weight History" [level=3] [ref=e100]
      - generic [ref=e102]: No weight history available yet
    - generic [ref=e103]:
      - heading "Active Proposals" [level=2] [ref=e104]
      - generic [ref=e105]:
        - generic [ref=e106] [cursor=pointer]:
          - checkbox "Expiring first" [ref=e107]
          - text: Expiring first
        - button "New" [ref=e108]:
          - img [ref=e109]
          - text: New
        - button "Recurring" [ref=e110]:
          - img [ref=e111]
          - text: Recurring
    - status [ref=e117]:
      - img [ref=e119]
      - heading "No active proposals" [level=3] [ref=e122]
      - paragraph [ref=e123]: Proposals let signers vote on transactions before they execute.
      - button "Create proposal" [ref=e124]:
        - img [ref=e125]
        - text: Create proposal
    - generic [ref=e126]:
      - heading "Recent Weight Changes" [level=2] [ref=e127]
      - status [ref=e129]:
        - heading "No voting-weight changes recorded yet." [level=3] [ref=e130]
    - generic [ref=e131]:
      - heading "Signers" [level=2] [ref=e132]
      - generic [ref=e134]:
        - generic [ref=e135]:
          - generic [ref=e136]: S
          - generic [ref=e137]: GDJSB2...C7JD
        - generic [ref=e138]: you
  - dialog "Create Recurring Payment" [ref=e140]:
    - generic [ref=e141]:
      - generic [ref=e142]:
        - heading "Create Recurring Payment" [level=2] [ref=e143]
        - button "Close modal" [ref=e144]: ✕
      - generic [ref=e145]:
        - generic [ref=e146]:
          - heading "Preview Recurring Payment" [level=3] [ref=e147]
          - generic [ref=e148]:
            - generic [ref=e149]:
              - term [ref=e150]: Action
              - definition [ref=e151]: Pay 10 USDC to GDJSB22NWBU7IV44SHHG6WO6AJTUED2KNKWL2DYNJJ5X7M5SG7UVC7JD, 1 hour
            - generic [ref=e152]:
              - term [ref=e153]: Estimated Fee
              - definition [ref=e154]: —
        - alert [ref=e155]: "Could not simulate this transaction: Account not found: GDJSB22NWBU7IV44SHHG6WO6AJTUED2KNKWL2DYNJJ5X7M5SG7UVC7JD"
        - generic [ref=e156]:
          - button "Back" [ref=e157]
          - button "Confirm & Submit" [disabled] [ref=e158]
```

# Test source

```ts
  1   | import type { xdr } from "@stellar/stellar-sdk";
  2   | import { expect, test, TEST_WALLET } from "./setup";
  3   | import {
  4   |   VOID,
  5   |   addrVec,
  6   |   emptyVec,
  7   |   installGovernanceRpc,
  8   |   native,
  9   |   symbolVec,
  10  |   u32,
  11  |   u64,
  12  | } from "./gov-harness";
  13  | 
  14  | /**
  15  |  * Recurring-payment end-to-end coverage (issue #789).
  16  |  *
  17  |  * Part 1 creates a recurring payment through the dashboard modal and asserts
  18  |  * the contract receives `create_recurring_payment` with the recipient, amount
  19  |  * (in stroops), and interval the form was filled with.
  20  |  *
  21  |  * Part 2 seeds an active schedule, opens the Recurring page, and disburses it,
  22  |  * asserting the `disburse_recurring` entry point receives the schedule id.
  23  |  */
  24  | 
  25  | const OWNER_A = TEST_WALLET;
  26  | 
  27  | function scheduleNative() {
  28  |   const now = Math.floor(Date.now() / 1000);
  29  |   return {
  30  |     id: 1n,
  31  |     proposer: OWNER_A,
  32  |     recipient: OWNER_A,
  33  |     token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  34  |     amount: 1_000_000_000n,
  35  |     interval_secs: 3600n,
  36  |     interval: 3600n,
  37  |     start_time: BigInt(now - 7200),
  38  |     end_time: BigInt(now + 86_400),
  39  |     cliff_time: 0n,
  40  |     total_cap: 10_000_000_000n,
  41  |     total_disbursed: 0n,
  42  |     last_disbursed_at: 0n,
  43  |     status: "Active",
  44  |     kind: { FixedAmountPerPeriod: null },
  45  |     category: { Ops: null },
  46  |     description: "Recurring E2E",
  47  |   };
  48  | }
  49  | 
  50  | test("recurring payments can be created and disbursed", async ({ page }) => {
  51  |   const state = { schedules: [] as ReturnType<typeof scheduleNative>[] };
  52  |   const sent: Array<{ fn: string; args: unknown[] }> = [];
  53  | 
  54  |   await installGovernanceRpc(page, {
  55  |     simulate: (fn): xdr.ScVal => {
  56  |       switch (fn) {
  57  |         case "get_owners":
  58  |           return addrVec([OWNER_A]);
  59  |         case "get_threshold":
  60  |           return u32(1);
  61  |         case "get_total_weight":
  62  |           return u32(1);
  63  |         case "get_total_proposals":
  64  |           return u64(0);
  65  |         case "get_proposals_paged":
  66  |           return emptyVec();
  67  |         case "get_owner_weight":
  68  |           return u32(1);
  69  |         case "get_owner_weights":
  70  |           return native([{ address: OWNER_A, weight: 1 }]);
  71  |         case "get_roles":
  72  |           return symbolVec(["Owner"]);
  73  |         case "get_total_recurring_payments":
  74  |           return u64(state.schedules.length);
  75  |         case "get_recurring_payments":
  76  |         case "get_recurring_payments_paged":
  77  |           return native(state.schedules);
  78  |         case "get_claimable_amount":
  79  |           return native(0n);
  80  |         default:
  81  |           return VOID;
  82  |       }
  83  |     },
  84  |     send: (fn, args) => {
  85  |       sent.push({ fn, args });
  86  |     },
  87  |   });
  88  | 
  89  |   await page.goto("/app");
  90  |   await expect(page.getByText("No active proposals")).toBeVisible({ timeout: 15_000 });
  91  | 
  92  |   // ─── Part 1: create a recurring payment ────────────────────────────────────
  93  |   await page.getByRole("button", { name: "Recurring" }).click();
  94  |   await expect(page.getByRole("dialog", { name: "Create Recurring Payment" })).toBeVisible();
  95  | 
  96  |   await page.getByLabel("Recipient Stellar address").fill(OWNER_A);
  97  |   await page.getByLabel("Payment amount").fill("10");
  98  |   await page.getByLabel("Payment interval in seconds").fill("3600");
  99  |   await page.getByRole("button", { name: "Review Recurring Payment" }).click();
> 100 |   await page.getByRole("button", { name: "Confirm & Submit" }).click();
      |                                                                ^ Error: locator.click: Test timeout of 60000ms exceeded.
  101 | 
  102 |   await expect
  103 |     .poll(() => sent.filter((call) => call.fn === "create_recurring_payment").length, {
  104 |       timeout: 20_000,
  105 |     })
  106 |     .toBeGreaterThanOrEqual(1);
  107 | 
  108 |   const created = sent.find((call) => call.fn === "create_recurring_payment");
  109 |   expect(created, "create_recurring_payment was submitted").toBeTruthy();
  110 |   // Contract signature:
  111 |   // (proposer, recipient, amount, token, interval, start, cliff, end, cap, category, kind)
  112 |   expect(created!.args[1]).toBe(OWNER_A);
  113 |   expect(Number(created!.args[2])).toBe(100_000_000); // 10 tokens in stroops
  114 |   expect(Number(created!.args[4])).toBe(3600);
  115 | 
  116 |   // ─── Part 2: disburse an active schedule ───────────────────────────────────
  117 |   state.schedules = [scheduleNative()];
  118 | 
  119 |   await page.goto("/app/recurring");
  120 |   await expect(page.getByRole("heading", { name: "Recurring Schedules" })).toBeVisible({
  121 |     timeout: 15_000,
  122 |   });
  123 |   await expect(page.getByText("Schedule #1")).toBeVisible({ timeout: 15_000 });
  124 | 
  125 |   await page.getByRole("button", { name: "Disburse schedule 1 now" }).click();
  126 | 
  127 |   await expect
  128 |     .poll(() => sent.filter((call) => call.fn === "disburse_recurring").length, {
  129 |       timeout: 20_000,
  130 |     })
  131 |     .toBeGreaterThanOrEqual(1);
  132 | 
  133 |   const disburse = sent.find((call) => call.fn === "disburse_recurring");
  134 |   expect(disburse, "disburse_recurring was submitted").toBeTruthy();
  135 |   expect(Number(disburse!.args[0])).toBe(1);
  136 | });
  137 | 
```