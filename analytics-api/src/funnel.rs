//! `GET /proposals/funnel` — proposal funnel and conversion analytics.
//!
//! Every proposal created in the requested window is followed through the
//! funnel `created → approved → executed`, with the two ways out of it
//! (`cancelled`, which is a revoked proposal, and `expired`) counted alongside.
//! The funnel can be grouped by proposal category or by proposing owner.
//!
//! The window filters on `created_at`, so each row is a cohort: "of the
//! proposals created in this period, how many went on to be approved and
//! executed". Statuses partition a cohort, so
//! `executed + cancelled + expired + open == created` always holds.

use std::collections::HashMap;

use axum::{Json, extract::State, http::StatusCode};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{QueryBuilder, postgres::Postgres};

use crate::{
    AppState,
    proposals::{self, ApiError, ErrorDetail},
    scope::{RequestScope, ScopeConfig, push_scope},
};

pub(crate) const GROUP_BY: &[&str] = &["category", "owner"];

/// Query parameters `GET /proposals/funnel` accepts.
pub(crate) const QUERY_PARAMS: &[&str] = &[
    "groupBy",
    "category",
    "owner",
    "token",
    "startDate",
    "endDate",
    "limit",
    "offset",
    "contractId",
    "network",
];

/// A proposal counts as approved once it reached its threshold, whatever
/// became of it afterwards (a proposal can be approved and still expire or be
/// revoked before anyone executes it).
pub(crate) const APPROVED: &str = "(p.status IN ('ready', 'executed') \
                         OR (p.threshold > 0 AND p.approvals >= p.threshold))";

#[derive(Debug, Default)]
struct FunnelQuery {
    group_by: GroupBy,
    category: Option<String>,
    owner: Option<String>,
    token: Option<String>,
    start_date: Option<DateTime<Utc>>,
    end_date: Option<DateTime<Utc>>,
    limit: i64,
    offset: i64,
    scope: RequestScope,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum GroupBy {
    #[default]
    Category,
    Owner,
}

impl GroupBy {
    fn as_str(self) -> &'static str {
        match self {
            Self::Category => "category",
            Self::Owner => "owner",
        }
    }

    /// The column the funnel is grouped by. A fixed allowlist, never user text.
    fn column(self) -> &'static str {
        match self {
            Self::Category => "p.category",
            Self::Owner => "p.proposer",
        }
    }
}

/// Raw counts for one group, as the database returns them.
#[derive(Debug, sqlx::FromRow)]
struct FunnelCounts {
    key: String,
    created: i64,
    approved: i64,
    executed: i64,
    cancelled: i64,
    expired: i64,
    open: i64,
    avg_seconds_to_execute: Option<f64>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FunnelRow {
    key: String,
    created: i64,
    approved: i64,
    executed: i64,
    cancelled: i64,
    expired: i64,
    open: i64,
    /// Percentage (0–100) of created proposals that were approved.
    approval_rate: f64,
    /// Percentage (0–100) of created proposals that were executed.
    execution_rate: f64,
    /// Percentage (0–100) of created proposals that were cancelled (revoked).
    cancellation_rate: f64,
    /// Percentage (0–100) of approved proposals that were then executed.
    approval_to_execution_rate: f64,
    avg_seconds_to_execute: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FunnelPage {
    group_by: &'static str,
    items: Vec<FunnelRow>,
    /// The funnel across every matching proposal, independent of paging.
    totals: FunnelRow,
    /// Number of groups, independent of paging.
    total: i64,
    limit: i64,
    offset: i64,
}

/// `part` as a percentage of `whole`, rounded to two places; `0` for an empty
/// denominator so a quiet group never produces `NaN`.
fn rate(part: i64, whole: i64) -> f64 {
    if whole <= 0 {
        return 0.0;
    }
    (part as f64 / whole as f64 * 10_000.0).round() / 100.0
}

impl From<FunnelCounts> for FunnelRow {
    fn from(counts: FunnelCounts) -> Self {
        Self {
            approval_rate: rate(counts.approved, counts.created),
            execution_rate: rate(counts.executed, counts.created),
            cancellation_rate: rate(counts.cancelled, counts.created),
            approval_to_execution_rate: rate(counts.executed, counts.approved),
            avg_seconds_to_execute: counts.avg_seconds_to_execute.map(|seconds| seconds.round()),
            key: counts.key,
            created: counts.created,
            approved: counts.approved,
            executed: counts.executed,
            cancelled: counts.cancelled,
            expired: counts.expired,
            open: counts.open,
        }
    }
}

pub(crate) async fn list(
    State(state): State<AppState>,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
) -> Result<Json<FunnelPage>, (StatusCode, Json<ApiError>)> {
    let query = parse_query(raw, &state.scope)
        .map_err(|details| (StatusCode::BAD_REQUEST, Json(ApiError::invalid(details))))?;
    let column = query.group_by.column();

    let mut count = QueryBuilder::<Postgres>::new(format!(
        "SELECT COUNT(DISTINCT {column}) FROM proposals p WHERE TRUE"
    ));
    add_filters(&mut count, &query);
    let total: i64 = count
        .build_query_scalar()
        .fetch_one(&state.pool)
        .await
        .map_err(internal_error)?;

    let mut rows = QueryBuilder::<Postgres>::new(counts_select(&format!("{column}::text")));
    add_filters(&mut rows, &query);
    rows.push(format!(
        " GROUP BY {column} ORDER BY created DESC, key ASC LIMIT "
    ));
    rows.push_bind(query.limit);
    rows.push(" OFFSET ");
    rows.push_bind(query.offset);
    let items: Vec<FunnelRow> = rows
        .build_query_as::<FunnelCounts>()
        .fetch_all(&state.pool)
        .await
        .map_err(internal_error)?
        .into_iter()
        .map(FunnelRow::from)
        .collect();

    let mut totals = QueryBuilder::<Postgres>::new(counts_select("'all'"));
    add_filters(&mut totals, &query);
    let totals = totals
        .build_query_as::<FunnelCounts>()
        .fetch_one(&state.pool)
        .await
        .map_err(internal_error)?;

    Ok(Json(FunnelPage {
        group_by: query.group_by.as_str(),
        items,
        totals: FunnelRow::from(totals),
        total,
        limit: query.limit,
        offset: query.offset,
    }))
}

fn counts_select(key: &str) -> String {
    format!(
        "SELECT {key} AS key, \
         COUNT(*)::bigint AS created, \
         (COUNT(*) FILTER (WHERE {APPROVED}))::bigint AS approved, \
         (COUNT(*) FILTER (WHERE p.status = 'executed'))::bigint AS executed, \
         (COUNT(*) FILTER (WHERE p.status = 'revoked'))::bigint AS cancelled, \
         (COUNT(*) FILTER (WHERE p.status = 'expired'))::bigint AS expired, \
         (COUNT(*) FILTER (WHERE p.status IN ('pending', 'ready')))::bigint AS open, \
         (AVG(EXTRACT(EPOCH FROM (p.executed_at - p.created_at))) \
            FILTER (WHERE p.status = 'executed' AND p.executed_at IS NOT NULL))::float8 \
            AS avg_seconds_to_execute \
         FROM proposals p WHERE TRUE"
    )
}

fn add_filters<'a>(builder: &mut QueryBuilder<'a, Postgres>, query: &'a FunnelQuery) {
    push_scope(builder, "p.", &query.scope);
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
) -> Result<FunnelQuery, Vec<ErrorDetail>> {
    let mut details = Vec::new();
    for key in raw.keys() {
        if !QUERY_PARAMS.contains(&key.as_str()) {
            details.push(proposals::detail(
                key,
                "is not a supported query parameter",
                "UNKNOWN_PARAMETER",
            ));
        }
    }

    let group_by = match proposals::nonempty(&raw, "groupBy").as_deref() {
        None | Some("category") => GroupBy::Category,
        Some("owner") => GroupBy::Owner,
        Some(_) => {
            details.push(proposals::detail(
                "groupBy",
                "must be one of: category, owner",
                "INVALID_GROUP_BY",
            ));
            GroupBy::Category
        }
    };

    let category = proposals::nonempty(&raw, "category");
    if let Some(value) = category.as_deref()
        && !proposals::CATEGORIES.contains(&value)
    {
        details.push(proposals::detail(
            "category",
            "is not a supported proposal category",
            "INVALID_CATEGORY",
        ));
    }

    let limit = proposals::parse_integer(&raw, "limit", 20, 1, 100, &mut details);
    let offset = proposals::parse_integer(&raw, "offset", 0, 0, i64::MAX, &mut details);
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
    Ok(FunnelQuery {
        group_by,
        category,
        owner: proposals::nonempty(&raw, "owner"),
        token: proposals::nonempty(&raw, "token"),
        start_date,
        end_date,
        limit,
        offset,
        scope,
    })
}

fn internal_error(error: sqlx::Error) -> (StatusCode, Json<ApiError>) {
    tracing::error!(%error, "failed to aggregate the proposal funnel");
    proposals::internal_error(error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope() -> ScopeConfig {
        ScopeConfig::new(vec!["test-contract".into()], vec!["testnet".into()])
    }

    fn raw(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    #[test]
    fn rates_are_percentages_rounded_to_two_places() {
        assert_eq!(rate(1, 3), 33.33);
        assert_eq!(rate(2, 3), 66.67);
        assert_eq!(rate(3, 3), 100.0);
        assert_eq!(rate(0, 5), 0.0);
    }

    #[test]
    fn an_empty_denominator_yields_zero_not_nan() {
        assert_eq!(rate(0, 0), 0.0);
        assert_eq!(rate(4, 0), 0.0);
    }

    #[test]
    fn counts_become_conversion_rates() {
        let row = FunnelRow::from(FunnelCounts {
            key: "Payroll".to_owned(),
            created: 10,
            approved: 8,
            executed: 6,
            cancelled: 1,
            expired: 1,
            open: 2,
            avg_seconds_to_execute: Some(3600.4),
        });

        assert_eq!(row.approval_rate, 80.0);
        assert_eq!(row.execution_rate, 60.0);
        assert_eq!(row.cancellation_rate, 10.0);
        assert_eq!(row.approval_to_execution_rate, 75.0);
        assert_eq!(row.avg_seconds_to_execute, Some(3600.0));
    }

    #[test]
    fn defaults_group_by_category_and_page_the_first_twenty() {
        let query = parse_query(HashMap::new(), &scope()).unwrap();

        assert_eq!(query.group_by, GroupBy::Category);
        assert_eq!(query.limit, 20);
        assert_eq!(query.offset, 0);
    }

    #[test]
    fn accepts_owner_grouping_and_filters() {
        let query = parse_query(
            raw(&[
                ("groupBy", "owner"),
                ("category", "Payroll"),
                ("token", "USDC"),
                ("startDate", "2026-09-01"),
            ]),
            &scope(),
        )
        .unwrap();

        assert_eq!(query.group_by, GroupBy::Owner);
        assert_eq!(query.category.as_deref(), Some("Payroll"));
        assert_eq!(query.token.as_deref(), Some("USDC"));
        assert!(query.start_date.is_some());
    }

    #[test]
    fn reports_every_invalid_parameter() {
        let details = parse_query(
            raw(&[
                ("groupBy", "token"),
                ("category", "Bogus"),
                ("limit", "0"),
                ("offset", "-1"),
                ("bogus", "1"),
                ("startDate", "2026-09-27"),
                ("endDate", "2026-09-26"),
            ]),
            &scope(),
        )
        .unwrap_err();

        let codes: Vec<String> = details
            .iter()
            .map(|detail| {
                serde_json::to_value(detail).unwrap()["code"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        assert_eq!(
            codes,
            [
                "INVALID_CATEGORY",
                "INVALID_DATE_RANGE",
                "INVALID_GROUP_BY",
                "INVALID_LIMIT",
                "INVALID_OFFSET",
                "UNKNOWN_PARAMETER",
            ]
        );
    }
}
