//! `GET /benchmarks/peers` — privacy-preserving peer benchmarking.
//!
//! The requested scope's treasury governance metrics are compared against
//! the aggregate of every *other* contract indexed in the same database.
//! Peers are only ever exposed as distribution statistics (25th percentile,
//! median, 75th percentile) over per-contract values:
//!
//! - nothing identifies a peer: no contract, network, address or raw value;
//! - a cohort smaller than `BENCHMARK_MIN_PEERS` (default 5, never below 3)
//!   is suppressed entirely, so a handful of peers cannot be reverse
//!   engineered from the percentiles. The exact cohort size is reported so a
//!   caller can tell "no data" from "suppressed".

use std::collections::HashMap;

use axum::{Json, extract::State, http::StatusCode, response::Response};
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use sqlx::{QueryBuilder, Row, postgres::Postgres};

use crate::{
    AppState, funnel, http_cache,
    proposals::{self, ApiError, ErrorDetail},
    scope::{RequestScope, ScopeConfig, push_scope},
};

pub(crate) const QUERY_PARAMS: &[&str] = &[
    "metric",
    "category",
    "token",
    "periodDays",
    "endDate",
    "limit",
    "offset",
    "contractId",
    "network",
];

/// `(name, column, unit)` for every benchmarked metric.
pub(crate) const METRICS: &[(&str, &str, &str)] = &[
    ("proposalCount", "proposal_count", "count"),
    ("approvalRate", "approval_rate", "percent"),
    ("executionRate", "execution_rate", "percent"),
    ("avgSecondsToExecute", "avg_seconds_to_execute", "seconds"),
];

pub(crate) const DEFAULT_MIN_PEERS: usize = 5;
/// The smallest cohort an operator may configure.
pub(crate) const FLOOR_MIN_PEERS: usize = 3;
const MAX_PERIOD_DAYS: i64 = 365;
const DEFAULT_PERIOD_DAYS: i64 = 30;

/// Reads `BENCHMARK_MIN_PEERS`; unset means the default, anything below the
/// floor (or not a number) is rejected rather than silently weakening privacy.
pub(crate) fn min_peers_from_env() -> anyhow::Result<usize> {
    match std::env::var("BENCHMARK_MIN_PEERS") {
        Err(_) => Ok(DEFAULT_MIN_PEERS),
        Ok(value) => match value.trim().parse::<usize>() {
            Ok(peers) if peers >= FLOOR_MIN_PEERS => Ok(peers),
            _ => anyhow::bail!("BENCHMARK_MIN_PEERS must be an integer of at least {FLOOR_MIN_PEERS}"),
        },
    }
}

#[derive(Debug)]
struct BenchmarkQuery {
    metric: Option<&'static str>,
    category: Option<String>,
    token: Option<String>,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    period_days: i64,
    limit: i64,
    offset: i64,
    scope: RequestScope,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PeerStats {
    p25: Option<f64>,
    median: Option<f64>,
    p75: Option<f64>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BenchmarkRow {
    metric: &'static str,
    unit: &'static str,
    /// The requested scope's value; `null` when it had no proposals in the window.
    own: Option<f64>,
    /// Peer distribution; `null` while the cohort is suppressed.
    peers: Option<PeerStats>,
    /// `own - peers.median`; `null` when either side is missing.
    delta_from_median: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Cohort {
    /// Number of other contracts with activity in the window.
    size: i64,
    minimum_size: usize,
    /// True when the cohort is too small to publish statistics about.
    suppressed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BenchmarkPage {
    period_days: i64,
    cohort: Cohort,
    items: Vec<BenchmarkRow>,
    total: i64,
    limit: i64,
    offset: i64,
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

/// The per-contract metric columns, shared by the scope's own aggregate and
/// the per-peer rows so both are computed identically.
fn metric_columns() -> String {
    format!(
        "COUNT(*)::float8 AS proposal_count, \
         (100.0 * COUNT(*) FILTER (WHERE {approved}) / NULLIF(COUNT(*), 0))::float8 AS approval_rate, \
         (100.0 * COUNT(*) FILTER (WHERE p.status = 'executed') / NULLIF(COUNT(*), 0))::float8 AS execution_rate, \
         (AVG(EXTRACT(EPOCH FROM (p.executed_at - p.created_at))) \
            FILTER (WHERE p.status = 'executed' AND p.executed_at IS NOT NULL))::float8 AS avg_seconds_to_execute",
        approved = funnel::APPROVED
    )
}

fn push_window<'a>(builder: &mut QueryBuilder<'a, Postgres>, query: &'a BenchmarkQuery) {
    builder
        .push(" AND p.created_at > ")
        .push_bind(query.start)
        .push(" AND p.created_at <= ")
        .push_bind(query.end);
    if let Some(category) = query.category.as_deref() {
        builder.push(" AND p.category = ").push_bind(category);
    }
    if let Some(token) = query.token.as_deref() {
        builder.push(" AND p.token = ").push_bind(token);
    }
}

pub(crate) async fn peers(
    State(state): State<AppState>,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    let query = parse_query(raw, &state.scope)
        .map_err(|details| (StatusCode::BAD_REQUEST, Json(ApiError::invalid(details))))?;

    let mut own = QueryBuilder::<Postgres>::new(format!(
        "SELECT {} FROM proposals p WHERE TRUE",
        metric_columns()
    ));
    push_scope(&mut own, "p.", &query.scope);
    push_window(&mut own, &query);
    let own = own
        .build()
        .fetch_one(&state.pool)
        .await
        .map_err(internal_error)?;

    // One row per other contract, then percentiles across those rows.
    let mut peers = QueryBuilder::<Postgres>::new(format!(
        "WITH per AS (SELECT {} FROM proposals p WHERE NOT (p.contract_id = ANY(",
        metric_columns()
    ));
    peers
        .push_bind(&query.scope.contract_ids)
        .push(") AND p.network = ANY(")
        .push_bind(&query.scope.networks)
        .push("))");
    push_window(&mut peers, &query);
    peers.push(" GROUP BY p.network, p.contract_id) SELECT COUNT(*)::bigint AS cohort");
    for (_, column, _) in METRICS {
        for (suffix, fraction) in [("p25", "0.25"), ("p50", "0.5"), ("p75", "0.75")] {
            peers.push(format!(
                ", (percentile_cont({fraction}) WITHIN GROUP (ORDER BY {column}))::float8 AS {column}_{suffix}"
            ));
        }
    }
    peers.push(" FROM per");
    let peers = peers
        .build()
        .fetch_one(&state.pool)
        .await
        .map_err(internal_error)?;

    let cohort: i64 = peers.try_get("cohort").map_err(internal_error)?;
    let suppressed = (cohort as usize) < state.benchmark_min_peers;

    let mut rows = Vec::new();
    for &(name, column, unit) in METRICS {
        if query.metric.is_some_and(|wanted| wanted != name) {
            continue;
        }
        let own_value: Option<f64> = own.try_get(column).map_err(internal_error)?;
        let stats = if suppressed {
            None
        } else {
            let read = |suffix: &str| -> Result<Option<f64>, _> {
                peers
                    .try_get::<Option<f64>, _>(format!("{column}_{suffix}").as_str())
                    .map(|value| value.map(round2))
            };
            Some(PeerStats {
                p25: read("p25").map_err(internal_error)?,
                median: read("p50").map_err(internal_error)?,
                p75: read("p75").map_err(internal_error)?,
            })
        };
        rows.push(BenchmarkRow {
            metric: name,
            unit,
            own: own_value.map(round2),
            delta_from_median: own_value
                .zip(stats.as_ref().and_then(|stats| stats.median))
                .map(|(own, median)| round2(own - median)),
            peers: stats,
        });
    }

    let total = rows.len() as i64;
    let items = rows
        .into_iter()
        .skip(query.offset as usize)
        .take(query.limit as usize)
        .collect();
    Ok(http_cache::json(BenchmarkPage {
        period_days: query.period_days,
        cohort: Cohort {
            size: cohort,
            minimum_size: state.benchmark_min_peers,
            suppressed,
        },
        items,
        total,
        limit: query.limit,
        offset: query.offset,
    }))
}

fn parse_query(
    raw: HashMap<String, String>,
    config: &ScopeConfig,
) -> Result<BenchmarkQuery, Vec<ErrorDetail>> {
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

    let metric = match proposals::nonempty(&raw, "metric") {
        None => None,
        Some(value) => match METRICS.iter().find(|(name, _, _)| *name == value) {
            Some((name, _, _)) => Some(*name),
            None => {
                details.push(proposals::detail(
                    "metric",
                    "must be one of: proposalCount, approvalRate, executionRate, avgSecondsToExecute",
                    "INVALID_METRIC",
                ));
                None
            }
        },
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
    let period_days = match proposals::nonempty(&raw, "periodDays") {
        None => DEFAULT_PERIOD_DAYS,
        Some(value) => match value.parse::<i64>() {
            Ok(days) if (1..=MAX_PERIOD_DAYS).contains(&days) => days,
            _ => {
                details.push(proposals::detail(
                    "periodDays",
                    "must be an integer between 1 and 365",
                    "INVALID_PERIOD_DAYS",
                ));
                DEFAULT_PERIOD_DAYS
            }
        },
    };
    let end = proposals::parse_date(&raw, "endDate", true, &mut details)
        .map_or_else(Utc::now, |end| end.min(Utc::now()));
    let limit = proposals::parse_integer(&raw, "limit", 20, 1, 100, &mut details);
    let offset = proposals::parse_integer(&raw, "offset", 0, 0, i64::MAX, &mut details);
    let scope = config.resolve(&raw, &mut details);

    if !details.is_empty() {
        return Err(details);
    }
    Ok(BenchmarkQuery {
        metric,
        category,
        token: proposals::nonempty(&raw, "token"),
        start: end - Duration::days(period_days),
        end,
        period_days,
        limit,
        offset,
        scope,
    })
}

fn internal_error(error: sqlx::Error) -> (StatusCode, Json<ApiError>) {
    tracing::error!(%error, "failed to compute peer benchmarks");
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
    fn defaults_to_a_thirty_day_window_and_every_metric() {
        let query = parse_query(HashMap::new(), &scope()).unwrap();
        assert_eq!(query.period_days, 30);
        assert_eq!(query.metric, None);
        assert_eq!(query.end - query.start, Duration::days(30));
    }

    #[test]
    fn reports_every_invalid_parameter() {
        let details = parse_query(
            raw(&[
                ("metric", "profit"),
                ("category", "Bogus"),
                ("periodDays", "0"),
                ("limit", "0"),
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
                "INVALID_LIMIT",
                "INVALID_METRIC",
                "INVALID_PERIOD_DAYS",
                "UNKNOWN_PARAMETER"
            ]
        );
    }

    #[test]
    fn the_peer_floor_cannot_be_configured_below_three() {
        // SAFETY: tests in this module are the only readers of this variable.
        unsafe { std::env::set_var("BENCHMARK_MIN_PEERS", "2") };
        assert!(min_peers_from_env().is_err());
        unsafe { std::env::set_var("BENCHMARK_MIN_PEERS", "7") };
        assert_eq!(min_peers_from_env().unwrap(), 7);
        unsafe { std::env::remove_var("BENCHMARK_MIN_PEERS") };
        assert_eq!(min_peers_from_env().unwrap(), DEFAULT_MIN_PEERS);
    }
}
