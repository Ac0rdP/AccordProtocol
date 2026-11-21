# Workspace Billing & Usage Plans

## User Story

As a treasury owner, I want to see our workspace's plan limits for workspaces, API usage, reports, and integrations and upgrade our plan directly in settings without waiting on an operator.

## Plan Tiers & Quotas

| Tier | Workspaces | API Requests / mo | Reports / mo | Integrations | Price |
| --- | --- | --- | --- | --- | --- |
| `free` | 1 | 10,000 | 5 | 2 | \$0/mo |
| `pro` | 5 | 250,000 | 100 | 25 | \$49/mo |
| `enterprise` | 50 | 5,000,000 | 2,000 | 500 | \$299/mo |

## Permissions & Data Boundaries

- **Workspace isolation**: Plans and usage counters are scoped to `(network, contractId)` in `workspace_plans`.
- **Read access**: `GET /billing` returns the active plan, usage counters, and upgrade catalog for the scoped workspace.
- **Write access**: `PUT /billing/plan` requires `ADMIN_TOKEN` bearer authorization when configured and workspace owner permissions in the UI (`canManageBilling`).

## Self-Serve Upgrade Path

1. Open **Settings -> Workspace billing & usage plans**.
2. Inspect current usage meters (highlighted in amber once usage reaches 80% of quota).
3. Enter or verify the **Billing email**.
4. Click **Upgrade to PRO** (or select any tier card) to invoke `PUT /billing/plan` and immediately unlock the new quotas.

## Failure States

| Condition | Code | Behavior |
| --- | --- | --- |
| Unknown plan tier | `INVALID_PLAN_TIER` | Rejected with `400 Bad Request`. |
| Invalid billing email | `INVALID_EMAIL` | Client and API reject malformed email addresses. |
| Downgrade below current usage | `PLAN_LIMIT_EXCEEDED` | Downgrade is blocked until usage fits within target limits. |
| Missing/invalid admin token | `UNAUTHORIZED` | `401 Unauthorized`; plan remains unchanged. |
