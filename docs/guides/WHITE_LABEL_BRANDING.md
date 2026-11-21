# White-Label Branding & Custom Domains

## User Story

As a workspace administrator, I want to replace the default Accord name, logo, colors, and hostname with my organization's own branding so that treasury stakeholders experience a cohesive portal while continuing to use shared Accord contract and indexer infrastructure.

## Permissions & Data Boundaries

- **Workspace isolation**: Branding is scoped to one `(network, contractId)` pair in `workspace_branding`. Customizing one workspace never alters another workspace or shared contract state.
- **Read access**: `GET /branding` is readable by any scoped workspace client so the frontend can apply CSS custom properties (`--accord-brand-primary`, `--accord-brand-accent`), brand name, and logo at load time.
- **Write access**: `PUT /branding` and `DELETE /branding` require the configured `ADMIN_TOKEN` bearer credential on the API and workspace owner status in the UI (`canEdit` in `SettingsPage`).
- **Domain uniqueness**: Custom domains are globally unique (case-insensitive) across workspaces so two workspaces cannot claim the same hostname.

## Common Self-Serve Workflow

1. Open **Settings -> White-label branding & custom domain** in the Accord frontend.
2. Enter your **Brand name**, HTTPS **Logo URL**, 6-digit hex **Primary/Accent colors**, and **Custom domain** (e.g. `treasury.acme.org`).
3. Click **Save branding** (`PUT /branding`). The API persists the configuration and returns a deterministic DNS `TXT` verification token (`accord-verify=<hash>`).
4. Add the displayed `_accord-verification.<domain>` `TXT` record at your DNS provider.
5. Click **Reset to defaults** (`DELETE /branding`) at any time to restore default Accord branding.

## Failure States

| Condition | Code | User-facing behavior |
| --- | --- | --- |
| Non-HTTPS or malformed logo URL | `INVALID_LOGO_URL` | Field error requiring an `https://` URL without spaces. |
| Invalid 6-digit hex color | `INVALID_COLOR` | Field error requiring `#rrggbb` format. |
| Invalid hostname | `INVALID_DOMAIN` | Field error requiring a valid FQDN hostname. |
| Missing/invalid admin token | `UNAUTHORIZED` | `401 Unauthorized`; write rejected without mutating state. |
| Multiple contracts without `contractId` | `MISSING_PARAMETER` | `400 Bad Request` requesting explicit target workspace. |
