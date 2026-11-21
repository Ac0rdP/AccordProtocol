//! Reviewed plugin and integration marketplace:
//! `GET /integrations`, `PUT /integrations/{id}`, `DELETE /integrations/{id}`.
//!
//! Teams can browse reviewed integrations for notifications, accounting, and
//! treasury automation, inspect explicit permissions and data boundaries, and
//! install or remove them for a workspace without operator intervention.

use std::collections::HashMap;

use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::types::Json as SqlJson;

use crate::{
    AppState, admin,
    proposals::{self, ApiError, ErrorDetail},
    scope::ScopeConfig,
};

/// Largest request body an integration install/update may carry.
pub(crate) const MAX_BODY_BYTES: usize = 8 * 1024;

/// Query parameters `GET /integrations` accepts.
pub(crate) const LIST_PARAMS: &[&str] = &["category", "contractId", "network", "limit", "offset"];
/// Query parameters `PUT` and `DELETE /integrations/{id}` accept.
pub(crate) const WRITE_PARAMS: &[&str] = &["contractId", "network"];

/// Valid integration categories.
pub(crate) const CATEGORIES: &[&str] = &["notifications", "accounting", "treasury_automation"];

const MAX_STRING_CONFIG_LEN: usize = 512;

/// A reviewed integration available in the marketplace catalog.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntegrationPlugin {
    pub id: &'static str,
    pub name: &'static str,
    pub category: &'static str,
    pub summary: &'static str,
    pub description: &'static str,
    pub version: &'static str,
    pub publisher: &'static str,
    pub reviewed: bool,
    pub permissions: &'static [&'static str],
    pub data_boundary: &'static str,
    pub config_fields: &'static [ConfigFieldSpec],
}

/// Declarative configuration field for an integration.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigFieldSpec {
    pub key: &'static str,
    pub label: &'static str,
    pub required: bool,
    pub placeholder: &'static str,
}

/// Curated, security-reviewed integration catalog.
pub(crate) const CATALOG: &[IntegrationPlugin] = &[
    IntegrationPlugin {
        id: "slack-notifications",
        name: "Slack Notifications",
        category: "notifications",
        summary: "Post proposal creation, quorum, and execution alerts to a Slack channel.",
        description: "Delivers structured webhook notifications when proposals are created, reach quorum, execute, or expire.",
        version: "1.0.0",
        publisher: "Accord Labs",
        reviewed: true,
        permissions: &["read:proposals", "read:events"],
        data_boundary: "Sends proposal ID, category, token, amount, and status only; no private keys or signer PII.",
        config_fields: &[ConfigFieldSpec {
            key: "channelLabel",
            label: "Slack channel label",
            required: true,
            placeholder: "#treasury-alerts",
        }],
    },
    IntegrationPlugin {
        id: "discord-notifications",
        name: "Discord Notifications",
        category: "notifications",
        summary: "Stream multisig governance and recurring payroll alerts to Discord.",
        description: "Posts concise status embeds to a designated Discord governance channel for fast owner review.",
        version: "1.0.0",
        publisher: "Accord Labs",
        reviewed: true,
        permissions: &["read:proposals", "read:events"],
        data_boundary: "Sends proposal ID, title, amount, and approval progress only; never accesses wallet secrets.",
        config_fields: &[ConfigFieldSpec {
            key: "channelLabel",
            label: "Discord channel name",
            required: true,
            placeholder: "#multisig-ops",
        }],
    },
    IntegrationPlugin {
        id: "quickbooks-accounting",
        name: "QuickBooks Accounting Sync",
        category: "accounting",
        summary: "Map executed treasury outflows to QuickBooks chart-of-accounts categories.",
        description: "Generates reconciled CSV/JSON journal batches from executed proposals and recurring disbursements.",
        version: "1.1.0",
        publisher: "Accord Labs",
        reviewed: true,
        permissions: &["read:proposals", "read:analytics", "export:reports"],
        data_boundary: "Exports executed transaction hashes, timestamps, amounts, and categories; read-only, cannot initiate transfers.",
        config_fields: &[ConfigFieldSpec {
            key: "ledgerAccount",
            label: "Default expense account",
            required: true,
            placeholder: "Operating Expenses:Crypto Treasury",
        }],
    },
    IntegrationPlugin {
        id: "xero-accounting",
        name: "Xero Ledger Export",
        category: "accounting",
        summary: "Reconcile Stellar USDC and XLM treasury movements in Xero.",
        description: "Formats categorized outflows and recurring payroll disbursements into Xero-compatible statement batches.",
        version: "1.0.0",
        publisher: "Accord Labs",
        reviewed: true,
        permissions: &["read:proposals", "read:analytics", "export:reports"],
        data_boundary: "Read-only export of executed transfers and categories; zero write or signing capability.",
        config_fields: &[ConfigFieldSpec {
            key: "ledgerAccount",
            label: "Xero account code",
            required: true,
            placeholder: "400 - Treasury Disbursements",
        }],
    },
    IntegrationPlugin {
        id: "recurring-keeper",
        name: "Recurring Payment Keeper",
        category: "treasury_automation",
        summary: "Automatically trigger due recurring payroll and grant disbursements.",
        description: "Monitors active recurring schedules and submits permissionless disburse_recurring calls when intervals elapse.",
        version: "1.0.0",
        publisher: "Accord Labs",
        reviewed: true,
        permissions: &["read:recurring", "trigger:disburse_recurring"],
        data_boundary: "Calls permissionless disburse_recurring on already-approved schedules; cannot create or modify schedules.",
        config_fields: &[ConfigFieldSpec {
            key: "cadenceMinutes",
            label: "Check cadence (minutes)",
            required: true,
            placeholder: "15",
        }],
    },
    IntegrationPlugin {
        id: "idle-balance-sweep",
        name: "Idle Balance Sweep Advisor",
        category: "treasury_automation",
        summary: "Draft rebalance proposals when hot-wallet balances exceed policy thresholds.",
        description: "Watches contract token balances and drafts a Transfer proposal to cold storage when thresholds are exceeded. Always requires full multisig quorum.",
        version: "1.0.0",
        publisher: "Accord Labs",
        reviewed: true,
        permissions: &["read:balances", "draft:proposal"],
        data_boundary: "Propose-only boundary: can draft a proposal for owner review, never approves or executes transfers.",
        config_fields: &[ConfigFieldSpec {
            key: "targetThreshold",
            label: "Sweep threshold (USDC)",
            required: true,
            placeholder: "50000",
        }],
    },
];

pub(crate) fn find_plugin(id: &str) -> Option<&'static IntegrationPlugin> {
    CATALOG.iter().find(|p| p.id == id)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstalledIntegration {
    pub plugin_id: String,
    pub network: String,
    pub contract_id: String,
    pub enabled: bool,
    pub config: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_by: Option<String>,
    pub installed_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct InstallRow {
    plugin_id: String,
    network: String,
    contract_id: String,
    enabled: bool,
    config: SqlJson<serde_json::Value>,
    installed_by: Option<String>,
    installed_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl From<InstallRow> for InstalledIntegration {
    fn from(r: InstallRow) -> Self {
        Self {
            plugin_id: r.plugin_id,
            network: r.network,
            contract_id: r.contract_id,
            enabled: r.enabled,
            config: r.config.0,
            installed_by: r.installed_by,
            installed_at: r.installed_at,
            updated_at: r.updated_at,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntegrationListResponse {
    pub catalog: Vec<&'static IntegrationPlugin>,
    pub installs: Vec<InstalledIntegration>,
    pub total_catalog: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallInput {
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub config: serde_json::Value,
    #[serde(default)]
    pub installed_by: Option<String>,
}

fn default_enabled() -> bool {
    true
}

type ApiResult<T> = Result<T, (StatusCode, Json<ApiError>)>;

fn rejected(details: Vec<ErrorDetail>) -> (StatusCode, Json<ApiError>) {
    (StatusCode::BAD_REQUEST, Json(ApiError::invalid(details)))
}

fn detail(field: &str, message: impl Into<String>, code: &'static str) -> ErrorDetail {
    proposals::error_detail(field, message, code)
}

fn reject_unknown(
    raw: &HashMap<String, String>,
    allowed: &[&str],
    details: &mut Vec<ErrorDetail>,
) {
    let mut unknown: Vec<&String> = raw
        .keys()
        .filter(|k| !allowed.contains(&k.as_str()))
        .collect();
    unknown.sort();
    for key in unknown {
        details.push(detail(
            key,
            format!("Unknown query parameter '{key}'"),
            "UNKNOWN_PARAMETER",
        ));
    }
}

fn validate_config(
    plugin: &IntegrationPlugin,
    config: &serde_json::Value,
    details: &mut Vec<ErrorDetail>,
) {
    let Some(obj) = config.as_object() else {
        details.push(detail(
            "config",
            "config must be a JSON object",
            "INVALID_CONFIG",
        ));
        return;
    };

    for field in plugin.config_fields {
        let val = obj
            .get(field.key)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or("");
        if field.required && val.is_empty() {
            details.push(detail(
                field.key,
                format!("Missing required config field '{}'", field.key),
                "REQUIRED_FIELD",
            ));
        } else if val.len() > MAX_STRING_CONFIG_LEN {
            details.push(detail(
                field.key,
                format!(
                    "Config field '{}' exceeds {MAX_STRING_CONFIG_LEN} characters",
                    field.key
                ),
                "FIELD_TOO_LONG",
            ));
        }
    }
}

fn resolve_target(
    raw: &HashMap<String, String>,
    scope: &ScopeConfig,
    details: &mut Vec<ErrorDetail>,
) -> Option<(String, String)> {
    let network = raw
        .get("network")
        .map(String::as_str)
        .filter(|s| !s.is_empty())
        .or(scope.default_network.as_deref())
        .unwrap_or("testnet")
        .to_owned();
    let contract_id = raw
        .get("contractId")
        .map(String::as_str)
        .filter(|s| !s.is_empty())
        .or(scope.default_contract.as_deref());
    match contract_id {
        Some(c) => Some((network, c.to_owned())),
        None => {
            details.push(detail(
                "contractId",
                "contractId is required",
                "REQUIRED_PARAMETER",
            ));
            None
        }
    }
}

/// `GET /integrations` — lists the reviewed marketplace catalog and any
/// workspace installations.
pub(crate) async fn list(
    State(state): State<AppState>,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Json<IntegrationListResponse>> {
    let mut details = Vec::new();
    reject_unknown(&raw, LIST_PARAMS, &mut details);

    let category = raw.get("category").map(String::as_str).filter(|s| !s.is_empty());
    if let Some(cat) = category {
        if cat != "all" && !CATEGORIES.contains(&cat) {
            details.push(detail(
                "category",
                format!("Unknown category '{cat}'"),
                "INVALID_CATEGORY",
            ));
        }
    }

    let limit = match raw.get("limit") {
        None => 20usize,
        Some(v) => match v.parse::<usize>() {
            Ok(n) if (1..=100).contains(&n) => n,
            _ => {
                details.push(detail(
                    "limit",
                    "limit must be an integer between 1 and 100",
                    "INVALID_PAGINATION",
                ));
                20
            }
        },
    };
    let offset = match raw.get("offset") {
        None => 0usize,
        Some(v) => match v.parse::<usize>() {
            Ok(n) => n,
            Err(_) => {
                details.push(detail(
                    "offset",
                    "offset must be a non-negative integer",
                    "INVALID_PAGINATION",
                ));
                0
            }
        },
    };

    if !details.is_empty() {
        return Err(rejected(details));
    }

    let filtered: Vec<&'static IntegrationPlugin> = CATALOG
        .iter()
        .filter(|p| match category {
            Some(c) if c != "all" => p.category == c,
            _ => true,
        })
        .collect();
    let total_catalog = filtered.len();
    let catalog: Vec<&'static IntegrationPlugin> =
        filtered.into_iter().skip(offset).take(limit).collect();

    let installs = if let Some(contract_id) = raw
        .get("contractId")
        .map(String::as_str)
        .filter(|s| !s.is_empty())
        .or(state.scope.default_contract.as_deref())
    {
        let network = raw
            .get("network")
            .map(String::as_str)
            .filter(|s| !s.is_empty())
            .or(state.scope.default_network.as_deref())
            .unwrap_or("testnet");
        let rows: Vec<InstallRow> = sqlx::query_as(
            "SELECT plugin_id, network, contract_id, enabled, config, installed_by, installed_at, updated_at \
             FROM integration_installs WHERE network = $1 AND contract_id = $2 ORDER BY plugin_id ASC",
        )
        .bind(network)
        .bind(contract_id)
        .fetch_all(&state.pool)
        .await
        .map_err(proposals::internal_error)?;
        rows.into_iter().map(Into::into).collect()
    } else {
        Vec::new()
    };

    Ok(Json(IntegrationListResponse {
        catalog,
        installs,
        total_catalog,
    }))
}

/// `PUT /integrations/{id}` — installs or updates a reviewed integration for
/// a workspace.
pub(crate) async fn put(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(plugin_id): Path<String>,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
    body: Bytes,
) -> ApiResult<Json<InstalledIntegration>> {
    admin::require(&state, &headers)?;

    let Some(plugin) = find_plugin(&plugin_id) else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ApiError::new(
                "NOT_FOUND",
                "Unknown or unreviewed integration plugin",
            )),
        ));
    };

    let mut details = Vec::new();
    reject_unknown(&raw, WRITE_PARAMS, &mut details);
    let target = resolve_target(&raw, &state.scope, &mut details);

    let input: InstallInput = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(err) => {
            details.push(detail("body", format!("Invalid JSON: {err}"), "INVALID_JSON"));
            return Err(rejected(details));
        }
    };
    validate_config(plugin, &input.config, &mut details);

    let (Some((network, contract_id)), true) = (target, details.is_empty()) else {
        return Err(rejected(details));
    };

    let row: InstallRow = sqlx::query_as(
        "INSERT INTO integration_installs (network, contract_id, plugin_id, enabled, config, installed_by) \
         VALUES ($1, $2, $3, $4, $5, $6) \
         ON CONFLICT (network, contract_id, plugin_id) DO UPDATE SET \
           enabled = EXCLUDED.enabled, \
           config = EXCLUDED.config, \
           installed_by = COALESCE(EXCLUDED.installed_by, integration_installs.installed_by), \
           updated_at = NOW() \
         RETURNING plugin_id, network, contract_id, enabled, config, installed_by, installed_at, updated_at",
    )
    .bind(&network)
    .bind(&contract_id)
    .bind(plugin.id)
    .bind(input.enabled)
    .bind(SqlJson(input.config))
    .bind(&input.installed_by)
    .fetch_one(&state.pool)
    .await
    .map_err(proposals::internal_error)?;

    Ok(Json(row.into()))
}

/// `DELETE /integrations/{id}` — uninstalls an integration from a workspace.
pub(crate) async fn delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(plugin_id): Path<String>,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<StatusCode> {
    admin::require(&state, &headers)?;

    let mut details = Vec::new();
    reject_unknown(&raw, WRITE_PARAMS, &mut details);
    let target = resolve_target(&raw, &state.scope, &mut details);
    let (Some((network, contract_id)), true) = (target, details.is_empty()) else {
        return Err(rejected(details));
    };

    let removed: Option<i64> = sqlx::query_scalar(
        "DELETE FROM integration_installs WHERE network = $1 AND contract_id = $2 AND plugin_id = $3 RETURNING id",
    )
    .bind(&network)
    .bind(&contract_id)
    .bind(&plugin_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(proposals::internal_error)?;

    match removed {
        Some(_) => Ok(StatusCode::NO_CONTENT),
        None => Err((
            StatusCode::NOT_FOUND,
            Json(ApiError::new(
                "NOT_FOUND",
                "Integration is not installed for this workspace",
            )),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_covers_all_required_categories_with_explicit_boundaries() {
        for cat in CATEGORIES {
            assert!(
                CATALOG.iter().any(|p| p.category == *cat),
                "missing catalog plugin for category {cat}"
            );
        }
        for plugin in CATALOG {
            assert!(plugin.reviewed);
            assert!(!plugin.permissions.is_empty());
            assert!(!plugin.data_boundary.is_empty());
        }
    }

    #[test]
    fn validate_config_rejects_missing_required_fields() {
        let plugin = find_plugin("slack-notifications").unwrap();
        let mut details = Vec::new();
        validate_config(plugin, &serde_json::json!({}), &mut details);
        assert_eq!(details.len(), 1);
    }

    #[test]
    fn validate_config_accepts_valid_fields() {
        let plugin = find_plugin("slack-notifications").unwrap();
        let mut details = Vec::new();
        validate_config(
            plugin,
            &serde_json::json!({ "channelLabel": "#treasury" }),
            &mut details,
        );
        assert!(details.is_empty());
    }
}
