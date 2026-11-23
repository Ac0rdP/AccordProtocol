# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: proposal-flow.spec.ts >> create then approve then execute a proposal
- Location: e2e/proposal-flow.spec.ts:118:1

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: locator.click: Test timeout of 60000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'New', exact: true })
    - locator resolved to <button disabled type="button" title="Creating proposals requires the Proposer role." class="inline-flex items-center gap-1.5 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-3 py-1.5 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-zinc-800">…</button>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
      - waiting 100ms
    88 × waiting for element to be visible, enabled and stable
       - element is not enabled
     - retrying click action
       - waiting 500ms

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
        - paragraph [ref=e59]: No multisig configured yet
        - paragraph [ref=e60]: Take the guided onboarding wizard to configure owners, quorum threshold, and your first proposal.
      - link "Start Setup Wizard →" [ref=e61]:
        - /url: /app/onboarding
    - generic [ref=e62]:
      - alert [ref=e63]:
        - paragraph [ref=e64]: Could not load dashboard data
        - paragraph [ref=e65]: Load failed
        - button "Retry" [ref=e66]
      - button "Dismiss dashboard error" [ref=e68]: Dismiss
    - region "Governance Health" [ref=e69]:
      - generic [ref=e70]:
        - heading "Governance Health" [level=3] [ref=e72]
        - status "No whale warning active" [ref=e73]:
          - generic [ref=e75]: Balanced Voting Power
      - paragraph [ref=e78]: Fetching owner weights…
    - generic [ref=e79]:
      - heading "Voting Weight History" [level=3] [ref=e80]
      - generic [ref=e82]: No weight history available yet
    - generic [ref=e83]:
      - heading "Active Proposals" [level=2] [ref=e84]
      - generic [ref=e85]:
        - generic [ref=e86] [cursor=pointer]:
          - checkbox "Expiring first" [ref=e87]
          - text: Expiring first
        - button "New" [disabled] [ref=e88]:
          - img [ref=e89]
          - text: New
        - button "Recurring" [disabled] [ref=e90]:
          - img [ref=e91]
          - text: Recurring
    - status [ref=e97]:
      - img [ref=e99]
      - heading "No active proposals" [level=3] [ref=e102]
      - paragraph [ref=e103]: Proposals let signers vote on transactions before they execute.
      - button "Create proposal" [ref=e104]:
        - img [ref=e105]
        - text: Create proposal
    - generic [ref=e106]:
      - heading "Recent Weight Changes" [level=2] [ref=e107]
      - status [ref=e109]:
        - heading "No voting-weight changes recorded yet." [level=3] [ref=e110]
    - generic [ref=e111]:
      - heading "Signers" [level=2] [ref=e112]
      - status [ref=e114]:
        - heading "No signers yet" [level=3] [ref=e115]
        - paragraph [ref=e116]: Owners will appear here once the multisig is initialized.
```

# Test source

```ts
  159 |         }),
  160 |       });
  161 |     }
  162 | 
  163 |     if (method === "simulateTransaction") {
  164 |       const fn = getCallDetails(body.params?.transaction ?? "").fn;
  165 |       let retval = VOID_B64;
  166 |       if (fn === "get_threshold") retval = THRESH_B64;
  167 |       else if (fn === "get_owners") retval = ownersXdr();
  168 |       else if (fn === "get_total_proposals") retval = totalXdr(state.total);
  169 |       else if (fn === "get_proposals_paged") retval = proposalsXdr(state.status, state.approvals);
  170 |       else if (fn === "has_approved") retval = hasApprovedXdr(state.hasApproved);
  171 |       else if (fn === "get_roles") retval = rolesXdr();
  172 |       return route.fulfill({
  173 |         contentType: "application/json",
  174 |         body: JSON.stringify(simResult(id, retval)),
  175 |       });
  176 |     }
  177 | 
  178 |     if (method === "sendTransaction") {
  179 |       const txBase64 = body.params?.transaction ?? "";
  180 |       lastEnvXdr = txBase64;
  181 |       const fn = getCallDetails(txBase64).fn;
  182 |       if (fn === "create_proposal") {
  183 |         Object.assign(state, { total: 1, status: "Pending", approvals: 0, hasApproved: false });
  184 |       } else if (fn === "approve") {
  185 |         Object.assign(state, { status: "Ready", approvals: 1, hasApproved: true });
  186 |       } else if (fn === "execute") {
  187 |         Object.assign(state, { status: "Executed" });
  188 |       }
  189 |       return route.fulfill({
  190 |         contentType: "application/json",
  191 |         body: JSON.stringify({
  192 |           jsonrpc: "2.0",
  193 |           id,
  194 |           result: { hash: "mock-tx-hash", status: "PENDING" },
  195 |         }),
  196 |       });
  197 |     }
  198 | 
  199 |     if (method === "getTransaction") {
  200 |       return route.fulfill({
  201 |         contentType: "application/json",
  202 |         body: JSON.stringify({
  203 |           jsonrpc: "2.0",
  204 |           id,
  205 |           result: {
  206 |             status: "SUCCESS",
  207 |             ledger: 1000,
  208 |             createdAt: Math.floor(Date.now() / 1000),
  209 |             envelopeXdr: lastEnvXdr,
  210 |             resultXdr: TX_RESULT_B64,
  211 |             resultMetaXdr: TX_META_B64,
  212 |             latestLedger: 1000,
  213 |             latestLedgerCloseTime: Math.floor(Date.now() / 1000),
  214 |           },
  215 |         }),
  216 |       });
  217 |     }
  218 | 
  219 |     if (method === "getLatestLedger") {
  220 |       return route.fulfill({
  221 |         contentType: "application/json",
  222 |         body: JSON.stringify({
  223 |           jsonrpc: "2.0",
  224 |           id,
  225 |           result: { id: "mock-ledger", sequence: 1000, protocolVersion: "22" },
  226 |         }),
  227 |       });
  228 |     }
  229 | 
  230 |     if (method === "getEvents") {
  231 |       return route.fulfill({
  232 |         contentType: "application/json",
  233 |         body: JSON.stringify({
  234 |           jsonrpc: "2.0",
  235 |           id,
  236 |           result: { events: [], latestLedger: 1000 },
  237 |         }),
  238 |       });
  239 |     }
  240 | 
  241 |     await route.continue();
  242 |   });
  243 | 
  244 |   // Intercept all unhandled promise rejections to surface hidden errors.
  245 |   await page.addInitScript(() => {
  246 |     window.addEventListener("unhandledrejection", (e) => {
  247 |       console.error("[UNHANDLED]", e.reason?.message ?? String(e.reason));
  248 |     });
  249 |   });
  250 | 
  251 |   await page.goto("/app");
  252 | 
  253 |   // Dashboard renders with empty proposal list once wallet and contract data load.
  254 |   await expect(page.getByRole("heading", { name: "Active Proposals", exact: true })).toBeVisible({ timeout: 15_000 });
  255 |   await expect(page.getByText("No active proposals", { exact: true })).toBeVisible({ timeout: 10_000 });
  256 | 
  257 |   // ─── Step 1: Create a proposal ───────────────────────────────────────────
  258 | 
> 259 |   await page.getByRole("button", { name: "New", exact: true }).click();
      |                                                                ^ Error: locator.click: Test timeout of 60000ms exceeded.
  260 |   await expect(page.getByText("New Proposal")).toBeVisible();
  261 |   await page.getByRole("button", { name: "Transfer" }).click();
  262 | 
  263 |   await page.getByPlaceholder("G...").fill(G);
  264 |   await page.getByPlaceholder("0.00").fill("10");
  265 |   await page.getByPlaceholder("What is this payment for?").fill("Test Proposal");
  266 | 
  267 |   // Review button is disabled until the form is valid.
  268 |   await expect(
  269 |     page.getByRole("button", { name: "Review Proposal" })
  270 |   ).not.toBeDisabled({ timeout: 10_000 });
  271 |   await page.getByRole("button", { name: "Review Proposal" }).click();
  272 |   await page.getByRole("button", { name: "Confirm & Submit" }).click();
  273 | 
  274 |   // buildAndSubmit polls getTransaction every 2 s before resolving; allow time.
  275 |   await expect(page.getByText("Test Proposal")).toBeVisible({ timeout: 20_000 });
  276 |   await expect(page.getByRole("button", { name: "Approve" })).toBeVisible({
  277 |     timeout: 5_000,
  278 |   });
  279 | 
  280 |   // ─── Step 2: Approve the proposal ────────────────────────────────────────
  281 | 
  282 |   await page.getByRole("button", { name: "Approve" }).click();
  283 | 
  284 |   // After approve refresh: approvals=1/threshold=1, status→ready → Execute visible.
  285 |   await expect(page.getByText("1 / 1 weight")).toBeVisible({ timeout: 20_000 });
  286 |   await expect(page.getByRole("button", { name: "Execute" })).toBeVisible({
  287 |     timeout: 5_000,
  288 |   });
  289 | 
  290 |   // ─── Step 3: Execute the proposal ────────────────────────────────────────
  291 | 
  292 |   await page.getByRole("button", { name: "Execute" }).click();
  293 |   await page.getByRole("button", { name: "Confirm" }).click();
  294 | 
  295 |   // Executed proposals are filtered out of activeProposals → empty state returns.
  296 |   await expect(page.getByText("No active proposals", { exact: true })).toBeVisible({ timeout: 20_000 });
  297 | });
  298 | 
```