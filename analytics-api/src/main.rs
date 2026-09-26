use std::{env, net::SocketAddr};

use anyhow::{Context, Result, bail};
use axum::{Json, Router, http::StatusCode, response::IntoResponse, routing::get};
use serde::Serialize;
use sqlx::{PgPool, postgres::PgPoolOptions};
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

#[derive(Clone)]
struct Config {
    listen_host: String,
    listen_port: u16,
    database_url: String,
}

impl Config {
    fn from_env() -> Result<Self> {
        let listen_host = env::var("LISTEN_HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let listen_port = env::var("LISTEN_PORT")
            .unwrap_or_else(|_| "8080".into())
            .parse()
            .context("LISTEN_PORT must be a valid port number")?;
        let database_url = env::var("DATABASE_URL")
            .context("DATABASE_URL must point to the indexer PostgreSQL database")?;

        if listen_host.is_empty() {
            bail!("LISTEN_HOST must not be empty");
        }

        Ok(Self {
            listen_host,
            listen_port,
            database_url,
        })
    }
}

#[derive(Serialize)]
struct RootResponse {
    service: &'static str,
    status: &'static str,
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    database: &'static str,
}

fn app(pool: PgPool) -> Router {
    Router::new()
        .route("/", get(root))
        .route("/health", get(health))
        .with_state(pool)
}

async fn root() -> Json<RootResponse> {
    Json(RootResponse {
        service: "accord-analytics-api",
        status: "ok",
    })
}

async fn health(pool: axum::extract::State<PgPool>) -> impl IntoResponse {
    match sqlx::query("SELECT 1").execute(&pool.0).await {
        Ok(_) => (
            StatusCode::OK,
            Json(HealthResponse {
                status: "ok",
                database: "connected",
            }),
        ),
        Err(error) => {
            tracing::error!(%error, "analytics database health check failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(HealthResponse {
                    status: "unavailable",
                    database: "disconnected",
                }),
            )
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let config = Config::from_env()?;
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&config.database_url)
        .await
        .context("failed to connect to the analytics datastore")?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("failed to apply analytics datastore migrations")?;

    let address: SocketAddr = format!("{}:{}", config.listen_host, config.listen_port)
        .parse()
        .context("LISTEN_HOST and LISTEN_PORT did not form a valid socket address")?;
    let listener = TcpListener::bind(address)
        .await
        .with_context(|| format!("failed to listen on {address}"))?;

    tracing::info!(%address, "analytics API listening");
    axum::serve(listener, app(pool)).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use axum::{body::Body, http::Request};
    use sqlx::postgres::PgPoolOptions;
    use tower::ServiceExt;

    use super::app;

    #[tokio::test]
    async fn root_returns_service_status() {
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://accord:accord@localhost/accord_analytics")
            .unwrap();
        let response = app(pool)
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::OK);
    }
}