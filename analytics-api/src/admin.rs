//! Optional bearer-token guard for the endpoints that change configuration.
//!
//! Reads stay open, as before. When `ADMIN_TOKEN` is set, every write endpoint
//! (report templates today) must present it as `Authorization: Bearer <token>`.
//! When it is unset the writes are as open as `POST /reports/run` is, so a
//! deployment that exposes the API beyond a trusted network should set it.

use axum::{
    Json,
    http::{HeaderMap, StatusCode, header},
};

use crate::{AppState, proposals::ApiError};

pub(crate) fn require(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let Some(expected) = state.admin_token.as_deref() else {
        return Ok(());
    };
    let presented = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim);
    if presented.is_some_and(|token| constant_time_eq(token.as_bytes(), expected.as_bytes())) {
        return Ok(());
    }
    Err((
        StatusCode::UNAUTHORIZED,
        Json(ApiError::new(
            "UNAUTHORIZED",
            "A valid administrator bearer token is required",
        )),
    ))
}

/// Compares without stopping at the first differing byte.
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

#[cfg(test)]
mod tests {
    use super::constant_time_eq;

    #[test]
    fn compares_whole_tokens() {
        assert!(constant_time_eq(b"secret", b"secret"));
        assert!(!constant_time_eq(b"secret", b"secreT"));
        assert!(!constant_time_eq(b"secret", b"secret2"));
        assert!(!constant_time_eq(b"", b"x"));
    }
}
