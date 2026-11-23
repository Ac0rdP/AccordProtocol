//! White-label branding and custom domains: `GET|PUT|DELETE /branding`.
//!
//! Lets a workspace (one `(network, contractId)` pair) customize its brand
//! name, logo URL, primary/accent colors, and custom domain while sharing the
//! underlying contract and API infrastructure.

use std::collections::HashMap;

use axum::{
    Json,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{QueryBuilder, postgres::Postgres};

use crate::{
    AppState, admin,
    proposals::{self, ApiError, ErrorDetail},
    scope::{ScopeConfig, push_scope},
};

/// Largest request body a branding write may carry.
pub(crate) const MAX_BODY_BYTES: usize = 16 * 1024;

/// Query parameters `GET /branding` accepts.
pub(crate) const LIST_PARAMS: &[&str] = &["limit", "offset", "contractId", "network"];

/// Query parameters `PUT` and `DELETE /branding` accept.
pub(crate) const WRITE_PARAMS: &[&str] = &["contractId", "network"];

const MAX_NAME: usize = 80;
const MAX_LOGO_URL: usize = 2048;
const MAX_DOMAIN_LEN: usize = 253;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrandingInput {
    brand_name: Option<String>,
    logo_url: Option<String>,
    primary_color: Option<String>,
    accent_color: Option<String>,
    custom_domain: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ValidatedBranding {
    brand_name: Option<String>,
    logo_url: Option<String>,
    primary_color: Option<String>,
    accent_color: Option<String>,
    custom_domain: Option<String>,
    domain_status: &'static str,
    verification_token: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrandingRecord {
    network: String,
    contract_id: String,
    brand_name: Option<String>,
    logo_url: Option<String>,
    primary_color: Option<String>,
    accent_color: Option<String>,
    custom_domain: Option<String>,
    domain_status: String,
    verification_token: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrandingPage {
    items: Vec<BrandingRecord>,
    total: i64,
    limit: i64,
    offset: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResetResponse {
    network: String,
    contract_id: String,
    removed: bool,
}

type ApiResult<T> = Result<T, (StatusCode, Json<ApiError>)>;

fn internal_error(error: sqlx::Error) -> (StatusCode, Json<ApiError>) {
    tracing::error!(%error, "branding database operation failed");
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

fn normalize_optional(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

fn validate_hex_color(
    field: &str,
    raw: Option<String>,
    details: &mut Vec<ErrorDetail>,
) -> Option<String> {
    let value = normalize_optional(raw)?;
    let lower = value.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let valid = bytes.len() == 7
        && bytes[0] == b'#'
        && bytes[1..].iter().all(|b| b.is_ascii_hexdigit());
    if !valid {
        details.push(proposals::detail(
            field,
            "must be a 6-digit hex color like #2563eb",
            "INVALID_COLOR",
        ));
        return None;
    }
    Some(lower)
}

fn validate_logo_url(raw: Option<String>, details: &mut Vec<ErrorDetail>) -> Option<String> {
    let value = normalize_optional(raw)?;
    if value.len() > MAX_LOGO_URL {
        details.push(proposals::detail(
            "logoUrl",
            "must be at most 2048 characters",
            "INVALID_LOGO_URL",
        ));
        return None;
    }
    if !value.starts_with("https://") || value.contains(char::is_whitespace) {
        details.push(proposals::detail(
            "logoUrl",
            "must be an https:// URL without whitespace",
            "INVALID_LOGO_URL",
        ));
        return None;
    }
    Some(value)
}

fn is_valid_hostname(host: &str) -> bool {
    if host.is_empty() || host.len() > MAX_DOMAIN_LEN || !host.contains('.') {
        return false;
    }
    if host.starts_with('.') || host.ends_with('.') {
        return false;
    }
    host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    })
}

fn validate_custom_domain(
    raw: Option<String>,
    details: &mut Vec<ErrorDetail>,
) -> Option<String> {
    let value = normalize_optional(raw)?.to_ascii_lowercase();
    if !is_valid_hostname(&value) {
        details.push(proposals::detail(
            "customDomain",
            "must be a valid hostname (for example, treasury.example.org)",
            "INVALID_DOMAIN",
        ));
        return None;
    }
    Some(value)
}

fn verification_token_for(network: &str, contract_id: &str, domain: &str) -> String {
    // Deterministic DNS TXT token per workspace/domain so verification records
    // stay stable across idempotent PUT updates.
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in network
        .bytes()
        .chain([b':'])
        .chain(contract_id.bytes())
        .chain([b':'])
        .chain(domain.bytes())
    {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("accord-verify={hash:016x}")
}

fn validate_input(
    network: &str,
    contract_id: &str,
    body: &[u8],
) -> Result<ValidatedBranding, Vec<ErrorDetail>> {
    if body.is_empty() {
        return Err(vec![proposals::detail(
            "body",
            "must be a JSON object",
            "INVALID_BODY",
        )]);
    }
    let input: BrandingInput = serde_json::from_slice(body).map_err(|err| {
        vec![proposals::detail(
            "body",
            &format!("invalid branding payload: {err}"),
            "INVALID_BODY",
        )]
    })?;

    let mut details = Vec::new();
    let brand_name = normalize_optional(input.brand_name);
    if let Some(ref name) = brand_name
        && name.chars().count() > MAX_NAME
    {
        details.push(proposals::detail(
            "brandName",
            "must be at most 80 characters",
            "INVALID_BODY",
        ));
    }

    let logo_url = validate_logo_url(input.logo_url, &mut details);
    let primary_color = validate_hex_color("primaryColor", input.primary_color, &mut details);
    let accent_color = validate_hex_color("accentColor", input.accent_color, &mut details);
    let custom_domain = validate_custom_domain(input.custom_domain, &mut details);

    if !details.is_empty() {
        return Err(details);
    }

    let (domain_status, verification_token) = match custom_domain.as_deref() {
        Some(domain) => (
            "pending",
            Some(verification_token_for(network, contract_id, domain)),
        ),
        None => ("pending", None),
    };

    Ok(ValidatedBranding {
        brand_name,
        logo_url,
        primary_color,
        accent_color,
        custom_domain,
        domain_status,
        verification_token,
    })
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

pub(crate) async fn list(
    State(state): State<AppState>,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Json<BrandingPage>> {
    let mut details = Vec::new();
    unknown_parameters(&raw, LIST_PARAMS, &mut details);
    let limit = proposals::parse_integer(&raw, "limit", 20, 1, 100, &mut details);
    let offset = proposals::parse_integer(&raw, "offset", 0, 0, i64::MAX, &mut details);
    let scope = state.scope.resolve(&raw, &mut details);
    if !details.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(ApiError::invalid(details))));
    }

    let mut count_qb =
        QueryBuilder::<Postgres>::new("SELECT COUNT(*) FROM workspace_branding WHERE TRUE");
    push_scope(&mut count_qb, "", &scope);
    let total: i64 = count_qb
        .build_query_scalar()
        .fetch_one(&state.pool)
        .await
        .map_err(internal_error)?;

    let mut qb = QueryBuilder::<Postgres>::new(
        "SELECT network, contract_id, brand_name, logo_url, primary_color, accent_color, \
         custom_domain, domain_status, verification_token, created_at, updated_at \
         FROM workspace_branding WHERE TRUE",
    );
    push_scope(&mut qb, "", &scope);
    qb.push(" ORDER BY network ASC, contract_id ASC LIMIT ")
        .push_bind(limit)
        .push(" OFFSET ")
        .push_bind(offset);

    let items: Vec<BrandingRecord> = qb
        .build_query_as()
        .fetch_all(&state.pool)
        .await
        .map_err(internal_error)?;

    Ok(Json(BrandingPage {
        items,
        total,
        limit,
        offset,
    }))
}

pub(crate) async fn put(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
    body: Bytes,
) -> ApiResult<Json<BrandingRecord>> {
    admin::require(&state, &headers)?;

    let mut details = Vec::new();
    unknown_parameters(&raw, WRITE_PARAMS, &mut details);
    let target = resolve_target(&state.scope, &raw, &mut details);
    if !details.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(ApiError::invalid(details))));
    }
    let (network, contract_id) = target.unwrap();

    let validated = match validate_input(&network, &contract_id, &body) {
        Ok(v) => v,
        Err(errs) => return Err((StatusCode::BAD_REQUEST, Json(ApiError::invalid(errs)))),
    };

    let row: BrandingRecord = sqlx::query_as(
        "INSERT INTO workspace_branding (
            network, contract_id, brand_name, logo_url, primary_color, accent_color,
            custom_domain, domain_status, verification_token
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (network, contract_id) DO UPDATE SET
            brand_name = EXCLUDED.brand_name,
            logo_url = EXCLUDED.logo_url,
            primary_color = EXCLUDED.primary_color,
            accent_color = EXCLUDED.accent_color,
            custom_domain = EXCLUDED.custom_domain,
            domain_status = CASE
                WHEN workspace_branding.custom_domain IS NOT DISTINCT FROM EXCLUDED.custom_domain
                THEN workspace_branding.domain_status
                ELSE EXCLUDED.domain_status
            END,
            verification_token = EXCLUDED.verification_token,
            updated_at = NOW()
         RETURNING network, contract_id, brand_name, logo_url, primary_color, accent_color,
                   custom_domain, domain_status, verification_token, created_at, updated_at",
    )
    .bind(&network)
    .bind(&contract_id)
    .bind(&validated.brand_name)
    .bind(&validated.logo_url)
    .bind(&validated.primary_color)
    .bind(&validated.accent_color)
    .bind(&validated.custom_domain)
    .bind(validated.domain_status)
    .bind(&validated.verification_token)
    .fetch_one(&state.pool)
    .await
    .map_err(internal_error)?;

    Ok(Json(row))
}

pub(crate) async fn delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Json<ResetResponse>> {
    admin::require(&state, &headers)?;

    let mut details = Vec::new();
    unknown_parameters(&raw, WRITE_PARAMS, &mut details);
    let target = resolve_target(&state.scope, &raw, &mut details);
    if !details.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(ApiError::invalid(details))));
    }
    let (network, contract_id) = target.unwrap();

    let result = sqlx::query(
        "DELETE FROM workspace_branding WHERE network = $1 AND contract_id = $2",
    )
    .bind(&network)
    .bind(&contract_id)
    .execute(&state.pool)
    .await
    .map_err(internal_error)?;

    Ok(Json(ResetResponse {
        network,
        contract_id,
        removed: result.rows_affected() > 0,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_valid_branding_and_generates_verification_token() {
        let payload = br##"{
            "brandName": " Acme DAO ",
            "logoUrl": "https://cdn.acme.org/logo.svg",
            "primaryColor": "#1D4ED8",
            "accentColor": "#0ea5e9",
            "customDomain": "Treasury.Acme.org"
        }"##;
        let parsed = validate_input("testnet", "C123", payload).unwrap();
        assert_eq!(parsed.brand_name.as_deref(), Some("Acme DAO"));
        assert_eq!(
            parsed.logo_url.as_deref(),
            Some("https://cdn.acme.org/logo.svg")
        );
        assert_eq!(parsed.primary_color.as_deref(), Some("#1d4ed8"));
        assert_eq!(parsed.accent_color.as_deref(), Some("#0ea5e9"));
        assert_eq!(parsed.custom_domain.as_deref(), Some("treasury.acme.org"));
        assert_eq!(parsed.domain_status, "pending");
        assert!(
            parsed
                .verification_token
                .as_deref()
                .is_some_and(|t| t.starts_with("accord-verify="))
        );
    }

    #[test]
    fn rejects_invalid_colors_urls_and_domains() {
        let payload = br##"{
            "brandName": "Acme",
            "logoUrl": "http://insecure.example.com/logo.png",
            "primaryColor": "red",
            "accentColor": "#12",
            "customDomain": "not a domain"
        }"##;
        let errors = validate_input("testnet", "C123", payload).unwrap_err();
        let codes: Vec<&str> = errors.iter().map(|e| e.code).collect();
        assert!(codes.contains(&"INVALID_LOGO_URL"));
        assert!(codes.contains(&"INVALID_COLOR"));
        assert!(codes.contains(&"INVALID_DOMAIN"));
    }

    #[test]
    fn rejects_empty_body_and_unknown_fields() {
        assert_eq!(
            validate_input("testnet", "C1", b"").unwrap_err()[0].code,
            "INVALID_BODY"
        );
        assert_eq!(
            validate_input("testnet", "C1", br#"{"unknown":true}"#).unwrap_err()[0].code,
            "INVALID_BODY"
        );
    }
}
