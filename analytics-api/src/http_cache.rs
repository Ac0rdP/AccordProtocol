//! Shared response helper for the cacheable analytics reads.
//!
//! The in-memory response cache (`limits.rs`) already short-circuits repeated
//! queries and reports `X-Cache`. Browsers and intermediaries need to be told
//! how long they may reuse a response too, so the reporting endpoints attach a
//! `Cache-Control` header. It is `private` because responses are scoped to the
//! caller's deployment and may sit behind an API key.

use axum::{
    Json,
    http::header,
    response::{IntoResponse, Response},
};
use serde::Serialize;

/// How long a client may reuse a response without asking again. Kept short so
/// a freshly indexed ledger shows up quickly; the server cache is invalidated
/// as soon as the indexer writes new events.
pub(crate) const CACHE_CONTROL: &str = "private, max-age=60";

/// A `200` JSON response carrying `Cache-Control`.
pub(crate) fn json<T: Serialize>(body: T) -> Response {
    ([(header::CACHE_CONTROL, CACHE_CONTROL)], Json(body)).into_response()
}

/// `current` as a percentage change over `base`; `None` when there is nothing to
/// compare against (a zero or missing base), so a first period never shows an
/// infinite or `NaN` delta.
pub(crate) fn percent_change(current: f64, base: f64) -> Option<f64> {
    if base == 0.0 || !base.is_finite() || !current.is_finite() {
        return None;
    }
    Some(((current - base) / base.abs() * 10_000.0).round() / 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_change_compares_against_the_base_magnitude() {
        assert_eq!(percent_change(150.0, 100.0), Some(50.0));
        assert_eq!(percent_change(50.0, 100.0), Some(-50.0));
        assert_eq!(percent_change(-50.0, -100.0), Some(50.0));
    }

    #[test]
    fn percent_change_has_no_value_without_a_base() {
        assert_eq!(percent_change(10.0, 0.0), None);
        assert_eq!(percent_change(f64::NAN, 5.0), None);
    }
}
