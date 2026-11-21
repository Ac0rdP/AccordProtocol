//! Workspace billing and usage plans: `GET /billing`, `PUT /billing/plan`.
//!
//! Enforces explicit plan limits for workspaces, API requests, reports, and
//! integrations per `(network, contractId)` workspace and provides a self-serve
//! upgrade path.

use std::collections::HashMap;

use axum::{
    Json,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{
    AppState, admin,
    proposals::{self, ApiError, ErrorDetail},
    scope::ScopeConfig,
};

pub(crate) const MAX_BODY_BYTES: usize = 8 * 1024;
pub(crate) const QUERY_PARAMS: &[&str] = &["contractId", "network"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanTier {
    Free,
    Pro,
    Enterprise,
}

impl PlanTier {
    pub fn as_str(self) -> &'static str {
        match self {
            PlanTier::Free => "free",
            PlanTier::Pro => "pro",
            PlanTier::Enterprise => "enterprise",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "free" => Some(PlanTier::Free),
            "pro" => Some(PlanTier::Pro),
            "enterprise" => Some(PlanTier::Enterprise),
            _ => None,
        }
    }

    pub fn limits(self) -> PlanLimits {
        match self {
            PlanTier::Free => PlanLimits {
                workspaces_limit: 1,
                api_requests_limit: 10_000,
                reports_limit: 5,
                integrations_limit: 2,
                monthly_price_usd: 0,
            },
            PlanTier::Pro => PlanLimits {
                workspaces_limit: 5,
                api_requests_limit: 250_000,
                reports_limit: 100,
                integrations_limit: 25,
                monthly_price_usd: 49,
            },
            PlanTier::Enterprise => PlanLimits {
                workspaces_limit: 50,
                api_requests_limit: 5_000_000,
                reports_limit: 2_000,
                integrations_limit: 500,
                monthly_price_usd: 299,
            },
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanLimits {
    pub workspaces_limit: i32,
    pub api_requests_limit: i64,
    pub reports_limit: i32,
    pub integrations_limit: i32,
    pub monthly_price_usd: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanCatalogEntry {
    pub tier: &'static str,
    pub limits: PlanLimits,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspacePlanRow {
    network: String,
    contract_id: String,
    plan_tier: String,
    workspaces_limit: i32,
    api_requests_used: i64,
    api_requests_limit: i64,
    reports_used: i32,
    reports_limit: i32,
    integrations_used: i32,
    integrations_limit: i32,
    billing_email: Option<String>,
    status: String,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BillingSummary {
    plan: WorkspacePlanRow,
    catalog: Vec<PlanCatalogEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdatePlanInput {
    plan_tier: String,
    billing_email: Option<String>,
}

type ApiResult<T> = Result<T, (StatusCode, Json<ApiError>)>;

fn internal_error(error: sqlx::Error) -> (StatusCode, Json<ApiError>) {
    tracing::error!(%error, "billing database operation failed");
    proposals::internal_error(error)
}

fn unknown_parameters(raw: &HashMap<String, String>, details: &mut Vec<ErrorDetail>) {
    for key in raw.keys() {
        if !QUERY_PARAMS.contains(&key.as_str()) {
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

fn is_valid_email(email: &str) -> bool {
    let trimmed = email.trim();
    if trimmed.is_empty() || trimmed.len() > 254 || trimmed.contains(char::is_whitespace) {
        return false;
    }
    let Some((local, domain)) = trimmed.split_once('@') else {
        return false;
    };
    !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
}

fn validate_plan_input(body: &[u8]) -> Result<(PlanTier, Option<String>), Vec<ErrorDetail>> {
    if body.is_empty() {
        return Err(vec![proposals::detail(
            "body",
            "must be a JSON object",
            "INVALID_BODY",
        )]);
    }
    let input: UpdatePlanInput = serde_json::from_slice(body).map_err(|err| {
        vec![proposals::detail(
            "body",
            &format!("invalid plan payload: {err}"),
            "INVALID_BODY",
        )]
    })?;

    let mut details = Vec::new();
    let tier = PlanTier::parse(&input.plan_tier);
    if tier.is_none() {
        details.push(proposals::detail(
            "planTier",
            "must be one of: free, pro, enterprise",
            "INVALID_PLAN_TIER",
        ));
    }

    let email = input
        .billing_email
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    if let Some(ref e) = email
        && !is_valid_email(e)
    {
        details.push(proposals::detail(
            "billingEmail",
            "must be a valid email address",
            "INVALID_EMAIL",
        ));
    }

    if !details.is_empty() {
        return Err(details);
    }

    Ok((tier.unwrap(), email))
}

fn catalog() -> Vec<PlanCatalogEntry> {
    [PlanTier::Free, PlanTier::Pro, PlanTier::Enterprise]
        .into_iter()
        .map(|tier| PlanCatalogEntry {
            tier: tier.as_str(),
            limits: tier.limits(),
        })
        .collect()
}

fn check_downgrade_headroom(
    api_used: i64,
    reports_used: i32,
    integrations_used: i32,
    target: PlanLimits,
) -> Result<(), Vec<ErrorDetail>> {
    let mut details = Vec::new();
    if api_used > target.api_requests_limit {
        details.push(proposals::detail(
            "planTier",
            "current API usage exceeds the target plan limit",
            "PLAN_LIMIT_EXCEEDED",
        ));
    }
    if reports_used > target.reports_limit {
        details.push(proposals::detail(
            "planTier",
            "current report usage exceeds the target plan limit",
            "PLAN_LIMIT_EXCEEDED",
        ));
    }
    if integrations_used > target.integrations_limit {
        details.push(proposals::detail(
            "planTier",
            "active integrations exceed the target plan limit",
            "PLAN_LIMIT_EXCEEDED",
        ));
    }
    if details.is_empty() {
        Ok(())
    } else {
        Err(details)
    }
}

pub(crate) async fn get_plan(
    State(state): State<AppState>,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Json<BillingSummary>> {
    let mut details = Vec::new();
    unknown_parameters(&raw, &mut details);
    let target = resolve_target(&state.scope, &raw, &mut details);
    if !details.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(ApiError::invalid(details))));
    }
    let (network, contract_id) = target.unwrap();

    let existing: Option<WorkspacePlanRow> = sqlx::query_as(
        "SELECT network, contract_id, plan_tier, workspaces_limit, api_requests_used,
                api_requests_limit, reports_used, reports_limit, integrations_used,
                integrations_limit, billing_email, status, updated_at
         FROM workspace_plans
         WHERE network = $1 AND contract_id = $2",
    )
    .bind(&network)
    .bind(&contract_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(internal_error)?;

    let plan = match existing {
        Some(row) => row,
        None => {
            let defaults = PlanTier::Free.limits();
            WorkspacePlanRow {
                network,
                contract_id,
                plan_tier: PlanTier::Free.as_str().to_owned(),
                workspaces_limit: defaults.workspaces_limit,
                api_requests_used: 0,
                api_requests_limit: defaults.api_requests_limit,
                reports_used: 0,
                reports_limit: defaults.reports_limit,
                integrations_used: 0,
                integrations_limit: defaults.integrations_limit,
                billing_email: None,
                status: "active".to_owned(),
                updated_at: Utc::now(),
            }
        }
    };

    Ok(Json(BillingSummary {
        plan,
        catalog: catalog(),
    }))
}

pub(crate) async fn update_plan(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
    body: Bytes,
) -> ApiResult<Json<BillingSummary>> {
    admin::require(&state, &headers)?;

    let mut details = Vec::new();
    unknown_parameters(&raw, &mut details);
    let target = resolve_target(&state.scope, &raw, &mut details);
    if !details.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(ApiError::invalid(details))));
    }
    let (network, contract_id) = target.unwrap();

    let (tier, billing_email) = match validate_plan_input(&body) {
        Ok(v) => v,
        Err(errs) => return Err((StatusCode::BAD_REQUEST, Json(ApiError::invalid(errs)))),
    };
    let limits = tier.limits();

    let existing: Option<(i64, i32, i32)> = sqlx::query_as(
        "SELECT api_requests_used, reports_used, integrations_used
         FROM workspace_plans
         WHERE network = $1 AND contract_id = $2",
    )
    .bind(&network)
    .bind(&contract_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(internal_error)?;

    if let Some((api_used, reports_used, integrations_used)) = existing
        && let Err(errs) =
            check_downgrade_headroom(api_used, reports_used, integrations_used, limits)
    {
        return Err((StatusCode::BAD_REQUEST, Json(ApiError::invalid(errs))));
    }

    let plan: WorkspacePlanRow = sqlx::query_as(
        "INSERT INTO workspace_plans (
            network, contract_id, plan_tier, workspaces_limit, api_requests_limit,
            reports_limit, integrations_limit, billing_email, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
         ON CONFLICT (network, contract_id) DO UPDATE SET
            plan_tier = EXCLUDED.plan_tier,
            workspaces_limit = EXCLUDED.workspaces_limit,
            api_requests_limit = EXCLUDED.api_requests_limit,
            reports_limit = EXCLUDED.reports_limit,
            integrations_limit = EXCLUDED.integrations_limit,
            billing_email = COALESCE(EXCLUDED.billing_email, workspace_plans.billing_email),
            status = 'active',
            updated_at = NOW()
         RETURNING network, contract_id, plan_tier, workspaces_limit, api_requests_used,
                   api_requests_limit, reports_used, reports_limit, integrations_used,
                   integrations_limit, billing_email, status, updated_at",
    )
    .bind(&network)
    .bind(&contract_id)
    .bind(tier.as_str())
    .bind(limits.workspaces_limit)
    .bind(limits.api_requests_limit)
    .bind(limits.reports_limit)
    .bind(limits.integrations_limit)
    .bind(&billing_email)
    .fetch_one(&state.pool)
    .await
    .map_err(internal_error)?;

    Ok(Json(BillingSummary {
        plan,
        catalog: catalog(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_plan_tiers_and_billing_email() {
        let (tier, email) =
            validate_plan_input(br#"{"planTier":"pro","billingEmail":"ops@acme.org"}"#).unwrap();
        assert_eq!(tier, PlanTier::Pro);
        assert_eq!(email.as_deref(), Some("ops@acme.org"));
        assert_eq!(tier.limits().api_requests_limit, 250_000);
    }

    #[test]
    fn rejects_unknown_plan_tiers_and_bad_emails() {
        let errs =
            validate_plan_input(br#"{"planTier":"platinum","billingEmail":"bad-email"}"#)
                .unwrap_err();
        let codes: Vec<&str> = errs.iter().map(|e| e.code.as_str()).collect();
        assert!(codes.contains(&"INVALID_PLAN_TIER"));
        assert!(codes.contains(&"INVALID_EMAIL"));
    }

    #[test]
    fn blocks_downgrade_when_usage_exceeds_target_limits() {
        let errs = check_downgrade_headroom(15_000, 1, 3, PlanTier::Free.limits()).unwrap_err();
        assert_eq!(errs.len(), 2);
        assert!(errs.iter().all(|e| e.code == "PLAN_LIMIT_EXCEEDED"));
    }
}
