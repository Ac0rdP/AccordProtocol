//! `GET /costs/attribution` — spend broken down by category, owner or
//! recipient, with drill-down.
//!
//! Spend is what executed transfer proposals paid out, windowed on execution
//! time like `GET /spend/by-category`. Amounts of different tokens are never
//! added together, so every row is one `(key, token)` pair and shares are
//! taken against that token's total.
//!
//! Drill-down is composition: filter on one dimension and group by another,
//! for example `category=Payroll&groupBy=recipient` shows who the Payroll spend
//! went to, and adding `owner=G...` narrows it to one proposer.

use std::collections::HashMap;

use axum::{Json, extract::State, http::StatusCode, response::Response};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{QueryBuilder, postgres::Postgres};

use crate::{
    AppState, http_cache,
    proposals::{self, ApiError, ErrorDetail},
    scope::{RequestScope, ScopeConfig, push_scope},
};

pub(crate) const GROUP_BY: &[&str] = &["category", "owner", "recipient"];

pub(crate) const QUERY_PARAMS: &[&str] = &[
    "groupBy",
    "category",
    "owner",
    "recipient",
    "token",
    "startDate",
    "endDate",
    "limit",
    "offset",
    "contractId",
    "network",
];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum GroupBy {
    #[default]
    Category,
    Owner,
    Recipient,
}

impl GroupBy {
    fn as_str(self) -> &'static str {
        match self {
            Self::Category => "category",
            Self::Owner => "owner",
            Self::Recipient => "recipient",
        }
    }

    /// The column spend is grouped by. A fixed allowlist, never user text.
    fn column(self) -> &'static str {
        match self {
            Self::Category => "p.category",
            Self::Owner => "p.proposer",
            Self::Recipient => "p.recipient",
        }
    }
}

#[derive(Debug, Default)]
struct CostQuery {
    group_by: GroupBy,
    category: Option<String>,
    owner: Option<String>,
    recipient: Option<String>,
    token: Option<String>,
    start_date: Option<DateTime<Utc>>,
    end_date: Option<DateTime<Utc>>,
    limit: i64,
    offset: i64,
    scope: RequestScope,
}

#[derive(Debug, sqlx::FromRow)]
struct CostRow {
    key: String,
    token: String,
    total: String,
    count: i64,
}

#[derive(Debug, sqlx::FromRow)]
struct TokenTotal {
    token: String,
    total: String,
    count: i64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CostItem {
    key: String,
    token: String,
    total: String,
    count: i64,
    /// Percentage (0–100) of this token's spend in the filtered range.
    share: f64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CostTotal {
    token: String,
    total: String,
    count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CostPage {
    group_by: &'static str,
    items: Vec<CostItem>,
    /// Spend per token across every matching proposal, independent of paging.
    totals: Vec<CostTotal>,
    /// Number of `(key, token)` rows, independent of paging.
    total: i64,
    limit: i64,
    offset: i64,
}

fn build_items(rows: Vec<CostRow>, totals: &[TokenTotal]) -> Vec<CostItem> {
    let grand: HashMap<&str, f64> = totals
        .iter()
        .map(|total| (total.token.as_str(), total.total.parse().unwrap_or(0.0)))
        .collect();
    rows.into_iter()
        .map(|row| {
            let whole = grand.get(row.token.as_str()).copied().unwrap_or(0.0);
            let share = if whole <= 0.0 {
                0.0
            } else {
                (row.total.parse::<f64>().unwrap_or(0.0) / whole * 10_000.0).round() / 100.0
            };
            CostItem {
                key: row.key,
                token: row.token,
                total: row.total,
                count: row.count,
                share,
            }
        })
        .collect()
}

pub(crate) async fn attribution(
    State(state): State<AppState>,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    let query = parse_query(raw, &state.scope)
        .map_err(|details| (StatusCode::BAD_REQUEST, Json(ApiError::invalid(details))))?;
    let column = query.group_by.column();

    let mut count = QueryBuilder::<Postgres>::new(
        "SELECT COUNT(*) FROM (SELECT 1 FROM proposals p \
         WHERE p.status = 'executed' AND p.kind = 'transfer'",
    );
    add_filters(&mut count, &query);
    count.push(format!(" GROUP BY {column}, p.token) AS grouped"));
    let total: i64 = count
        .build_query_scalar()
        .fetch_one(&state.pool)
        .await
        .map_err(internal_error)?;

    let mut rows = QueryBuilder::<Postgres>::new(format!(
        "SELECT {column}::text AS key, p.token AS token, \
         COALESCE(SUM(p.amount::numeric), 0)::text AS total, COUNT(*)::bigint AS count \
         FROM proposals p WHERE p.status = 'executed' AND p.kind = 'transfer'"
    ));
    add_filters(&mut rows, &query);
    rows.push(format!(
        " GROUP BY {column}, p.token \
          ORDER BY SUM(p.amount::numeric) DESC, key ASC, p.token ASC LIMIT "
    ));
    rows.push_bind(query.limit);
    rows.push(" OFFSET ");
    rows.push_bind(query.offset);
    let rows: Vec<CostRow> = rows
        .build_query_as()
        .fetch_all(&state.pool)
        .await
        .map_err(internal_error)?;

    let mut totals = QueryBuilder::<Postgres>::new(
        "SELECT p.token AS token, COALESCE(SUM(p.amount::numeric), 0)::text AS total, \
         COUNT(*)::bigint AS count FROM proposals p \
         WHERE p.status = 'executed' AND p.kind = 'transfer'",
    );
    add_filters(&mut totals, &query);
    totals.push(" GROUP BY p.token ORDER BY p.token");
    let totals: Vec<TokenTotal> = totals
        .build_query_as()
        .fetch_all(&state.pool)
        .await
        .map_err(internal_error)?;

    let items = build_items(rows, &totals);
    Ok(http_cache::json(CostPage {
        group_by: query.group_by.as_str(),
        items,
        totals: totals
            .into_iter()
            .map(|total| CostTotal {
                token: total.token,
                total: total.total,
                count: total.count,
            })
            .collect(),
        total,
        limit: query.limit,
        offset: query.offset,
    }))
}

fn add_filters<'a>(builder: &mut QueryBuilder<'a, Postgres>, query: &'a CostQuery) {
    push_scope(builder, "p.", &query.scope);
    if let Some(category) = query.category.as_deref() {
        builder.push(" AND p.category = ").push_bind(category);
    }
    if let Some(owner) = query.owner.as_deref() {
        builder.push(" AND p.proposer = ").push_bind(owner);
    }
    if let Some(recipient) = query.recipient.as_deref() {
        builder.push(" AND p.recipient = ").push_bind(recipient);
    }
    if let Some(token) = query.token.as_deref() {
        builder.push(" AND p.token = ").push_bind(token);
    }
    if let Some(start) = query.start_date {
        builder.push(" AND p.executed_at >= ").push_bind(start);
    }
    if let Some(end) = query.end_date {
        builder.push(" AND p.executed_at <= ").push_bind(end);
    }
}

fn parse_query(
    raw: HashMap<String, String>,
    config: &ScopeConfig,
) -> Result<CostQuery, Vec<ErrorDetail>> {
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
        Some("recipient") => GroupBy::Recipient,
        Some(_) => {
            details.push(proposals::detail(
                "groupBy",
                "must be one of: category, owner, recipient",
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
    Ok(CostQuery {
        group_by,
        category,
        owner: proposals::nonempty(&raw, "owner"),
        recipient: proposals::nonempty(&raw, "recipient"),
        token: proposals::nonempty(&raw, "token"),
        start_date,
        end_date,
        limit,
        offset,
        scope,
    })
}

fn internal_error(error: sqlx::Error) -> (StatusCode, Json<ApiError>) {
    tracing::error!(%error, "failed to attribute costs");
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
    fn groups_by_category_and_pages_the_first_twenty_by_default() {
        let query = parse_query(HashMap::new(), &scope()).unwrap();
        assert_eq!(query.group_by, GroupBy::Category);
        assert_eq!((query.limit, query.offset), (20, 0));
    }

    #[test]
    fn drill_down_combines_a_filter_with_another_grouping() {
        let query = parse_query(
            raw(&[
                ("groupBy", "recipient"),
                ("category", "Payroll"),
                ("owner", "GALICE"),
            ]),
            &scope(),
        )
        .unwrap();
        assert_eq!(query.group_by, GroupBy::Recipient);
        assert_eq!(query.category.as_deref(), Some("Payroll"));
        assert_eq!(query.owner.as_deref(), Some("GALICE"));
    }

    #[test]
    fn reports_every_invalid_parameter() {
        let details = parse_query(
            raw(&[
                ("groupBy", "token"),
                ("category", "Bogus"),
                ("limit", "0"),
                ("startDate", "2026-09-27"),
                ("endDate", "2026-09-26"),
                ("bogus", "1"),
            ]),
            &scope(),
        )
        .unwrap_err();
        let mut codes: Vec<&str> = details.iter().map(|detail| detail.code).collect();
        codes.sort_unstable();
        assert_eq!(
            codes,
            [
                "INVALID_CATEGORY",
                "INVALID_DATE_RANGE",
                "INVALID_GROUP_BY",
                "INVALID_LIMIT",
                "UNKNOWN_PARAMETER"
            ]
        );
    }

    #[test]
    fn shares_are_taken_against_the_rows_own_token() {
        let rows = vec![
            CostRow {
                key: "Payroll".into(),
                token: "USDC".into(),
                total: "75".into(),
                count: 3,
            },
            CostRow {
                key: "Payroll".into(),
                token: "XLM".into(),
                total: "5".into(),
                count: 1,
            },
        ];
        let totals = [
            TokenTotal {
                token: "USDC".into(),
                total: "100".into(),
                count: 4,
            },
            TokenTotal {
                token: "XLM".into(),
                total: "5".into(),
                count: 1,
            },
        ];
        let items = build_items(rows, &totals);
        assert_eq!(items[0].share, 75.0);
        assert_eq!(items[1].share, 100.0);
    }

    #[test]
    fn a_zero_total_never_divides() {
        let rows = vec![CostRow {
            key: "Ops".into(),
            token: "XLM".into(),
            total: "0".into(),
            count: 1,
        }];
        assert_eq!(build_items(rows, &[])[0].share, 0.0);
    }
}
