# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: weighted-approval.spec.ts >> weighted approvals accumulate across owners until quorum is reached
- Location: e2e/weighted-approval.spec.ts:70:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText('No active proposals')
Expected: visible
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 15000ms
  - waiting for getByText('No active proposals')

```

# Test source

```ts
  45  |   to: string;
  46  |   amount: bigint;
  47  |   approvalWeight: number;
  48  |   approvals: number;
  49  |   status: "Pending" | "Ready" | "Executed";
  50  |   approvedBy: Set<string>;
  51  | };
  52  | 
  53  | function proposalToNative(proposal: ProposalState) {
  54  |   return {
  55  |     id: BigInt(proposal.id),
  56  |     proposer: proposal.proposer,
  57  |     description: "Weighted E2E transfer",
  58  |     deadline: BigInt(Math.floor(Date.now() / 1000) + 7 * 86_400),
  59  |     approvals: proposal.approvals,
  60  |     approval_weight: proposal.approvalWeight,
  61  |     quorum_weight: QUORUM,
  62  |     status: proposal.status,
  63  |     kind: { Transfer: [proposal.to, proposal.amount, XLM_TOKEN] },
  64  |     to: proposal.to,
  65  |     amount: proposal.amount,
  66  |     token: XLM_TOKEN,
  67  |   };
  68  | }
  69  | 
  70  | test("weighted approvals accumulate across owners until quorum is reached", async ({ page }) => {
  71  |   const proposals: ProposalState[] = [];
  72  |   const sent: Array<{ fn: string; args: unknown[] }> = [];
  73  |   let nextProposalId = 1;
  74  | 
  75  |   const findProposal = (id: number) => proposals.find((p) => p.id === id);
  76  | 
  77  |   await installGovernanceRpc(page, {
  78  |     simulate: (fn, args): xdr.ScVal => {
  79  |       switch (fn) {
  80  |         case "get_owners":
  81  |           return addrVec(OWNERS);
  82  |         case "get_threshold":
  83  |           return u32(QUORUM);
  84  |         case "get_total_weight":
  85  |           return u32(TOTAL_WEIGHT);
  86  |         case "get_required_quorum_weight":
  87  |           return u32(QUORUM);
  88  |         case "get_weight_cap_pct":
  89  |           return u32(50);
  90  |         case "get_total_proposals":
  91  |           return u64(proposals.length);
  92  |         case "get_proposals_paged":
  93  |           return native(proposals.map(proposalToNative));
  94  |         case "get_owner_weight":
  95  |           return u32(WEIGHTS[String(args[0] ?? "")] ?? 0);
  96  |         case "get_owner_weights":
  97  |           return native(
  98  |             OWNERS.map((owner) => ({ address: owner, weight: WEIGHTS[owner] })),
  99  |           );
  100 |         case "get_roles":
  101 |           return symbolVec(["Owner"]);
  102 |         case "has_approved": {
  103 |           const owner = String(args[0] ?? "");
  104 |           const id = Number(args[1] ?? 0);
  105 |           return native(findProposal(id)?.approvedBy.has(owner) ?? false);
  106 |         }
  107 |         case "get_recurring_payments":
  108 |           return emptyVec();
  109 |         default:
  110 |           return VOID;
  111 |       }
  112 |     },
  113 |     send: (fn, args) => {
  114 |       sent.push({ fn, args });
  115 |       if (fn === "create_proposal") {
  116 |         proposals.push({
  117 |           id: nextProposalId++,
  118 |           proposer: String(args[0] ?? ""),
  119 |           to: String(args[1] ?? ""),
  120 |           amount: BigInt(String(args[2] ?? 0)),
  121 |           approvalWeight: 0,
  122 |           approvals: 0,
  123 |           status: "Pending",
  124 |           approvedBy: new Set(),
  125 |         });
  126 |       } else if (fn === "approve") {
  127 |         const owner = String(args[0] ?? "");
  128 |         const id = Number(args[1] ?? 0);
  129 |         const proposal = findProposal(id);
  130 |         if (proposal && !proposal.approvedBy.has(owner)) {
  131 |           proposal.approvedBy.add(owner);
  132 |           proposal.approvals += 1;
  133 |           proposal.approvalWeight += WEIGHTS[owner] ?? 0;
  134 |           if (proposal.approvalWeight >= QUORUM) proposal.status = "Ready";
  135 |         }
  136 |       } else if (fn === "execute") {
  137 |         const id = Number(args[1] ?? 0);
  138 |         const proposal = findProposal(id);
  139 |         if (proposal) proposal.status = "Executed";
  140 |       }
  141 |     },
  142 |   });
  143 | 
  144 |   await page.goto("/app");
> 145 |   await expect(page.getByText("No active proposals")).toBeVisible({ timeout: 15_000 });
      |                                                       ^ Error: expect(locator).toBeVisible() failed
  146 | 
  147 |   // ─── Create a transfer proposal ────────────────────────────────────────────
  148 |   await page.getByRole("button", { name: "New" }).click();
  149 |   await expect(page.getByRole("dialog", { name: "New Proposal" })).toBeVisible();
  150 |   await page.getByRole("button", { name: "Transfer" }).click();
  151 | 
  152 |   await page.getByLabel("Recipient Address").fill(OWNER_C);
  153 |   await page.getByLabel("Amount").fill("1");
  154 |   await page.getByLabel("Description").fill("Pay vendor");
  155 |   await page.getByRole("button", { name: "Review Proposal" }).click();
  156 |   await page.getByRole("button", { name: "Confirm & Submit" }).click();
  157 | 
  158 |   await expect(page.getByText("0 / 4 weight")).toBeVisible({ timeout: 20_000 });
  159 |   const created = sent.find((call) => call.fn === "create_proposal");
  160 |   expect(created, "create_proposal was submitted").toBeTruthy();
  161 |   expect(created!.args[1]).toBe(OWNER_C);
  162 | 
  163 |   // ─── Approve as A (weight 2 of 4) ──────────────────────────────────────────
  164 |   await page.getByRole("button", { name: "Approve proposal #1" }).click();
  165 |   await expect(page.getByText("2 / 4 weight")).toBeVisible({ timeout: 20_000 });
  166 |   await expect(page.getByRole("button", { name: "Execute proposal #1" })).toHaveCount(0);
  167 | 
  168 |   // ─── Switch to B (weight 3) — combined weight 5 exceeds the quorum ─────────
  169 |   await page.addInitScript((wallet) => {
  170 |     (window as unknown as { __TEST_WALLET__: string }).__TEST_WALLET__ = wallet;
  171 |   }, OWNER_B);
  172 |   await page.reload();
  173 | 
  174 |   await expect(page.getByText("2 / 4 weight")).toBeVisible({ timeout: 20_000 });
  175 |   await page.getByRole("button", { name: "Approve proposal #1" }).click();
  176 |   await expect(page.getByText("5 / 4 weight")).toBeVisible({ timeout: 20_000 });
  177 | 
  178 |   // ─── Execute once the quorum is met ────────────────────────────────────────
  179 |   await page.getByRole("button", { name: "Execute proposal #1" }).click();
  180 |   await page.getByRole("button", { name: "Confirm" }).click();
  181 | 
  182 |   await expect(page.getByText("No active proposals")).toBeVisible({ timeout: 20_000 });
  183 |   expect(sent.some((call) => call.fn === "execute")).toBe(true);
  184 | });
  185 | 
```