//! `GET /freshness` — data freshness against service level objectives.
//!
//! For every (network, contract) in scope: how far ingestion lags (the age of
//! the indexer's checkpoint) and how old the last treasury report is, each
//! judged against an SLO. The API's own request latency (process-wide, since
//! start) is judged against its SLO too. Live health, so it is not cached.

use std::{collections::HashMap, env};

use axum::{Json, extract::State, http::StatusCode};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{QueryBuilder, postgres::Postgres};

use crate::{
    AppState, metrics,
    proposals::{self, ApiError},
    scope::push_scope,
};

/// Query parameters `GET /freshness` accepts.
pub(crate) const QUERY_PARAMS: &[&str] = &["limit", "offset", "contractId", "network"];

/// The objectives, from `SLO_*` environment variables.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Slo {
    ingestion_lag_seconds: u64,
    api_p95_ms: u64,
    report_max_age_seconds: u64,
}

impl Slo {
    pub(crate) fn from_env() -> Self {
        let read = |name: &str, default: u64| {
            env::var(name)
                .ok()
                .and_then(|value| value.trim().parse::<u64>().ok())
                .filter(|value| *value > 0)
                .unwrap_or(default)
        };
        Self {
            ingestion_lag_seconds: read("SLO_INGESTION_LAG_SECS", 120),
            api_p95_ms: read("SLO_API_P95_MS", 500),
            report_max_age_seconds: read("SLO_REPORT_MAX_AGE_SECS", 32 * 86_400),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Status {
    Ok,
    Breach,
    /// Nothing to judge yet: no checkpoint, no report, no requests.
    Unknown,
}

fn judge(value: Option<f64>, limit: f64) -> Status {
    match value {
        None => Status::Unknown,
        Some(value) if value <= limit => Status::Ok,
        Some(_) => Status::Breach,
    }
}

/// The worst of several statuses: any breach wins, then unknown.
fn worst(statuses: impl IntoIterator<Item = Status>) -> Status {
    let mut result = Status::Ok;
    for status in statuses {
        match status {
            Status::Breach => return Status::Breach,
            Status::Unknown => result = Status::Unknown,
            Status::Ok => {}
        }
    }
    result
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiLatency {
    requests: u64,
    p50_ms: Option<f64>,
    p95_ms: Option<f64>,
    status: Status,
}

fn api_latency(summary: &metrics::LatencySummary, slo: &Slo) -> ApiLatency {
    let p95_ms = summary.p95_seconds.map(|seconds| seconds * 1000.0);
    ApiLatency {
        requests: summary.requests,
        p50_ms: summary.p50_seconds.map(|seconds| seconds * 1000.0),
        p95_ms,
        status: judge(p95_ms, slo.api_p95_ms as f64),
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FreshnessItem {
    network: String,
    contract_id: String,
    last_ledger: Option<i64>,
    last_checkpoint_at: Option<DateTime<Utc>>,
    ingestion_lag_seconds: Option<f64>,
    ingestion_status: Status,
    last_report_at: Option<DateTime<Utc>>,
    report_age_seconds: Option<f64>,
    report_status: Status,
    status: Status,
}

fn item(
    network: &str,
    contract_id: &str,
    checkpoint: Option<(i64, DateTime<Utc>)>,
    last_report_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
    slo: &Slo,
) -> FreshnessItem {
    let age = |at: DateTime<Utc>| ((now - at).num_milliseconds() as f64 / 1000.0).max(0.0);
    let ingestion_lag_seconds = checkpoint.map(|(_, at)| age(at));
    let report_age_seconds = last_report_at.map(age);
    let ingestion_status = judge(ingestion_lag_seconds, slo.ingestion_lag_seconds as f64);
    let report_status = judge(report_age_seconds, slo.report_max_age_seconds as f64);
    FreshnessItem {
        network: network.to_owned(),
        contract_id: contract_id.to_owned(),
        last_ledger: checkpoint.map(|(ledger, _)| ledger),
        last_checkpoint_at: checkpoint.map(|(_, at)| at),
        ingestion_lag_seconds,
        ingestion_status,
        last_report_at,
        report_age_seconds,
        report_status,
        status: worst([ingestion_status, report_status]),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FreshnessPage {
    generated_at: DateTime<Utc>,
    slo: Slo,
    /// The worst status across the API and every item (not only this page).
    status: Status,
    api: ApiLatency,
    items: Vec<FreshnessItem>,
    total: i64,
    limit: i64,
    offset: i64,
}

type ApiResult<T> = Result<T, (StatusCode, Json<ApiError>)>;

pub(crate) async fn get(
    State(state): State<AppState>,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Json<FreshnessPage>> {
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
    let limit = proposals::parse_integer(&raw, "limit", 20, 1, 100, &mut details);
    let offset = proposals::parse_integer(&raw, "offset", 0, 0, i64::MAX, &mut details);
    let scope = state.scope.resolve(&raw, &mut details);
    if !details.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(ApiError::invalid(details))));
    }
    let fail = |error: sqlx::Error| {
        tracing::error!(%error, "failed to read data freshness");
        proposals::internal_error(error)
    };

    let mut checkpoints = QueryBuilder::<Postgres>::new(
        "SELECT network, contract_id, last_ledger, updated_at FROM checkpoints WHERE TRUE",
    );
    push_scope(&mut checkpoints, "", &scope);
    let checkpoints: HashMap<(String, String), (i64, DateTime<Utc>)> = checkpoints
        .build_query_as::<(String, String, i64, DateTime<Utc>)>()
        .fetch_all(&state.pool)
        .await
        .map_err(fail)?
        .into_iter()
        .map(|(network, contract, ledger, at)| ((network, contract), (ledger, at)))
        .collect();

    let mut reports = QueryBuilder::<Postgres>::new(
        "SELECT network, contract_id, MAX(COALESCE(delivered_at, created_at)) FROM report_runs \
         WHERE status IN ('generated', 'delivered')",
    );
    push_scope(&mut reports, "", &scope);
    reports.push(" GROUP BY network, contract_id");
    let reports: HashMap<(String, String), DateTime<Utc>> = reports
        .build_query_as::<(String, String, Option<DateTime<Utc>>)>()
        .fetch_all(&state.pool)
        .await
        .map_err(fail)?
        .into_iter()
        .filter_map(|(network, contract, at)| at.map(|at| ((network, contract), at)))
        .collect();

    let slo = Slo::from_env();
    let now = Utc::now();
    let pairs: Vec<(String, String)> = scope
        .networks
        .iter()
        .flat_map(|network| {
            scope
                .contract_ids
                .iter()
                .map(move |contract| (network.clone(), contract.clone()))
        })
        .collect();
    let all: Vec<FreshnessItem> = pairs
        .iter()
        .map(|pair| {
            item(
                &pair.0,
                &pair.1,
                checkpoints.get(pair).copied(),
                reports.get(pair).copied(),
                now,
                &slo,
            )
        })
        .collect();

    let api = api_latency(&metrics::registry().latency_summary(), &slo);
    let status = worst(std::iter::once(api.status).chain(all.iter().map(|item| item.status)));
    let total = all.len() as i64;
    let items = all
        .into_iter()
        .skip(usize::try_from(offset).unwrap_or(usize::MAX))
        .take(usize::try_from(limit).unwrap_or(0))
        .collect();
    Ok(Json(FreshnessPage {
        generated_at: now,
        slo,
        status,
        api,
        items,
        total,
        limit,
        offset,
    }))
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, TimeZone};

    use super::*;

    const SLO: Slo = Slo {
        ingestion_lag_seconds: 120,
        api_p95_ms: 500,
        report_max_age_seconds: 86_400,
    };

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 19, 12, 0, 0).unwrap()
    }

    #[test]
    fn fresh_data_meets_its_objectives() {
        let row = item(
            "testnet",
            "C1",
            Some((900, now() - Duration::seconds(30))),
            Some(now() - Duration::hours(2)),
            now(),
            &SLO,
        );

        assert_eq!(row.ingestion_lag_seconds, Some(30.0));
        assert_eq!(row.last_ledger, Some(900));
        assert_eq!(row.status, Status::Ok);
    }

    #[test]
    fn a_stale_checkpoint_or_report_is_a_breach() {
        let lagging = item("n", "c", Some((1, now() - Duration::seconds(121))), Some(now()), now(), &SLO);
        assert_eq!(lagging.ingestion_status, Status::Breach);
        assert_eq!(lagging.report_status, Status::Ok);
        assert_eq!(lagging.status, Status::Breach);

        let old_report = item("n", "c", Some((1, now())), Some(now() - Duration::days(2)), now(), &SLO);
        assert_eq!(old_report.report_status, Status::Breach);
    }

    #[test]
    fn missing_data_is_unknown_not_ok() {
        let row = item("n", "c", None, None, now(), &SLO);

        assert_eq!(row.ingestion_status, Status::Unknown);
        assert_eq!(row.status, Status::Unknown);
        assert_eq!(row.last_checkpoint_at, None);
        let mixed = item("n", "c", None, Some(now() - Duration::days(9)), now(), &SLO);
        assert_eq!(mixed.status, Status::Breach, "a breach outranks unknown");
    }

    #[test]
    fn a_future_timestamp_never_gives_a_negative_lag() {
        let row = item("n", "c", Some((1, now() + Duration::seconds(5))), None, now(), &SLO);

        assert_eq!(row.ingestion_lag_seconds, Some(0.0));
    }

    #[test]
    fn api_latency_is_judged_by_p95() {
        let slow = metrics::LatencySummary { requests: 10, p50_seconds: Some(0.1), p95_seconds: Some(1.0) };
        let fast = metrics::LatencySummary { requests: 10, p50_seconds: Some(0.01), p95_seconds: Some(0.25) };
        let none = metrics::LatencySummary { requests: 0, p50_seconds: None, p95_seconds: None };

        assert_eq!(api_latency(&slow, &SLO).status, Status::Breach);
        assert_eq!(api_latency(&fast, &SLO).status, Status::Ok);
        assert_eq!(api_latency(&fast, &SLO).p95_ms, Some(250.0));
        assert_eq!(api_latency(&none, &SLO).status, Status::Unknown);
    }
}
