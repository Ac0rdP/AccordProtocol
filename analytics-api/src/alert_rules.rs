//! Alert rule management: `/alert-rules`.
//!
//! Rules from `ALERT_RULES` stay read-only configuration. On top of them an
//! operator can create, edit, pause and delete *managed* rules, stored in
//! `alert_rules`, and dry-run a rule against recent history before relying on
//! it. The engine evaluates the configured rules plus the active managed ones;
//! the watcher reloads them every tick, so a change made on one instance
//! reaches the others.
//!
//! "Threshold" rules are `spend_threshold`; "anomaly" rules are
//! `approval_burst` and `off_hours_approval`.

use std::collections::HashMap;

use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use sqlx::{PgPool, types::Json as SqlJson};

use crate::{
    AppState, admin,
    alerts::{
        Alert, AlertEngine, AlertEvent, Rule, RuleKind, StormSettings, parse_rule,
    },
    proposals::{self, ApiError, ErrorDetail},
};

/// Largest request body a rule write may carry.
pub(crate) const MAX_BODY_BYTES: usize = 8 * 1024;
/// How many managed rules may exist; keeps the per-tick reload cheap.
const MAX_MANAGED_RULES: i64 = 200;
/// Longest rolling window or cooldown a managed rule may use (30 days).
const MAX_SECONDS: u64 = 30 * 24 * 3600;
/// Events read per source and (network, contract) when testing a rule.
const TEST_EVENT_CAP: i64 = 20_000;
const MAX_ID_LEN: usize = 64;

pub(crate) const STATUSES: &[&str] = &["active", "paused"];
pub(crate) const KINDS: &[&str] = &["spend_threshold", "approval_burst", "off_hours_approval"];
pub(crate) const CATEGORIES: &[&str] = &["threshold", "anomaly"];
pub(crate) const SOURCES: &[&str] = &["config", "managed"];
pub(crate) const SEVERITIES: &[&str] = &["info", "warning", "critical"];

/// Query parameters `GET /alert-rules` accepts.
pub(crate) const LIST_PARAMS: &[&str] = &[
    "limit", "offset", "status", "type", "category", "source", "severity",
];
/// Query parameters the rule test endpoints accept.
pub(crate) const TEST_PARAMS: &[&str] = &["lookbackHours", "limit", "contractId", "network"];

type ApiResult<T> = Result<T, (StatusCode, Json<ApiError>)>;

fn rejected(details: Vec<ErrorDetail>) -> (StatusCode, Json<ApiError>) {
    (StatusCode::BAD_REQUEST, Json(ApiError::invalid(details)))
}

fn conflict(message: &'static str) -> (StatusCode, Json<ApiError>) {
    (StatusCode::CONFLICT, Json(ApiError::new("CONFLICT", message)))
}

fn not_found() -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::NOT_FOUND,
        Json(ApiError::new("NOT_FOUND", "Alert rule not found")),
    )
}

fn read_only() -> (StatusCode, Json<ApiError>) {
    conflict("Rules from the deployment configuration cannot be changed through the API")
}

fn internal_error(error: sqlx::Error) -> (StatusCode, Json<ApiError>) {
    tracing::error!(%error, "failed to access alert rules");
    proposals::internal_error(error)
}

fn reject_unknown(raw: &HashMap<String, String>, allowed: &[&str], details: &mut Vec<ErrorDetail>) {
    for key in raw.keys() {
        if !allowed.contains(&key.as_str()) {
            details.push(proposals::detail(
                key,
                "is not a supported query parameter",
                "UNKNOWN_PARAMETER",
            ));
        }
    }
}

fn category_of(rule: &Rule) -> &'static str {
    match rule.kind {
        RuleKind::SpendThreshold { .. } => "threshold",
        RuleKind::ApprovalBurst { .. } | RuleKind::OffHoursApproval { .. } => "anomaly",
    }
}

/// A rule as the API shows it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedRule {
    #[serde(flatten)]
    rule: Rule,
    category: &'static str,
    /// `config` rules come from `ALERT_RULES` and are read-only.
    source: &'static str,
    enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<DateTime<Utc>>,
}

impl ManagedRule {
    fn config(rule: Rule) -> Self {
        Self {
            category: category_of(&rule),
            rule,
            source: "config",
            enabled: true,
            created_at: None,
            updated_at: None,
        }
    }
}

#[derive(sqlx::FromRow)]
struct RuleRow {
    definition: SqlJson<serde_json::Value>,
    enabled: bool,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl RuleRow {
    fn into_rule(self) -> Option<ManagedRule> {
        let rule: Rule = match serde_json::from_value(self.definition.0) {
            Ok(rule) => rule,
            Err(error) => {
                tracing::warn!(%error, "skipping a stored alert rule that no longer parses");
                return None;
            }
        };
        Some(ManagedRule {
            category: category_of(&rule),
            rule,
            source: "managed",
            enabled: self.enabled,
            created_at: Some(self.created_at),
            updated_at: Some(self.updated_at),
        })
    }
}

const COLUMNS: &str = "definition, enabled, created_at, updated_at";

/// The enabled managed rules, for the engine.
pub(crate) async fn load_active(pool: &PgPool) -> sqlx::Result<Vec<Rule>> {
    let rows: Vec<SqlJson<serde_json::Value>> =
        sqlx::query_scalar("SELECT definition FROM alert_rules WHERE enabled ORDER BY id")
            .fetch_all(pool)
            .await?;
    Ok(rows
        .into_iter()
        .filter_map(|definition| match serde_json::from_value::<Rule>(definition.0) {
            Ok(rule) => Some(rule),
            Err(error) => {
                tracing::warn!(%error, "skipping a stored alert rule that no longer parses");
                None
            }
        })
        .collect())
}

/// Applies the stored rules to the running engine right away. A failure only
/// delays the change until the watcher's next tick.
async fn reload(state: &AppState) {
    let Some(engine) = &state.alert_engine else {
        return;
    };
    match load_active(&state.pool).await {
        Ok(managed) => {
            engine.replace_managed(managed);
        }
        Err(error) => tracing::warn!(%error, "alert rules will reload on the next watcher tick"),
    }
}

fn config_rule(state: &AppState, id: &str) -> Option<Rule> {
    state
        .alert_engine
        .as_ref()?
        .base_rules()
        .iter()
        .find(|rule| rule.id == id)
        .cloned()
}

// --- validation -----------------------------------------------------------

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id != "test"
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

fn bad_id() -> ErrorDetail {
    proposals::detail(
        "id",
        "must be 1-64 letters, digits, '.', '_' or '-', and not \"test\"",
        "INVALID_RULE_ID",
    )
}

fn check_id(id: &str) -> ApiResult<()> {
    if valid_id(id) {
        Ok(())
    } else {
        Err(rejected(vec![bad_id()]))
    }
}

/// Names the rule field an error message is about, so the dashboard can mark it.
fn rule_error(message: &str) -> ErrorDetail {
    if message.contains("unknown field") {
        return proposals::detail("body", message, "INVALID_BODY");
    }
    let field = [
        "type",
        "maxApprovals",
        "startHour",
        "endHour",
        "windowSecs",
        "threshold",
        "cooldownSecs",
        "severity",
    ]
    .into_iter()
    .find(|field| message.contains(field))
    .unwrap_or("body");
    proposals::detail(field, message, "INVALID_RULE")
}

#[derive(Debug)]
struct RuleInput {
    rule: Rule,
    /// `None` keeps the stored value on an update and means `true` on create.
    enabled: Option<bool>,
}

/// Parses a rule body. `path_id` is the id from the URL on updates; the body's
/// own `id` must then agree with it or be left out.
fn parse_input(body: &Bytes, path_id: Option<&str>) -> Result<RuleInput, Vec<ErrorDetail>> {
    let invalid_body = |message: String| vec![proposals::detail("body", &message, "INVALID_BODY")];
    let mut value: serde_json::Value = serde_json::from_slice(body)
        .map_err(|error| invalid_body(format!("must be a JSON object describing a rule: {error}")))?;
    let Some(object) = value.as_object_mut() else {
        return Err(invalid_body("must be a JSON object describing a rule".to_owned()));
    };

    let enabled = match object.remove("enabled") {
        None => None,
        Some(serde_json::Value::Bool(enabled)) => Some(enabled),
        Some(_) => {
            return Err(vec![proposals::detail(
                "enabled",
                "must be true or false",
                "INVALID_BODY",
            )]);
        }
    };

    match (object.get("id").and_then(serde_json::Value::as_str), path_id) {
        (Some(body_id), Some(path_id)) if body_id != path_id => {
            return Err(vec![proposals::detail(
                "id",
                "must match the id in the path",
                "INVALID_RULE_ID",
            )]);
        }
        (None, Some(path_id)) => {
            object.insert("id".to_owned(), serde_json::json!(path_id));
        }
        (None, None) => {
            return Err(vec![proposals::detail("id", "is required", "INVALID_RULE_ID")]);
        }
        _ => {}
    }
    let id = object
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if !valid_id(id) {
        return Err(vec![bad_id()]);
    }

    let rule = parse_rule(value).map_err(|error| vec![rule_error(&format!("{error:#}"))])?;

    let too_long = |seconds: u64| seconds > MAX_SECONDS;
    let window = match &rule.kind {
        RuleKind::SpendThreshold { window_secs, .. }
        | RuleKind::ApprovalBurst { window_secs, .. } => Some(*window_secs),
        RuleKind::OffHoursApproval { .. } => None,
    };
    if window.is_some_and(too_long) {
        return Err(vec![proposals::detail(
            "windowSecs",
            "must be at most 2592000 (30 days)",
            "INVALID_RULE",
        )]);
    }
    if rule.cooldown_secs.is_some_and(too_long) {
        return Err(vec![proposals::detail(
            "cooldownSecs",
            "must be at most 2592000 (30 days)",
            "INVALID_RULE",
        )]);
    }
    Ok(RuleInput { rule, enabled })
}

// --- list and read ----------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RulePage {
    items: Vec<ManagedRule>,
    total: i64,
    limit: i64,
    offset: i64,
}

async fn managed_rules(pool: &PgPool) -> sqlx::Result<Vec<ManagedRule>> {
    let rows: Vec<RuleRow> = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM alert_rules ORDER BY id LIMIT {MAX_MANAGED_RULES}"
    ))
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().filter_map(RuleRow::into_rule).collect())
}

fn one_of(
    raw: &HashMap<String, String>,
    field: &'static str,
    allowed: &[&str],
    code: &'static str,
    details: &mut Vec<ErrorDetail>,
) -> Option<String> {
    let value = proposals::nonempty(raw, field)?;
    if allowed.contains(&value.as_str()) {
        Some(value)
    } else {
        details.push(proposals::detail(
            field,
            &format!("must be one of: {}", allowed.join(", ")),
            code,
        ));
        None
    }
}

/// `GET /alert-rules` — configured and managed rules together, by id. Not
/// cached, so an edit shows on the next read.
pub(crate) async fn list(
    State(state): State<AppState>,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Json<RulePage>> {
    let mut details = Vec::new();
    reject_unknown(&raw, LIST_PARAMS, &mut details);
    let limit = proposals::parse_integer(&raw, "limit", 20, 1, 100, &mut details);
    let offset = proposals::parse_integer(&raw, "offset", 0, 0, i64::MAX, &mut details);
    let status = one_of(&raw, "status", STATUSES, "INVALID_STATUS", &mut details);
    let kind = one_of(&raw, "type", KINDS, "INVALID_RULE_TYPE", &mut details);
    let category = one_of(&raw, "category", CATEGORIES, "INVALID_CATEGORY", &mut details);
    let source = one_of(&raw, "source", SOURCES, "INVALID_SOURCE", &mut details);
    let severity = one_of(&raw, "severity", SEVERITIES, "INVALID_SEVERITY", &mut details);
    if !details.is_empty() {
        return Err(rejected(details));
    }

    let mut rules: Vec<ManagedRule> = state
        .alert_engine
        .as_ref()
        .map(|engine| engine.base_rules().to_vec())
        .unwrap_or_default()
        .into_iter()
        .map(ManagedRule::config)
        .collect();
    rules.extend(managed_rules(&state.pool).await.map_err(internal_error)?);
    rules.retain(|rule| {
        status
            .as_deref()
            .is_none_or(|status| (status == "active") == rule.enabled)
            && kind.as_deref().is_none_or(|kind| kind == rule.rule.kind_name())
            && category.as_deref().is_none_or(|category| category == rule.category)
            && source.as_deref().is_none_or(|source| source == rule.source)
            && severity
                .as_deref()
                .is_none_or(|severity| severity == rule.rule.severity.as_str())
    });
    rules.sort_by(|a, b| a.rule.id.cmp(&b.rule.id));

    let total = rules.len() as i64;
    let items = rules
        .into_iter()
        .skip(usize::try_from(offset).unwrap_or(usize::MAX))
        .take(usize::try_from(limit).unwrap_or(0))
        .collect();
    Ok(Json(RulePage {
        items,
        total,
        limit,
        offset,
    }))
}

async fn fetch_managed(pool: &PgPool, id: &str) -> ApiResult<Option<ManagedRule>> {
    let row: Option<RuleRow> = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM alert_rules WHERE id = $1"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(internal_error)?;
    Ok(row.and_then(RuleRow::into_rule))
}

async fn find(state: &AppState, id: &str) -> ApiResult<ManagedRule> {
    if let Some(rule) = config_rule(state, id) {
        return Ok(ManagedRule::config(rule));
    }
    fetch_managed(&state.pool, id).await?.ok_or_else(not_found)
}

/// `GET /alert-rules/{id}`.
pub(crate) async fn get_one(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Json<ManagedRule>> {
    check_id(&id)?;
    no_parameters(&raw)?;
    Ok(Json(find(&state, &id).await?))
}

fn no_parameters(raw: &HashMap<String, String>) -> ApiResult<()> {
    let mut details = Vec::new();
    reject_unknown(raw, &[], &mut details);
    if details.is_empty() {
        Ok(())
    } else {
        Err(rejected(details))
    }
}

// --- writes -----------------------------------------------------------------

/// `POST /alert-rules` — creates a managed rule (active unless `enabled: false`).
pub(crate) async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
    body: Bytes,
) -> ApiResult<(StatusCode, Json<ManagedRule>)> {
    admin::require(&state, &headers)?;
    no_parameters(&raw)?;
    let input = parse_input(&body, None).map_err(rejected)?;
    let id = input.rule.id.clone();

    if config_rule(&state, &id).is_some() {
        return Err(conflict("A rule from the deployment configuration already uses this id"));
    }
    let existing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM alert_rules")
        .fetch_one(&state.pool)
        .await
        .map_err(internal_error)?;
    if existing >= MAX_MANAGED_RULES {
        return Err(conflict("The limit of 200 managed alert rules has been reached"));
    }

    let row: Option<RuleRow> = sqlx::query_as(&format!(
        "INSERT INTO alert_rules (id, kind, severity, definition, enabled) \
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING RETURNING {COLUMNS}"
    ))
    .bind(&id)
    .bind(input.rule.kind_name())
    .bind(input.rule.severity.as_str())
    .bind(SqlJson(&input.rule))
    .bind(input.enabled.unwrap_or(true))
    .fetch_optional(&state.pool)
    .await
    .map_err(internal_error)?;
    let rule = row
        .and_then(RuleRow::into_rule)
        .ok_or_else(|| conflict("An alert rule with this id already exists"))?;

    reload(&state).await;
    Ok((StatusCode::CREATED, Json(rule)))
}

/// `PUT /alert-rules/{id}` — replaces a managed rule. `enabled` is kept when omitted.
pub(crate) async fn replace(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
    body: Bytes,
) -> ApiResult<Json<ManagedRule>> {
    admin::require(&state, &headers)?;
    check_id(&id)?;
    no_parameters(&raw)?;
    let input = parse_input(&body, Some(&id)).map_err(rejected)?;
    if config_rule(&state, &id).is_some() {
        return Err(read_only());
    }

    let row: Option<RuleRow> = sqlx::query_as(&format!(
        "UPDATE alert_rules SET kind = $2, severity = $3, definition = $4, \
         enabled = COALESCE($5, enabled), updated_at = NOW() WHERE id = $1 RETURNING {COLUMNS}"
    ))
    .bind(&id)
    .bind(input.rule.kind_name())
    .bind(input.rule.severity.as_str())
    .bind(SqlJson(&input.rule))
    .bind(input.enabled)
    .fetch_optional(&state.pool)
    .await
    .map_err(internal_error)?;
    let rule = row.and_then(RuleRow::into_rule).ok_or_else(not_found)?;

    reload(&state).await;
    Ok(Json(rule))
}

async fn set_enabled(
    state: AppState,
    headers: HeaderMap,
    id: String,
    raw: HashMap<String, String>,
    enabled: bool,
) -> ApiResult<Json<ManagedRule>> {
    admin::require(&state, &headers)?;
    check_id(&id)?;
    no_parameters(&raw)?;
    if config_rule(&state, &id).is_some() {
        return Err(read_only());
    }
    let row: Option<RuleRow> = sqlx::query_as(&format!(
        "UPDATE alert_rules SET enabled = $2, updated_at = NOW() WHERE id = $1 RETURNING {COLUMNS}"
    ))
    .bind(&id)
    .bind(enabled)
    .fetch_optional(&state.pool)
    .await
    .map_err(internal_error)?;
    let rule = row.and_then(RuleRow::into_rule).ok_or_else(not_found)?;

    reload(&state).await;
    Ok(Json(rule))
}

/// `POST /alert-rules/{id}/pause` — stops evaluating the rule; it is kept.
pub(crate) async fn pause(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Json<ManagedRule>> {
    set_enabled(state, headers, id, raw, false).await
}

/// `POST /alert-rules/{id}/resume` — evaluates the rule again.
pub(crate) async fn resume(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Json<ManagedRule>> {
    set_enabled(state, headers, id, raw, true).await
}

/// `DELETE /alert-rules/{id}`. Alerts the rule already raised are kept.
pub(crate) async fn remove(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<StatusCode> {
    admin::require(&state, &headers)?;
    check_id(&id)?;
    no_parameters(&raw)?;
    if config_rule(&state, &id).is_some() {
        return Err(read_only());
    }
    let removed: Option<String> =
        sqlx::query_scalar("DELETE FROM alert_rules WHERE id = $1 RETURNING id")
            .bind(&id)
            .fetch_optional(&state.pool)
            .await
            .map_err(internal_error)?;
    if removed.is_none() {
        return Err(not_found());
    }
    reload(&state).await;
    Ok(StatusCode::NO_CONTENT)
}

// --- testing a rule -----------------------------------------------------------

/// What a rule would have done over the tested history.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DryRun {
    rule_id: String,
    lookback_hours: i64,
    events_evaluated: usize,
    /// Set when a source had more events than the test reads.
    truncated: bool,
    /// How many alerts the rule would have raised.
    would_fire: usize,
    /// Matches the cooldown or storm cap would have held back.
    suppressed: u32,
    /// The first `limit` alerts, oldest first.
    alerts: Vec<Alert>,
}

/// Replays `events` through a fresh engine holding only `rule`. Nothing is
/// stored and nobody is notified.
fn dry_run(
    rule: Rule,
    settings: StormSettings,
    mut events: Vec<AlertEvent>,
    lookback_hours: i64,
    truncated: bool,
    limit: usize,
) -> DryRun {
    events.sort_by(|a, b| {
        (a.occurred_at(), a.key()).cmp(&(b.occurred_at(), b.key()))
    });
    let rule_id = rule.id.clone();
    let engine = AlertEngine::new(vec![rule], settings);
    let events_evaluated = events.len();
    let (mut alerts, mut suppressed) = (Vec::new(), 0);
    for event in &events {
        let evaluation = engine.evaluate(event);
        suppressed += evaluation.suppressed;
        alerts.extend(evaluation.alerts);
    }
    let would_fire = alerts.len();
    alerts.truncate(limit);
    DryRun {
        rule_id,
        lookback_hours,
        events_evaluated,
        truncated,
        would_fire,
        suppressed,
        alerts,
    }
}

#[derive(sqlx::FromRow)]
struct TransferRow {
    ledger: i64,
    tx_hash: String,
    event_index: i32,
    token: String,
    amount: String,
    occurred_at: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct ApprovalRow {
    ledger: i64,
    tx_hash: String,
    event_index: i32,
    owner: String,
    proposal_id: i64,
    occurred_at: DateTime<Utc>,
}

/// The validated query parameters of the rule test endpoints.
struct TestParams {
    limit: i64,
    lookback: i64,
    scope: crate::scope::RequestScope,
}

fn test_params(state: &AppState, raw: &HashMap<String, String>) -> ApiResult<TestParams> {
    let mut details = Vec::new();
    reject_unknown(raw, TEST_PARAMS, &mut details);
    let limit = proposals::parse_integer(raw, "limit", 20, 1, 100, &mut details);
    let lookback = match proposals::nonempty(raw, "lookbackHours") {
        None => 24,
        Some(value) => match value.parse::<i64>() {
            Ok(hours) if (1..=168).contains(&hours) => hours,
            _ => {
                details.push(proposals::detail(
                    "lookbackHours",
                    "must be an integer between 1 and 168",
                    "INVALID_LOOKBACK",
                ));
                24
            }
        },
    };
    let scope = state.scope.resolve(raw, &mut details);
    if !details.is_empty() {
        return Err(rejected(details));
    }
    Ok(TestParams {
        limit,
        lookback,
        scope,
    })
}

async fn run_test(
    state: &AppState,
    rule: Rule,
    params: TestParams,
) -> ApiResult<Json<DryRun>> {
    let TestParams {
        limit,
        lookback,
        scope,
    } = params;
    let since = Utc::now() - Duration::hours(lookback);
    let mut events = Vec::new();
    let mut truncated = false;
    for network in &scope.networks {
        for contract_id in &scope.contract_ids {
            let transfers: Vec<TransferRow> = sqlx::query_as(
                "SELECT ledger, tx_hash, event_index, token, amount, occurred_at FROM transfers \
                 WHERE network = $1 AND contract_id = $2 AND occurred_at >= $3 \
                 ORDER BY occurred_at ASC, ledger ASC, event_index ASC LIMIT $4",
            )
            .bind(network)
            .bind(contract_id)
            .bind(since)
            .bind(TEST_EVENT_CAP + 1)
            .fetch_all(&state.pool)
            .await
            .map_err(internal_error)?;
            truncated |= transfers.len() as i64 > TEST_EVENT_CAP;
            for row in transfers.into_iter().take(TEST_EVENT_CAP as usize) {
                let Ok(amount) = row.amount.trim().parse::<i128>() else {
                    continue;
                };
                events.push(AlertEvent::Transfer {
                    key: format!(
                        "transfer:{network}:{contract_id}:{}:{}:{}",
                        row.ledger, row.tx_hash, row.event_index
                    ),
                    network: network.clone(),
                    contract_id: contract_id.clone(),
                    token: row.token,
                    amount,
                    occurred_at: row.occurred_at,
                });
            }

            let approvals: Vec<ApprovalRow> = sqlx::query_as(
                "SELECT ledger, tx_hash, event_index, owner, proposal_id, occurred_at \
                 FROM proposal_approvals \
                 WHERE network = $1 AND contract_id = $2 AND occurred_at >= $3 \
                 ORDER BY occurred_at ASC, ledger ASC, event_index ASC LIMIT $4",
            )
            .bind(network)
            .bind(contract_id)
            .bind(since)
            .bind(TEST_EVENT_CAP + 1)
            .fetch_all(&state.pool)
            .await
            .map_err(internal_error)?;
            truncated |= approvals.len() as i64 > TEST_EVENT_CAP;
            for row in approvals.into_iter().take(TEST_EVENT_CAP as usize) {
                events.push(AlertEvent::Approval {
                    key: format!(
                        "approval:{network}:{contract_id}:{}:{}:{}",
                        row.ledger, row.tx_hash, row.event_index
                    ),
                    network: network.clone(),
                    contract_id: contract_id.clone(),
                    owner: row.owner,
                    proposal_id: Some(row.proposal_id),
                    occurred_at: row.occurred_at,
                });
            }
        }
    }

    let settings = state
        .alert_engine
        .as_ref()
        .map(|engine| engine.settings().clone())
        .unwrap_or_default();
    Ok(Json(dry_run(
        rule,
        settings,
        events,
        lookback,
        truncated,
        usize::try_from(limit).unwrap_or(20),
    )))
}

/// `POST /alert-rules/test` — dry-runs the rule in the body (a draft, not
/// stored) against recent indexed history. Needs no administrator token: it
/// changes nothing.
pub(crate) async fn test_draft(
    State(state): State<AppState>,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
    body: Bytes,
) -> ApiResult<Json<DryRun>> {
    let params = test_params(&state, &raw)?;
    // The draft may not have an id yet; the test only needs one to exist.
    let body = match serde_json::from_slice::<serde_json::Value>(&body) {
        Ok(serde_json::Value::Object(mut object)) => {
            object
                .entry("id")
                .or_insert_with(|| serde_json::json!("draft"));
            Bytes::from(serde_json::Value::Object(object).to_string())
        }
        _ => body,
    };
    let input = parse_input(&body, None).map_err(rejected)?;
    run_test(&state, input.rule, params).await
}

/// `POST /alert-rules/{id}/test` — dry-runs a saved rule.
pub(crate) async fn test_saved(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Json<DryRun>> {
    check_id(&id)?;
    let params = test_params(&state, &raw)?;
    let rule = find(&state, &id).await?.rule;
    run_test(&state, rule, params).await
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    fn body(json: &str) -> Bytes {
        Bytes::from(json.to_owned())
    }

    fn codes(details: &[ErrorDetail]) -> Vec<(String, String)> {
        details
            .iter()
            .map(|detail| {
                let value = serde_json::to_value(detail).unwrap();
                (
                    value["field"].as_str().unwrap().to_owned(),
                    value["code"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    }

    const SPEND: &str = r#"{"id":"big","type":"spend_threshold","token":"USDC","threshold":"1000","windowSecs":3600,"severity":"critical"}"#;

    #[test]
    fn accepts_each_rule_kind_and_reads_enabled() {
        let input = parse_input(&body(SPEND), None).unwrap();
        assert_eq!(input.rule.id, "big");
        assert_eq!(input.enabled, None);
        assert_eq!(category_of(&input.rule), "threshold");

        let burst = parse_input(
            &body(r#"{"id":"b","type":"approval_burst","maxApprovals":3,"windowSecs":600,"enabled":false}"#),
            None,
        )
        .unwrap();
        assert_eq!(burst.enabled, Some(false));
        assert_eq!(category_of(&burst.rule), "anomaly");

        let night = parse_input(
            &body(r#"{"id":"n","type":"off_hours_approval","startHour":22,"endHour":5}"#),
            None,
        )
        .unwrap();
        assert_eq!(category_of(&night.rule), "anomaly");
    }

    #[test]
    fn the_path_id_fills_in_or_must_match_the_body() {
        let without_id = r#"{"type":"approval_burst","maxApprovals":3,"windowSecs":600}"#;
        let input = parse_input(&body(without_id), Some("from-path")).unwrap();
        assert_eq!(input.rule.id, "from-path");

        let error = parse_input(&body(SPEND), Some("other")).unwrap_err();
        assert_eq!(codes(&error), [("id".into(), "INVALID_RULE_ID".into())]);
        assert!(parse_input(&body(without_id), None).is_err(), "create needs an id");
    }

    #[test]
    fn rejects_bad_ids() {
        for id in ["", "has space", "slash/inside", "test", "ünï"] {
            assert!(!valid_id(id), "{id:?}");
        }
        assert!(!valid_id(&"a".repeat(65)));
        for id in ["big-spend", "rule_1", "a.b", "X"] {
            assert!(valid_id(id), "{id:?}");
        }
    }

    #[test]
    fn rejects_malformed_bodies_and_unknown_fields() {
        for json in ["not json", "[]", r#"{"id":"x","type":"nope"}"#] {
            assert!(parse_input(&body(json), None).is_err(), "{json}");
        }
        let error = parse_input(
            &body(r#"{"id":"x","type":"approval_burst","maxApprovals":3,"windowSecs":60,"cooldownSec":5}"#),
            None,
        )
        .unwrap_err();
        assert_eq!(codes(&error), [("body".into(), "INVALID_BODY".into())]);

        let error = parse_input(&body(r#"{"id":"x","type":"approval_burst","maxApprovals":3,"windowSecs":60,"enabled":"yes"}"#), None).unwrap_err();
        assert_eq!(codes(&error), [("enabled".into(), "INVALID_BODY".into())]);
    }

    #[test]
    fn names_the_field_that_failed_validation() {
        for (json, field) in [
            (r#"{"id":"x","type":"spend_threshold","threshold":"-5","windowSecs":60}"#, "threshold"),
            (r#"{"id":"x","type":"spend_threshold","threshold":"5","windowSecs":0}"#, "windowSecs"),
            (r#"{"id":"x","type":"approval_burst","maxApprovals":0,"windowSecs":60}"#, "maxApprovals"),
            (r#"{"id":"x","type":"off_hours_approval","startHour":5,"endHour":5}"#, "startHour"),
            (
                r#"{"id":"x","type":"spend_threshold","threshold":"5","windowSecs":99999999}"#,
                "windowSecs",
            ),
            (
                r#"{"id":"x","type":"approval_burst","maxApprovals":2,"windowSecs":60,"cooldownSecs":99999999}"#,
                "cooldownSecs",
            ),
        ] {
            let error = parse_input(&body(json), None).unwrap_err();
            assert_eq!(codes(&error), [(field.into(), "INVALID_RULE".into())], "{json}");
        }
    }

    fn at(hour: u32, minute: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 27, hour, minute, 0).unwrap()
    }

    fn transfer(key: &str, amount: i128, when: DateTime<Utc>) -> AlertEvent {
        AlertEvent::Transfer {
            key: key.to_owned(),
            network: "testnet".to_owned(),
            contract_id: "C1".to_owned(),
            token: "USDC".to_owned(),
            amount,
            occurred_at: when,
        }
    }

    fn spend_rule() -> Rule {
        parse_input(&body(SPEND), None).unwrap().rule
    }

    #[test]
    fn a_dry_run_reports_what_would_fire_without_side_effects() {
        let events = vec![
            transfer("t3", 600, at(10, 20)),
            transfer("t1", 500, at(10, 0)),
            transfer("t2", 400, at(10, 10)),
        ];
        let run = dry_run(spend_rule(), StormSettings::default(), events, 24, false, 20);

        assert_eq!(run.rule_id, "big");
        assert_eq!(run.events_evaluated, 3);
        assert_eq!(run.would_fire, 1, "events are replayed oldest first: 500+400+600 >= 1000");
        assert_eq!(run.alerts[0].subject, "USDC");
        assert_eq!(run.alerts[0].fired_at, at(10, 20));
        assert_eq!(run.suppressed, 0);
    }

    #[test]
    fn a_dry_run_applies_the_cooldown_and_caps_the_listed_alerts() {
        let settings = StormSettings {
            cooldown: std::time::Duration::from_secs(0),
            ..StormSettings::default()
        };
        let events: Vec<AlertEvent> = (0..5)
            .map(|index| transfer(&format!("t{index}"), 2000, at(10, index)))
            .collect();
        let run = dry_run(spend_rule(), settings, events, 24, false, 2);

        assert_eq!(run.would_fire, 5);
        assert_eq!(run.alerts.len(), 2, "only `limit` alerts are returned");

        let events: Vec<AlertEvent> = (0..5)
            .map(|index| transfer(&format!("t{index}"), 2000, at(10, index)))
            .collect();
        let cooling = dry_run(spend_rule(), StormSettings::default(), events, 24, false, 20);
        assert_eq!(cooling.would_fire, 1, "the default 15 minute cooldown holds the rest back");
        assert_eq!(cooling.suppressed, 4);
    }

    #[test]
    fn a_rule_that_never_matches_fires_nothing() {
        let run = dry_run(
            spend_rule(),
            StormSettings::default(),
            vec![transfer("t1", 1, at(9, 0))],
            24,
            true,
            20,
        );

        assert_eq!(run.would_fire, 0);
        assert!(run.truncated);
        assert!(run.alerts.is_empty());
    }

    #[test]
    fn the_engine_picks_up_managed_rules_and_forgets_edited_ones() {
        let base = parse_input(
            &body(r#"{"id":"cfg","type":"approval_burst","maxApprovals":5,"windowSecs":60}"#),
            None,
        )
        .unwrap()
        .rule;
        let engine = AlertEngine::new(vec![base], StormSettings::default());
        assert_eq!(engine.rules().len(), 1);

        assert!(engine.replace_managed(vec![spend_rule()]));
        assert_eq!(engine.rules().len(), 2);
        assert!(!engine.replace_managed(vec![spend_rule()]), "no change, no reset");

        // A managed rule cannot shadow a configured one.
        let shadow = parse_input(
            &body(r#"{"id":"cfg","type":"approval_burst","maxApprovals":1,"windowSecs":60}"#),
            None,
        )
        .unwrap()
        .rule;
        engine.replace_managed(vec![shadow]);
        assert_eq!(engine.rules().len(), 1);
        assert_eq!(engine.base_rules().len(), 1);

        // A paused rule is simply no longer in the active set.
        engine.replace_managed(Vec::new());
        assert_eq!(engine.rules().len(), 1);
    }

    #[test]
    fn editing_a_rule_discards_the_samples_counted_under_the_old_one() {
        let engine = AlertEngine::new(Vec::new(), StormSettings::default());
        engine.replace_managed(vec![spend_rule()]);
        assert!(engine.evaluate(&transfer("a", 900, at(10, 0))).alerts.is_empty());

        // Same id, lower threshold: the 900 counted before must not carry over.
        let edited = parse_input(
            &body(r#"{"id":"big","type":"spend_threshold","token":"USDC","threshold":"1000","windowSecs":7200,"severity":"critical"}"#),
            None,
        )
        .unwrap()
        .rule;
        engine.replace_managed(vec![edited]);
        assert!(engine.evaluate(&transfer("b", 200, at(10, 5))).alerts.is_empty());
    }
}
