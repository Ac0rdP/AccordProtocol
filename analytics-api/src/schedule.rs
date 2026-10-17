use std::{env, fs, path::PathBuf, str::FromStr, sync::Arc, time::Duration};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use cron::Schedule;
use serde::Serialize;
use sqlx::{PgPool, types::Json as SqlJson};

use crate::{
    mail::{
        DirectoryReportTransport, ReportAttachment, ReportEnvelope, ReportTransport,
        SmtpReportTransport, deliver_with_retry,
    },
    reports::{ReportFormat, ReportPeriod, TreasuryReport},
};

const DEFAULT_FROM: &str = "accord-analytics@localhost";

/// Everything the scheduled report pipeline needs: when to run, what to
/// produce, where to send it and how hard to retry.
#[derive(Clone, Debug)]
pub struct ReportConfig {
    pub schedule: Option<Schedule>,
    pub expression: Option<String>,
    pub formats: Vec<ReportFormat>,
    pub recipients: Vec<String>,
    pub period_days: i64,
    pub output_dir: Option<PathBuf>,
    pub max_attempts: u32,
    pub retry_backoff: Duration,
    pub from: String,
}

/// What the configuration looks like over the wire on `GET /reports`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportConfigSummary {
    pub schedule: Option<String>,
    pub formats: Vec<String>,
    pub recipients: Vec<String>,
    pub period_days: i64,
    pub max_attempts: u32,
    pub retry_backoff_ms: u64,
    pub output_dir: Option<String>,
    pub delivery: String,
}

fn split_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect()
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

impl ReportConfig {
    pub fn from_env() -> Result<Self> {
        let expression = env::var("REPORT_SCHEDULE")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        let schedule = match expression.as_deref() {
            None => None,
            Some(value) => Some(Schedule::from_str(value).with_context(|| {
                format!(
                    "REPORT_SCHEDULE \"{value}\" is not a valid cron expression \
                     (seconds minutes hours day-of-month month day-of-week, for example \"0 0 6 1 * *\")"
                )
            })?),
        };

        let formats = split_list(&env::var("REPORT_FORMATS").unwrap_or_else(|_| "csv,pdf".into()))
            .into_iter()
            .map(|value| value.parse::<ReportFormat>())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| anyhow::anyhow!("REPORT_FORMATS is invalid: {error}"))?;
        if formats.is_empty() {
            bail!("REPORT_FORMATS must name at least one of csv, pdf");
        }

        let period_days: i64 = parse_env("REPORT_PERIOD_DAYS", 30)?;
        if period_days < 1 {
            bail!("REPORT_PERIOD_DAYS must be at least 1");
        }

        Ok(Self {
            schedule,
            expression,
            formats,
            recipients: split_list(&env::var("REPORT_RECIPIENTS").unwrap_or_default()),
            period_days,
            output_dir: env::var("REPORT_OUTPUT_DIR")
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
                .map(PathBuf::from),
            max_attempts: parse_env("REPORT_MAX_ATTEMPTS", 3u32)?.max(1),
            retry_backoff: Duration::from_millis(parse_env("REPORT_RETRY_BACKOFF_MS", 2000u64)?),
            from: env::var("REPORT_FROM")
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| DEFAULT_FROM.to_owned()),
        })
    }

    /// Builds the delivery transport: SMTP when `SMTP_URL` is set, otherwise a
    /// directory drop when `REPORT_OUTPUT_DIR` is set. With neither, reports are
    /// generated and recorded but not delivered.
    pub fn transport_from_env(&self) -> Result<Option<Arc<dyn ReportTransport>>> {
        if let Ok(url) = env::var("SMTP_URL")
            && !url.trim().is_empty()
        {
            let transport = SmtpReportTransport::new(url.trim(), &self.from)
                .map_err(|error| anyhow::anyhow!(error))?;
            return Ok(Some(Arc::new(transport)));
        }
        if let Some(directory) = &self.output_dir {
            return Ok(Some(Arc::new(DirectoryReportTransport::new(
                directory.join("delivered"),
            ))));
        }
        Ok(None)
    }

    pub fn summary(&self, transport: Option<&Arc<dyn ReportTransport>>) -> ReportConfigSummary {
        ReportConfigSummary {
            schedule: self.expression.clone(),
            formats: self
                .formats
                .iter()
                .map(|format| format.as_str().to_owned())
                .collect(),
            recipients: self.recipients.clone(),
            period_days: self.period_days,
            max_attempts: self.max_attempts,
            retry_backoff_ms: self.retry_backoff.as_millis() as u64,
            output_dir: self
                .output_dir
                .as_ref()
                .map(|path| path.display().to_string()),
            delivery: match transport {
                Some(transport) if !self.recipients.is_empty() => transport.describe(),
                Some(_) => "disabled (no REPORT_RECIPIENTS configured)".to_owned(),
                None => "disabled (set SMTP_URL or REPORT_OUTPUT_DIR)".to_owned(),
            },
        }
    }

    pub fn next_run_after(&self, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
        self.schedule
            .as_ref()
            .and_then(|schedule| schedule.after(&after).next())
    }
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ReportRunRecord {
    pub id: i64,
    pub network: String,
    pub contract_id: String,
    pub period_start: DateTime<Utc>,
    pub period_end: DateTime<Utc>,
    pub format: String,
    pub trigger_source: String,
    pub status: String,
    pub attempts: i32,
    pub recipients: SqlJson<Vec<String>>,
    pub byte_size: i64,
    pub file_path: Option<String>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub delivered_at: Option<DateTime<Utc>>,
}

struct RunOutcome {
    status: &'static str,
    attempts: i32,
    byte_size: i64,
    file_path: Option<String>,
    error: Option<String>,
    delivered_at: Option<DateTime<Utc>>,
}

#[allow(clippy::too_many_arguments)]
async fn record_run(
    pool: &PgPool,
    network: &str,
    contract_id: &str,
    period: ReportPeriod,
    format: ReportFormat,
    trigger_source: &str,
    recipients: &[String],
    outcome: RunOutcome,
) -> sqlx::Result<ReportRunRecord> {
    sqlx::query_as::<_, ReportRunRecord>(
        "INSERT INTO report_runs (network, contract_id, period_start, period_end, format, \
         trigger_source, status, attempts, recipients, byte_size, file_path, error, delivered_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) \
         RETURNING id, network, contract_id, period_start, period_end, format, trigger_source, \
         status, attempts, recipients, byte_size, file_path, error, created_at, delivered_at",
    )
    .bind(network)
    .bind(contract_id)
    .bind(period.start)
    .bind(period.end)
    .bind(format.as_str())
    .bind(trigger_source)
    .bind(outcome.status)
    .bind(outcome.attempts)
    .bind(SqlJson(recipients.to_vec()))
    .bind(outcome.byte_size)
    .bind(outcome.file_path)
    .bind(outcome.error)
    .bind(outcome.delivered_at)
    .fetch_one(pool)
    .await
}

async fn already_delivered(
    pool: &PgPool,
    network: &str,
    contract_id: &str,
    period: ReportPeriod,
    format: ReportFormat,
) -> sqlx::Result<bool> {
    let existing: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM report_runs WHERE network = $1 AND contract_id = $2 \
         AND period_start = $3 AND period_end = $4 AND format = $5 \
         AND status = 'delivered' LIMIT 1",
    )
    .bind(network)
    .bind(contract_id)
    .bind(period.start)
    .bind(period.end)
    .bind(format.as_str())
    .fetch_optional(pool)
    .await?;
    Ok(existing.is_some())
}

fn write_to_output_dir(
    config: &ReportConfig,
    report: &TreasuryReport,
    format: ReportFormat,
    bytes: &[u8],
) -> Result<Option<String>, String> {
    let Some(directory) = &config.output_dir else {
        return Ok(None);
    };
    fs::create_dir_all(directory)
        .map_err(|error| format!("failed to create {}: {error}", directory.display()))?;
    let path = directory.join(report.filename(format));
    fs::write(&path, bytes).map_err(|error| format!("failed to write {}: {error}", path.display()))?;
    Ok(Some(path.display().to_string()))
}

/// Generates every configured format for every (network, contract) pair and
/// delivers it. One failing pair or format never stops the others: each records
/// its own row, and a failure that exhausts its retries is logged at error
/// level so log-based alerting picks it up.
pub async fn run_reports(
    pool: &PgPool,
    pairs: &[(String, String)],
    config: &ReportConfig,
    transport: Option<&Arc<dyn ReportTransport>>,
    trigger_source: &str,
    period: ReportPeriod,
    now: DateTime<Utc>,
) -> Vec<ReportRunRecord> {
    let mut records = Vec::new();

    for (network, contract_id) in pairs {
        for &format in &config.formats {
            if trigger_source == "scheduled"
                && matches!(
                    already_delivered(pool, network, contract_id, period, format).await,
                    Ok(true)
                )
            {
                tracing::debug!(%network, %contract_id, %format, "report already delivered for this period");
                continue;
            }

            let outcome = match generate_and_deliver(
                pool, network, contract_id, config, transport, period, format, now,
            )
            .await
            {
                Ok(outcome) => outcome,
                Err(error) => {
                    tracing::error!(
                        %network, %contract_id, %format, %error,
                        "treasury report generation failed"
                    );
                    RunOutcome {
                        status: "failed",
                        attempts: 0,
                        byte_size: 0,
                        file_path: None,
                        error: Some(error),
                        delivered_at: None,
                    }
                }
            };

            if outcome.status == "failed" {
                tracing::error!(
                    %network, %contract_id, %format,
                    attempts = outcome.attempts,
                    error = outcome.error.as_deref().unwrap_or("unknown"),
                    "treasury report run failed after exhausting its retries"
                );
            }

            match record_run(
                pool,
                network,
                contract_id,
                period,
                format,
                trigger_source,
                &config.recipients,
                outcome,
            )
            .await
            {
                Ok(record) => records.push(record),
                Err(error) => tracing::error!(
                    %network, %contract_id, %format, %error,
                    "failed to record the treasury report run"
                ),
            }
        }
    }

    records
}

#[allow(clippy::too_many_arguments)]
async fn generate_and_deliver(
    pool: &PgPool,
    network: &str,
    contract_id: &str,
    config: &ReportConfig,
    transport: Option<&Arc<dyn ReportTransport>>,
    period: ReportPeriod,
    format: ReportFormat,
    now: DateTime<Utc>,
) -> Result<RunOutcome, String> {
    let report = TreasuryReport::load(pool, network, contract_id, period, now)
        .await
        .map_err(|error| format!("failed to read indexed records: {error}"))?;
    let bytes = report.render(format)?;
    let byte_size = bytes.len() as i64;
    let file_path = write_to_output_dir(config, &report, format, &bytes)?;

    let (Some(transport), false) = (transport, config.recipients.is_empty()) else {
        return Ok(RunOutcome {
            status: "generated",
            attempts: 0,
            byte_size,
            file_path,
            error: None,
            delivered_at: None,
        });
    };

    let envelope = ReportEnvelope {
        subject: report.title(),
        body: format!(
            "The attached {} report covers {} on {} for contract {}.",
            format.as_str(),
            period_label(period),
            network,
            contract_id
        ),
        recipients: config.recipients.clone(),
        attachments: vec![ReportAttachment {
            filename: report.filename(format),
            content_type: format.content_type().to_owned(),
            bytes,
        }],
    };

    match deliver_with_retry(
        transport.as_ref(),
        &envelope,
        config.max_attempts,
        config.retry_backoff,
    )
    .await
    {
        Ok(attempts) => Ok(RunOutcome {
            status: "delivered",
            attempts: attempts as i32,
            byte_size,
            file_path,
            error: None,
            delivered_at: Some(Utc::now()),
        }),
        Err((attempts, error)) => Ok(RunOutcome {
            status: "failed",
            attempts: attempts as i32,
            byte_size,
            file_path,
            error: Some(error),
            delivered_at: None,
        }),
    }
}

fn period_label(period: ReportPeriod) -> String {
    format!(
        "{} to {}",
        period.start.format("%Y-%m-%d"),
        period.end.format("%Y-%m-%d")
    )
}

/// Runs the configured schedule until the process exits. Returns `None` when no
/// `REPORT_SCHEDULE` is configured, so the service stays quiet by default.
pub fn spawn(
    pool: PgPool,
    pairs: Vec<(String, String)>,
    config: Arc<ReportConfig>,
    transport: Option<Arc<dyn ReportTransport>>,
) -> Option<tokio::task::JoinHandle<()>> {
    config.schedule.as_ref()?;
    let expression = config.expression.clone().unwrap_or_default();
    tracing::info!(
        schedule = %expression,
        pairs = pairs.len(),
        "scheduled treasury reports enabled"
    );

    Some(tokio::spawn(async move {
        loop {
            let Some(next) = config.next_run_after(Utc::now()) else {
                tracing::warn!("report schedule has no further run times; stopping the scheduler");
                return;
            };
            let wait = (next - Utc::now()).to_std().unwrap_or(Duration::ZERO);
            tracing::info!(next_run = %next, "waiting for the next treasury report run");
            tokio::time::sleep(wait).await;

            let now = Utc::now();
            let period = ReportPeriod::ending_at(now, config.period_days);
            let records = run_reports(
                &pool,
                &pairs,
                &config,
                transport.as_ref(),
                "scheduled",
                period,
                now,
            )
            .await;
            tracing::info!(
                runs = records.len(),
                failed = records
                    .iter()
                    .filter(|record| record.status == "failed")
                    .count(),
                "scheduled treasury report run finished"
            );
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn config(expression: &str) -> ReportConfig {
        ReportConfig {
            schedule: Some(Schedule::from_str(expression).unwrap()),
            expression: Some(expression.to_owned()),
            formats: vec![ReportFormat::Csv, ReportFormat::Pdf],
            recipients: vec!["treasury@example.com".to_owned()],
            period_days: 30,
            output_dir: None,
            max_attempts: 3,
            retry_backoff: Duration::from_millis(10),
            from: DEFAULT_FROM.to_owned(),
        }
    }

    #[test]
    fn computes_the_next_run_from_a_cron_expression() {
        // 06:00 UTC on the first day of every month.
        let config = config("0 0 6 1 * *");
        let after = Utc.with_ymd_and_hms(2026, 9, 15, 12, 0, 0).unwrap();

        assert_eq!(
            config.next_run_after(after),
            Some(Utc.with_ymd_and_hms(2026, 10, 1, 6, 0, 0).unwrap())
        );
    }

    #[test]
    fn a_weekly_schedule_advances_one_week_at_a_time() {
        let config = config("0 0 6 * * Mon");
        let first = config
            .next_run_after(Utc.with_ymd_and_hms(2026, 9, 15, 12, 0, 0).unwrap())
            .unwrap();
        let second = config.next_run_after(first).unwrap();

        assert_eq!(first, Utc.with_ymd_and_hms(2026, 9, 21, 6, 0, 0).unwrap());
        assert_eq!(second - first, chrono::Duration::days(7));
    }

    #[test]
    fn no_schedule_means_no_runs() {
        let mut config = config("0 0 6 1 * *");
        config.schedule = None;
        config.expression = None;

        assert_eq!(config.next_run_after(Utc::now()), None);
    }

    #[test]
    fn rejects_an_invalid_cron_expression() {
        assert!(Schedule::from_str("every monday please").is_err());
    }

    #[test]
    fn a_scheduled_period_ends_at_the_run_time() {
        let now = Utc.with_ymd_and_hms(2026, 10, 1, 6, 0, 0).unwrap();
        let period = ReportPeriod::ending_at(now, config("0 0 6 1 * *").period_days);

        assert_eq!(period.end, now);
        assert_eq!(period.start, Utc.with_ymd_and_hms(2026, 9, 1, 6, 0, 0).unwrap());
    }

    #[test]
    fn the_summary_says_why_delivery_is_disabled() {
        let summary = config("0 0 6 1 * *").summary(None);

        assert_eq!(summary.schedule.as_deref(), Some("0 0 6 1 * *"));
        assert_eq!(summary.formats, vec!["csv".to_owned(), "pdf".to_owned()]);
        assert!(summary.delivery.contains("SMTP_URL"));
    }

    #[test]
    fn the_summary_names_the_transport_when_delivery_is_configured() {
        let transport: Arc<dyn ReportTransport> =
            Arc::new(DirectoryReportTransport::new("/tmp/accord-reports"));
        let summary = config("0 0 6 1 * *").summary(Some(&transport));

        assert!(summary.delivery.contains("/tmp/accord-reports"));
    }

    #[test]
    fn recipients_are_required_for_delivery() {
        let mut config = config("0 0 6 1 * *");
        config.recipients.clear();
        let transport: Arc<dyn ReportTransport> =
            Arc::new(DirectoryReportTransport::new("/tmp/accord-reports"));

        assert!(
            config
                .summary(Some(&transport))
                .delivery
                .contains("REPORT_RECIPIENTS")
        );
    }
}
