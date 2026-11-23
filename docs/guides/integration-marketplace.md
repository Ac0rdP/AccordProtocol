# Plugin & Integration Marketplace

The Accord Protocol Integration Marketplace lets multisig teams browse, configure, and install **reviewed integrations** for **notifications**, **accounting**, and **treasury automation** without operator intervention.

---

## User Story

> As a treasury operator or multisig owner, I want to install reviewed integrations for notifications, accounting exports, and recurring treasury automation directly from the dashboard so my team gets real-time alerts, clean bookkeeping, and timely disbursements without custom scripts or manual operator setup.

---

## Permissions & Data Boundaries

Every integration in the marketplace is security-reviewed and declares explicit permissions and a strict data boundary **before** you install it:

| Integration | Category | Permissions | Data Boundary |
|---|---|---|---|
| **Slack Notifications** (`slack-notifications`) | Notifications | `read:proposals`, `read:events` | Sends proposal ID, category, token, amount, and status only; no private keys or signer PII. |
| **Discord Notifications** (`discord-notifications`) | Notifications | `read:proposals`, `read:events` | Sends proposal ID, title, amount, and approval progress only; never accesses wallet secrets. |
| **QuickBooks Accounting Sync** (`quickbooks-accounting`) | Accounting | `read:proposals`, `read:analytics`, `export:reports` | Exports executed transaction hashes, timestamps, amounts, and categories; read-only, cannot initiate transfers. |
| **Xero Ledger Export** (`xero-accounting`) | Accounting | `read:proposals`, `read:analytics`, `export:reports` | Read-only export of executed transfers and categories; zero write or signing capability. |
| **Recurring Payment Keeper** (`recurring-keeper`) | Treasury Automation | `read:recurring`, `trigger:disburse_recurring` | Calls permissionless `disburse_recurring` on already-approved schedules; cannot create or modify schedules. |
| **Idle Balance Sweep Advisor** (`idle-balance-sweep`) | Treasury Automation | `read:balances`, `draft:proposal` | Propose-only boundary: can draft a proposal for owner review, never approves or executes transfers. |

> **Security invariant:** Integrations never store raw wallet private keys, never bypass on-chain multisig quorum, and cannot execute unapproved token transfers.

---

## Installing an Integration (Common Path)

1. Open `/app/integrations` (**Integrations** in the sidebar).
2. Filter by **All**, **Notifications**, **Accounting**, or **Treasury Automation**.
3. Review the **Permissions** and **Data boundary** box on the integration card.
4. Click **Install: \<Integration Name\>**.
5. Fill in the required configuration field (for example, `#treasury-alerts` for Slack or `15` minutes for the Recurring Payment Keeper) and click **Save & enable**.

When `VITE_ANALYTICS_API_URL` is configured, installations are persisted in PostgreSQL via `PUT /integrations/{id}`. In standalone frontend mode (without `VITE_ANALYTICS_API_URL`), installations are stored in browser workspace storage (`accord_integration_installs`) so the common path works immediately without operator intervention.

---

## Failure States & Troubleshooting

| Failure State | Cause | Resolution |
|---|---|---|
| `Could not load the integration marketplace` | `GET /integrations` returned 5xx or network error. | Click **Retry** on the error banner, or verify `VITE_ANALYTICS_API_URL` is reachable. |
| `<Field> is required.` | Required configuration field was left blank. | Enter a non-empty value (up to 512 characters) and submit again. |
| `401 Unauthorized` on install/uninstall | `ADMIN_TOKEN` is enabled on `analytics-api` and no bearer token was supplied. | Provide `Authorization: Bearer <ADMIN_TOKEN>` or configure the frontend proxy. |
| `404 Unknown or unreviewed integration plugin` | Attempted to install a plugin ID not in the reviewed catalog. | Only reviewed catalog IDs listed by `GET /integrations` may be installed. |

---

## API Reference

- `GET /integrations?category=all&contractId=<C...>&network=testnet` — Lists the reviewed catalog and workspace installations.
- `PUT /integrations/{id}?contractId=<C...>&network=testnet` — Installs or updates a reviewed integration (`{ "enabled": true, "config": { ... } }`).
- `DELETE /integrations/{id}?contractId=<C...>&network=testnet` — Uninstalls an integration from the workspace.

See also:
- [Analytics API Reference](../ANALYTICS_API.md)
- [Roles & Permissions](roles-and-permissions.md)
- [Error-Code & Troubleshooting Index](../ERROR_CODES.md)
