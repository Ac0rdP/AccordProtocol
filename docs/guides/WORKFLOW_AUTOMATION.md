# Workflow Automation (Zapier & Generic Webhooks)

## User Story

As a treasury operator, I want to subscribe Zapier catch hooks or generic HTTPS webhooks to proposal, approval, and treasury events so our team receives automated notifications in Slack, email, or ticketing tools without custom polling scripts.

## Supported Triggers

- `proposal.created` — A new spending or governance proposal was created.
- `proposal.approved` — An owner approved a proposal.
- `proposal.executed` — A ready proposal was executed on-chain.
- `treasury.disbursed` — A recurring or one-off treasury disbursement completed.
- `alert.fired` — A configured analytics alert rule triggered.

## Permissions & Data Boundaries

- **Workspace isolation**: Subscriptions and delivery logs are scoped by `(network, contractId)` in `workflow_webhooks` and `workflow_deliveries`.
- **Secret protection**: Signing secrets are stored server-side and never returned in `GET /workflows/webhooks` responses.
- **SSRF protection**: Only public `https://` URLs are accepted; `localhost`, loopback (`127.0.0.1`, `::1`), `.local`, and private RFC1918/link-local ranges are rejected.
- **Write access**: `POST /workflows/webhooks`, `DELETE /workflows/webhooks/{id}`, and `POST /workflows/webhooks/{id}/test` require `ADMIN_TOKEN` bearer authorization when configured and workspace owner permissions in the UI.

## Common Self-Serve Workflow

1. Open **Settings -> Workflow automation (Zapier & webhooks)**.
2. Enter a **Subscription name**, choose **Zapier Catch Hook** or **Generic HTTPS Webhook**, and paste the public `https://` endpoint URL.
3. Select one or more **Trigger events** and click **Add workflow webhook** (`POST /workflows/webhooks`).
4. Click **Test trigger** (`POST /workflows/webhooks/{id}/test`) to queue a sample JSON payload for Zapier field mapping or webhook verification.

## Failure States

| Condition | Code | Behavior |
| --- | --- | --- |
| Non-HTTPS or private/loopback URL | `INVALID_WEBHOOK_URL` | Rejected with `400 Bad Request`. |
| Unsupported `targetType` | `INVALID_TARGET_TYPE` | Must be `zapier` or `generic`. |
| Empty or unknown trigger event | `INVALID_EVENT_TYPE` | Rejected with `400 Bad Request`. |
| Webhook not found in workspace | `NOT_FOUND` | `404 Not Found` on test trigger. |
| Missing/invalid admin token | `UNAUTHORIZED` | `401 Unauthorized`; no subscription created or deleted. |
