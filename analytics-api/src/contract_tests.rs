//! Contract tests for the HTTP API.
//!
//! `docs/analytics-api.openapi.json` is the published contract. The tests here
//! hold the implementation to it in both directions: the spec is checked against
//! the router and the parameter validators (so it cannot drift), and the
//! endpoints are exercised for pagination, filtering, sorting and invalid input.
//!
//! Tests that need data run against the database named by `TEST_DATABASE_URL`
//! (each in its own schema) and are skipped when it is not set.

use std::{
    collections::{BTreeSet, HashSet},
    str::FromStr,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::Value;
use sqlx::{
    PgPool,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use tower::ServiceExt;

use crate::{
    AppState, ReportConfig, ScopeConfig, alert_api, alert_rules,
    alerts::{
        Alert, AlertChannel, AlertEngine, AlertRuntime, ChannelFuture, StormSettings, Watcher,
        parse_rules,
    },
    app,
    limits::{Limits, LimitsConfig},
    funnel, proposals, report_api, spend, templates,
};

const SPEC: &str = include_str!("../../docs/analytics-api.openapi.json");
const MAIN_SOURCE: &str = include_str!("main.rs");

fn spec() -> Value {
    serde_json::from_str(SPEC).expect("the OpenAPI spec must be valid JSON")
}

fn scope() -> ScopeConfig {
    ScopeConfig::new(
        vec!["test-contract".to_owned(), "other-contract".to_owned()],
        vec!["testnet".to_owned()],
    )
}

fn lazy_state() -> AppState {
    AppState::with_scope(
        PgPoolOptions::new()
            .connect_lazy("postgres://accord:accord@localhost/accord_analytics")
            .unwrap(),
        scope(),
        Arc::new(ReportConfig::disabled()),
        None,
    )
}

async fn request(
    state: &AppState,
    method: &str,
    uri: &str,
) -> (StatusCode, axum::http::HeaderMap, Value) {
    let response = app(state.clone())
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json = serde_json::from_slice(&body).unwrap_or(Value::Null);
    (status, headers, json)
}

async fn get(state: &AppState, uri: &str) -> (StatusCode, Value) {
    let (status, _, json) = request(state, "GET", uri).await;
    (status, json)
}

/// Every `(method, path)` the spec documents.
fn spec_operations() -> BTreeSet<(String, String)> {
    let spec = spec();
    spec["paths"]
        .as_object()
        .unwrap()
        .iter()
        .flat_map(|(path, item)| {
            item.as_object()
                .unwrap()
                .keys()
                .map(|method| (method.to_uppercase(), path.clone()))
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Every `(method, path)` registered in `fn app`, read from the source so a new
/// route cannot be added without documenting it.
fn router_operations() -> BTreeSet<(String, String)> {
    let start = MAIN_SOURCE.find("fn app(state: AppState)").unwrap();
    let body = &MAIN_SOURCE[start..];
    let body = &body[..body.find(".with_state(state)").unwrap()];

    let mut operations = BTreeSet::new();
    for chunk in body.split(".route(").skip(1) {
        let path_start = chunk.find('"').unwrap() + 1;
        let path = &chunk[path_start..path_start + chunk[path_start..].find('"').unwrap()];
        let after = &chunk[path_start + path.len()..];
        // A route can chain several methods: `get(..).put(..).delete(..)`.
        for method in ["get", "post", "put", "delete"] {
            let call = format!("{method}(");
            let registered = after.match_indices(&call).any(|(index, _)| {
                after[..index]
                    .chars()
                    .next_back()
                    .is_none_or(|before| before == ' ' || before == '.')
            });
            if registered {
                operations.insert((method.to_uppercase(), path.to_owned()));
            }
        }
        assert!(
            operations.iter().any(|(_, known)| known == path),
            "{path} registers no method"
        );
    }
    operations
}

fn query_parameters(spec: &Value, path: &str, method: &str) -> Vec<Value> {
    spec["paths"][path][method]["parameters"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|parameter| parameter["in"] == "query")
        .collect()
}

fn names(parameters: &[Value]) -> BTreeSet<String> {
    parameters
        .iter()
        .map(|parameter| parameter["name"].as_str().unwrap().to_owned())
        .collect()
}

fn enum_of(spec: &Value, path: &str, method: &str, parameter: &str) -> Vec<String> {
    query_parameters(spec, path, method)
        .into_iter()
        .find(|candidate| candidate["name"] == parameter)
        .unwrap_or_else(|| panic!("{path} documents no {parameter} parameter"))["schema"]["enum"]
        .as_array()
        .unwrap_or_else(|| panic!("{path} {parameter} documents no enum"))
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect()
}

fn collect_refs(value: &Value, refs: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, item) in map {
                if key == "$ref" {
                    refs.push(item.as_str().unwrap().to_owned());
                } else {
                    collect_refs(item, refs);
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|item| collect_refs(item, refs)),
        _ => {}
    }
}

// --- the spec is well formed and in sync -----------------------------------

#[test]
fn openapi_spec_is_well_formed() {
    let spec = spec();
    assert_eq!(spec["openapi"], "3.0.3");
    assert!(spec["info"]["title"].is_string() && spec["info"]["version"].is_string());

    let mut refs = Vec::new();
    collect_refs(&spec, &mut refs);
    assert!(!refs.is_empty());
    for reference in refs {
        let pointer = reference
            .strip_prefix('#')
            .expect("only local $refs are used");
        assert!(
            spec.pointer(pointer).is_some(),
            "unresolved $ref {reference}"
        );
    }

    let mut operation_ids = HashSet::new();
    for (path, item) in spec["paths"].as_object().unwrap() {
        for (method, operation) in item.as_object().unwrap() {
            let id = operation["operationId"].as_str().unwrap_or_else(|| {
                panic!("{method} {path} has no operationId");
            });
            assert!(
                operation_ids.insert(id.to_owned()),
                "duplicate operationId {id}"
            );
            assert!(
                operation["responses"]
                    .as_object()
                    .is_some_and(|r| !r.is_empty()),
                "{method} {path} documents no responses"
            );
        }
    }
}

#[test]
fn openapi_paths_match_the_router() {
    assert_eq!(
        spec_operations(),
        router_operations(),
        "docs/analytics-api.openapi.json and the routes in main.rs have drifted; update the spec"
    );
}

#[test]
fn openapi_query_parameters_match_the_validators() {
    let spec = spec();
    for (path, method, accepted) in [
        ("/proposals", "get", proposals::QUERY_PARAMS),
        ("/proposals/{id}", "get", proposals::DETAIL_PARAMS),
        ("/proposals/funnel", "get", funnel::QUERY_PARAMS),
        ("/spend/by-category", "get", spend::QUERY_PARAMS),
        ("/reports", "get", report_api::LIST_PARAMS),
        ("/reports/run", "post", report_api::RUN_PARAMS),
        ("/report-templates", "get", templates::LIST_PARAMS),
        ("/report-templates", "put", templates::WRITE_PARAMS),
        ("/report-templates", "delete", templates::WRITE_PARAMS),
        ("/alert-rules", "get", alert_rules::LIST_PARAMS),
        ("/alert-rules/test", "post", alert_rules::TEST_PARAMS),
        ("/alert-rules/{id}/test", "post", alert_rules::TEST_PARAMS),
        ("/alerts", "get", alert_api::QUERY_PARAMS),
    ] {
        let documented = names(&query_parameters(&spec, path, method));
        let implemented: BTreeSet<String> =
            accepted.iter().map(|name| (*name).to_owned()).collect();
        assert_eq!(
            documented, implemented,
            "{method} {path} parameters have drifted"
        );
    }
}

#[test]
fn openapi_enumerations_match_the_validators() {
    let spec = spec();
    let with_all = |values: &[&str]| -> Vec<String> {
        std::iter::once("all")
            .chain(values.iter().copied())
            .map(str::to_owned)
            .collect()
    };

    assert_eq!(
        enum_of(&spec, "/proposals", "get", "status"),
        with_all(proposals::STATUSES)
    );
    assert_eq!(
        enum_of(&spec, "/proposals", "get", "category"),
        with_all(proposals::CATEGORIES)
    );
    assert_eq!(
        enum_of(&spec, "/proposals", "get", "sort"),
        ["deadline", "amount", "createdAt"]
    );
    assert_eq!(
        enum_of(&spec, "/proposals", "get", "order"),
        ["asc", "desc"]
    );
    assert_eq!(
        enum_of(&spec, "/proposals/funnel", "get", "groupBy"),
        funnel::GROUP_BY
    );
    assert_eq!(
        enum_of(&spec, "/proposals/funnel", "get", "category"),
        proposals::CATEGORIES
    );
    assert_eq!(
        enum_of(&spec, "/reports", "get", "status"),
        report_api::STATUSES
    );
    assert_eq!(
        enum_of(&spec, "/alerts", "get", "severity"),
        alert_api::SEVERITIES
    );
    for (parameter, implemented) in [
        ("status", alert_rules::STATUSES),
        ("type", alert_rules::KINDS),
        ("category", alert_rules::CATEGORIES),
        ("source", alert_rules::SOURCES),
        ("severity", alert_rules::SEVERITIES),
    ] {
        assert_eq!(
            enum_of(&spec, "/alert-rules", "get", parameter),
            implemented,
            "/alert-rules {parameter}"
        );
    }
}

#[test]
fn openapi_pagination_bounds_match_the_validators() {
    let spec = spec();
    for (path, method) in [
        ("/proposals", "get"),
        ("/proposals/funnel", "get"),
        ("/reports", "get"),
        ("/report-templates", "get"),
        ("/alert-rules", "get"),
        ("/alerts", "get"),
    ] {
        let parameters = query_parameters(&spec, path, method);
        let limit = parameters.iter().find(|p| p["name"] == "limit").unwrap();
        let offset = parameters.iter().find(|p| p["name"] == "offset").unwrap();
        assert_eq!(limit["schema"]["minimum"], 1);
        assert_eq!(limit["schema"]["maximum"], 100);
        assert_eq!(limit["schema"]["default"], 20);
        assert_eq!(offset["schema"]["minimum"], 0);
        assert_eq!(offset["schema"]["default"], 0);
    }
}

// --- invalid parameters are handled as documented --------------------------

fn expand(path: &str, value: &str) -> String {
    path.replace("{id}", value)
}

#[tokio::test]
async fn every_documented_invalid_parameter_is_rejected_with_its_code() {
    let state = lazy_state();
    let spec = spec();
    let mut checked = 0;

    for (method, path) in spec_operations() {
        let lower = method.to_lowercase();
        for parameter in spec["paths"][&path][&lower]["parameters"]
            .as_array()
            .into_iter()
            .flatten()
        {
            let (Some(code), Some(example)) = (
                parameter["x-error-code"].as_str(),
                parameter["x-invalid-example"].as_str(),
            ) else {
                continue;
            };
            let name = parameter["name"].as_str().unwrap();

            if parameter["in"] == "path" {
                let (status, _, body) = request(&state, &method, &expand(&path, example)).await;
                assert_eq!(status, StatusCode::BAD_REQUEST, "{method} {path} {name}");
                assert_eq!(body["error"]["code"], code, "{method} {path} {name}");
            } else {
                let uri = format!("{}?{name}={example}", expand(&path, "1"));
                let (status, _, body) = request(&state, &method, &uri).await;
                assert_eq!(status, StatusCode::BAD_REQUEST, "{method} {uri}");
                assert_eq!(body["error"]["code"], "VALIDATION_ERROR", "{method} {uri}");
                let details = body["error"]["details"].as_array().unwrap();
                assert!(
                    details
                        .iter()
                        .any(|d| d["field"] == name && d["code"] == code),
                    "{method} {uri} did not report {code} for {name}: {body}"
                );
            }
            checked += 1;
        }
    }
    assert!(
        checked >= 20,
        "only {checked} documented invalid parameters were exercised"
    );
}

#[tokio::test]
async fn unknown_parameters_are_rejected_on_every_endpoint_with_parameters() {
    let state = lazy_state();
    for (method, path) in [
        ("GET", "/proposals"),
        ("GET", "/proposals/1"),
        ("GET", "/proposals/funnel"),
        ("GET", "/spend/by-category"),
        ("GET", "/reports"),
        ("POST", "/reports/run"),
        ("GET", "/report-templates"),
        ("PUT", "/report-templates"),
        ("DELETE", "/report-templates"),
        ("GET", "/alert-rules"),
        ("POST", "/alert-rules"),
        ("POST", "/alert-rules/test"),
        ("GET", "/alert-rules/x"),
        ("PUT", "/alert-rules/x"),
        ("DELETE", "/alert-rules/x"),
        ("POST", "/alert-rules/x/pause"),
        ("POST", "/alert-rules/x/resume"),
        ("POST", "/alert-rules/x/test"),
        ("GET", "/alerts"),
        ("GET", "/owners/participation"),
    ] {
        let (status, _, body) = request(&state, method, &format!("{path}?bogus=1")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{method} {path}");
        assert_eq!(
            body["error"]["details"][0]["field"], "bogus",
            "{method} {path}"
        );
        assert_eq!(
            body["error"]["details"][0]["code"], "UNKNOWN_PARAMETER",
            "{method} {path}"
        );
    }
}

#[tokio::test]
async fn every_invalid_parameter_is_reported_not_just_the_first() {
    let (status, body) = get(
        &lazy_state(),
        "/proposals?limit=0&offset=-5&sort=nope&order=sideways&status=bad&category=bad&bogus=1",
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    let codes: BTreeSet<&str> = body["error"]["details"]
        .as_array()
        .unwrap()
        .iter()
        .map(|detail| detail["code"].as_str().unwrap())
        .collect();
    assert_eq!(
        codes,
        BTreeSet::from([
            "INVALID_CATEGORY",
            "INVALID_LIMIT",
            "INVALID_OFFSET",
            "INVALID_ORDER",
            "INVALID_SORT",
            "INVALID_STATUS",
            "UNKNOWN_PARAMETER",
        ])
    );
}

#[tokio::test]
async fn pagination_bounds_are_inclusive() {
    // limit 1 and 100 and offset 0 are valid, so these fail later, at the
    // database, with a 500 rather than a 400.
    let state = lazy_state_with_dead_database();
    for uri in [
        "/proposals?limit=1",
        "/proposals?limit=100",
        "/proposals?offset=0",
    ] {
        let (status, _) = get(&state, uri).await;
        assert_ne!(
            status,
            StatusCode::BAD_REQUEST,
            "{uri} should pass validation"
        );
    }
    for uri in [
        "/proposals?limit=0",
        "/proposals?limit=101",
        "/proposals?offset=-1",
    ] {
        let (status, _) = get(&state, uri).await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "{uri} should fail validation"
        );
    }
}

#[tokio::test]
async fn an_inverted_date_range_is_rejected() {
    let (status, body) = get(
        &lazy_state(),
        "/proposals?startDate=2026-09-27&endDate=2026-09-26",
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["details"][0]["code"], "INVALID_DATE_RANGE");
}

#[tokio::test]
async fn the_error_envelope_has_one_shape() {
    let (_, body) = get(&lazy_state(), "/proposals?limit=0").await;

    assert!(body["error"]["code"].is_string());
    assert!(body["error"]["message"].is_string());
    for detail in body["error"]["details"].as_array().unwrap() {
        assert!(detail["field"].is_string());
        assert!(detail["message"].is_string());
        assert!(detail["code"].is_string());
    }
}

#[tokio::test]
async fn documented_error_codes_cover_what_the_validators_emit() {
    let spec = spec();
    let documented: HashSet<String> =
        spec["components"]["schemas"]["ErrorDetail"]["properties"]["code"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .map(|code| code.as_str().unwrap().to_owned())
            .collect();
    let state = lazy_state();
    for uri in [
        "/proposals?limit=0&offset=-1&sort=x&order=x&status=x&category=x&bogus=1&startDate=a&contractId=x&network=x",
        "/proposals?startDate=2026-09-27&endDate=2026-09-26",
        "/proposals/funnel?groupBy=x&category=x&limit=0",
        "/reports?format=x&status=x",
        "/report-templates?limit=0&offset=-1&contractId=x&network=x&bogus=1",
        "/alerts?severity=x",
        "/alert-rules?limit=0&offset=-1&status=x&type=x&category=x&source=x&severity=x&bogus=1",
    ] {
        let (_, body) = get(&state, uri).await;
        for detail in body["error"]["details"].as_array().unwrap() {
            let code = detail["code"].as_str().unwrap();
            assert!(
                documented.contains(code),
                "{code} is not documented ({uri})"
            );
        }
    }
}

fn lazy_state_with_dead_database() -> AppState {
    AppState::with_scope(
        PgPoolOptions::new()
            .acquire_timeout(Duration::from_millis(100))
            .connect_lazy("postgres://accord:accord@127.0.0.1:1/accord_analytics")
            .unwrap(),
        scope(),
        Arc::new(ReportConfig::disabled()),
        None,
    )
}

// --- behaviour against real data -------------------------------------------

const SEED: &str = r#"
INSERT INTO proposals (contract_id, network, proposal_id, kind, recipient, amount, token, status,
                       deadline, created_at, proposer, category, executed_at) VALUES
 ('test-contract', 'testnet', 1, 'transfer', 'GR', '10',  'USDC', 'executed', '2026-09-10T00:00:00Z', '2026-09-01T00:00:00Z', 'GALICE', 'Transfer', '2026-09-09T00:00:00Z'),
 ('test-contract', 'testnet', 2, 'transfer', 'GR', '9',   'XLM',  'pending',  '2026-09-08T00:00:00Z', '2026-09-05T00:00:00Z', 'GBOB',   'Payroll',  NULL),
 ('test-contract', 'testnet', 3, 'transfer', 'GR', '100', 'USDC', 'ready',    '2026-09-20T00:00:00Z', '2026-09-10T00:00:00Z', 'GALICE', 'Grant',    NULL),
 ('test-contract', 'testnet', 4, 'transfer', 'GR', '2',   'XLM',  'executed', '2026-09-16T00:00:00Z', '2026-09-15T00:00:00Z', 'GCAROL', 'Payroll',  '2026-09-15T12:00:00Z'),
 ('test-contract', 'testnet', 5, 'transfer', 'GR', '50',  'XLM',  'expired',  '2026-09-21T00:00:00Z', '2026-09-20T00:00:00Z', 'GBOB',   'Ops',      NULL),
 ('test-contract', 'testnet', 6, 'transfer', 'GR', '7',   'USDC', 'revoked',  '2026-09-30T00:00:00Z', '2026-09-25T00:00:00Z', 'GDAVE',  'Other',    NULL),
 ('other-contract', 'testnet', 1, 'transfer', 'GR', '5',  'XLM',  'pending',  '2026-09-12T00:00:00Z', '2026-09-02T00:00:00Z', 'GEVE',   'Ops',      NULL);

INSERT INTO report_runs (network, contract_id, period_start, period_end, format, trigger_source, status, created_at) VALUES
 ('testnet', 'test-contract', '2026-08-01Z', '2026-09-01Z', 'csv', 'scheduled', 'delivered', '2026-09-01T06:00:00Z'),
 ('testnet', 'test-contract', '2026-08-01Z', '2026-09-01Z', 'pdf', 'scheduled', 'delivered', '2026-09-01T06:00:01Z'),
 ('testnet', 'test-contract', '2026-09-01Z', '2026-10-01Z', 'csv', 'manual',    'failed',    '2026-10-01T06:00:00Z'),
 ('testnet', 'other-contract', '2026-09-01Z', '2026-10-01Z', 'pdf', 'manual',   'generated', '2026-10-01T06:00:01Z');

INSERT INTO alerts (dedupe_key, rule_id, kind, severity, network, contract_id, subject, message, fired_at) VALUES
 ('k1', 'big-spend', 'spend_threshold',  'critical', 'testnet', 'test-contract',  'USDC',  'm1', '2026-09-01T00:00:00Z'),
 ('k2', 'burst',     'approval_burst',   'warning',  'testnet', 'test-contract',  'GALICE','m2', '2026-09-02T00:00:00Z'),
 ('k3', 'night',     'off_hours_approval','info',    'testnet', 'test-contract',  'GBOB',  'm3', '2026-09-03T00:00:00Z'),
 ('k4', 'big-spend', 'spend_threshold',  'critical', 'testnet', 'other-contract', 'XLM',   'm4', '2026-09-04T00:00:00Z');
"#;

/// An isolated, seeded schema on the database named by `TEST_DATABASE_URL`.
struct TestDb {
    admin: PgPool,
    schema: String,
    pool: PgPool,
}

impl TestDb {
    async fn connect(name: &str, seed: bool) -> Option<Self> {
        let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
            eprintln!("skipping {name}: TEST_DATABASE_URL is not set");
            return None;
        };
        let schema = format!("contract_{name}_{}", std::process::id());
        let admin = PgPoolOptions::new().connect(&url).await.unwrap();
        sqlx::query(&format!("DROP SCHEMA IF EXISTS {schema} CASCADE"))
            .execute(&admin)
            .await
            .unwrap();
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&admin)
            .await
            .unwrap();
        let options = PgConnectOptions::from_str(&url)
            .unwrap()
            .options([("search_path", schema.as_str())]);
        let pool = PgPoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        if seed {
            sqlx::raw_sql(SEED).execute(&pool).await.unwrap();
        }
        Some(Self {
            admin,
            schema,
            pool,
        })
    }

    fn state(&self) -> AppState {
        AppState::with_scope(
            self.pool.clone(),
            scope(),
            Arc::new(ReportConfig::disabled()),
            None,
        )
    }

    async fn cleanup(self) {
        self.pool.close().await;
        sqlx::query(&format!("DROP SCHEMA IF EXISTS {} CASCADE", self.schema))
            .execute(&self.admin)
            .await
            .unwrap();
    }
}

fn ids(body: &Value) -> Vec<i64> {
    body["proposals"]
        .as_array()
        .unwrap()
        .iter()
        .map(|proposal| proposal["id"].as_i64().unwrap())
        .collect()
}

#[tokio::test]
async fn proposals_paginate_without_gaps_or_overlap() {
    let Some(db) = TestDb::connect("paginate", true).await else {
        return;
    };
    let state = db.state();

    let (status, first) = get(
        &state,
        "/proposals?contractId=test-contract&sort=createdAt&order=asc",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["total"], 6);
    assert_eq!(first["limit"], 20, "limit defaults to 20");
    assert_eq!(first["offset"], 0, "offset defaults to 0");
    assert_eq!(ids(&first), [1, 2, 3, 4, 5, 6]);

    let mut seen = Vec::new();
    for offset in [0, 2, 4] {
        let (_, page) = get(
            &state,
            &format!("/proposals?contractId=test-contract&sort=createdAt&order=asc&limit=2&offset={offset}"),
        )
        .await;
        assert_eq!(page["total"], 6, "total ignores paging");
        assert_eq!(page["limit"], 2);
        assert_eq!(page["offset"], offset);
        assert_eq!(page["proposals"].as_array().unwrap().len(), 2);
        seen.extend(ids(&page));
    }
    assert_eq!(seen, [1, 2, 3, 4, 5, 6], "pages tile the result exactly");

    let (_, last) = get(
        &state,
        "/proposals?contractId=test-contract&limit=4&offset=4",
    )
    .await;
    assert_eq!(
        last["proposals"].as_array().unwrap().len(),
        2,
        "the last page is short"
    );

    let (status, beyond) = get(&state, "/proposals?contractId=test-contract&offset=100").await;
    assert_eq!(status, StatusCode::OK);
    assert!(beyond["proposals"].as_array().unwrap().is_empty());
    assert_eq!(beyond["total"], 6, "an empty page still reports the total");

    db.cleanup().await;
}

#[tokio::test]
async fn proposals_filter_by_every_documented_field() {
    let Some(db) = TestDb::connect("filter", true).await else {
        return;
    };
    let state = db.state();
    let base = "/proposals?contractId=test-contract&sort=createdAt&order=asc";

    for (filter, expected) in [
        ("status=executed", vec![1, 4]),
        ("status=pending", vec![2]),
        ("status=all", vec![1, 2, 3, 4, 5, 6]),
        ("category=Payroll", vec![2, 4]),
        ("category=all", vec![1, 2, 3, 4, 5, 6]),
        ("token=USDC", vec![1, 3, 6]),
        ("owner=alice", vec![1, 3]),
        ("owner=GB", vec![2, 5]),
        ("startDate=2026-09-10", vec![3, 4, 5, 6]),
        ("endDate=2026-09-10", vec![1, 2, 3]),
        ("startDate=2026-09-05&endDate=2026-09-15", vec![2, 3, 4]),
        ("status=executed&token=XLM", vec![4]),
        ("status=executed&category=Transfer&token=USDC", vec![1]),
        ("status=revoked&token=XLM", vec![]),
    ] {
        let (status, body) = get(&state, &format!("{base}&{filter}")).await;
        assert_eq!(status, StatusCode::OK, "{filter}");
        assert_eq!(ids(&body), expected, "{filter}");
        assert_eq!(
            body["total"],
            expected.len(),
            "{filter}: total counts the filtered set"
        );
    }

    // The same filter on the other contract and with no contractId (both).
    let (_, other) = get(&state, "/proposals?contractId=other-contract").await;
    assert_eq!(ids(&other), [1]);
    let (_, everything) = get(&state, "/proposals").await;
    assert_eq!(everything["total"], 7);

    db.cleanup().await;
}

#[tokio::test]
async fn proposals_sort_in_both_directions_with_a_stable_tiebreak() {
    let Some(db) = TestDb::connect("sort", true).await else {
        return;
    };
    let state = db.state();

    for (sort, order, expected) in [
        ("createdAt", "asc", vec![1, 2, 3, 4, 5, 6]),
        ("createdAt", "desc", vec![6, 5, 4, 3, 2, 1]),
        ("deadline", "asc", vec![2, 1, 4, 3, 5, 6]),
        ("deadline", "desc", vec![6, 5, 3, 4, 1, 2]),
        // Amounts compare as numbers: 100 > 50 > 10 > 9 > 7 > 2, not as text.
        ("amount", "desc", vec![3, 5, 1, 2, 6, 4]),
        ("amount", "asc", vec![4, 6, 2, 1, 5, 3]),
    ] {
        let (status, body) = get(
            &state,
            &format!("/proposals?contractId=test-contract&sort={sort}&order={order}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{sort} {order}");
        assert_eq!(ids(&body), expected, "{sort} {order}");
    }

    // The default is newest first.
    let (_, default) = get(&state, "/proposals?contractId=test-contract").await;
    assert_eq!(ids(&default), [6, 5, 4, 3, 2, 1]);

    // Sorting and paging compose: page two of amount-desc.
    let (_, page) = get(
        &state,
        "/proposals?contractId=test-contract&sort=amount&order=desc&limit=2&offset=2",
    )
    .await;
    assert_eq!(ids(&page), [1, 2]);

    db.cleanup().await;
}

#[tokio::test]
async fn every_documented_enum_value_is_accepted() {
    let Some(db) = TestDb::connect("enums", true).await else {
        return;
    };
    let state = db.state();
    let spec = spec();

    let mut accepted = 0;
    for (path, method) in [
        ("/proposals", "get"),
        ("/reports", "get"),
        ("/alerts", "get"),
    ] {
        for parameter in query_parameters(&spec, path, method) {
            let Some(values) = parameter["schema"]["enum"].as_array() else {
                continue;
            };
            for value in values {
                let uri = format!(
                    "{path}?{}={}",
                    parameter["name"].as_str().unwrap(),
                    value.as_str().unwrap()
                );
                let (status, _) = get(&state, &uri).await;
                assert_eq!(status, StatusCode::OK, "{uri} is documented but rejected");
                accepted += 1;
            }
        }
    }
    assert!(accepted >= 20);

    db.cleanup().await;
}

#[tokio::test]
async fn proposals_response_shape_matches_the_spec() {
    let Some(db) = TestDb::connect("shape", true).await else {
        return;
    };
    let spec = spec();
    let (_, body) = get(&db.state(), "/proposals?limit=1").await;

    let page = &spec["components"]["schemas"];
    for key in ["proposals", "total", "limit", "offset"] {
        assert!(body.get(key).is_some(), "page is missing {key}");
    }
    let documented: BTreeSet<&str> = page["Proposal"]["properties"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    let returned: BTreeSet<&str> = body["proposals"][0]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        returned, documented,
        "Proposal fields drifted from the spec"
    );

    db.cleanup().await;
}

#[tokio::test]
async fn report_runs_paginate_and_filter() {
    let Some(db) = TestDb::connect("reports", true).await else {
        return;
    };
    let state = db.state();

    let (status, all) = get(&state, "/reports").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(all["total"], 4);
    assert_eq!(all["limit"], 20);
    // Newest first.
    let formats: Vec<&str> = all["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["format"].as_str().unwrap())
        .collect();
    assert_eq!(formats, ["pdf", "csv", "pdf", "csv"]);

    let (_, page) = get(&state, "/reports?limit=2&offset=2").await;
    assert_eq!(page["runs"].as_array().unwrap().len(), 2);
    assert_eq!(page["total"], 4);
    assert_eq!(page["runs"][0]["format"], "pdf");

    for (filter, expected) in [
        ("status=delivered", 2),
        ("status=failed", 1),
        ("format=pdf", 2),
        ("format=csv&status=delivered", 1),
        ("contractId=other-contract", 1),
        ("status=generated&format=csv", 0),
    ] {
        let (_, body) = get(&state, &format!("/reports?{filter}")).await;
        assert_eq!(body["total"], expected, "{filter}");
        assert_eq!(body["runs"].as_array().unwrap().len(), expected, "{filter}");
    }

    db.cleanup().await;
}

#[tokio::test]
async fn alerts_paginate_and_filter() {
    let Some(db) = TestDb::connect("alerts", true).await else {
        return;
    };
    let state = db.state();

    let (status, all) = get(&state, "/alerts").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(all["total"], 4);
    let rules: Vec<&str> = all["alerts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["ruleId"].as_str().unwrap())
        .collect();
    assert_eq!(
        rules,
        ["big-spend", "night", "burst", "big-spend"],
        "newest first"
    );

    let (_, page) = get(&state, "/alerts?limit=1&offset=1").await;
    assert_eq!(page["alerts"][0]["ruleId"], "night");
    assert_eq!(page["total"], 4);

    for (filter, expected) in [
        ("severity=critical", 2),
        ("severity=info", 1),
        ("ruleId=big-spend", 2),
        ("ruleId=big-spend&contractId=other-contract", 1),
        ("ruleId=missing", 0),
    ] {
        let (_, body) = get(&state, &format!("/alerts?{filter}")).await;
        assert_eq!(body["total"], expected, "{filter}");
    }

    let (status, rules) = get(&state, "/alerts/rules").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rules["enabled"], false);

    db.cleanup().await;
}

// --- alert evaluation and cache invalidation against the database ----------

struct Recording {
    sent: Arc<Mutex<Vec<String>>>,
}

impl AlertChannel for Recording {
    fn name(&self) -> String {
        "recording".to_owned()
    }

    fn send<'a>(&'a self, alert: &'a Alert) -> ChannelFuture<'a> {
        Box::pin(async move {
            self.sent.lock().unwrap().push(alert.dedupe_key.clone());
            Ok(())
        })
    }
}

const SPEND_RULE: &str = r#"[{"id":"big-spend","type":"spend_threshold","token":"USDC",
    "threshold":"1000","windowSecs":3600,"severity":"critical","cooldownSecs":900}]"#;

fn watcher(
    db: &TestDb,
    rules: &str,
    backfill: bool,
    limits: Arc<Limits>,
) -> (Watcher, Arc<Mutex<Vec<String>>>) {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let engine = Arc::new(AlertEngine::new(
        parse_rules(rules).unwrap(),
        StormSettings::default(),
    ));
    let watcher = Watcher {
        pool: db.pool.clone(),
        pairs: vec![("testnet".to_owned(), "test-contract".to_owned())],
        limits,
        alerts: Some(AlertRuntime {
            engine,
            channels: vec![Arc::new(Recording {
                sent: Arc::clone(&sent),
            })],
            backfill,
        }),
    };
    (watcher, sent)
}

async fn insert_transfer(pool: &PgPool, ledger: i64, amount: &str, token: &str, at: &str) {
    sqlx::query(
        "INSERT INTO transfers (contract_id, recipient, token, amount, ledger, tx_hash, event_index, occurred_at) \
         VALUES ('test-contract', 'GR', $1, $2, $3, $4, 0, $5::timestamptz)",
    )
    .bind(token)
    .bind(amount)
    .bind(ledger)
    .bind(format!("tx{ledger}"))
    .bind(at)
    .execute(pool)
    .await
    .unwrap();
}

async fn alert_count(pool: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM alerts")
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn new_events_raise_alerts_that_are_stored_and_routed() {
    let Some(db) = TestDb::connect("watch_alerts", false).await else {
        return;
    };
    let (watcher, sent) = watcher(&db, SPEND_RULE, true, Arc::new(Limits::disabled()));
    insert_transfer(&db.pool, 10, "600", "USDC", "2026-09-27T09:00:00Z").await;
    insert_transfer(&db.pool, 11, "300", "USDC", "2026-09-27T09:05:00Z").await;

    let mut stamp = None;
    assert_eq!(
        watcher.tick(&mut stamp).await.unwrap(),
        0,
        "900 is under the 1000 threshold"
    );

    insert_transfer(&db.pool, 12, "200", "USDC", "2026-09-27T09:10:00Z").await;
    assert_eq!(watcher.tick(&mut stamp).await.unwrap(), 1);

    let row: (String, String, String) =
        sqlx::query_as("SELECT rule_id, severity, delivered_channels::text FROM alerts")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(row.0, "big-spend");
    assert_eq!(row.1, "critical");
    assert!(
        row.2.contains("recording"),
        "the channel result is recorded: {}",
        row.2
    );
    assert_eq!(sent.lock().unwrap().len(), 1);

    // The alert is visible through the API.
    let (_, listed) = get(&db.state(), "/alerts").await;
    assert_eq!(listed["total"], 1);
    assert_eq!(listed["alerts"][0]["details"]["total"], "1100");

    db.cleanup().await;
}

#[tokio::test]
async fn cooldown_stops_a_burst_of_transfers_from_alerting_repeatedly() {
    let Some(db) = TestDb::connect("watch_cooldown", false).await else {
        return;
    };
    let (watcher, sent) = watcher(&db, SPEND_RULE, true, Arc::new(Limits::disabled()));
    let mut stamp = None;

    for (ledger, at) in [
        (10, "09:00:00"),
        (11, "09:01:00"),
        (12, "09:02:00"),
        (13, "09:03:00"),
    ] {
        insert_transfer(
            &db.pool,
            ledger,
            "1000",
            "USDC",
            &format!("2026-09-27T{at}Z"),
        )
        .await;
    }
    watcher.tick(&mut stamp).await.unwrap();

    assert_eq!(
        alert_count(&db.pool).await,
        1,
        "four over-threshold transfers, one alert"
    );
    assert_eq!(sent.lock().unwrap().len(), 1);

    // Once the cooldown passes the rule may alert again.
    insert_transfer(&db.pool, 14, "1000", "USDC", "2026-09-27T09:30:00Z").await;
    watcher.tick(&mut stamp).await.unwrap();
    assert_eq!(alert_count(&db.pool).await, 2);

    db.cleanup().await;
}

#[tokio::test]
async fn reprocessing_events_never_notifies_twice() {
    let Some(db) = TestDb::connect("watch_idempotent", false).await else {
        return;
    };
    insert_transfer(&db.pool, 10, "5000", "USDC", "2026-09-27T09:00:00Z").await;
    let (first, first_sent) = watcher(&db, SPEND_RULE, true, Arc::new(Limits::disabled()));
    first.tick(&mut None).await.unwrap();
    assert_eq!(alert_count(&db.pool).await, 1);
    assert_eq!(first_sent.lock().unwrap().len(), 1);

    // A restart that lost its in-memory state and its cursor re-reads the event.
    sqlx::query("DELETE FROM alert_cursors")
        .execute(&db.pool)
        .await
        .unwrap();
    let (second, second_sent) = watcher(&db, SPEND_RULE, true, Arc::new(Limits::disabled()));
    second.tick(&mut None).await.unwrap();

    assert_eq!(
        alert_count(&db.pool).await,
        1,
        "the dedupe key rejects the repeat"
    );
    assert!(
        second_sent.lock().unwrap().is_empty(),
        "and nothing is sent again"
    );

    db.cleanup().await;
}

#[tokio::test]
async fn enabling_alerts_does_not_replay_old_history_unless_asked() {
    let Some(db) = TestDb::connect("watch_seed", false).await else {
        return;
    };
    insert_transfer(&db.pool, 10, "5000", "USDC", "2026-09-27T09:00:00Z").await;
    let (watcher, _) = watcher(&db, SPEND_RULE, false, Arc::new(Limits::disabled()));
    let mut stamp = None;

    watcher.tick(&mut stamp).await.unwrap();
    assert_eq!(
        alert_count(&db.pool).await,
        0,
        "history before the first poll is skipped"
    );

    insert_transfer(&db.pool, 11, "5000", "USDC", "2026-09-27T10:00:00Z").await;
    watcher.tick(&mut stamp).await.unwrap();
    assert_eq!(alert_count(&db.pool).await, 1, "new events are evaluated");

    db.cleanup().await;
}

fn cached_state(db: &TestDb, limits: &Arc<Limits>) -> AppState {
    db.state().with_limits(Arc::clone(limits))
}

#[tokio::test]
async fn cached_reads_are_dropped_when_new_events_are_indexed() {
    let Some(db) = TestDb::connect("watch_cache", true).await else {
        return;
    };
    let limits = Arc::new(Limits::new(&LimitsConfig {
        rate_limit_requests: 0,
        cache_ttl: Duration::from_secs(300),
        ..LimitsConfig::default()
    }));
    let state = cached_state(&db, &limits);
    let watcher = Watcher {
        pool: db.pool.clone(),
        pairs: vec![("testnet".to_owned(), "test-contract".to_owned())],
        limits: Arc::clone(&limits),
        alerts: None,
    };
    let mut stamp = None;
    watcher.tick(&mut stamp).await.unwrap();

    let (_, headers, before) = request(&state, "GET", "/proposals?contractId=test-contract").await;
    assert_eq!(headers["x-cache"], "MISS");
    let (_, headers, _) = request(&state, "GET", "/proposals?contractId=test-contract").await;
    assert_eq!(
        headers["x-cache"], "HIT",
        "an identical read is answered from the cache"
    );

    // The indexer writes a new proposal and its event.
    sqlx::raw_sql(
        "INSERT INTO proposals (contract_id, network, proposal_id, status, deadline, created_at, proposer) \
         VALUES ('test-contract', 'testnet', 7, 'pending', '2026-10-01T00:00:00Z', '2026-09-28T00:00:00Z', 'GNEW'); \
         INSERT INTO events (contract_id, ledger, tx_hash, event_index, topic, occurred_at) \
         VALUES ('test-contract', 500, 'txnew', 0, 'created', '2026-09-28T00:00:00Z');",
    )
    .execute(&db.pool)
    .await
    .unwrap();

    // Still cached until the watcher notices.
    let (_, headers, stale) = request(&state, "GET", "/proposals?contractId=test-contract").await;
    assert_eq!(headers["x-cache"], "HIT");
    assert_eq!(stale["total"], before["total"]);

    watcher.tick(&mut stamp).await.unwrap();
    let (_, headers, fresh) = request(&state, "GET", "/proposals?contractId=test-contract").await;
    assert_eq!(
        headers["x-cache"], "MISS",
        "new events invalidated the cache"
    );
    assert_eq!(fresh["total"], 7);

    db.cleanup().await;
}

// --- proposal funnel ---------------------------------------------------------

fn funnel_items(body: &Value) -> Vec<(String, i64)> {
    body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            (
                row["key"].as_str().unwrap().to_owned(),
                row["created"].as_i64().unwrap(),
            )
        })
        .collect()
}

#[tokio::test]
async fn the_funnel_rejects_bad_input_before_touching_the_database() {
    let state = lazy_state();
    for (uri, code) in [
        ("/proposals/funnel?groupBy=token", "INVALID_GROUP_BY"),
        ("/proposals/funnel?category=Bogus", "INVALID_CATEGORY"),
        ("/proposals/funnel?limit=101", "INVALID_LIMIT"),
        ("/proposals/funnel?offset=-1", "INVALID_OFFSET"),
        ("/proposals/funnel?startDate=soon", "INVALID_DATE"),
        (
            "/proposals/funnel?startDate=2026-09-27&endDate=2026-09-26",
            "INVALID_DATE_RANGE",
        ),
        ("/proposals/funnel?network=nope", "INVALID_NETWORK"),
    ] {
        let (status, body) = get(&state, uri).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}");
        assert_eq!(body["error"]["code"], "VALIDATION_ERROR", "{uri}");
        assert_eq!(body["error"]["details"][0]["code"], code, "{uri}");
    }
}

#[tokio::test]
async fn the_funnel_is_not_mistaken_for_a_proposal_id() {
    // `/proposals/funnel` must route to the funnel, not to `/proposals/{id}`,
    // which would answer INVALID_PARAMETER for a non-numeric id.
    let (_, body) = get(&lazy_state(), "/proposals/funnel?limit=0").await;
    assert_eq!(body["error"]["code"], "VALIDATION_ERROR");
}

#[tokio::test]
async fn the_funnel_groups_by_category_with_conversion_rates() {
    let Some(db) = TestDb::connect("funnel_category", true).await else {
        return;
    };
    let state = db.state();

    let (status, body) = get(&state, "/proposals/funnel?contractId=test-contract").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["groupBy"], "category");
    assert_eq!(body["total"], 5);
    assert_eq!(body["limit"], 20);
    assert_eq!(body["offset"], 0);
    assert_eq!(
        funnel_items(&body),
        [
            ("Payroll".to_owned(), 2),
            ("Grant".to_owned(), 1),
            ("Ops".to_owned(), 1),
            ("Other".to_owned(), 1),
            ("Transfer".to_owned(), 1),
        ],
        "largest cohort first, ties broken by key"
    );

    let payroll = &body["items"][0];
    assert_eq!(payroll["approved"], 1);
    assert_eq!(payroll["executed"], 1);
    assert_eq!(payroll["open"], 1);
    assert_eq!(payroll["approvalRate"], 50.0);
    assert_eq!(payroll["executionRate"], 50.0);
    assert_eq!(payroll["approvalToExecutionRate"], 100.0);
    assert_eq!(payroll["avgSecondsToExecute"], 43_200.0);

    let ops = &body["items"][2];
    assert_eq!(ops["expired"], 1);
    assert_eq!(ops["approvalRate"], 0.0);
    assert_eq!(ops["approvalToExecutionRate"], 0.0, "no division by zero");
    assert!(ops["avgSecondsToExecute"].is_null());

    let other = &body["items"][3];
    assert_eq!(other["cancelled"], 1);
    assert_eq!(other["cancellationRate"], 100.0);

    let totals = &body["totals"];
    assert_eq!(totals["key"], "all");
    assert_eq!(totals["created"], 6);
    assert_eq!(totals["approved"], 3);
    assert_eq!(totals["executed"], 2);
    assert_eq!(totals["cancelled"], 1);
    assert_eq!(totals["expired"], 1);
    assert_eq!(totals["open"], 2);
    assert_eq!(totals["approvalRate"], 50.0);
    assert_eq!(totals["executionRate"], 33.33);
    assert_eq!(totals["cancellationRate"], 16.67);
    assert_eq!(totals["approvalToExecutionRate"], 66.67);

    db.cleanup().await;
}

#[tokio::test]
async fn the_funnel_groups_by_owner_and_filters_the_cohort() {
    let Some(db) = TestDb::connect("funnel_owner", true).await else {
        return;
    };
    let state = db.state();
    let base = "/proposals/funnel?contractId=test-contract&groupBy=owner";

    let (_, body) = get(&state, base).await;
    assert_eq!(body["groupBy"], "owner");
    assert_eq!(
        funnel_items(&body),
        [
            ("GALICE".to_owned(), 2),
            ("GBOB".to_owned(), 2),
            ("GCAROL".to_owned(), 1),
            ("GDAVE".to_owned(), 1),
        ]
    );
    assert_eq!(body["items"][0]["approved"], 2);
    assert_eq!(body["items"][1]["approved"], 0);

    for (filter, created) in [
        ("token=USDC", 3),
        ("category=Payroll", 2),
        ("owner=alice", 2),
        ("startDate=2026-09-10", 4),
        ("endDate=2026-09-10", 3),
        ("token=XLM&category=Ops", 1),
        ("category=Grant&token=XLM", 0),
    ] {
        let (status, body) = get(&state, &format!("{base}&{filter}")).await;
        assert_eq!(status, StatusCode::OK, "{filter}");
        assert_eq!(body["totals"]["created"], created, "{filter}");
        let summed: i64 = funnel_items(&body).iter().map(|(_, count)| count).sum();
        assert_eq!(summed, created, "{filter}: rows add up to the totals");
    }

    db.cleanup().await;
}

#[tokio::test]
async fn the_funnel_paginates_groups_and_spans_contracts() {
    let Some(db) = TestDb::connect("funnel_page", true).await else {
        return;
    };
    let state = db.state();

    let mut seen = Vec::new();
    for offset in [0, 2, 4] {
        let (status, page) = get(
            &state,
            &format!("/proposals/funnel?contractId=test-contract&limit=2&offset={offset}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(page["total"], 5, "total counts groups, ignoring paging");
        assert_eq!(page["totals"]["created"], 6, "totals ignore paging too");
        seen.extend(funnel_items(&page).into_iter().map(|(key, _)| key));
    }
    assert_eq!(seen, ["Payroll", "Grant", "Ops", "Other", "Transfer"]);

    let (_, beyond) = get(&state, "/proposals/funnel?offset=100").await;
    assert!(beyond["items"].as_array().unwrap().is_empty());

    // No contractId: both contracts are included.
    let (_, everything) = get(&state, "/proposals/funnel").await;
    assert_eq!(everything["totals"]["created"], 7);

    db.cleanup().await;
}

// --- branded report templates -------------------------------------------------

async fn send(
    state: &AppState,
    method: &str,
    uri: &str,
    body: &str,
    token: Option<&str>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let response = app(state.clone())
        .oneshot(builder.body(Body::from(body.to_owned())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn first_detail(body: &Value) -> (&str, &str) {
    (
        body["error"]["details"][0]["field"].as_str().unwrap_or(""),
        body["error"]["details"][0]["code"].as_str().unwrap_or(""),
    )
}

#[test]
fn openapi_template_sections_match_the_implementation() {
    let spec = spec();
    let documented: Vec<&str> = spec["components"]["schemas"]["ReportTemplateInput"]["properties"]
        ["sections"]["items"]["enum"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();

    assert_eq!(documented, templates::SECTION_NAMES);
}

#[tokio::test]
async fn template_writes_reject_bad_requests_before_touching_the_database() {
    let state = lazy_state();
    let uri = "/report-templates?contractId=test-contract";
    for (body, field, code) in [
        ("not json", "body", "INVALID_BODY"),
        (r#"{"colour":"red"}"#, "body", "INVALID_BODY"),
        (r#"{"accentColor":"red"}"#, "accentColor", "INVALID_COLOR"),
        (
            r#"{"logoUrl":"http://x.example/logo.png"}"#,
            "logoUrl",
            "INVALID_LOGO_URL",
        ),
        (r#"{"sections":[]}"#, "sections", "INVALID_SECTION"),
        (r#"{"sections":["charts"]}"#, "sections", "INVALID_SECTION"),
        (r#"{"title":"{oops}"}"#, "title", "INVALID_TEMPLATE_FIELD"),
        (
            r#"{"headerText":"two\nlines"}"#,
            "headerText",
            "INVALID_TEMPLATE_FIELD",
        ),
    ] {
        let (status, response) = send(&state, "PUT", uri, body, None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(response["error"]["code"], "VALIDATION_ERROR", "{body}");
        assert_eq!(first_detail(&response), (field, code), "{body}");
    }
}

#[tokio::test]
async fn template_writes_need_a_target_when_several_are_served() {
    // `scope()` serves two contracts, so the caller must name one.
    let (status, body) = send(&lazy_state(), "PUT", "/report-templates", "{}", None).await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(first_detail(&body), ("contractId", "MISSING_PARAMETER"));

    let (status, body) = send(&lazy_state(), "DELETE", "/report-templates", "", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(first_detail(&body), ("contractId", "MISSING_PARAMETER"));
}

#[tokio::test]
async fn template_writes_reject_oversized_bodies() {
    let huge = format!(r#"{{"headerText":"{}"}}"#, "a".repeat(templates::MAX_BODY_BYTES));
    let (status, _) = send(
        &lazy_state(),
        "PUT",
        "/report-templates?contractId=test-contract",
        &huge,
        None,
    )
    .await;

    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn template_writes_require_the_admin_token_when_one_is_configured() {
    let state = lazy_state().with_admin_token(Some(Arc::from("s3cret")));
    let uri = "/report-templates?contractId=test-contract";

    for token in [None, Some("wrong"), Some("")] {
        for method in ["PUT", "DELETE"] {
            let (status, body) = send(&state, method, uri, "{}", token).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {token:?}");
            assert_eq!(body["error"]["code"], "UNAUTHORIZED");
        }
    }

    // With the token the request is authorised and reaches validation.
    let (status, body) = send(&state, "PUT", uri, r#"{"accentColor":"red"}"#, Some("s3cret")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(first_detail(&body).1, "INVALID_COLOR");

    // Reads stay open.
    let (status, _) = send(&state, "GET", "/report-templates?limit=0", "", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "validated, not refused");
}

#[tokio::test]
async fn templates_can_be_created_listed_replaced_and_removed() {
    let Some(db) = TestDb::connect("templates", true).await else {
        return;
    };
    let state = db.state();
    let uri = "/report-templates?contractId=test-contract&network=testnet";

    let (status, empty) = send(&state, "GET", "/report-templates", "", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(empty["total"], 0);
    assert_eq!(empty["limit"], 20);

    let (status, created) = send(
        &state,
        "PUT",
        uri,
        r##"{"brandName":" Acme ","title":"{network} report","logoUrl":"https://cdn.example.com/a.png","accentColor":"#1A73E8","footerText":"Confidential","sections":["transactions","summary"]}"##,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(created["brandName"], "Acme");
    assert_eq!(created["accentColor"], "#1a73e8");
    assert_eq!(created["sections"], serde_json::json!(["transactions", "summary"]));
    assert_eq!(created["contractId"], "test-contract");
    assert!(created["headerText"].is_null());

    // A second PUT replaces: omitted fields go back to their defaults.
    let (_, replaced) = send(&state, "PUT", uri, r#"{"headerText":"Hello"}"#, None).await;
    assert_eq!(replaced["id"], created["id"], "same row, updated in place");
    assert_eq!(replaced["headerText"], "Hello");
    assert!(replaced["brandName"].is_null());
    assert_eq!(
        replaced["sections"],
        serde_json::json!(["summary", "token_totals", "category_totals", "transactions"])
    );

    // The other contract gets its own template.
    send(
        &state,
        "PUT",
        "/report-templates?contractId=other-contract",
        r#"{"brandName":"Other"}"#,
        None,
    )
    .await;
    let (_, all) = send(&state, "GET", "/report-templates", "", None).await;
    assert_eq!(all["total"], 2);
    let names: Vec<&str> = all["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["contractId"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["other-contract", "test-contract"]);

    let (_, page) = send(&state, "GET", "/report-templates?limit=1&offset=1", "", None).await;
    assert_eq!(page["total"], 2);
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    let (_, narrowed) = send(&state, "GET", "/report-templates?contractId=test-contract", "", None).await;
    assert_eq!(narrowed["total"], 1);

    let (status, _) = send(&state, "DELETE", uri, "", None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, missing) = send(&state, "DELETE", uri, "", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(missing["error"]["code"], "NOT_FOUND");

    db.cleanup().await;
}

#[tokio::test]
async fn a_stored_template_brands_the_generated_report() {
    use crate::{
        reports::{ReportFormat, ReportPeriod, TreasuryReport},
        templates::ReportTemplate,
    };

    let Some(db) = TestDb::connect("template_report", true).await else {
        return;
    };
    let state = db.state();
    send(
        &state,
        "PUT",
        "/report-templates?contractId=test-contract",
        r#"{"brandName":"Acme","footerText":"Confidential","sections":["transactions"]}"#,
        None,
    )
    .await;

    let period = ReportPeriod::ending_at(
        chrono::DateTime::parse_from_rfc3339("2026-09-30T00:00:00Z")
            .unwrap()
            .into(),
        60,
    );
    let mut report = TreasuryReport::load(&db.pool, "testnet", "test-contract", period, period.end)
        .await
        .unwrap();
    assert!(report.template.is_none(), "load alone does not brand");
    report.template = ReportTemplate::load(&db.pool, "testnet", "test-contract")
        .await
        .unwrap();
    assert!(
        ReportTemplate::load(&db.pool, "testnet", "other-contract")
            .await
            .unwrap()
            .is_none()
    );

    let csv = String::from_utf8(report.render(ReportFormat::Csv).unwrap()).unwrap();
    assert!(csv.starts_with("brand,Acme\n"));
    assert!(csv.contains("network,contract_id,proposal_id"));
    assert!(!csv.contains("token_total"));
    assert!(csv.trim_end().ends_with("footer,Confidential"));
    assert!(report.render(ReportFormat::Pdf).unwrap().starts_with(b"%PDF-"));

    db.cleanup().await;
}

// --- alert rule management ------------------------------------------------------

const RULE_SPEND: &str = r#"{"id":"big-spend","type":"spend_threshold","token":"USDC","threshold":"1000","windowSecs":3600,"severity":"critical"}"#;
const RULE_BURST: &str = r#"{"id":"burst","type":"approval_burst","maxApprovals":3,"windowSecs":600}"#;

fn configured_rule() -> crate::alerts::Rule {
    parse_rules(r#"[{"id":"cfg-night","type":"off_hours_approval","startHour":22,"endHour":5}]"#)
        .unwrap()
        .remove(0)
}

fn engine_state(state: AppState) -> (AppState, Arc<AlertEngine>) {
    let engine = Arc::new(AlertEngine::new(
        vec![configured_rule()],
        StormSettings::default(),
    ));
    (state.with_alerts(Some(Arc::clone(&engine))), engine)
}

fn rule_ids(page: &Value) -> Vec<&str> {
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|rule| rule["id"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn rule_writes_reject_bad_requests_before_touching_the_database() {
    let state = lazy_state();
    for (body, field, code) in [
        ("not json", "body", "INVALID_BODY"),
        ("[]", "body", "INVALID_BODY"),
        (r#"{"id":"bad id","type":"approval_burst","maxApprovals":3,"windowSecs":60}"#, "id", "INVALID_RULE_ID"),
        (r#"{"id":"test","type":"approval_burst","maxApprovals":3,"windowSecs":60}"#, "id", "INVALID_RULE_ID"),
        (r#"{"id":"x","type":"nope"}"#, "type", "INVALID_RULE"),
        (r#"{"id":"x","type":"spend_threshold","threshold":"-1","windowSecs":60}"#, "threshold", "INVALID_RULE"),
        (r#"{"id":"x","type":"spend_threshold","threshold":"5","windowSecs":0}"#, "windowSecs", "INVALID_RULE"),
        (r#"{"id":"x","type":"approval_burst","maxApprovals":0,"windowSecs":60}"#, "maxApprovals", "INVALID_RULE"),
        (r#"{"id":"x","type":"off_hours_approval","startHour":4,"endHour":4}"#, "startHour", "INVALID_RULE"),
        (r#"{"id":"x","type":"approval_burst","maxApprovals":1,"windowSecs":99999999}"#, "windowSecs", "INVALID_RULE"),
        (r#"{"id":"x","type":"approval_burst","maxApprovals":1,"windowSecs":60,"colour":1}"#, "body", "INVALID_BODY"),
        (r#"{"id":"x","type":"approval_burst","maxApprovals":1,"windowSecs":60,"enabled":"yes"}"#, "enabled", "INVALID_BODY"),
    ] {
        for (method, uri) in [
            ("POST", "/alert-rules"),
            ("PUT", "/alert-rules/x"),
            ("POST", "/alert-rules/test"),
        ] {
            let (status, response) = send(&state, method, uri, body, None).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{method} {uri} {body}");
            assert_eq!(first_detail(&response), (field, code), "{method} {uri} {body}");
        }
    }

    // A create needs an id; a replace takes it from the path and a draft test
    // fills one in.
    let missing = r#"{"type":"approval_burst","maxApprovals":3,"windowSecs":60}"#;
    let (status, response) = send(&state, "POST", "/alert-rules", missing, None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(first_detail(&response), ("id", "INVALID_RULE_ID"));
}

#[tokio::test]
async fn rule_paths_validate_the_id_and_the_body_must_agree_with_it() {
    let state = lazy_state();
    for (method, uri) in [
        ("GET", "/alert-rules/bad$id"),
        ("PUT", "/alert-rules/bad$id"),
        ("DELETE", "/alert-rules/bad$id"),
        ("POST", "/alert-rules/bad$id/pause"),
        ("POST", "/alert-rules/bad$id/resume"),
        ("POST", "/alert-rules/bad$id/test"),
    ] {
        let (status, body) = send(&state, method, uri, RULE_BURST, None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{method} {uri}");
        assert_eq!(first_detail(&body), ("id", "INVALID_RULE_ID"), "{method} {uri}");
    }

    let (status, body) = send(&state, "PUT", "/alert-rules/other", RULE_BURST, None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(first_detail(&body), ("id", "INVALID_RULE_ID"));
}

#[tokio::test]
async fn rule_test_parameters_are_validated_before_the_database() {
    let state = lazy_state();
    for (uri, code) in [
        ("/alert-rules/test?lookbackHours=0", "INVALID_LOOKBACK"),
        ("/alert-rules/test?lookbackHours=169", "INVALID_LOOKBACK"),
        ("/alert-rules/test?lookbackHours=soon", "INVALID_LOOKBACK"),
        ("/alert-rules/test?limit=0", "INVALID_LIMIT"),
        ("/alert-rules/test?network=nope", "INVALID_NETWORK"),
        ("/alert-rules/big/test?lookbackHours=0", "INVALID_LOOKBACK"),
    ] {
        let (status, body) = send(&state, "POST", uri, RULE_BURST, None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}");
        assert_eq!(first_detail(&body).1, code, "{uri}");
    }
}

#[tokio::test]
async fn rule_writes_need_the_admin_token_but_tests_and_reads_do_not() {
    let state = lazy_state().with_admin_token(Some(Arc::from("s3cret")));
    for (method, uri) in [
        ("POST", "/alert-rules"),
        ("PUT", "/alert-rules/x"),
        ("DELETE", "/alert-rules/x"),
        ("POST", "/alert-rules/x/pause"),
        ("POST", "/alert-rules/x/resume"),
    ] {
        for token in [None, Some("wrong")] {
            let (status, body) = send(&state, method, uri, RULE_BURST, token).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {uri} {token:?}");
            assert_eq!(body["error"]["code"], "UNAUTHORIZED");
        }
    }

    // Authorised, the request reaches validation.
    let (status, body) = send(&state, "POST", "/alert-rules", "{}", Some("s3cret")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(first_detail(&body).0, "id");

    // The dry-run changes nothing, so it is open: it is validated, not refused.
    let (status, _) = send(&state, "POST", "/alert-rules/test?limit=0", RULE_BURST, None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn rule_writes_reject_oversized_bodies() {
    let huge = format!(r#"{{"id":"x","token":"{}"}}"#, "a".repeat(alert_rules::MAX_BODY_BYTES));
    let (status, _) = send(&lazy_state(), "POST", "/alert-rules", &huge, None).await;

    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn rules_can_be_created_listed_edited_paused_and_deleted() {
    let Some(db) = TestDb::connect("alert_rules", true).await else {
        return;
    };
    let (state, engine) = engine_state(db.state());
    assert_eq!(engine.rules().len(), 1);

    // The configured rule is listed and read-only.
    let (status, page) = send(&state, "GET", "/alert-rules", "", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rule_ids(&page), ["cfg-night"]);
    assert_eq!(page["items"][0]["source"], "config");
    assert_eq!(page["items"][0]["category"], "anomaly");
    assert_eq!(page["items"][0]["enabled"], true);

    // Create: 201, active, evaluated right away.
    let (status, created) = send(&state, "POST", "/alert-rules", RULE_SPEND, None).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["id"], "big-spend");
    assert_eq!(created["source"], "managed");
    assert_eq!(created["category"], "threshold");
    assert_eq!(created["enabled"], true);
    assert_eq!(created["severity"], "critical");
    assert_eq!(created["threshold"], "1000");
    assert_eq!(engine.rules().len(), 2);

    let (status, again) = send(&state, "POST", "/alert-rules", RULE_SPEND, None).await;
    assert_eq!(status, StatusCode::CONFLICT, "ids are unique");
    assert_eq!(again["error"]["code"], "CONFLICT");
    let shadow = r#"{"id":"cfg-night","type":"approval_burst","maxApprovals":1,"windowSecs":60}"#;
    let (status, _) = send(&state, "POST", "/alert-rules", shadow, None).await;
    assert_eq!(status, StatusCode::CONFLICT, "a configured id cannot be reused");

    // Created paused: stored but not evaluated.
    let paused = r#"{"id":"burst","type":"approval_burst","maxApprovals":3,"windowSecs":600,"enabled":false}"#;
    let (_, created) = send(&state, "POST", "/alert-rules", paused, None).await;
    assert_eq!(created["enabled"], false);
    assert_eq!(engine.rules().len(), 2, "a paused rule is not evaluated");

    // List, filter, page.
    let (_, all) = send(&state, "GET", "/alert-rules", "", None).await;
    assert_eq!(rule_ids(&all), ["big-spend", "burst", "cfg-night"]);
    assert_eq!(all["total"], 3);
    for (filter, expected) in [
        ("status=paused", vec!["burst"]),
        ("status=active", vec!["big-spend", "cfg-night"]),
        ("source=managed", vec!["big-spend", "burst"]),
        ("source=config", vec!["cfg-night"]),
        ("category=threshold", vec!["big-spend"]),
        ("category=anomaly", vec!["burst", "cfg-night"]),
        ("type=approval_burst", vec!["burst"]),
        ("severity=critical", vec!["big-spend"]),
        ("severity=warning", vec!["burst", "cfg-night"]),
    ] {
        let (status, page) = send(&state, "GET", &format!("/alert-rules?{filter}"), "", None).await;
        assert_eq!(status, StatusCode::OK, "{filter}");
        assert_eq!(rule_ids(&page), expected, "{filter}");
        assert_eq!(page["total"], expected.len(), "{filter}");
    }
    let (_, second) = send(&state, "GET", "/alert-rules?limit=1&offset=1", "", None).await;
    assert_eq!(rule_ids(&second), ["burst"]);
    assert_eq!(second["total"], 3);

    // Read one.
    let (status, one) = send(&state, "GET", "/alert-rules/big-spend", "", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(one["windowSecs"], 3600);
    let (status, _) = send(&state, "GET", "/alert-rules/cfg-night", "", None).await;
    assert_eq!(status, StatusCode::OK, "configured rules can be read");
    let (status, missing) = send(&state, "GET", "/alert-rules/nope", "", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(missing["error"]["code"], "NOT_FOUND");

    // Edit: replaces the definition and keeps `enabled` when it is left out.
    let edited = r#"{"type":"spend_threshold","token":"USDC","threshold":"2500","windowSecs":7200,"severity":"warning"}"#;
    let (status, edited) = send(&state, "PUT", "/alert-rules/big-spend", edited, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(edited["threshold"], "2500");
    assert_eq!(edited["severity"], "warning");
    assert_eq!(edited["enabled"], true);
    assert!(
        engine
            .rules()
            .iter()
            .any(|rule| rule.id == "big-spend" && matches!(&rule.kind, crate::alerts::RuleKind::SpendThreshold { threshold, .. } if threshold == "2500")),
        "the engine runs the edited rule"
    );
    let (status, _) = send(&state, "PUT", "/alert-rules/ghost", r#"{"type":"approval_burst","maxApprovals":3,"windowSecs":600}"#, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Pause and resume.
    let (status, paused) = send(&state, "POST", "/alert-rules/big-spend/pause", "", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(paused["enabled"], false);
    assert_eq!(engine.rules().len(), 1, "a paused rule stops being evaluated");
    let (_, resumed) = send(&state, "POST", "/alert-rules/big-spend/resume", "", None).await;
    assert_eq!(resumed["enabled"], true);
    assert_eq!(engine.rules().len(), 2);
    let (status, _) = send(&state, "POST", "/alert-rules/ghost/pause", "", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Configured rules cannot be changed.
    for (method, uri, body) in [
        ("PUT", "/alert-rules/cfg-night", shadow),
        ("DELETE", "/alert-rules/cfg-night", ""),
        ("POST", "/alert-rules/cfg-night/pause", ""),
        ("POST", "/alert-rules/cfg-night/resume", ""),
    ] {
        let (status, response) = send(&state, method, uri, body, None).await;
        assert_eq!(status, StatusCode::CONFLICT, "{method} {uri}");
        assert_eq!(response["error"]["code"], "CONFLICT");
    }

    // Delete.
    let (status, _) = send(&state, "DELETE", "/alert-rules/big-spend", "", None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(engine.rules().len(), 1);
    let (status, _) = send(&state, "DELETE", "/alert-rules/big-spend", "", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    db.cleanup().await;
}

#[tokio::test]
async fn the_watcher_applies_rules_written_by_another_instance() {
    let Some(db) = TestDb::connect("alert_rules_reload", true).await else {
        return;
    };
    let (watcher, _sent) = watcher(&db, "[]", false, Arc::new(Limits::disabled()));
    let engine = Arc::clone(&watcher.alerts.as_ref().unwrap().engine);
    let before = engine.rules().len();

    // Written straight to the table, as a second instance would.
    sqlx::query(
        "INSERT INTO alert_rules (id, kind, severity, definition) VALUES \
         ('remote', 'approval_burst', 'warning', \
          '{\"id\":\"remote\",\"type\":\"approval_burst\",\"maxApprovals\":2,\"windowSecs\":60}')",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    watcher.tick(&mut None).await.unwrap();
    assert_eq!(engine.rules().len(), before + 1);

    sqlx::query("UPDATE alert_rules SET enabled = FALSE WHERE id = 'remote'")
        .execute(&db.pool)
        .await
        .unwrap();
    watcher.tick(&mut None).await.unwrap();
    assert_eq!(engine.rules().len(), before);

    db.cleanup().await;
}

#[tokio::test]
async fn a_rule_can_be_tested_against_recent_history_without_side_effects() {
    let Some(db) = TestDb::connect("alert_rules_test", true).await else {
        return;
    };
    let (state, _engine) = engine_state(db.state());
    let now = chrono::Utc::now();
    insert_transfer(&db.pool, 1, "600", "USDC", &(now - chrono::Duration::hours(2)).to_rfc3339()).await;
    insert_transfer(&db.pool, 2, "600", "USDC", &(now - chrono::Duration::hours(1)).to_rfc3339()).await;
    insert_transfer(&db.pool, 3, "5000", "XLM", &(now - chrono::Duration::minutes(5)).to_rfc3339()).await;
    insert_transfer(&db.pool, 4, "9000", "USDC", &(now - chrono::Duration::hours(100)).to_rfc3339()).await;

    // A draft that was never saved.
    let (status, run) = send(
        &state,
        "POST",
        "/alert-rules/test?contractId=test-contract",
        RULE_SPEND,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(run["ruleId"], "big-spend");
    assert_eq!(run["lookbackHours"], 24);
    assert_eq!(run["eventsEvaluated"], 3, "the 100 hour old transfer is outside the window");
    assert_eq!(run["wouldFire"], 0, "600 + 600 are 2 hours apart, outside the 1 hour window");
    assert_eq!(run["truncated"], false);

    let wide = RULE_SPEND.replace("3600", "86400");
    let (_, run) = send(&state, "POST", "/alert-rules/test?contractId=test-contract", &wide, None).await;
    assert_eq!(run["wouldFire"], 1);
    assert_eq!(run["alerts"][0]["subject"], "USDC");
    assert_eq!(run["alerts"][0]["severity"], "critical");
    assert_eq!(run["alerts"][0]["details"]["total"], "1200");

    // A longer look-back also replays the old 9000 transfer, which fires on its own.
    let (_, long) = send(
        &state,
        "POST",
        "/alert-rules/test?contractId=test-contract&lookbackHours=120",
        &wide,
        None,
    )
    .await;
    assert_eq!(long["eventsEvaluated"], 4);
    assert_eq!(long["wouldFire"], 2);

    let (_, limited) = send(&state, "POST", "/alert-rules/test?contractId=test-contract&limit=1", &wide, None).await;
    assert!(limited["alerts"].as_array().unwrap().len() <= 1);

    // A saved rule, by id.
    send(&state, "POST", "/alert-rules", &wide, None).await;
    let (status, saved) = send(&state, "POST", "/alert-rules/big-spend/test?contractId=test-contract", "", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["wouldFire"], 1);
    let (status, _) = send(&state, "POST", "/alert-rules/ghost/test", "", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Nothing was recorded or sent.
    let (_, alerts) = send(&state, "GET", "/alerts", "", None).await;
    assert_eq!(alerts["total"], 0);

    db.cleanup().await;
}
