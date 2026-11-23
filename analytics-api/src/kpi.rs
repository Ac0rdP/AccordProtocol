//! `GET /treasury/kpis` — daily treasury KPI snapshots and period-over-period
//! trend deltas for balance, spend and runway.
//!
//! Snapshots are persisted in `treasury_kpi_snapshots`. A request recomputes
//! the snapshots for the window it needs with an upsert, so the operation is
//! idempotent and a replayed or late-indexed event simply converges the rows.

use std::collections::HashMap;

use axum::{Json, extract::State, http::StatusCode, response::Response};
use chrono::{Duration, NaiveDate, Utc};
use serde::Serialize;
use sqlx::{QueryBuilder, postgres::Postgres};

use crate::{
    AppState, http_cache,
    proposals::{self, ApiError, ErrorDetail},
    scope::{RequestScope, ScopeConfig, push_scope},
};

pub(crate) const QUERY_PARAMS: &[&str] = &[
    "token",
    "periodDays",
    "endDate",
    "limit",
    "offset",
    "contractId",
    "network",
];

pub(crate) const MAX_PERIOD_DAYS: i64 = 365;
const DEFAULT_PERIOD_DAYS: i64 = 30;
/// Trailing window the burn rate (and so the runway) is averaged over.
const BURN_WINDOW_DAYS: i32 = 30;

const REFRESH_SQL: &str = "
WITH flows AS (
    SELECT network, contract_id, token,
           (occurred_at AT TIME ZONE 'UTC')::date AS day,
           0::numeric AS inflow,
           CASE WHEN amount ~ '^[0-9]+(\\.[0-9]+)?$' THEN amount::numeric ELSE 0 END AS spend,
           1::bigint AS spend_count
      FROM transfers
     WHERE network = ANY($1) AND contract_id = ANY($2)
    UNION ALL
    SELECT network, contract_id, COALESCE(NULLIF(data->>'token', ''), 'XLM'),
           (occurred_at AT TIME ZONE 'UTC')::date,
           CASE WHEN data->>'amount' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (data->>'amount')::numeric ELSE 0 END,
           0::numeric,
           0::bigint
      FROM events
     WHERE topic = 'deposit' AND network = ANY($1) AND contract_id = ANY($2)
),
daily AS (
    SELECT network, contract_id, token, day,
           SUM(inflow) AS inflow, SUM(spend) AS spend, SUM(spend_count)::bigint AS spend_count
      FROM flows GROUP BY network, contract_id, token, day
),
keys AS (
    SELECT DISTINCT network, contract_id, token FROM daily
     WHERE $3::text IS NULL OR token = $3
),
days AS (
    SELECT gs::date AS day FROM generate_series($4::date, $5::date, interval '1 day') AS gs
),
grid AS (
    SELECT k.network, k.contract_id, k.token, d.day,
           COALESCE(t.inflow, 0) AS inflow,
           COALESCE(t.spend, 0) AS spend,
           COALESCE(t.spend_count, 0) AS spend_count,
           (SELECT COALESCE(SUM(f.inflow - f.spend), 0) FROM daily f
             WHERE f.network = k.network AND f.contract_id = k.contract_id
               AND f.token = k.token AND f.day <= d.day) AS balance,
           (SELECT COALESCE(SUM(f.spend - f.inflow), 0) FROM daily f
             WHERE f.network = k.network AND f.contract_id = k.contract_id
               AND f.token = k.token AND f.day > d.day - $6::int AND f.day <= d.day)
             / $6::int AS net_burn_rate
      FROM keys k CROSS JOIN days d
      LEFT JOIN daily t ON t.network = k.network AND t.contract_id = k.contract_id
                       AND t.token = k.token AND t.day = d.day
)
INSERT INTO treasury_kpi_snapshots
    (network, contract_id, token, snapshot_date, balance, inflow, spend, spend_count,
     net_burn_rate, runway_days)
SELECT network, contract_id, token, day, balance, inflow, spend, spend_count, net_burn_rate,
       CASE WHEN net_burn_rate > 0 AND balance > 0 THEN ROUND(balance / net_burn_rate, 2) END
  FROM grid
ON CONFLICT (network, contract_id, token, snapshot_date) DO UPDATE SET
    balance = EXCLUDED.balance, inflow = EXCLUDED.inflow, spend = EXCLUDED.spend,
    spend_count = EXCLUDED.spend_count, net_burn_rate = EXCLUDED.net_burn_rate,
    runway_days = EXCLUDED.runway_days, computed_at = NOW()";

#[derive(Debug)]
struct KpiQuery {
    token: Option<String>,
    period_days: i64,
    end: NaiveDate,
    limit: i64,
    offset: i64,
    scope: RequestScope,
}

#[derive(Debug, sqlx::FromRow)]
struct SnapshotRow {
    network: String,
    contract_id: String,
    token: String,
    snapshot_date: NaiveDate,
    balance: String,
    inflow: String,
    spend: String,
    spend_count: i64,
    net_burn_rate: String,
    runway_days: Option<f64>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    network: String,
    contract_id: String,
    token: String,
    date: NaiveDate,
    balance: String,
    inflow: String,
    spend: String,
    spend_count: i64,
    net_burn_rate: String,
    runway_days: Option<f64>,
}

impl From<SnapshotRow> for Snapshot {
    fn from(row: SnapshotRow) -> Self {
        Self {
            network: row.network,
            contract_id: row.contract_id,
            token: row.token,
            date: row.snapshot_date,
            balance: row.balance,
            inflow: row.inflow,
            spend: row.spend,
            spend_count: row.spend_count,
            net_burn_rate: row.net_burn_rate,
            runway_days: row.runway_days,
        }
    }
}

/// Per-token period-over-period aggregates, as the database returns them.
#[derive(Debug, sqlx::FromRow)]
struct TrendRow {
    token: String,
    balance_current: String,
    balance_previous: String,
    balance_delta: String,
    spend_current: String,
    spend_previous: String,
    spend_delta: String,
    burn_current: String,
    burn_previous: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Metric {
    current: String,
    previous: String,
    delta: String,
    /// Percentage change; `null` when the previous period was zero.
    delta_percent: Option<f64>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Runway {
    current_days: Option<f64>,
    previous_days: Option<f64>,
    delta_days: Option<f64>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TokenTrend {
    token: String,
    balance: Metric,
    spend: Metric,
    runway: Runway,
}

#[derive(Serialize)]
pub(crate) struct Period {
    start: NaiveDate,
    end: NaiveDate,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KpiPage {
    period_days: i64,
    current_period: Period,
    previous_period: Period,
    trends: Vec<TokenTrend>,
    items: Vec<Snapshot>,
    total: i64,
    limit: i64,
    offset: i64,
}

fn num(text: &str) -> f64 {
    text.parse().unwrap_or(0.0)
}

fn metric(current: String, previous: String, delta: String) -> Metric {
    Metric {
        delta_percent: http_cache::percent_change(num(&current), num(&previous)),
        current,
        previous,
        delta,
    }
}

/// Days of runway at a net burn rate; `None` unless burning with a balance.
fn runway_days(balance: f64, burn: f64) -> Option<f64> {
    (balance > 0.0 && burn > 0.0).then(|| (balance / burn * 100.0).round() / 100.0)
}

impl From<TrendRow> for TokenTrend {
    fn from(row: TrendRow) -> Self {
        let current = runway_days(num(&row.balance_current), num(&row.burn_current));
        let previous = runway_days(num(&row.balance_previous), num(&row.burn_previous));
        Self {
            token: row.token,
            balance: metric(row.balance_current, row.balance_previous, row.balance_delta),
            spend: metric(row.spend_current, row.spend_previous, row.spend_delta),
            runway: Runway {
                current_days: current,
                previous_days: previous,
                delta_days: current
                    .zip(previous)
                    .map(|(now, before)| ((now - before) * 100.0).round() / 100.0),
            },
        }
    }
}

pub(crate) async fn list(
    State(state): State<AppState>,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    let query = parse_query(raw, &state.scope)
        .map_err(|details| (StatusCode::BAD_REQUEST, Json(ApiError::invalid(details))))?;
    let days = Duration::days(query.period_days);
    let current_start = query.end - days;
    let previous_end = current_start;
    let previous_start = previous_end - days;

    sqlx::query(REFRESH_SQL)
        .bind(&query.scope.networks)
        .bind(&query.scope.contract_ids)
        .bind(query.token.as_deref())
        .bind(previous_end)
        .bind(query.end)
        .bind(BURN_WINDOW_DAYS)
        .execute(&state.pool)
        .await
        .map_err(internal_error)?;

    // Balance and burn are point-in-time, so each period is read at its last
    // day; spend is a flow, summed over the days inside the period.
    let mut trends = QueryBuilder::<Postgres>::new("SELECT token, ");
    for (column, alias) in [("balance", "balance"), ("net_burn_rate", "burn")] {
        for (suffix, day) in [("current", query.end), ("previous", previous_end)] {
            trends
                .push(format!(
                    "COALESCE(SUM({column}) FILTER (WHERE snapshot_date = "
                ))
                .push_bind(day)
                .push(format!("), 0)::text AS {alias}_{suffix}, "));
        }
    }
    trends
        .push("COALESCE(SUM(spend) FILTER (WHERE snapshot_date > ")
        .push_bind(current_start)
        .push("), 0)::text AS spend_current, ")
        .push("COALESCE(SUM(spend) FILTER (WHERE snapshot_date <= ")
        .push_bind(previous_end)
        .push("), 0)::text AS spend_previous, ")
        .push("(COALESCE(SUM(balance) FILTER (WHERE snapshot_date = ")
        .push_bind(query.end)
        .push("), 0) - COALESCE(SUM(balance) FILTER (WHERE snapshot_date = ")
        .push_bind(previous_end)
        .push("), 0))::text AS balance_delta, ")
        .push("(COALESCE(SUM(spend) FILTER (WHERE snapshot_date > ")
        .push_bind(current_start)
        .push("), 0) - COALESCE(SUM(spend) FILTER (WHERE snapshot_date <= ")
        .push_bind(previous_end)
        .push("), 0))::text AS spend_delta ")
        .push("FROM treasury_kpi_snapshots WHERE snapshot_date > ")
        .push_bind(previous_start)
        .push(" AND snapshot_date <= ")
        .push_bind(query.end);
    push_filters(&mut trends, &query);
    trends.push(" GROUP BY token ORDER BY token");
    let trends: Vec<TokenTrend> = trends
        .build_query_as::<TrendRow>()
        .fetch_all(&state.pool)
        .await
        .map_err(internal_error)?
        .into_iter()
        .map(TokenTrend::from)
        .collect();

    let mut count = QueryBuilder::<Postgres>::new(
        "SELECT COUNT(*) FROM treasury_kpi_snapshots WHERE snapshot_date > ",
    );
    count
        .push_bind(current_start)
        .push(" AND snapshot_date <= ")
        .push_bind(query.end);
    push_filters(&mut count, &query);
    let total: i64 = count
        .build_query_scalar()
        .fetch_one(&state.pool)
        .await
        .map_err(internal_error)?;

    let mut rows = QueryBuilder::<Postgres>::new(
        "SELECT network, contract_id, token, snapshot_date, balance::text AS balance, \
         inflow::text AS inflow, spend::text AS spend, spend_count, \
         net_burn_rate::text AS net_burn_rate, runway_days::float8 AS runway_days \
         FROM treasury_kpi_snapshots WHERE snapshot_date > ",
    );
    rows.push_bind(current_start)
        .push(" AND snapshot_date <= ")
        .push_bind(query.end);
    push_filters(&mut rows, &query);
    rows.push(" ORDER BY snapshot_date DESC, token ASC, network ASC, contract_id ASC LIMIT ")
        .push_bind(query.limit)
        .push(" OFFSET ")
        .push_bind(query.offset);
    let items: Vec<Snapshot> = rows
        .build_query_as::<SnapshotRow>()
        .fetch_all(&state.pool)
        .await
        .map_err(internal_error)?
        .into_iter()
        .map(Snapshot::from)
        .collect();

    Ok(http_cache::json(KpiPage {
        period_days: query.period_days,
        current_period: Period {
            start: current_start + Duration::days(1),
            end: query.end,
        },
        previous_period: Period {
            start: previous_start + Duration::days(1),
            end: previous_end,
        },
        trends,
        items,
        total,
        limit: query.limit,
        offset: query.offset,
    }))
}

fn push_filters<'a>(builder: &mut QueryBuilder<'a, Postgres>, query: &'a KpiQuery) {
    push_scope(builder, "", &query.scope);
    if let Some(token) = query.token.as_deref() {
        builder.push(" AND token = ").push_bind(token);
    }
}

fn parse_query(
    raw: HashMap<String, String>,
    config: &ScopeConfig,
) -> Result<KpiQuery, Vec<ErrorDetail>> {
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
    let today = Utc::now().date_naive();
    let end = proposals::parse_date(&raw, "endDate", true, &mut details)
        .map_or(today, |end| end.date_naive().min(today));
    let limit = proposals::parse_integer(&raw, "limit", 20, 1, 100, &mut details);
    let offset = proposals::parse_integer(&raw, "offset", 0, 0, i64::MAX, &mut details);
    let scope = config.resolve(&raw, &mut details);

    if !details.is_empty() {
        return Err(details);
    }
    Ok(KpiQuery {
        token: proposals::nonempty(&raw, "token"),
        period_days,
        end,
        limit,
        offset,
        scope,
    })
}

fn internal_error(error: sqlx::Error) -> (StatusCode, Json<ApiError>) {
    tracing::error!(%error, "failed to compute treasury KPI snapshots");
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
    fn defaults_to_a_thirty_day_period_ending_today() {
        let query = parse_query(HashMap::new(), &scope()).unwrap();
        assert_eq!(query.period_days, 30);
        assert_eq!(query.end, Utc::now().date_naive());
        assert_eq!(query.limit, 20);
    }

    #[test]
    fn rejects_out_of_range_periods() {
        let details = parse_query(raw(&[("periodDays", "366")]), &scope()).unwrap_err();
        assert_eq!(details[0].code, "INVALID_PERIOD_DAYS");
    }

    #[test]
    fn deltas_compare_current_with_previous() {
        let trend = TokenTrend::from(TrendRow {
            token: "USDC".into(),
            balance_current: "900".into(),
            balance_previous: "1000".into(),
            balance_delta: "-100".into(),
            spend_current: "300".into(),
            spend_previous: "200".into(),
            spend_delta: "100".into(),
            burn_current: "10".into(),
            burn_previous: "5".into(),
        });
        assert_eq!(trend.balance.delta_percent, Some(-10.0));
        assert_eq!(trend.spend.delta_percent, Some(50.0));
        assert_eq!(trend.runway.current_days, Some(90.0));
        assert_eq!(trend.runway.previous_days, Some(200.0));
        assert_eq!(trend.runway.delta_days, Some(-110.0));
    }

    #[test]
    fn an_empty_previous_period_has_no_percentage() {
        let trend = TokenTrend::from(TrendRow {
            token: "XLM".into(),
            balance_current: "10".into(),
            balance_previous: "0".into(),
            balance_delta: "10".into(),
            spend_current: "0".into(),
            spend_previous: "0".into(),
            spend_delta: "0".into(),
            burn_current: "0".into(),
            burn_previous: "0".into(),
        });
        assert_eq!(trend.balance.delta_percent, None);
        assert_eq!(trend.runway.current_days, None);
        assert_eq!(trend.runway.delta_days, None);
    }
}
