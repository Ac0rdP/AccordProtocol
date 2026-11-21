//! Workflow automation with Zapier and generic webhooks:
//! `GET|POST /workflows/webhooks`, `DELETE /workflows/webhooks/{id}`,
//! `POST /workflows/webhooks/{id}/test`.
//!
//! Exposes proposal, approval, and treasury triggers so teams can automate
//! notifications via Zapier hooks or generic signed HTTP webhooks.

use std::collections::{BTreeSet, HashMap};

use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{QueryBuilder, postgres::Postgres, types::Json as SqlJson};

use crate::{
    AppState, admin,
    proposals::{self, ApiError, ErrorDetail},
    scope::{ScopeConfig, push_scope},
};

pub(crate) const MAX_BODY_BYTES: usize = 16 * 1024;
pub(crate) const LIST_PARAMS: &[&str] = &["limit", "offset", "contractId", "network"];
pub(crate) const WRITE_PARAMS: &[&str] = &["contractId", "network"];

pub(crate) const TRIGGER_EVENTS: &[&str] = &[
    "proposal.created",
    "proposal.approved",
    "proposal.executed",
    "treasury.disbursed",
    "alert.fired",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateWebhookInput {
    name: String,
    target_type: String,
    url: String,
    events: Vec<String>,
    signing_secret: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebhookView {
    id: i64,
    network: String,
    contract_id: String,
    name: String,
    target_type: String,
    url: String,
    events: SqlJson<Vec<String>>,
    enabled: bool,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebhookPage {
    items: Vec<WebhookView>,
    total: i64,
    limit: i64,
    offset: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteWebhookResponse {
    id: i64,
    deleted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TestTriggerResponse {
    webhook_id: i64,
    target_type: String,
    event_type: String,
    payload: serde_json::Value,
    dispatched: bool,
}

type ApiResult<T> = Result<T, (StatusCode, Json<ApiError>)>;

fn internal_error(error: sqlx::Error) -> (StatusCode, Json<ApiError>) {
    tracing::error!(%error, "workflow webhook database operation failed");
    proposals::internal_error(error)
}

fn unknown_parameters(
    raw: &HashMap<String, String>,
    accepted: &[&str],
    details: &mut Vec<ErrorDetail>,
) {
    for key in raw.keys() {
        if !accepted.contains(&key.as_str()) {
            details.push(proposals::detail(
                key,
                "is not a supported query parameter",
                "UNKNOWN_PARAMETER",
            ));
        }
    }
}

fn resolve_target(
    scope: &ScopeConfig,
    raw: &HashMap<String, String>,
    details: &mut Vec<ErrorDetail>,
) -> Option<(String, String)> {
    let resolved = scope.resolve(raw, details);
    if !details.is_empty() {
        return None;
    }
    if resolved.networks.len() != 1 || resolved.contract_ids.len() != 1 {
        if resolved.networks.len() != 1 {
            details.push(proposals::detail(
                "network",
                "is required when several networks are configured",
                "MISSING_PARAMETER",
            ));
        }
        if resolved.contract_ids.len() != 1 {
            details.push(proposals::detail(
                "contractId",
                "is required when several contracts are configured",
                "MISSING_PARAMETER",
            ));
        }
        return None;
    }
    Some((resolved.networks[0].clone(), resolved.contract_ids[0].clone()))
}

fn is_safe_webhook_url(raw: &str) -> bool {
    let url = raw.trim();
    if url.len() > 2048 || !url.starts_with("https://") || url.contains(char::is_whitespace) {
        return false;
    }
    let after_scheme = &url["https://".len()..];
    let host_port = after_scheme.split('/').next().unwrap_or("");
    let host = host_port
        .split(':')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if host.is_empty()
        || host == "localhost"
        || host == "127.0.0.1"
        || host == "::1"
        || host.ends_with(".local")
        || host.starts_with("10.")
        || host.starts_with("192.168.")
        || host.starts_with("169.254.")
    {
        return false;
    }
    true
}

fn validate_webhook_input(
    body: &[u8],
) -> Result<(String, String, String, Vec<String>, String), Vec<ErrorDetail>> {
    if body.is_empty() {
        return Err(vec![proposals::detail(
            "body",
            "must be a JSON object",
            "INVALID_BODY",
        )]);
    }
    let input: CreateWebhookInput = serde_json::from_slice(body).map_err(|err| {
        vec![proposals::detail(
            "body",
            &format!("invalid webhook payload: {err}"),
            "INVALID_BODY",
        )]
    })?;

    let mut details = Vec::new();
    let name = input.name.trim().to_owned();
    if name.is_empty() || name.chars().count() > 80 {
        details.push(proposals::detail(
            "name",
            "must be between 1 and 80 characters",
            "INVALID_BODY",
        ));
    }

    let target_type = input.target_type.trim().to_ascii_lowercase();
    if target_type != "zapier" && target_type != "generic" {
        details.push(proposals::detail(
            "targetType",
            "must be either zapier or generic",
            "INVALID_TARGET_TYPE",
        ));
    }

    let url = input.url.trim().to_owned();
    if !is_safe_webhook_url(&url) {
        details.push(proposals::detail(
            "url",
            "must be a public https:// webhook URL",
            "INVALID_WEBHOOK_URL",
        ));
    }

    let mut unique_events = BTreeSet::new();
    for event in &input.events {
        let trimmed = event.trim();
        if !TRIGGER_EVENTS.contains(&trimmed) {
            details.push(proposals::detail(
                "events",
                &format!("unsupported trigger event: {trimmed}"),
                "INVALID_EVENT_TYPE",
            ));
        } else {
            unique_events.insert(trimmed.to_owned());
        }
    }
    if unique_events.is_empty() && details.iter().all(|d| d.field != "events") {
        details.push(proposals::detail(
            "events",
            "must subscribe to at least one trigger event",
            "INVALID_EVENT_TYPE",
        ));
    }

    if !details.is_empty() {
        return Err(details);
    }

    let secret = input
        .signing_secret
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("whsec_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)));

    Ok((
        name,
        target_type,
        url,
        unique_events.into_iter().collect(),
        secret,
    ))
}

pub(crate) fn build_sample_payload(
    network: &str,
    contract_id: &str,
    event_type: &str,
) -> serde_json::Value {
    serde_json::json!({
        "event": event_type,
        "network": network,
        "contractId": contract_id,
        "timestamp": Utc::now().to_rfc3339(),
        "data": {
            "proposalId": 42,
            "proposer": "GDJSB22NWBU7IV44SHHG6WO6AJTUED2KNKWL2DYNJJ5X7M5SG7UVC7JD",
            "amount": "100.00",
            "token": "USDC",
            "status": "Ready"
        }
    })
}

pub(crate) async fn list(
    State(state): State<AppState>,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Json<WebhookPage>> {
    let mut details = Vec::new();
    unknown_parameters(&raw, LIST_PARAMS, &mut details);
    let limit = proposals::parse_integer(&raw, "limit", 20, 1, 100, &mut details);
    let offset = proposals::parse_integer(&raw, "offset", 0, 0, i64::MAX, &mut details);
    let scope = state.scope.resolve(&raw, &mut details);
    if !details.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(ApiError::invalid(details))));
    }

    let mut count_qb =
        QueryBuilder::<Postgres>::new("SELECT COUNT(*) FROM workflow_webhooks WHERE TRUE");
    push_scope(&mut count_qb, "", &scope);
    let total: i64 = count_qb
        .build_query_scalar()
        .fetch_one(&state.pool)
        .await
        .map_err(internal_error)?;

    let mut qb = QueryBuilder::<Postgres>::new(
        "SELECT id, network, contract_id, name, target_type, url, events, enabled, \
         created_at, updated_at FROM workflow_webhooks WHERE TRUE",
    );
    push_scope(&mut qb, "", &scope);
    qb.push(" ORDER BY created_at DESC, id DESC LIMIT ")
        .push_bind(limit)
        .push(" OFFSET ")
        .push_bind(offset);

    let items: Vec<WebhookView> = qb
        .build_query_as()
        .fetch_all(&state.pool)
        .await
        .map_err(internal_error)?;

    Ok(Json(WebhookPage {
        items,
        total,
        limit,
        offset,
    }))
}

pub(crate) async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
    body: Bytes,
) -> ApiResult<(StatusCode, Json<WebhookView>)> {
    admin::require_token(state.admin_token.as_deref(), &headers)?;

    let mut details = Vec::new();
    unknown_parameters(&raw, WRITE_PARAMS, &mut details);
    let target = resolve_target(&state.scope, &raw, &mut details);
    if !details.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(ApiError::invalid(details))));
    }
    let (network, contract_id) = target.unwrap();

    let (name, target_type, url, events, secret) = match validate_webhook_input(&body) {
        Ok(v) => v,
        Err(errs) => return Err((StatusCode::BAD_REQUEST, Json(ApiError::invalid(errs)))),
    };

    let row: WebhookView = sqlx::query_as(
        "INSERT INTO workflow_webhooks (
            network, contract_id, name, target_type, url, events, signing_secret
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, network, contract_id, name, target_type, url, events, enabled,
                   created_at, updated_at",
    )
    .bind(&network)
    .bind(&contract_id)
    .bind(&name)
    .bind(&target_type)
    .bind(&url)
    .bind(SqlJson(events))
    .bind(&secret)
    .fetch_one(&state.pool)
    .await
    .map_err(internal_error)?;

    Ok((StatusCode::CREATED, Json(row)))
}

pub(crate) async fn remove(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Json<DeleteWebhookResponse>> {
    admin::require_token(state.admin_token.as_deref(), &headers)?;

    let mut details = Vec::new();
    unknown_parameters(&raw, WRITE_PARAMS, &mut details);
    let target = resolve_target(&state.scope, &raw, &mut details);
    if !details.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(ApiError::invalid(details))));
    }
    let (network, contract_id) = target.unwrap();

    let result = sqlx::query(
        "DELETE FROM workflow_webhooks WHERE id = $1 AND network = $2 AND contract_id = $3",
    )
    .bind(id)
    .bind(&network)
    .bind(&contract_id)
    .execute(&state.pool)
    .await
    .map_err(internal_error)?;

    Ok(Json(DeleteWebhookResponse {
        id,
        deleted: result.rows_affected() > 0,
    }))
}

pub(crate) async fn test_trigger(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Json<TestTriggerResponse>> {
    admin::require_token(state.admin_token.as_deref(), &headers)?;

    let mut details = Vec::new();
    unknown_parameters(&raw, WRITE_PARAMS, &mut details);
    let target = resolve_target(&state.scope, &raw, &mut details);
    if !details.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(ApiError::invalid(details))));
    }
    let (network, contract_id) = target.unwrap();

    let webhook: Option<WebhookView> = sqlx::query_as(
        "SELECT id, network, contract_id, name, target_type, url, events, enabled,
                created_at, updated_at
         FROM workflow_webhooks
         WHERE id = $1 AND network = $2 AND contract_id = $3",
    )
    .bind(id)
    .bind(&network)
    .bind(&contract_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(internal_error)?;

    let Some(webhook) = webhook else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ApiError::invalid(vec![proposals::detail(
                "id",
                "workflow webhook not found",
                "NOT_FOUND",
            )])),
        ));
    };

    let event_type = webhook
        .events
        .0
        .first()
        .cloned()
        .unwrap_or_else(|| "proposal.created".to_owned());
    let payload = build_sample_payload(&network, &contract_id, &event_type);

    sqlx::query(
        "INSERT INTO workflow_deliveries (webhook_id, event_type, payload, status)
         VALUES ($1, $2, $3, 'queued')",
    )
    .bind(webhook.id)
    .bind(&event_type)
    .bind(SqlJson(&payload))
    .execute(&state.pool)
    .await
    .map_err(internal_error)?;

    Ok(Json(TestTriggerResponse {
        webhook_id: webhook.id,
        target_type: webhook.target_type,
        event_type,
        payload,
        dispatched: true,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_zapier_and_generic_webhooks() {
        let payload = br#"{
            "name": "Zapier Proposal Alerts",
            "targetType": "zapier",
            "url": "https://hooks.zapier.com/hooks/catch/123456/abcdef/",
            "events": ["proposal.created", "proposal.approved", "proposal.created"]
        }"#;
        let (name, target_type, url, events, _secret) = validate_webhook_input(payload).unwrap();
        assert_eq!(name, "Zapier Proposal Alerts");
        assert_eq!(target_type, "zapier");
        assert_eq!(url, "https://hooks.zapier.com/hooks/catch/123456/abcdef/");
        assert_eq!(events, vec!["proposal.approved", "proposal.created"]);
    }

    #[test]
    fn rejects_ssrf_urls_and_unsupported_events() {
        let payload = br#"{
            "name": "Internal",
            "targetType": "slack",
            "url": "https://127.0.0.1/hook",
            "events": ["unknown.event"]
        }"#;
        let errs = validate_webhook_input(payload).unwrap_err();
        let codes: Vec<&str> = errs.iter().map(|e| e.code.as_str()).collect();
        assert!(codes.contains(&"INVALID_TARGET_TYPE"));
        assert!(codes.contains(&"INVALID_WEBHOOK_URL"));
        assert!(codes.contains(&"INVALID_EVENT_TYPE"));
    }

    #[test]
    fn sample_payload_includes_workspace_and_event() {
        let payload = build_sample_payload("testnet", "C123", "treasury.disbursed");
        assert_eq!(payload["event"], "treasury.disbursed");
        assert_eq!(payload["network"], "testnet");
        assert_eq!(payload["contractId"], "C123");
    }
}
