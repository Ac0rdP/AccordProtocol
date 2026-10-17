use std::{collections::HashMap, env, net::SocketAddr, sync::Arc};

use anyhow::{Context, Result, bail};
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
};
use chrono::{DateTime, NaiveDate, NaiveTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{
    PgPool, QueryBuilder,
    postgres::{PgPoolOptions, Postgres},
    types::Json as SqlJson,
};
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

mod mail;
mod reports;
mod schedule;
mod scope;

use mail::ReportTransport;
use reports::{ReportFormat, ReportPeriod};
use schedule::{ReportConfig, ReportConfigSummary, ReportRunRecord, run_reports};
use scope::{RequestScope, ScopeConfig, push_scope};

#[derive(Clone)]
struct Config {
    listen_host: String,
    listen_port: u16,
    database_url: String,
    scope: ScopeConfig,
}

#[derive(Clone)]
struct AppState {
    pool: PgPool,
    scope: ScopeConfig,
    reports: Arc<ReportConfig>,
    transport: Option<Arc<dyn ReportTransport>>,
}

impl Config {
    fn from_env() -> Result<Self> {
        let listen_host = env::var("LISTEN_HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let listen_port = env::var("LISTEN_PORT")
            .unwrap_or_else(|_| "8080".into())
            .parse()
            .context("LISTEN_PORT must be a valid port number")?;
        let database_url = env::var("DATABASE_URL")
            .context("DATABASE_URL must point to the indexer PostgreSQL database")?;
        let scope = ScopeConfig::from_env()?;

        if listen_host.is_empty() {
            bail!("LISTEN_HOST must not be empty");
        }

        Ok(Self {
            listen_host,
            listen_port,
            database_url,
            scope,
        })
    }
}

#[derive(Serialize)]
struct RootResponse {
    service: &'static str,
    status: &'static str,
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    database: &'static str,
}

fn app(state: AppState) -> Router {
    Router::new()
        .route("/", get(root))
        .route("/health", get(health))
        .route("/proposals", get(proposals::list))
        .route("/proposals/{id}", get(proposals::get_detail))
        .route("/spend/by-category", get(spend::by_category))
        .route("/reports", get(report_api::list))
        .route("/reports/run", post(report_api::run_now))
        .with_state(state)
}

mod spend {
    use super::*;

    const CATEGORIES: &[&str] = &["Transfer", "Payroll", "Grant", "Ops", "Other"];

    #[derive(Serialize)]
    pub(super) struct CategorySpendBucket {
        category: String,
        token: String,
        total: String,
        count: i64,
        share: f64,
    }

    #[derive(sqlx::FromRow)]
    struct CategoryTotal {
        category: String,
        total: String,
        count: i64,
    }

    #[derive(Debug, Default)]
    struct SpendQuery {
        token: Option<String>,
        start_date: Option<DateTime<Utc>>,
        end_date: Option<DateTime<Utc>>,
        scope: RequestScope,
    }

    pub(super) async fn by_category(
        State(state): State<AppState>,
        axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
    ) -> Result<Json<Vec<CategorySpendBucket>>, (StatusCode, Json<proposals::ApiError>)> {
        let query = parse_query(raw, &state.scope).map_err(|details| {
            (
                StatusCode::BAD_REQUEST,
                Json(proposals::ApiError::invalid(details)),
            )
        })?;

        let mut token_query = QueryBuilder::<Postgres>::new(
            "SELECT DISTINCT token FROM proposals WHERE status = 'executed' AND kind = 'transfer'",
        );
        push_scope(&mut token_query, "", &query.scope);
        if let Some(token) = query.token.as_deref() {
            token_query.push(" AND token = ").push_bind(token);
        }
        token_query.push(" ORDER BY token");
        let mut tokens: Vec<String> = token_query
            .build_query_scalar()
            .fetch_all(&state.pool)
            .await
            .map_err(proposals::internal_error)?;
        if tokens.is_empty() {
            tokens.push(query.token.clone().unwrap_or_else(|| "XLM".to_owned()));
        }

        let mut buckets = Vec::new();
        for token in tokens {
            let mut totals_query = QueryBuilder::<Postgres>::new(
                "SELECT category, COALESCE(SUM(amount::numeric), 0)::text AS total, \
                 COUNT(*)::bigint AS count FROM proposals \
                 WHERE status = 'executed' AND kind = 'transfer' AND token = ",
            );
            totals_query.push_bind(&token);
            push_scope(&mut totals_query, "", &query.scope);
            if let Some(start) = query.start_date {
                totals_query.push(" AND executed_at >= ").push_bind(start);
            }
            if let Some(end) = query.end_date {
                totals_query.push(" AND executed_at <= ").push_bind(end);
            }
            totals_query.push(" GROUP BY category");
            let totals: Vec<CategoryTotal> = totals_query
                .build_query_as()
                .fetch_all(&state.pool)
                .await
                .map_err(proposals::internal_error)?;
            buckets.extend(build_buckets(token, totals));
        }

        Ok(Json(buckets))
    }

    fn build_buckets(token: String, totals: Vec<CategoryTotal>) -> Vec<CategorySpendBucket> {
        let totals: HashMap<String, CategoryTotal> = totals
            .into_iter()
            .map(|total| (total.category.clone(), total))
            .collect();
        let grand_total: f64 = totals
            .values()
            .filter_map(|row| row.total.parse::<f64>().ok())
            .sum();

        CATEGORIES
            .iter()
            .map(|category| {
                let row = totals.get(*category);
                let total = row
                    .map(|row| row.total.clone())
                    .unwrap_or_else(|| "0".to_owned());
                let amount = total.parse::<f64>().unwrap_or(0.0);
                CategorySpendBucket {
                    category: (*category).to_owned(),
                    token: token.clone(),
                    total,
                    count: row.map(|row| row.count).unwrap_or(0),
                    share: if grand_total == 0.0 {
                        0.0
                    } else {
                        amount / grand_total * 100.0
                    },
                }
            })
            .collect()
    }

    fn parse_query(
        raw: HashMap<String, String>,
        config: &ScopeConfig,
    ) -> Result<SpendQuery, Vec<proposals::ErrorDetail>> {
        let mut details = Vec::new();
        for key in raw.keys() {
            if !["token", "startDate", "endDate", "contractId", "network"].contains(&key.as_str()) {
                details.push(proposals::detail(
                    key,
                    "is not a supported query parameter",
                    "UNKNOWN_PARAMETER",
                ));
            }
        }
        let start_date = proposals::parse_date(&raw, "startDate", false, &mut details);
        let end_date = proposals::parse_date(&raw, "endDate", true, &mut details);
        if matches!((start_date, end_date), (Some(start), Some(end)) if start > end) {
            details.push(proposals::detail(
                "startDate",
                "must be before or equal to endDate",
                "INVALID_DATE_RANGE",
            ));
        }
        let scope = config.resolve(&raw, &mut details);
        if !details.is_empty() {
            return Err(details);
        }
        Ok(SpendQuery {
            token: proposals::nonempty(&raw, "token"),
            start_date,
            end_date,
            scope,
        })
    }

    #[cfg(test)]
    mod tests {
        use super::{CategoryTotal, ScopeConfig, build_buckets, parse_query};
        use std::collections::HashMap;

        fn scope() -> ScopeConfig {
            ScopeConfig::new(vec!["test-contract".into()], vec!["testnet".into()])
        }

        #[test]
        fn includes_every_category_with_zeroes() {
            let buckets = build_buckets("XLM".to_owned(), Vec::new());

            assert_eq!(buckets.len(), 5);
            assert!(buckets.iter().all(|bucket| bucket.total == "0"));
            assert!(buckets.iter().all(|bucket| bucket.count == 0));
            assert!(buckets.iter().all(|bucket| bucket.share == 0.0));
        }

        #[test]
        fn computes_shares_for_each_token() {
            let buckets = build_buckets(
                "USDC".to_owned(),
                vec![
                    CategoryTotal {
                        category: "Payroll".to_owned(),
                        total: "75.0000000".to_owned(),
                        count: 3,
                    },
                    CategoryTotal {
                        category: "Grant".to_owned(),
                        total: "25.0000000".to_owned(),
                        count: 1,
                    },
                ],
            );

            let payroll = buckets
                .iter()
                .find(|bucket| bucket.category == "Payroll")
                .unwrap();
            let grant = buckets
                .iter()
                .find(|bucket| bucket.category == "Grant")
                .unwrap();
            let ops = buckets
                .iter()
                .find(|bucket| bucket.category == "Ops")
                .unwrap();
            assert_eq!(payroll.share, 75.0);
            assert_eq!(grant.share, 25.0);
            assert_eq!(ops.share, 0.0);
            assert_eq!(payroll.token, "USDC");
        }

        #[test]
        fn rejects_inverted_date_ranges_and_unsupported_parameters() {
            let error = parse_query(
                HashMap::from([
                    ("startDate".to_owned(), "2026-09-27".to_owned()),
                    ("endDate".to_owned(), "2026-09-26".to_owned()),
                    ("limit".to_owned(), "5".to_owned()),
                ]),
                &scope(),
            )
            .unwrap_err();

            assert_eq!(error.len(), 2);
        }
    }
}

mod report_api {
    use super::*;

    const STATUSES: &[&str] = &["generated", "delivered", "failed"];

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct ReportPage {
        config: ReportConfigSummary,
        next_run: Option<DateTime<Utc>>,
        runs: Vec<ReportRunRecord>,
        total: i64,
        limit: i64,
        offset: i64,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct ManualRunResponse {
        period: ReportPeriod,
        runs: Vec<ReportRunRecord>,
    }

    /// `GET /reports` — the configured schedule plus the recorded report runs,
    /// newest first. Scoped and filterable the same way the other endpoints are.
    pub(super) async fn list(
        State(state): State<AppState>,
        axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
    ) -> Result<Json<ReportPage>, (StatusCode, Json<proposals::ApiError>)> {
        let mut details = Vec::new();
        for key in raw.keys() {
            if !["limit", "offset", "status", "format", "contractId", "network"]
                .contains(&key.as_str())
            {
                details.push(proposals::detail(
                    key,
                    "is not a supported query parameter",
                    "UNKNOWN_PARAMETER",
                ));
            }
        }

        let limit = proposals::parse_integer(&raw, "limit", 20, 1, 100, &mut details);
        let offset = proposals::parse_integer(&raw, "offset", 0, 0, i64::MAX, &mut details);

        let status = proposals::nonempty(&raw, "status");
        if let Some(value) = status.as_deref()
            && !STATUSES.contains(&value)
        {
            details.push(proposals::detail(
                "status",
                "must be one of: generated, delivered, failed",
                "INVALID_STATUS",
            ));
        }

        let format = match proposals::nonempty(&raw, "format") {
            None => None,
            Some(value) => match value.parse::<ReportFormat>() {
                Ok(format) => Some(format),
                Err(_) => {
                    details.push(proposals::detail(
                        "format",
                        "must be csv or pdf",
                        "INVALID_FORMAT",
                    ));
                    None
                }
            },
        };

        let scope = state.scope.resolve(&raw, &mut details);
        if !details.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(proposals::ApiError::invalid(details)),
            ));
        }

        let mut count = QueryBuilder::<Postgres>::new("SELECT COUNT(*) FROM report_runs WHERE TRUE");
        push_scope(&mut count, "", &scope);
        add_filters(&mut count, status.as_deref(), format);
        let total: i64 = count
            .build_query_scalar()
            .fetch_one(&state.pool)
            .await
            .map_err(internal_error)?;

        let mut rows = QueryBuilder::<Postgres>::new(
            "SELECT id, network, contract_id, period_start, period_end, format, trigger_source, \
             status, attempts, recipients, byte_size, file_path, error, created_at, delivered_at \
             FROM report_runs WHERE TRUE",
        );
        push_scope(&mut rows, "", &scope);
        add_filters(&mut rows, status.as_deref(), format);
        rows.push(" ORDER BY created_at DESC, id DESC LIMIT ");
        rows.push_bind(limit);
        rows.push(" OFFSET ");
        rows.push_bind(offset);

        let runs = rows
            .build_query_as::<ReportRunRecord>()
            .fetch_all(&state.pool)
            .await
            .map_err(internal_error)?;

        Ok(Json(ReportPage {
            config: state.reports.summary(state.transport.as_ref()),
            next_run: state.reports.next_run_after(Utc::now()),
            runs,
            total,
            limit,
            offset,
        }))
    }

    /// `POST /reports/run` — generates and delivers a report immediately for the
    /// scoped contracts, without waiting for the schedule.
    pub(super) async fn run_now(
        State(state): State<AppState>,
        axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
    ) -> Result<Json<ManualRunResponse>, (StatusCode, Json<proposals::ApiError>)> {
        let mut details = Vec::new();
        for key in raw.keys() {
            if !["format", "periodDays", "contractId", "network"].contains(&key.as_str()) {
                details.push(proposals::detail(
                    key,
                    "is not a supported query parameter",
                    "UNKNOWN_PARAMETER",
                ));
            }
        }

        let period_days = proposals::parse_integer(
            &raw,
            "periodDays",
            state.reports.period_days,
            1,
            3650,
            &mut details,
        );

        let mut config = (*state.reports).clone();
        if let Some(value) = proposals::nonempty(&raw, "format") {
            match value.parse::<ReportFormat>() {
                Ok(format) => config.formats = vec![format],
                Err(_) => details.push(proposals::detail(
                    "format",
                    "must be csv or pdf",
                    "INVALID_FORMAT",
                )),
            }
        }
        config.period_days = period_days;

        let scope = state.scope.resolve(&raw, &mut details);
        if !details.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(proposals::ApiError::invalid(details)),
            ));
        }

        let pairs: Vec<(String, String)> = scope
            .networks
            .iter()
            .flat_map(|network| {
                scope
                    .contract_ids
                    .iter()
                    .map(move |contract_id| (network.clone(), contract_id.clone()))
            })
            .collect();

        let now = Utc::now();
        let period = ReportPeriod::ending_at(now, period_days);
        let runs = run_reports(
            &state.pool,
            &pairs,
            &config,
            state.transport.as_ref(),
            "manual",
            period,
            now,
        )
        .await;

        Ok(Json(ManualRunResponse { period, runs }))
    }

    fn add_filters(
        builder: &mut QueryBuilder<'_, Postgres>,
        status: Option<&str>,
        format: Option<ReportFormat>,
    ) {
        if let Some(status) = status {
            builder.push(" AND status = ").push_bind(status.to_owned());
        }
        if let Some(format) = format {
            builder
                .push(" AND format = ")
                .push_bind(format.as_str().to_owned());
        }
    }

    fn internal_error(error: sqlx::Error) -> (StatusCode, Json<proposals::ApiError>) {
        tracing::error!(%error, "failed to query treasury report runs");
        proposals::internal_error(error)
    }
}

async fn root() -> Json<RootResponse> {
    Json(RootResponse {
        service: "accord-analytics-api",
        status: "ok",
    })
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    match sqlx::query("SELECT 1").execute(&state.pool).await {
        Ok(_) => (
            StatusCode::OK,
            Json(HealthResponse {
                status: "ok",
                database: "connected",
            }),
        ),
        Err(error) => {
            tracing::error!(%error, "analytics database health check failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(HealthResponse {
                    status: "unavailable",
                    database: "disconnected",
                }),
            )
        }
    }
}

mod proposals {
    use super::*;

    const STATUSES: &[&str] = &["pending", "ready", "executed", "expired", "revoked"];
    const CATEGORIES: &[&str] = &["Transfer", "Payroll", "Grant", "Ops", "Other"];

    #[derive(Debug, Deserialize, sqlx::FromRow)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct ProposalRow {
        id: i64,
        network: String,
        contract_id: String,
        kind: String,
        to: String,
        amount: String,
        token: String,
        description: String,
        approvals: i32,
        threshold: i32,
        quorum_weight: Option<i32>,
        approval_weight: Option<i32>,
        total_weight: Option<i32>,
        approver_addresses: SqlJson<Vec<String>>,
        status: String,
        deadline: DateTime<Utc>,
        created_at: DateTime<Utc>,
        proposer: String,
        category: String,
        executed_at: Option<DateTime<Utc>>,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct ProposalResponse {
        id: i64,
        network: String,
        contract_id: String,
        kind: String,
        to: String,
        amount: String,
        token: String,
        description: String,
        approvals: i32,
        threshold: i32,
        quorum_weight: Option<i32>,
        approval_weight: Option<i32>,
        total_weight: Option<i32>,
        status: String,
        deadline: DateTime<Utc>,
        deadline_ts: i64,
        created_at: DateTime<Utc>,
        proposer: String,
        user_has_approved: bool,
        approver_addresses: Vec<String>,
        category: String,
        executed_at: Option<DateTime<Utc>>,
    }

    impl From<ProposalRow> for ProposalResponse {
        fn from(row: ProposalRow) -> Self {
            Self {
                id: row.id,
                network: row.network,
                contract_id: row.contract_id,
                kind: row.kind,
                to: row.to,
                amount: row.amount,
                token: row.token,
                description: row.description,
                approvals: row.approvals,
                threshold: row.threshold,
                quorum_weight: row.quorum_weight,
                approval_weight: row.approval_weight,
                total_weight: row.total_weight,
                status: row.status,
                deadline_ts: row.deadline.timestamp(),
                deadline: row.deadline,
                created_at: row.created_at,
                proposer: row.proposer,
                user_has_approved: false,
                approver_addresses: row.approver_addresses.0,
                category: row.category,
                executed_at: row.executed_at,
            }
        }
    }

    #[derive(Serialize)]
    pub(super) struct ProposalPage {
        proposals: Vec<ProposalResponse>,
        total: i64,
        limit: i64,
        offset: i64,
    }

    #[derive(Serialize)]
    pub(super) struct ProposalDetail {
        proposal: ProposalResponse,
        timeline: Vec<EventResponse>,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct EventResponse {
        #[serde(rename = "type")]
        event_type: String,
        actor: String,
        timestamp: DateTime<Utc>,
        ledger: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        schedule_id: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        amount: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        token: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        recipient: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<String>,
    }

    #[derive(sqlx::FromRow)]
    struct EventRow {
        topic: String,
        actor: String,
        occurred_at: DateTime<Utc>,
        ledger: i64,
        data: SqlJson<serde_json::Value>,
    }

    impl From<EventRow> for EventResponse {
        fn from(row: EventRow) -> Self {
            let data = row.data.0;
            Self {
                event_type: row.topic,
                actor: row.actor,
                timestamp: row.occurred_at,
                ledger: row.ledger,
                schedule_id: json_i64(&data, "schedule_id"),
                amount: json_string(&data, "amount"),
                token: json_string(&data, "token"),
                recipient: json_string(&data, "recipient"),
                details: json_string(&data, "details"),
            }
        }
    }

    #[derive(Debug, Default)]
    struct ProposalQuery {
        limit: i64,
        offset: i64,
        sort: String,
        order: String,
        status: Option<String>,
        category: Option<String>,
        owner: Option<String>,
        token: Option<String>,
        start_date: Option<DateTime<Utc>>,
        end_date: Option<DateTime<Utc>>,
        scope: RequestScope,
    }

    #[derive(Serialize)]
    pub(super) struct ApiError {
        error: ErrorBody,
    }

    #[derive(Serialize)]
    struct ErrorBody {
        code: &'static str,
        message: &'static str,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        details: Vec<ErrorDetail>,
    }

    #[derive(Debug, Serialize)]
    pub(super) struct ErrorDetail {
        field: String,
        message: String,
        code: &'static str,
    }

    impl ApiError {
        pub(super) fn invalid(details: Vec<ErrorDetail>) -> Self {
            Self {
                error: ErrorBody {
                    code: "VALIDATION_ERROR",
                    message: "Invalid query parameters",
                    details,
                },
            }
        }

        fn parameter(message: &'static str) -> Self {
            Self {
                error: ErrorBody {
                    code: "INVALID_PARAMETER",
                    message,
                    details: Vec::new(),
                },
            }
        }

        fn not_found() -> Self {
            Self {
                error: ErrorBody {
                    code: "NOT_FOUND",
                    message: "Proposal not found",
                    details: Vec::new(),
                },
            }
        }
    }

    pub(super) async fn list(
        State(state): State<AppState>,
        axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
    ) -> Result<Json<ProposalPage>, (StatusCode, Json<ApiError>)> {
        let query = parse_query(raw, &state.scope)
            .map_err(|details| (StatusCode::BAD_REQUEST, Json(ApiError::invalid(details))))?;

        let mut count =
            QueryBuilder::<Postgres>::new("SELECT COUNT(*) FROM proposals p WHERE TRUE");
        add_filters(&mut count, &query);
        let total: i64 = count
            .build_query_scalar()
            .fetch_one(&state.pool)
            .await
            .map_err(internal_error)?;

        let sort_column = match query.sort.as_str() {
            "deadline" => "p.deadline",
            "amount" => "p.amount::numeric",
            _ => "p.created_at",
        };
        let direction = if query.order == "asc" { "ASC" } else { "DESC" };
        let mut rows = QueryBuilder::<Postgres>::new(
            "SELECT p.proposal_id AS id, p.network, p.contract_id, p.kind, p.recipient AS to, \
             p.amount, p.token, p.description, p.approvals, p.threshold, p.quorum_weight, \
             p.approval_weight, p.total_weight, p.approver_addresses, p.status, p.deadline, \
             p.created_at, p.proposer, p.category, p.executed_at FROM proposals p WHERE TRUE",
        );
        add_filters(&mut rows, &query);
        rows.push(" ORDER BY ");
        rows.push(sort_column);
        rows.push(" ");
        rows.push(direction);
        rows.push(", p.network ASC, p.contract_id ASC, p.proposal_id DESC LIMIT ");
        rows.push_bind(query.limit);
        rows.push(" OFFSET ");
        rows.push_bind(query.offset);

        let proposals = rows
            .build_query_as::<ProposalRow>()
            .fetch_all(&state.pool)
            .await
            .map_err(internal_error)?
            .into_iter()
            .map(ProposalResponse::from)
            .collect();

        Ok(Json(ProposalPage {
            proposals,
            total,
            limit: query.limit,
            offset: query.offset,
        }))
    }

    pub(super) async fn get_detail(
        State(state): State<AppState>,
        axum::extract::Path(raw_id): axum::extract::Path<String>,
        axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
    ) -> Result<Json<ProposalDetail>, (StatusCode, Json<ApiError>)> {
        let id = raw_id
            .parse::<i64>()
            .ok()
            .filter(|id| *id >= 0)
            .ok_or_else(|| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(ApiError::parameter(
                        "Proposal id must be a non-negative integer",
                    )),
                )
            })?;

        let mut details = Vec::new();
        for key in raw.keys() {
            if !["contractId", "network"].contains(&key.as_str()) {
                details.push(detail(
                    key,
                    "is not a supported query parameter",
                    "UNKNOWN_PARAMETER",
                ));
            }
        }
        let scope = state.scope.resolve(&raw, &mut details);
        if !details.is_empty() {
            return Err((StatusCode::BAD_REQUEST, Json(ApiError::invalid(details))));
        }

        // A proposal id is only unique within one contract on one network. With
        // several in scope the first pair in a stable order wins, and the
        // response names it so the caller can narrow with contractId/network.
        let mut proposal_query = QueryBuilder::<Postgres>::new(
            "SELECT p.proposal_id AS id, p.network, p.contract_id, p.kind, p.recipient AS to, \
             p.amount, p.token, p.description, p.approvals, p.threshold, p.quorum_weight, \
             p.approval_weight, p.total_weight, p.approver_addresses, p.status, p.deadline, \
             p.created_at, p.proposer, p.category, p.executed_at FROM proposals p \
             WHERE p.proposal_id = ",
        );
        proposal_query.push_bind(id);
        push_scope(&mut proposal_query, "p.", &scope);
        proposal_query.push(" ORDER BY p.network ASC, p.contract_id ASC LIMIT 1");

        let proposal = proposal_query
            .build_query_as::<ProposalRow>()
            .fetch_optional(&state.pool)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| (StatusCode::NOT_FOUND, Json(ApiError::not_found())))?;

        let events = sqlx::query_as::<_, EventRow>(
            "SELECT topic, actor, occurred_at, ledger, data FROM events \
             WHERE network = $1 AND contract_id = $2 AND proposal_id = $3 \
             ORDER BY ledger ASC, event_index ASC",
        )
        .bind(&proposal.network)
        .bind(&proposal.contract_id)
        .bind(id)
        .fetch_all(&state.pool)
        .await
        .map_err(internal_error)?
        .into_iter()
        .map(EventResponse::from)
        .collect();

        Ok(Json(ProposalDetail {
            proposal: ProposalResponse::from(proposal),
            timeline: events,
        }))
    }

    fn json_string(data: &serde_json::Value, key: &str) -> Option<String> {
        data.get(key).and_then(|value| match value {
            serde_json::Value::String(value) => Some(value.clone()),
            serde_json::Value::Number(value) => Some(value.to_string()),
            _ => None,
        })
    }

    fn json_i64(data: &serde_json::Value, key: &str) -> Option<i64> {
        data.get(key).and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
        })
    }

    fn add_filters<'a>(builder: &mut QueryBuilder<'a, Postgres>, query: &'a ProposalQuery) {
        push_scope(builder, "p.", &query.scope);
        if let Some(status) = query.status.as_deref() {
            builder.push(" AND p.status = ").push_bind(status);
        }
        if let Some(category) = query.category.as_deref() {
            builder.push(" AND p.category = ").push_bind(category);
        }
        if let Some(owner) = query.owner.as_deref() {
            builder
                .push(" AND p.proposer ILIKE ")
                .push_bind(format!("%{owner}%"));
        }
        if let Some(token) = query.token.as_deref() {
            builder.push(" AND p.token = ").push_bind(token);
        }
        if let Some(start) = query.start_date {
            builder.push(" AND p.created_at >= ").push_bind(start);
        }
        if let Some(end) = query.end_date {
            builder.push(" AND p.created_at <= ").push_bind(end);
        }
    }

    fn parse_query(
        raw: HashMap<String, String>,
        config: &ScopeConfig,
    ) -> Result<ProposalQuery, Vec<ErrorDetail>> {
        let mut details = Vec::new();
        let allowed = [
            "limit",
            "offset",
            "sort",
            "order",
            "status",
            "category",
            "owner",
            "token",
            "startDate",
            "endDate",
            "contractId",
            "network",
        ];
        for key in raw.keys() {
            if !allowed.contains(&key.as_str()) {
                details.push(detail(
                    key,
                    "is not a supported query parameter",
                    "UNKNOWN_PARAMETER",
                ));
            }
        }

        let limit = parse_integer(&raw, "limit", 20, 1, 100, &mut details);
        let offset = parse_integer(&raw, "offset", 0, 0, i64::MAX, &mut details);
        let sort = raw.get("sort").map(String::as_str).unwrap_or("createdAt");
        if !["deadline", "amount", "createdAt"].contains(&sort) {
            details.push(detail(
                "sort",
                "must be one of: deadline, amount, createdAt",
                "INVALID_SORT",
            ));
        }
        let order = raw.get("order").map(String::as_str).unwrap_or("desc");
        if !["asc", "desc"].contains(&order) {
            details.push(detail("order", "must be asc or desc", "INVALID_ORDER"));
        }

        let status = nonempty(&raw, "status");
        if let Some(value) = status.as_deref().filter(|value| *value != "all")
            && !STATUSES.contains(&value)
        {
            details.push(detail(
                "status",
                "is not a supported proposal status",
                "INVALID_STATUS",
            ));
        }
        let status = status.filter(|value| value != "all");

        let category = nonempty(&raw, "category");
        if let Some(value) = category.as_deref().filter(|value| *value != "all")
            && !CATEGORIES.contains(&value)
        {
            details.push(detail(
                "category",
                "is not a supported proposal category",
                "INVALID_CATEGORY",
            ));
        }
        let category = category.filter(|value| value != "all");

        let start_date = parse_date(&raw, "startDate", false, &mut details);
        let end_date = parse_date(&raw, "endDate", true, &mut details);
        if matches!((start_date, end_date), (Some(start), Some(end)) if start > end) {
            details.push(detail(
                "startDate",
                "must be before or equal to endDate",
                "INVALID_DATE_RANGE",
            ));
        }

        let scope = config.resolve(&raw, &mut details);

        if !details.is_empty() {
            return Err(details);
        }
        Ok(ProposalQuery {
            limit,
            offset,
            sort: sort.to_owned(),
            order: order.to_owned(),
            status,
            category,
            owner: nonempty(&raw, "owner"),
            token: nonempty(&raw, "token"),
            start_date,
            end_date,
            scope,
        })
    }

    pub(super) fn parse_integer(
        raw: &HashMap<String, String>,
        field: &'static str,
        default: i64,
        min: i64,
        max: i64,
        details: &mut Vec<ErrorDetail>,
    ) -> i64 {
        let Some(value) = raw.get(field) else {
            return default;
        };
        match value.parse::<i64>() {
            Ok(parsed) if (min..=max).contains(&parsed) => parsed,
            _ => {
                let (message, code) = match field {
                    "limit" => ("must be an integer between 1 and 100", "INVALID_LIMIT"),
                    "periodDays" => (
                        "must be an integer between 1 and 3650",
                        "INVALID_PERIOD_DAYS",
                    ),
                    _ => ("must be a non-negative integer", "INVALID_OFFSET"),
                };
                details.push(detail(field, message, code));
                default
            }
        }
    }

    pub(super) fn parse_date(
        raw: &HashMap<String, String>,
        field: &'static str,
        end_of_day: bool,
        details: &mut Vec<ErrorDetail>,
    ) -> Option<DateTime<Utc>> {
        let value = nonempty(raw, field)?;
        if let Ok(date_time) = DateTime::parse_from_rfc3339(&value) {
            return Some(date_time.with_timezone(&Utc));
        }
        if let Ok(date) = NaiveDate::parse_from_str(&value, "%Y-%m-%d") {
            let time = if end_of_day {
                NaiveTime::from_hms_nano_opt(23, 59, 59, 999_999_999).unwrap()
            } else {
                NaiveTime::MIN
            };
            return Some(date.and_time(time).and_utc());
        }
        details.push(detail(
            field,
            "must be a valid ISO 8601 date or date-time",
            "INVALID_DATE",
        ));
        None
    }

    pub(super) fn nonempty(raw: &HashMap<String, String>, field: &str) -> Option<String> {
        raw.get(field)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    }

    pub(super) fn detail(
        field: impl Into<String>,
        message: &str,
        code: &'static str,
    ) -> ErrorDetail {
        ErrorDetail {
            field: field.into(),
            message: message.to_owned(),
            code,
        }
    }

    pub(super) fn internal_error(error: sqlx::Error) -> (StatusCode, Json<ApiError>) {
        tracing::error!(%error, "failed to query indexed proposals");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: ErrorBody {
                    code: "INTERNAL_ERROR",
                    message: "Failed to query indexed proposals",
                    details: Vec::new(),
                },
            }),
        )
    }

    #[cfg(test)]
    mod tests {
        use super::{ScopeConfig, parse_query};
        use std::collections::HashMap;

        fn scope() -> ScopeConfig {
            ScopeConfig::new(
                vec!["CONTRACT_A".into(), "CONTRACT_B".into()],
                vec!["testnet".into(), "pubnet".into()],
            )
        }

        #[test]
        fn applies_defaults_and_accepts_filters() {
            let query = parse_query(
                HashMap::from([
                    ("status".to_owned(), "executed".to_owned()),
                    ("category".to_owned(), "Payroll".to_owned()),
                    ("owner".to_owned(), "GABC".to_owned()),
                    ("sort".to_owned(), "amount".to_owned()),
                ]),
                &scope(),
            )
            .unwrap();

            assert_eq!(query.limit, 20);
            assert_eq!(query.offset, 0);
            assert_eq!(query.status.as_deref(), Some("executed"));
            assert_eq!(query.category.as_deref(), Some("Payroll"));
            assert_eq!(query.sort, "amount");
            assert_eq!(query.scope.contract_ids.len(), 2, "defaults to every contract");
            assert_eq!(query.scope.networks.len(), 2, "defaults to every network");
        }

        #[test]
        fn rejects_invalid_filters_and_sort_values() {
            let error = parse_query(
                HashMap::from([
                    ("limit".to_owned(), "101".to_owned()),
                    ("status".to_owned(), "active".to_owned()),
                    ("sort".to_owned(), "arbitrary_sql".to_owned()),
                ]),
                &scope(),
            )
            .unwrap_err();

            assert_eq!(error.len(), 3);
        }

        #[test]
        fn date_only_end_date_includes_the_entire_day() {
            let query = parse_query(
                HashMap::from([("endDate".to_owned(), "2026-09-26".to_owned())]),
                &scope(),
            )
            .unwrap();

            assert_eq!(
                query.end_date.unwrap().format("%H:%M:%S").to_string(),
                "23:59:59"
            );
        }

        #[test]
        fn narrows_to_one_contract_and_network_when_asked() {
            let query = parse_query(
                HashMap::from([
                    ("contractId".to_owned(), "CONTRACT_B".to_owned()),
                    ("network".to_owned(), "pubnet".to_owned()),
                ]),
                &scope(),
            )
            .unwrap();

            assert_eq!(query.scope.contract_ids, vec!["CONTRACT_B".to_owned()]);
            assert_eq!(query.scope.networks, vec!["pubnet".to_owned()]);
        }

        #[test]
        fn rejects_a_contract_this_deployment_does_not_serve() {
            let error = parse_query(
                HashMap::from([("contractId".to_owned(), "CONTRACT_Z".to_owned())]),
                &scope(),
            )
            .unwrap_err();

            assert_eq!(error.len(), 1);
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let config = Config::from_env()?;
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&config.database_url)
        .await
        .context("failed to connect to the analytics datastore")?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("failed to apply analytics datastore migrations")?;

    let reports = Arc::new(ReportConfig::from_env()?);
    let transport = reports.transport_from_env()?;
    let scheduler = schedule::spawn(
        pool.clone(),
        config.scope.pairs(),
        Arc::clone(&reports),
        transport.clone(),
    );
    if scheduler.is_none() {
        tracing::info!("no REPORT_SCHEDULE configured; scheduled treasury reports are off");
    }

    let address: SocketAddr = format!("{}:{}", config.listen_host, config.listen_port)
        .parse()
        .context("LISTEN_HOST and LISTEN_PORT did not form a valid socket address")?;
    let listener = TcpListener::bind(address)
        .await
        .with_context(|| format!("failed to listen on {address}"))?;

    tracing::info!(
        %address,
        contracts = config.scope.contract_ids.len(),
        networks = config.scope.networks.len(),
        "analytics API listening"
    );
    axum::serve(
        listener,
        app(AppState {
            pool,
            scope: config.scope,
            reports,
            transport,
        }),
    )
    .await?;

    if let Some(scheduler) = scheduler {
        scheduler.abort();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use sqlx::postgres::PgPoolOptions;
    use std::sync::Arc;
    use tower::ServiceExt;

    use super::{AppState, ReportConfig, ScopeConfig, app};

    /// The handlers under test reject their input before touching the database,
    /// so a lazy pool that never connects is enough.
    fn state() -> AppState {
        AppState {
            pool: PgPoolOptions::new()
                .connect_lazy("postgres://accord:accord@localhost/accord_analytics")
                .unwrap(),
            scope: ScopeConfig::new(
                vec!["test-contract".to_owned(), "other-contract".to_owned()],
                vec!["testnet".to_owned()],
            ),
            reports: Arc::new(ReportConfig {
                schedule: None,
                expression: None,
                formats: vec![super::ReportFormat::Csv],
                recipients: Vec::new(),
                period_days: 30,
                output_dir: None,
                max_attempts: 3,
                retry_backoff: std::time::Duration::from_millis(10),
                from: "reports@example.com".to_owned(),
            }),
            transport: None,
        }
    }

    async fn error_body(response: axum::response::Response) -> serde_json::Value {
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    #[tokio::test]
    async fn root_returns_service_status() {
        let response = app(state())
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::OK);
    }

    #[tokio::test]
    async fn proposals_reject_invalid_pagination_with_json_error() {
        let response = app(state())
            .oneshot(
                Request::builder()
                    .uri("/proposals?limit=101")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
        let error = error_body(response).await;
        assert_eq!(error["error"]["code"], "VALIDATION_ERROR");
        assert_eq!(error["error"]["details"][0]["field"], "limit");
    }

    #[tokio::test]
    async fn proposal_detail_rejects_malformed_ids() {
        let response = app(state())
            .oneshot(
                Request::builder()
                    .uri("/proposals/not-a-number")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
        let error = error_body(response).await;
        assert_eq!(error["error"]["code"], "INVALID_PARAMETER");
    }

    #[tokio::test]
    async fn proposals_reject_a_contract_this_deployment_does_not_serve() {
        let response = app(state())
            .oneshot(
                Request::builder()
                    .uri("/proposals?contractId=somebody-elses-contract")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
        let error = error_body(response).await;
        assert_eq!(error["error"]["details"][0]["code"], "INVALID_CONTRACT_ID");
    }

    #[tokio::test]
    async fn proposal_detail_rejects_an_unknown_network() {
        let response = app(state())
            .oneshot(
                Request::builder()
                    .uri("/proposals/1?network=futurenet")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
        let error = error_body(response).await;
        assert_eq!(error["error"]["details"][0]["code"], "INVALID_NETWORK");
    }

    #[tokio::test]
    async fn spend_by_category_accepts_the_scope_parameters() {
        // Reaching the database means validation let the request through; the
        // lazy pool then fails the query, which is the 500 path.
        let response = app(state())
            .oneshot(
                Request::builder()
                    .uri("/spend/by-category?contractId=test-contract&network=testnet")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            response.status(),
            axum::http::StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    #[tokio::test]
    async fn reports_reject_an_unsupported_format() {
        let response = app(state())
            .oneshot(
                Request::builder()
                    .uri("/reports?format=xlsx")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
        let error = error_body(response).await;
        assert_eq!(error["error"]["details"][0]["code"], "INVALID_FORMAT");
    }

    #[tokio::test]
    async fn reports_reject_an_unsupported_status() {
        let response = app(state())
            .oneshot(
                Request::builder()
                    .uri("/reports?status=queued")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
        let error = error_body(response).await;
        assert_eq!(error["error"]["details"][0]["code"], "INVALID_STATUS");
    }

    #[tokio::test]
    async fn manual_report_runs_reject_an_out_of_range_period() {
        let response = app(state())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/reports/run?periodDays=0")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
        let error = error_body(response).await;
        assert_eq!(error["error"]["details"][0]["code"], "INVALID_PERIOD_DAYS");
    }

    #[tokio::test]
    async fn manual_report_runs_reject_unknown_parameters() {
        let response = app(state())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/reports/run?recipients=someone@example.com")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
        let error = error_body(response).await;
        assert_eq!(error["error"]["details"][0]["code"], "UNKNOWN_PARAMETER");
    }

    #[tokio::test]
    async fn reports_are_not_reachable_with_a_get_on_the_run_route() {
        let response = app(state())
            .oneshot(
                Request::builder()
                    .uri("/reports/run")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            response.status(),
            axum::http::StatusCode::METHOD_NOT_ALLOWED
        );
    }
}
