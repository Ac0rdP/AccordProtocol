//! Per-client rate limiting and short-lived response caching.
//!
//! Both protect the database: the limiter stops one client from hammering the
//! expensive read endpoints, and the cache lets identical dashboard queries be
//! answered from memory for a short window. The cache is also dropped the
//! moment the event watcher sees new indexed events (see `alerts::watch`), so a
//! cached answer is never older than the TTL *and* never older than the data.

use std::{
    collections::HashMap,
    env,
    net::SocketAddr,
    str::FromStr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use anyhow::{Result, bail};
use axum::{
    body::{Body, Bytes, to_bytes},
    extract::{ConnectInfo, Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};

use crate::{AppState, metrics};

/// Largest response body the cache will hold; bigger ones are served uncached.
const MAX_CACHED_BODY_BYTES: usize = 1024 * 1024;
/// Rate-limit windows are pruned once the table grows past this many clients.
const PRUNE_THRESHOLD: usize = 10_000;

/// Paths that are never limited or cached: probes and the scrape endpoint must
/// keep answering when the API is under load.
const EXEMPT_PATHS: &[&str] = &["/", "/health", "/livez", "/readyz", "/metrics"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LimitsConfig {
    /// Requests allowed per client per window; `0` disables rate limiting.
    pub rate_limit_requests: u32,
    pub rate_limit_window: Duration,
    /// Read the client from `X-Forwarded-For` instead of the socket peer.
    pub trust_proxy: bool,
    /// How long a cached read stays fresh; zero disables the cache.
    pub cache_ttl: Duration,
    pub cache_max_entries: usize,
}

impl Default for LimitsConfig {
    fn default() -> Self {
        Self {
            rate_limit_requests: 120,
            rate_limit_window: Duration::from_secs(60),
            trust_proxy: false,
            cache_ttl: Duration::from_secs(30),
            cache_max_entries: 500,
        }
    }
}

fn parse_env<T: FromStr>(name: &str, default: T) -> Result<T>
where
    T::Err: std::fmt::Display,
{
    match env::var(name) {
        Err(_) => Ok(default),
        Ok(value) if value.trim().is_empty() => Ok(default),
        Ok(value) => value
            .trim()
            .parse::<T>()
            .map_err(|error| anyhow::anyhow!("{name} is invalid: {error}")),
    }
}

impl LimitsConfig {
    pub fn from_env() -> Result<Self> {
        let defaults = Self::default();
        let window_secs: u64 = parse_env(
            "RATE_LIMIT_WINDOW_SECS",
            defaults.rate_limit_window.as_secs(),
        )?;
        if window_secs == 0 {
            bail!("RATE_LIMIT_WINDOW_SECS must be at least 1");
        }
        Ok(Self {
            rate_limit_requests: parse_env("RATE_LIMIT_REQUESTS", defaults.rate_limit_requests)?,
            rate_limit_window: Duration::from_secs(window_secs),
            trust_proxy: parse_env("RATE_LIMIT_TRUST_PROXY", defaults.trust_proxy)?,
            cache_ttl: Duration::from_secs(parse_env(
                "CACHE_TTL_SECS",
                defaults.cache_ttl.as_secs(),
            )?),
            cache_max_entries: parse_env("CACHE_MAX_ENTRIES", defaults.cache_max_entries)?,
        })
    }
}

/// The outcome of counting one request against a client's window.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Allowed { remaining: u32, reset_secs: u64 },
    Limited { retry_after_secs: u64 },
}

struct Window {
    started: Instant,
    count: u32,
}

/// A fixed-window counter per client. Simple and predictable: the first
/// request opens a window, and the client is refused once it spends the quota
/// until the window closes.
pub struct RateLimiter {
    limit: u32,
    window: Duration,
    clients: Mutex<HashMap<String, Window>>,
}

impl RateLimiter {
    pub fn new(limit: u32, window: Duration) -> Self {
        Self {
            limit,
            window,
            clients: Mutex::new(HashMap::new()),
        }
    }

    pub fn limit(&self) -> u32 {
        self.limit
    }

    pub fn check(&self, client: &str, now: Instant) -> Decision {
        let mut clients = self
            .clients
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if clients.len() >= PRUNE_THRESHOLD {
            clients.retain(|_, window| now.duration_since(window.started) < self.window);
        }

        let window = clients.entry(client.to_owned()).or_insert(Window {
            started: now,
            count: 0,
        });
        if now.duration_since(window.started) >= self.window {
            window.started = now;
            window.count = 0;
        }
        let reset_secs = self
            .window
            .saturating_sub(now.duration_since(window.started))
            .as_secs()
            .max(1);

        if window.count >= self.limit {
            return Decision::Limited {
                retry_after_secs: reset_secs,
            };
        }
        window.count += 1;
        Decision::Allowed {
            remaining: self.limit - window.count,
            reset_secs,
        }
    }
}

#[derive(Clone)]
struct CachedResponse {
    status: StatusCode,
    content_type: Option<HeaderValue>,
    body: Bytes,
    stored: Instant,
}

/// A bounded TTL cache of successful GET responses.
pub struct ResponseCache {
    ttl: Duration,
    max_entries: usize,
    entries: Mutex<HashMap<String, CachedResponse>>,
}

impl ResponseCache {
    pub fn new(ttl: Duration, max_entries: usize) -> Self {
        Self {
            ttl,
            max_entries,
            entries: Mutex::new(HashMap::new()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, CachedResponse>> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn get(&self, key: &str, now: Instant) -> Option<CachedResponse> {
        let mut entries = self.lock();
        match entries.get(key) {
            Some(entry) if now.duration_since(entry.stored) < self.ttl => Some(entry.clone()),
            Some(_) => {
                entries.remove(key);
                None
            }
            None => None,
        }
    }

    fn put(&self, key: String, entry: CachedResponse) {
        let mut entries = self.lock();
        if entries.len() >= self.max_entries && !entries.contains_key(&key) {
            let now = entry.stored;
            entries.retain(|_, cached| now.duration_since(cached.stored) < self.ttl);
            // Still full of fresh entries: drop the oldest one to make room.
            if entries.len() >= self.max_entries
                && let Some(oldest) = entries
                    .iter()
                    .min_by_key(|(_, cached)| cached.stored)
                    .map(|(key, _)| key.clone())
            {
                entries.remove(&oldest);
            }
        }
        entries.insert(key, entry);
    }

    /// Drops every cached response. Called when new events are indexed.
    pub fn invalidate(&self) -> usize {
        let mut entries = self.lock();
        let removed = entries.len();
        entries.clear();
        if removed > 0 {
            metrics::record_labeled(metrics::CACHE_INVALIDATIONS, "events");
        }
        removed
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }
}

/// The limiter and cache the middleware consults. Either half may be off.
pub struct Limits {
    pub limiter: Option<RateLimiter>,
    pub cache: Option<ResponseCache>,
    trust_proxy: bool,
}

impl Limits {
    pub fn new(config: &LimitsConfig) -> Self {
        Self {
            limiter: (config.rate_limit_requests > 0)
                .then(|| RateLimiter::new(config.rate_limit_requests, config.rate_limit_window)),
            cache: (!config.cache_ttl.is_zero() && config.cache_max_entries > 0)
                .then(|| ResponseCache::new(config.cache_ttl, config.cache_max_entries)),
            trust_proxy: config.trust_proxy,
        }
    }

    /// Neither limiting nor caching; what tests of unrelated behaviour use.
    pub fn disabled() -> Self {
        Self {
            limiter: None,
            cache: None,
            trust_proxy: false,
        }
    }

    pub fn invalidate_cache(&self) -> usize {
        self.cache.as_ref().map_or(0, ResponseCache::invalidate)
    }
}

/// Only read endpoints that run database queries are worth caching.
fn is_cacheable(method: &Method, path: &str) -> bool {
    method == Method::GET
        && (path == "/proposals" || path.starts_with("/proposals/") || path.starts_with("/spend/"))
}

/// Parameters in a different order are the same query, so sort them.
fn cache_key(path: &str, query: Option<&str>) -> String {
    let mut pairs: Vec<(String, String)> = query
        .and_then(|query| serde_urlencoded::from_str(query).ok())
        .unwrap_or_default();
    pairs.sort();
    let query = serde_urlencoded::to_string(&pairs).unwrap_or_default();
    format!("{path}?{query}")
}

fn client_key(headers: &HeaderMap, peer: Option<SocketAddr>, trust_proxy: bool) -> String {
    if trust_proxy
        && let Some(forwarded) = headers
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(',').next())
            .map(str::trim)
            .filter(|value| !value.is_empty())
    {
        return forwarded.to_owned();
    }
    peer.map_or_else(|| "unknown".to_owned(), |address| address.ip().to_string())
}

fn rate_limit_headers(response: &mut Response, limit: u32, remaining: u32, reset_secs: u64) {
    let headers = response.headers_mut();
    for (name, value) in [
        ("x-ratelimit-limit", limit.to_string()),
        ("x-ratelimit-remaining", remaining.to_string()),
        ("x-ratelimit-reset", reset_secs.to_string()),
    ] {
        if let Ok(value) = HeaderValue::from_str(&value) {
            headers.insert(HeaderName::from_static(name), value);
        }
    }
}

fn limited_response(limit: u32, retry_after_secs: u64) -> Response {
    let body = serde_json::json!({
        "error": {
            "code": "RATE_LIMITED",
            "message": format!(
                "Rate limit of {limit} requests exceeded; retry in {retry_after_secs} seconds"
            ),
            "details": [{
                "field": "retryAfterSeconds",
                "message": retry_after_secs.to_string(),
                "code": "RATE_LIMITED",
            }],
        }
    });
    let mut response = (StatusCode::TOO_MANY_REQUESTS, axum::Json(body)).into_response();
    rate_limit_headers(&mut response, limit, 0, retry_after_secs);
    if let Ok(value) = HeaderValue::from_str(&retry_after_secs.to_string()) {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    response
}

fn cached_to_response(cached: CachedResponse) -> Response {
    let mut response = Response::new(Body::from(cached.body));
    *response.status_mut() = cached.status;
    if let Some(content_type) = cached.content_type {
        response
            .headers_mut()
            .insert(header::CONTENT_TYPE, content_type);
    }
    response
}

fn mark_cache(response: &mut Response, result: &'static str) {
    response
        .headers_mut()
        .insert("x-cache", HeaderValue::from_static(result));
}

/// Middleware: count the request against the client's quota, then serve it
/// from the cache or the handler.
pub async fn guard(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    if EXEMPT_PATHS.contains(&path.as_str()) {
        return next.run(request).await;
    }
    let limits = Arc::clone(&state.limits);

    let mut quota = None;
    if let Some(limiter) = &limits.limiter {
        let peer = request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ConnectInfo(address)| *address);
        let client = client_key(request.headers(), peer, limits.trust_proxy);
        match limiter.check(&client, Instant::now()) {
            Decision::Limited { retry_after_secs } => {
                metrics::record_labeled(metrics::RATE_LIMIT_REQUESTS, "limited");
                tracing::warn!(%client, %path, "request rate limited");
                return limited_response(limiter.limit(), retry_after_secs);
            }
            Decision::Allowed {
                remaining,
                reset_secs,
            } => {
                metrics::record_labeled(metrics::RATE_LIMIT_REQUESTS, "allowed");
                quota = Some((limiter.limit(), remaining, reset_secs));
            }
        }
    }

    let mut response = match &limits.cache {
        Some(cache) if is_cacheable(request.method(), &path) => {
            let key = cache_key(&path, request.uri().query());
            if let Some(cached) = cache.get(&key, Instant::now()) {
                metrics::record_labeled(metrics::CACHE_REQUESTS, "hit");
                let mut response = cached_to_response(cached);
                mark_cache(&mut response, "HIT");
                response
            } else {
                metrics::record_labeled(metrics::CACHE_REQUESTS, "miss");
                let mut response = next.run(request).await;
                if response.status() == StatusCode::OK {
                    let (parts, body) = response.into_parts();
                    match to_bytes(body, MAX_CACHED_BODY_BYTES).await {
                        Ok(bytes) => {
                            cache.put(
                                key,
                                CachedResponse {
                                    status: parts.status,
                                    content_type: parts.headers.get(header::CONTENT_TYPE).cloned(),
                                    body: bytes.clone(),
                                    stored: Instant::now(),
                                },
                            );
                            response = Response::from_parts(parts, Body::from(bytes));
                        }
                        // Too large to cache; the body was consumed, so report it.
                        Err(_) => {
                            response = StatusCode::INTERNAL_SERVER_ERROR.into_response();
                        }
                    }
                }
                mark_cache(&mut response, "MISS");
                response
            }
        }
        _ => next.run(request).await,
    };

    if let Some((limit, remaining, reset_secs)) = quota {
        rate_limit_headers(&mut response, limit, remaining, reset_secs);
    }
    response
}

/// Cache occupancy for the `/metrics` scrape.
pub fn cache_len(limits: &Limits) -> usize {
    limits.cache.as_ref().map_or(0, ResponseCache::len)
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW: Duration = Duration::from_secs(60);

    #[test]
    fn allows_requests_up_to_the_limit_then_refuses() {
        let limiter = RateLimiter::new(2, WINDOW);
        let now = Instant::now();

        assert_eq!(
            limiter.check("a", now),
            Decision::Allowed {
                remaining: 1,
                reset_secs: 60
            }
        );
        assert!(matches!(
            limiter.check("a", now),
            Decision::Allowed { remaining: 0, .. }
        ));
        assert!(matches!(
            limiter.check("a", now + Duration::from_secs(10)),
            Decision::Limited {
                retry_after_secs: 50
            }
        ));
    }

    #[test]
    fn clients_have_independent_quotas() {
        let limiter = RateLimiter::new(1, WINDOW);
        let now = Instant::now();

        assert!(matches!(limiter.check("a", now), Decision::Allowed { .. }));
        assert!(matches!(limiter.check("a", now), Decision::Limited { .. }));
        assert!(matches!(limiter.check("b", now), Decision::Allowed { .. }));
    }

    #[test]
    fn the_quota_resets_when_the_window_closes() {
        let limiter = RateLimiter::new(1, WINDOW);
        let now = Instant::now();

        limiter.check("a", now);
        assert!(matches!(limiter.check("a", now), Decision::Limited { .. }));
        assert!(matches!(
            limiter.check("a", now + WINDOW),
            Decision::Allowed { .. }
        ));
    }

    fn entry(stored: Instant, body: &'static str) -> CachedResponse {
        CachedResponse {
            status: StatusCode::OK,
            content_type: None,
            body: Bytes::from_static(body.as_bytes()),
            stored,
        }
    }

    #[test]
    fn cached_entries_expire_after_the_ttl() {
        let cache = ResponseCache::new(Duration::from_secs(30), 10);
        let now = Instant::now();
        cache.put("k".into(), entry(now, "x"));

        assert!(cache.get("k", now + Duration::from_secs(29)).is_some());
        assert!(cache.get("k", now + Duration::from_secs(30)).is_none());
        assert_eq!(cache.len(), 0, "an expired entry is evicted on read");
    }

    #[test]
    fn the_cache_is_bounded_and_evicts_the_oldest_entry() {
        let cache = ResponseCache::new(Duration::from_secs(300), 2);
        let now = Instant::now();
        cache.put("old".into(), entry(now, "1"));
        cache.put("mid".into(), entry(now + Duration::from_secs(1), "2"));
        cache.put("new".into(), entry(now + Duration::from_secs(2), "3"));

        assert_eq!(cache.len(), 2);
        assert!(cache.get("old", now + Duration::from_secs(3)).is_none());
        assert!(cache.get("new", now + Duration::from_secs(3)).is_some());
    }

    #[test]
    fn invalidate_clears_everything_and_reports_how_much() {
        let cache = ResponseCache::new(Duration::from_secs(300), 10);
        let now = Instant::now();
        cache.put("a".into(), entry(now, "1"));
        cache.put("b".into(), entry(now, "2"));

        assert_eq!(cache.invalidate(), 2);
        assert_eq!(cache.len(), 0);
        assert_eq!(cache.invalidate(), 0);
    }

    #[test]
    fn cache_keys_ignore_parameter_order() {
        assert_eq!(
            cache_key("/proposals", Some("limit=5&status=ready")),
            cache_key("/proposals", Some("status=ready&limit=5"))
        );
        assert_ne!(
            cache_key("/proposals", Some("limit=5")),
            cache_key("/proposals", Some("limit=6"))
        );
    }

    #[test]
    fn only_database_backed_reads_are_cacheable() {
        assert!(is_cacheable(&Method::GET, "/proposals"));
        assert!(is_cacheable(&Method::GET, "/proposals/7"));
        assert!(is_cacheable(&Method::GET, "/spend/by-category"));
        assert!(!is_cacheable(&Method::POST, "/proposals"));
        assert!(!is_cacheable(&Method::POST, "/reports/run"));
        assert!(!is_cacheable(&Method::GET, "/reports"));
    }

    #[test]
    fn the_client_comes_from_the_peer_unless_the_proxy_is_trusted() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("203.0.113.9, 10.0.0.1"),
        );
        let peer: SocketAddr = "192.0.2.1:4000".parse().unwrap();

        assert_eq!(client_key(&headers, Some(peer), false), "192.0.2.1");
        assert_eq!(client_key(&headers, Some(peer), true), "203.0.113.9");
        assert_eq!(client_key(&HeaderMap::new(), None, false), "unknown");
    }

    // --- the middleware, end to end -----------------------------------------

    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::{Router, extract::ConnectInfo, middleware, routing::get};
    use sqlx::postgres::PgPoolOptions;
    use tower::ServiceExt;

    fn state_with(limits: Limits) -> AppState {
        AppState::new(
            PgPoolOptions::new()
                .connect_lazy("postgres://accord:accord@localhost/accord_analytics")
                .unwrap(),
            "test-contract".to_owned(),
        )
        .with_limits(Arc::new(limits))
    }

    /// A router whose handlers count how often they actually run.
    fn counted(state: AppState, hits: &Arc<AtomicUsize>) -> Router {
        let proposals = Arc::clone(hits);
        let failing = Arc::clone(hits);
        Router::new()
            .route(
                "/proposals",
                get(move || {
                    let hits = Arc::clone(&proposals);
                    async move {
                        hits.fetch_add(1, Ordering::SeqCst);
                        axum::Json(serde_json::json!({ "proposals": [] }))
                    }
                }),
            )
            .route(
                "/spend/by-category",
                get(move || {
                    let hits = Arc::clone(&failing);
                    async move {
                        hits.fetch_add(1, Ordering::SeqCst);
                        StatusCode::INTERNAL_SERVER_ERROR
                    }
                }),
            )
            .route("/livez", get(|| async { "ok" }))
            .layer(middleware::from_fn_with_state(state, guard))
    }

    async fn call(router: &Router, uri: &str, client: &str) -> Response {
        let mut request = Request::builder().uri(uri).body(Body::empty()).unwrap();
        let address: SocketAddr = format!("{client}:4000").parse().unwrap();
        request.extensions_mut().insert(ConnectInfo(address));
        router.clone().oneshot(request).await.unwrap()
    }

    fn config(requests: u32, ttl_secs: u64) -> LimitsConfig {
        LimitsConfig {
            rate_limit_requests: requests,
            rate_limit_window: Duration::from_secs(60),
            trust_proxy: false,
            cache_ttl: Duration::from_secs(ttl_secs),
            cache_max_entries: 10,
        }
    }

    #[tokio::test]
    async fn exceeding_the_limit_returns_a_clear_429() {
        let hits = Arc::new(AtomicUsize::new(0));
        let router = counted(state_with(Limits::new(&config(2, 0))), &hits);

        for expected_remaining in ["1", "0"] {
            let response = call(&router, "/proposals", "192.0.2.1").await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()["x-ratelimit-limit"], "2");
            assert_eq!(
                response.headers()["x-ratelimit-remaining"],
                expected_remaining
            );
        }
        let response = call(&router, "/proposals", "192.0.2.1").await;

        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(
            response.headers()["retry-after"]
                .to_str()
                .unwrap()
                .parse::<u64>()
                .unwrap()
                >= 1
        );
        assert_eq!(response.headers()["x-ratelimit-remaining"], "0");
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["error"]["code"], "RATE_LIMITED");
        assert!(
            json["error"]["message"]
                .as_str()
                .unwrap()
                .contains("2 requests")
        );
        assert_eq!(json["error"]["details"][0]["field"], "retryAfterSeconds");
        assert_eq!(
            hits.load(Ordering::SeqCst),
            2,
            "a limited request never reaches the handler"
        );
    }

    #[tokio::test]
    async fn limits_are_per_client_and_probes_are_exempt() {
        let hits = Arc::new(AtomicUsize::new(0));
        let router = counted(state_with(Limits::new(&config(1, 0))), &hits);

        assert_eq!(
            call(&router, "/proposals", "192.0.2.1").await.status(),
            StatusCode::OK
        );
        assert_eq!(
            call(&router, "/proposals", "192.0.2.1").await.status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(
            call(&router, "/proposals", "192.0.2.2").await.status(),
            StatusCode::OK,
            "another client has its own quota"
        );
        for _ in 0..5 {
            assert_eq!(
                call(&router, "/livez", "192.0.2.1").await.status(),
                StatusCode::OK
            );
        }
    }

    #[tokio::test]
    async fn repeated_reads_are_served_from_the_cache() {
        let hits = Arc::new(AtomicUsize::new(0));
        let limits = Limits::new(&config(0, 60));
        let router = counted(state_with(limits), &hits);

        let first = call(&router, "/proposals?limit=5&status=ready", "192.0.2.1").await;
        let second = call(&router, "/proposals?status=ready&limit=5", "192.0.2.1").await;
        let other = call(&router, "/proposals?limit=6", "192.0.2.1").await;

        assert_eq!(first.headers()["x-cache"], "MISS");
        assert_eq!(second.headers()["x-cache"], "HIT");
        assert_eq!(
            other.headers()["x-cache"],
            "MISS",
            "a different query is a different entry"
        );
        assert_eq!(hits.load(Ordering::SeqCst), 2);
        let body = to_bytes(second.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            &body[..],
            br#"{"proposals":[]}"#,
            "the cached body is served unchanged"
        );
    }

    #[tokio::test]
    async fn invalidation_forces_the_next_read_to_the_handler() {
        let hits = Arc::new(AtomicUsize::new(0));
        let state = state_with(Limits::new(&config(0, 60)));
        let limits = Arc::clone(&state.limits);
        let router = counted(state, &hits);

        call(&router, "/proposals", "192.0.2.1").await;
        call(&router, "/proposals", "192.0.2.1").await;
        assert_eq!(hits.load(Ordering::SeqCst), 1);

        assert_eq!(limits.invalidate_cache(), 1);
        let after = call(&router, "/proposals", "192.0.2.1").await;

        assert_eq!(after.headers()["x-cache"], "MISS");
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn failed_responses_are_not_cached() {
        let hits = Arc::new(AtomicUsize::new(0));
        let router = counted(state_with(Limits::new(&config(0, 60))), &hits);

        call(&router, "/spend/by-category", "192.0.2.1").await;
        call(&router, "/spend/by-category", "192.0.2.1").await;

        assert_eq!(
            hits.load(Ordering::SeqCst),
            2,
            "a 500 must be retried, not remembered"
        );
    }

    #[tokio::test]
    async fn limited_requests_are_not_answered_from_the_cache() {
        let hits = Arc::new(AtomicUsize::new(0));
        let router = counted(state_with(Limits::new(&config(1, 60))), &hits);

        call(&router, "/proposals", "192.0.2.1").await;
        let response = call(&router, "/proposals", "192.0.2.1").await;

        assert_eq!(
            response.status(),
            StatusCode::TOO_MANY_REQUESTS,
            "the quota applies to cache hits too"
        );
    }

    #[tokio::test]
    async fn disabled_limits_pass_everything_through() {
        let hits = Arc::new(AtomicUsize::new(0));
        let router = counted(state_with(Limits::disabled()), &hits);

        for _ in 0..3 {
            let response = call(&router, "/proposals", "192.0.2.1").await;
            assert_eq!(response.status(), StatusCode::OK);
            assert!(response.headers().get("x-ratelimit-limit").is_none());
            assert!(response.headers().get("x-cache").is_none());
        }
        assert_eq!(hits.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn limits_are_read_from_the_environment_with_safe_defaults() {
        let defaults = LimitsConfig::default();
        assert_eq!(defaults.rate_limit_requests, 120);
        assert_eq!(defaults.cache_ttl, Duration::from_secs(30));
        assert!(Limits::new(&config(0, 0)).limiter.is_none());
        assert!(Limits::new(&config(0, 0)).cache.is_none());
        assert!(Limits::new(&config(5, 5)).limiter.is_some());
    }
}
