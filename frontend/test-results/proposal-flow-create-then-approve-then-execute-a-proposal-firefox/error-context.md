# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: proposal-flow.spec.ts >> create then approve then execute a proposal
- Location: e2e/proposal-flow.spec.ts:118:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('button', { name: 'Approve' })
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByRole('button', { name: 'Approve' })

```

```yaml
- banner:
  - link "A Accord testnet":
    - /url: /
  - text: Search proposals, owners, and recipients
  - combobox "Search proposals, owners, and recipients"
  - text: ⌘K
  - navigation:
    - link "dashboard":
      - /url: /app
    - link "recurring":
      - /url: /app/recurring
    - link "history":
      - /url: /app/history
    - link "analytics":
      - /url: /app/analytics
    - link "owners":
      - /url: /app/owners
    - link "settings":
      - /url: /app/settings
    - link "docs":
      - /url: /docs
    - radiogroup "Theme selection":
      - radio "Light theme": Light
      - radio "System theme" [checked]: System
      - radio "Dark theme": Dark
    - combobox "Language":
      - option "English" [selected]
      - option "Español"
      - option "العربية"
  - button "What's new, 29 unread entries": "29"
  - button "Send feedback": Feedback
  - button "Notifications, 1 unread": "1"
  - button "GDJSB2…C7JD"
- main:
  - status: Loading contract data…
```

# Test source

```ts
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
  259 |   await page.getByRole("button", { name: "New", exact: true }).click();
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
> 276 |   await expect(page.getByRole("button", { name: "Approve" })).toBeVisible({
      |                                                               ^ Error: expect(locator).toBeVisible() failed
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