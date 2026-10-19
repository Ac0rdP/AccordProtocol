//! Prometheus metrics for the analytics API.
//!
//! The registry is a small hand-rolled implementation of the text exposition
//! format (version 0.0.4); the service only needs a handful of counters and
//! histograms, so it avoids pulling in a metrics stack.

use std::{
    collections::BTreeMap,
    fmt::Write as _,
    sync::{Mutex, OnceLock},
    time::Instant,
};

use axum::{
    extract::{MatchedPath, Request},
    middleware::Next,
    response::Response,
};

/// Upper bounds (seconds) of the request latency histogram buckets.
const LATENCY_BUCKETS: &[f64] = &[
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
];

/// Counter families keyed by one label: `(name, help, label name)`.
pub(crate) const RATE_LIMIT_REQUESTS: Family = (
    "accord_api_rate_limit_requests_total",
    "Requests counted by the rate limiter, by outcome.",
    "outcome",
);
pub(crate) const CACHE_REQUESTS: Family = (
    "accord_api_cache_requests_total",
    "Cacheable reads, by whether the cache answered them.",
    "result",
);
pub(crate) const CACHE_INVALIDATIONS: Family = (
    "accord_api_cache_invalidations_total",
    "Times the response cache was cleared, by cause.",
    "cause",
);
pub(crate) const ALERTS: Family = (
    "accord_api_alerts_total",
    "Alerts by outcome: fired, suppressed (cooldown or storm cap) or delivery_failed.",
    "outcome",
);
const FAMILIES: &[Family] = &[
    RATE_LIMIT_REQUESTS,
    CACHE_REQUESTS,
    CACHE_INVALIDATIONS,
    ALERTS,
];

pub(crate) type Family = (&'static str, &'static str, &'static str);

pub(crate) const CONTENT_TYPE: &str = "text/plain; version=0.0.4; charset=utf-8";

#[derive(Default)]
struct Histogram {
    /// Observations that fell into each bucket (not cumulative).
    buckets: Vec<u64>,
    sum: f64,
    count: u64,
}

impl Histogram {
    fn observe(&mut self, value: f64) {
        if self.buckets.is_empty() {
            self.buckets = vec![0; LATENCY_BUCKETS.len()];
        }
        if let Some(index) = LATENCY_BUCKETS.iter().position(|bound| value <= *bound) {
            self.buckets[index] += 1;
        }
        self.sum += value;
        self.count += 1;
    }

    fn render(&self, out: &mut String, name: &str, labels: &str) {
        let mut cumulative = 0;
        for (index, bound) in LATENCY_BUCKETS.iter().enumerate() {
            cumulative += self.buckets.get(index).copied().unwrap_or(0);
            let _ = writeln!(out, "{name}_bucket{{{labels},le=\"{bound}\"}} {cumulative}");
        }
        let _ = writeln!(out, "{name}_bucket{{{labels},le=\"+Inf\"}} {}", self.count);
        let _ = writeln!(out, "{name}_sum{{{labels}}} {}", self.sum);
        let _ = writeln!(out, "{name}_count{{{labels}}} {}", self.count);
    }
}

#[derive(Default)]
pub(crate) struct Registry {
    requests: Mutex<BTreeMap<(String, String, u16), u64>>,
    durations: Mutex<BTreeMap<(String, String), Histogram>>,
    errors: Mutex<BTreeMap<String, u64>>,
    rejections: Mutex<BTreeMap<String, u64>>,
    labeled: Mutex<BTreeMap<(&'static str, String), u64>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

impl Registry {
    pub(crate) fn observe_request(&self, method: &str, route: &str, status: u16, seconds: f64) {
        *lock(&self.requests)
            .entry((method.to_owned(), route.to_owned(), status))
            .or_default() += 1;
        lock(&self.durations)
            .entry((method.to_owned(), route.to_owned()))
            .or_default()
            .observe(seconds);
    }

    pub(crate) fn inc_error(&self, kind: &str) {
        *lock(&self.errors).entry(kind.to_owned()).or_default() += 1;
    }

    pub(crate) fn inc_rejection(&self, reason: &str) {
        *lock(&self.rejections).entry(reason.to_owned()).or_default() += 1;
    }

    pub(crate) fn inc_labeled(&self, family: Family, label: &str) {
        *lock(&self.labeled)
            .entry((family.0, label.to_owned()))
            .or_default() += 1;
    }

    /// Renders every registered family. Gauges that are sampled at scrape time
    /// are appended by the caller.
    pub(crate) fn render(&self) -> String {
        let mut out = String::new();

        out.push_str("# HELP accord_api_http_requests_total HTTP requests handled.\n");
        out.push_str("# TYPE accord_api_http_requests_total counter\n");
        for ((method, route, status), value) in lock(&self.requests).iter() {
            let _ = writeln!(
                out,
                "accord_api_http_requests_total{{method=\"{}\",route=\"{}\",status=\"{status}\"}} {value}",
                escape(method),
                escape(route)
            );
        }

        out.push_str(
            "# HELP accord_api_http_request_duration_seconds HTTP request latency in seconds.\n",
        );
        out.push_str("# TYPE accord_api_http_request_duration_seconds histogram\n");
        for ((method, route), histogram) in lock(&self.durations).iter() {
            let labels = format!("method=\"{}\",route=\"{}\"", escape(method), escape(route));
            histogram.render(
                &mut out,
                "accord_api_http_request_duration_seconds",
                &labels,
            );
        }

        out.push_str("# HELP accord_api_errors_total Server-side errors by kind.\n");
        out.push_str("# TYPE accord_api_errors_total counter\n");
        for (kind, value) in lock(&self.errors).iter() {
            let _ = writeln!(
                out,
                "accord_api_errors_total{{kind=\"{}\"}} {value}",
                escape(kind)
            );
        }

        out.push_str(
            "# HELP accord_api_graphql_rejections_total GraphQL requests rejected by safeguards.\n",
        );
        out.push_str("# TYPE accord_api_graphql_rejections_total counter\n");
        for (reason, value) in lock(&self.rejections).iter() {
            let _ = writeln!(
                out,
                "accord_api_graphql_rejections_total{{reason=\"{}\"}} {value}",
                escape(reason)
            );
        }

        let labeled = lock(&self.labeled);
        for (name, help, label_name) in FAMILIES {
            let _ = writeln!(out, "# HELP {name} {help}");
            let _ = writeln!(out, "# TYPE {name} counter");
            for ((family, label), value) in labeled.iter() {
                if family == name {
                    let _ = writeln!(out, "{name}{{{label_name}=\"{}\"}} {value}", escape(label));
                }
            }
        }
        out
    }
}

pub(crate) fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(Registry::default)
}

pub(crate) fn record_error(kind: &str) {
    registry().inc_error(kind);
}

pub(crate) fn record_labeled(family: Family, label: &str) {
    registry().inc_labeled(family, label);
}

pub(crate) fn record_rejection(reason: &str) {
    registry().inc_rejection(reason);
}

/// Middleware recording request count and latency per matched route.
pub(crate) async fn track(request: Request, next: Next) -> Response {
    let method = request.method().as_str().to_owned();
    // Raw paths would make label cardinality unbounded, so only routes that
    // matched a registered pattern are reported by name.
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map_or_else(|| "unmatched".to_owned(), |path| path.as_str().to_owned());
    let started = Instant::now();
    let response = next.run(request).await;
    registry().observe_request(
        &method,
        &route,
        response.status().as_u16(),
        started.elapsed().as_secs_f64(),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::Registry;

    #[test]
    fn renders_cumulative_histogram_buckets() {
        let registry = Registry::default();
        registry.observe_request("GET", "/proposals", 200, 0.004);
        registry.observe_request("GET", "/proposals", 200, 0.2);
        registry.observe_request("GET", "/proposals", 500, 30.0);

        let text = registry.render();

        assert!(text.contains(
            "accord_api_http_requests_total{method=\"GET\",route=\"/proposals\",status=\"200\"} 2"
        ));
        let labels = "method=\"GET\",route=\"/proposals\"";
        assert!(text.contains(&format!(
            "accord_api_http_request_duration_seconds_bucket{{{labels},le=\"0.005\"}} 1"
        )));
        assert!(text.contains(&format!(
            "accord_api_http_request_duration_seconds_bucket{{{labels},le=\"0.25\"}} 2"
        )));
        assert!(text.contains(&format!(
            "accord_api_http_request_duration_seconds_bucket{{{labels},le=\"10\"}} 2"
        )));
        assert!(text.contains(&format!(
            "accord_api_http_request_duration_seconds_bucket{{{labels},le=\"+Inf\"}} 3"
        )));
        assert!(text.contains(&format!(
            "accord_api_http_request_duration_seconds_count{{{labels}}} 3"
        )));
    }

    #[test]
    fn renders_labeled_counter_families() {
        let registry = Registry::default();
        registry.inc_labeled(super::RATE_LIMIT_REQUESTS, "limited");
        registry.inc_labeled(super::CACHE_REQUESTS, "hit");
        registry.inc_labeled(super::CACHE_REQUESTS, "hit");

        let text = registry.render();

        assert!(text.contains("accord_api_rate_limit_requests_total{outcome=\"limited\"} 1"));
        assert!(text.contains("accord_api_cache_requests_total{result=\"hit\"} 2"));
        assert!(text.contains("# TYPE accord_api_cache_invalidations_total counter"));
    }

    #[test]
    fn renders_error_and_rejection_counters() {
        let registry = Registry::default();
        registry.inc_error("database");
        registry.inc_rejection("depth");
        registry.inc_rejection("depth");

        let text = registry.render();

        assert!(text.contains("accord_api_errors_total{kind=\"database\"} 1"));
        assert!(text.contains("accord_api_graphql_rejections_total{reason=\"depth\"} 2"));
    }
}
