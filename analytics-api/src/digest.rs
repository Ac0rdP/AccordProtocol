//! Owner digest emails: a periodic summary of the pending and ready proposals
//! that still need an owner's approval, mailed straight to that owner.
//!
//! Owners no longer have to poll the dashboard to know what is waiting on them.
//! The digest is built from the indexed `proposals` table and sent through the
//! same transport as scheduled reports and alert emails (`SMTP_URL`, or the
//! `REPORT_OUTPUT_DIR` directory drop), so operators configure mail once.
//!
//! Preferences are per owner and come from `OWNER_DIGEST_PREFERENCES` (inline
//! JSON) or `OWNER_DIGEST_PREFERENCES_FILE`, mirroring `ALERT_RULES`: an array
//! of `{ network, contractId, owner, email, enabled, notifyPending,
//! notifyReady }`. A digest is only sent when at least one actionable proposal
//! remains after the owner's preferences and existing approvals are applied.

use std::{env, fs, str::FromStr, sync::Arc, time::Duration};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use cron::Schedule;
use serde::Deserialize;
use sqlx::{PgPool, types::Json as SqlJson};

use crate::mail::{ReportEnvelope, ReportTransport, deliver_with_retry};

const DEFAULT_LINK_BASE: &str = "http://localhost:5173";
const STATUS_READY: &str = "ready";
const STATUS_PENDING: &str = "pending";

fn enabled_by_default() -> bool {
    true
}

/// One owner's digest settings and delivery address.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DigestPreference {
    pub network: String,
    pub contract_id: String,
    pub owner: String,
    pub email: String,
    /// A disabled entry keeps the address on file but receives nothing.
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    /// Include proposals still gathering approvals.
    #[serde(default = "enabled_by_default")]
    pub notify_pending: bool,
    /// Include proposals that already have enough approvals to execute.
    #[serde(default = "enabled_by_default")]
    pub notify_ready: bool,
}

/// A proposal as the digest renders it.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct DigestProposal {
    pub proposal_id: i64,
    pub status: String,
    pub category: String,
    pub description: String,
    pub recipient: String,
    pub amount: String,
    pub token: String,
    pub deadline: DateTime<Utc>,
    pub approver_addresses: SqlJson<Vec<String>>,
}

/// The rendered email for one owner.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DigestEmail {
    pub to: String,
    pub subject: String,
    pub text: String,
}

/// What happened to one owner's digest during a run.
#[derive(Clone, Debug)]
pub struct DigestOutcome {
    pub owner: String,
    pub status: &'static str,
    pub proposal_count: usize,
    pub attempts: u32,
    pub error: Option<String>,
}

/// Everything the digest pipeline needs: when to run, where links point and how
/// hard to retry a failed delivery.
#[derive(Clone, Debug)]
pub struct DigestConfig {
    pub schedule: Option<Schedule>,
    pub expression: Option<String>,
    pub link_base: String,
    pub preferences: Vec<DigestPreference>,
    pub max_attempts: u32,
    pub retry_backoff: Duration,
}

fn parse_number<T: FromStr>(name: &str, default: T) -> Result<T>
where
    T::Err: std::fmt::Display,
{
    match env::var(name) {
        Ok(value) if !value.trim().is_empty() => value
            .trim()
            .parse()
            .map_err(|error| anyhow::anyhow!("{name} is invalid: {error}")),
        _ => Ok(default),
    }
}

fn is_valid_email(value: &str) -> bool {
    if value.chars().any(char::is_whitespace) {
        return false;
    }
    let mut parts = value.split('@');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(local), Some(domain), None) => {
            !local.is_empty()
                && !domain.is_empty()
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
        }
        _ => false,
    }
}

/// Parses and validates the preference array, defaulting the optional booleans
/// to `true` and rejecting entries that could never be delivered.
pub fn parse_preferences(json: &str) -> Result<Vec<DigestPreference>> {
    let raw: Vec<DigestPreference> = serde_json::from_str(json).context(
        "OWNER_DIGEST_PREFERENCES must be a JSON array of {network, contractId, owner, email} objects",
    )?;

    let mut preferences = Vec::with_capacity(raw.len());
    let mut seen = std::collections::HashSet::new();
    for mut preference in raw {
        preference.network = preference.network.trim().to_owned();
        preference.contract_id = preference.contract_id.trim().to_owned();
        preference.owner = preference.owner.trim().to_owned();
        preference.email = preference.email.trim().to_owned();

        if preference.network.is_empty() {
            bail!("owner digest preference is missing network");
        }
        if preference.contract_id.is_empty() {
            bail!(
                "owner digest preference for {} is missing contractId",
                preference.owner
            );
        }
        if preference.owner.is_empty() {
            bail!("owner digest preference is missing owner");
        }
        if !is_valid_email(&preference.email) {
            bail!(
                "owner digest preference for {} has an invalid email \"{}\"",
                preference.owner,
                preference.email
            );
        }
        let key = (
            preference.network.clone(),
            preference.contract_id.clone(),
            preference.owner.clone(),
        );
        if !seen.insert(key) {
            bail!(
                "owner digest preferences list {} twice on {} ({})",
                preference.owner,
                preference.contract_id,
                preference.network
            );
        }
        preferences.push(preference);
    }
    Ok(preferences)
}

impl DigestConfig {
    /// Reads the schedule, preferences and delivery tuning from the
    /// environment. With no `OWNER_DIGEST_SCHEDULE` the pipeline is off.
    pub fn from_env() -> Result<Self> {
        let expression = env::var("OWNER_DIGEST_SCHEDULE")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        let schedule = match expression.as_deref() {
            None => None,
            Some(value) => Some(Schedule::from_str(value).with_context(|| {
                format!(
                    "OWNER_DIGEST_SCHEDULE \"{value}\" is not a valid cron expression \
                     (seconds minutes hours day-of-month month day-of-week, for example \"0 0 8 * * Mon\")"
                )
            })?),
        };

        let json = match (
            env::var("OWNER_DIGEST_PREFERENCES_FILE"),
            env::var("OWNER_DIGEST_PREFERENCES"),
        ) {
            (Ok(path), _) if !path.trim().is_empty() => {
                Some(fs::read_to_string(path.trim()).with_context(|| {
                    format!(
                        "failed to read OWNER_DIGEST_PREFERENCES_FILE {}",
                        path.trim()
                    )
                })?)
            }
            (_, Ok(inline)) if !inline.trim().is_empty() => Some(inline),
            _ => None,
        };
        let preferences = match json {
            Some(json) => parse_preferences(&json)?,
            None => Vec::new(),
        };

        let link_base = env::var("OWNER_DIGEST_LINK_BASE_URL")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| DEFAULT_LINK_BASE.to_owned());
        if !(link_base.starts_with("http://") || link_base.starts_with("https://")) {
            bail!("OWNER_DIGEST_LINK_BASE_URL must be an http:// or https:// URL");
        }

        Ok(Self {
            schedule,
            expression,
            link_base,
            preferences,
            max_attempts: parse_number("OWNER_DIGEST_MAX_ATTEMPTS", 3u32)?.max(1),
            retry_backoff: Duration::from_millis(parse_number(
                "OWNER_DIGEST_RETRY_BACKOFF_MS",
                2000u64,
            )?),
        })
    }

    pub fn next_run_after(&self, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
        self.schedule
            .as_ref()
            .and_then(|schedule| schedule.after(&after).next())
    }
}

/// The open proposals for one workspace, ready ones first then by deadline.
pub async fn load_open_proposals(
    pool: &PgPool,
    network: &str,
    contract_id: &str,
) -> sqlx::Result<Vec<DigestProposal>> {
    sqlx::query_as::<_, DigestProposal>(
        "SELECT proposal_id, status, category, description, recipient, amount, token, \
         deadline, approver_addresses FROM proposals \
         WHERE network = $1 AND contract_id = $2 AND status IN ('pending', 'ready') \
         ORDER BY CASE status WHEN 'ready' THEN 0 ELSE 1 END, deadline ASC, proposal_id ASC",
    )
    .bind(network)
    .bind(contract_id)
    .fetch_all(pool)
    .await
}

/// The proposals that still need `preference.owner` to act: the chosen event
/// types are enabled, and a `pending` proposal the owner already approved is
/// dropped. A `ready` proposal is kept even if the owner approved it, because
/// it still has to be executed.
pub fn actionable_proposals<'a>(
    preference: &DigestPreference,
    proposals: &'a [DigestProposal],
) -> Vec<&'a DigestProposal> {
    let already_approved = |proposal: &DigestProposal| {
        proposal
            .approver_addresses
            .0
            .iter()
            .any(|approver| approver == &preference.owner)
    };
    proposals
        .iter()
        .filter(|proposal| match proposal.status.as_str() {
            STATUS_PENDING => preference.notify_pending && !already_approved(proposal),
            STATUS_READY => preference.notify_ready,
            _ => false,
        })
        .collect()
}

/// Builds a direct dashboard link to one proposal, carrying the workspace so
/// multi-contract deployments open the right one.
pub fn proposal_link(
    link_base: &str,
    network: &str,
    contract_id: &str,
    proposal_id: i64,
) -> String {
    format!(
        "{}/proposals/{}?contractId={}&network={}",
        link_base.trim_end_matches('/'),
        proposal_id,
        contract_id,
        network
    )
}

fn normalize_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate(text: &str, width: usize) -> String {
    if text.chars().count() <= width {
        return text.to_owned();
    }
    let mut shortened: String = text.chars().take(width.saturating_sub(3)).collect();
    shortened.push_str("...");
    shortened
}

/// Renders the digest for one owner. Returns `None` when the owner is disabled
/// or nothing needs their action, so an empty digest is never sent.
pub fn build_digest(
    preference: &DigestPreference,
    proposals: &[DigestProposal],
    link_base: &str,
    generated_at: DateTime<Utc>,
) -> Option<DigestEmail> {
    if !preference.enabled {
        return None;
    }
    let actionable = actionable_proposals(preference, proposals);
    if actionable.is_empty() {
        return None;
    }

    let ready: Vec<&DigestProposal> = actionable
        .iter()
        .copied()
        .filter(|proposal| proposal.status == STATUS_READY)
        .collect();
    let pending: Vec<&DigestProposal> = actionable
        .iter()
        .copied()
        .filter(|proposal| proposal.status == STATUS_PENDING)
        .collect();

    let mut text = format!(
        "Hello {owner},\n\n\
         {count} proposal{plural} {verb} your attention on {network} ({contract}).\n\n",
        owner = preference.owner,
        count = actionable.len(),
        plural = if actionable.len() == 1 { "" } else { "s" },
        verb = if actionable.len() == 1 {
            "needs"
        } else {
            "need"
        },
        network = preference.network,
        contract = preference.contract_id,
    );
    for (heading, group) in [("Ready to execute", &ready), ("Pending approval", &pending)] {
        if group.is_empty() {
            continue;
        }
        text.push_str(heading);
        text.push_str(":\n");
        for proposal in group.iter().copied() {
            text.push_str(&describe_with_base(preference, proposal, link_base));
            text.push('\n');
        }
        text.push('\n');
    }
    text.push_str(&format!(
        "Open {base}/proposals?contractId={contract}&network={network} to review them all.\n\n\
         Sent {generated}. You are receiving this because owner digest emails are enabled for your address.",
        base = link_base.trim_end_matches('/'),
        contract = preference.contract_id,
        network = preference.network,
        generated = generated_at.format("%Y-%m-%d %H:%M UTC"),
    ));

    Some(DigestEmail {
        to: preference.email.clone(),
        subject: if actionable.len() == 1 {
            "Accord: 1 proposal needs your attention".to_owned()
        } else {
            format!("Accord: {} proposals need your attention", actionable.len())
        },
        text,
    })
}

fn describe_with_base(
    preference: &DigestPreference,
    proposal: &DigestProposal,
    link_base: &str,
) -> String {
    let link = proposal_link(
        link_base,
        &preference.network,
        &preference.contract_id,
        proposal.proposal_id,
    );
    let description = normalize_line(&proposal.description);
    let description = if description.is_empty() {
        "No description".to_owned()
    } else {
        truncate(&description, 120)
    };
    format!(
        "- #{} [{}] {}: {} {} -> {} (deadline {}). {}",
        proposal.proposal_id,
        proposal.category,
        description,
        proposal.amount,
        proposal.token,
        truncate(&proposal.recipient, 20),
        proposal.deadline.format("%Y-%m-%d"),
        link
    )
}

/// Builds and delivers one digest per configured owner. A failed read or
/// delivery is recorded on that owner's outcome and never stops the others.
pub async fn run_digests(
    pool: &PgPool,
    config: &DigestConfig,
    transport: Option<&Arc<dyn ReportTransport>>,
    now: DateTime<Utc>,
) -> Vec<DigestOutcome> {
    let mut outcomes = Vec::with_capacity(config.preferences.len());
    for preference in &config.preferences {
        if !preference.enabled {
            outcomes.push(DigestOutcome {
                owner: preference.owner.clone(),
                status: "skipped",
                proposal_count: 0,
                attempts: 0,
                error: Some("digest is disabled for this owner".to_owned()),
            });
            continue;
        }

        let proposals =
            match load_open_proposals(pool, &preference.network, &preference.contract_id).await {
                Ok(proposals) => proposals,
                Err(error) => {
                    tracing::error!(
                        %error,
                        owner = %preference.owner,
                        "failed to load proposals for the owner digest"
                    );
                    outcomes.push(DigestOutcome {
                        owner: preference.owner.clone(),
                        status: "failed",
                        proposal_count: 0,
                        attempts: 0,
                        error: Some(format!("failed to read indexed proposals: {error}")),
                    });
                    continue;
                }
            };

        let count = actionable_proposals(preference, &proposals).len();
        let Some(email) = build_digest(preference, &proposals, &config.link_base, now) else {
            outcomes.push(DigestOutcome {
                owner: preference.owner.clone(),
                status: "skipped",
                proposal_count: count,
                attempts: 0,
                error: None,
            });
            continue;
        };
        let Some(transport) = transport else {
            tracing::error!(
                owner = %preference.owner,
                "owner digest email needs SMTP_URL or REPORT_OUTPUT_DIR"
            );
            outcomes.push(DigestOutcome {
                owner: preference.owner.clone(),
                status: "skipped",
                proposal_count: count,
                attempts: 0,
                error: Some("email delivery is not configured".to_owned()),
            });
            continue;
        };

        let envelope = ReportEnvelope {
            subject: email.subject,
            body: email.text,
            recipients: vec![email.to],
            attachments: Vec::new(),
        };
        match deliver_with_retry(
            transport.as_ref(),
            &envelope,
            config.max_attempts,
            config.retry_backoff,
        )
        .await
        {
            Ok(attempts) => outcomes.push(DigestOutcome {
                owner: preference.owner.clone(),
                status: "delivered",
                proposal_count: count,
                attempts,
                error: None,
            }),
            Err((attempts, error)) => {
                tracing::error!(
                    owner = %preference.owner,
                    attempts,
                    %error,
                    "owner digest email failed after exhausting its retries"
                );
                outcomes.push(DigestOutcome {
                    owner: preference.owner.clone(),
                    status: "failed",
                    proposal_count: count,
                    attempts,
                    error: Some(error),
                });
            }
        }
    }
    outcomes
}

/// Runs the configured schedule until the process exits. Returns `None` when no
/// `OWNER_DIGEST_SCHEDULE` is configured, so the service stays quiet by default.
pub fn spawn(
    pool: PgPool,
    config: Arc<DigestConfig>,
    transport: Option<Arc<dyn ReportTransport>>,
) -> Option<tokio::task::JoinHandle<()>> {
    config.schedule.as_ref()?;
    let expression = config.expression.clone().unwrap_or_default();
    tracing::info!(
        schedule = %expression,
        owners = config.preferences.len(),
        "scheduled owner digest emails enabled"
    );

    Some(tokio::spawn(async move {
        loop {
            let Some(next) = config.next_run_after(Utc::now()) else {
                tracing::warn!(
                    "owner digest schedule has no further run times; stopping the scheduler"
                );
                return;
            };
            let wait = (next - Utc::now()).to_std().unwrap_or(Duration::ZERO);
            tracing::info!(next_run = %next, "waiting for the next owner digest run");
            tokio::time::sleep(wait).await;

            let outcomes = run_digests(&pool, &config, transport.as_ref(), Utc::now()).await;
            for outcome in &outcomes {
                if outcome.status != "delivered" {
                    tracing::debug!(
                        owner = %outcome.owner,
                        status = outcome.status,
                        proposals = outcome.proposal_count,
                        attempts = outcome.attempts,
                        error = outcome.error.as_deref(),
                        "owner digest outcome"
                    );
                }
            }
            let delivered = outcomes
                .iter()
                .filter(|outcome| outcome.status == "delivered")
                .count();
            let failed = outcomes
                .iter()
                .filter(|outcome| outcome.status == "failed")
                .count();
            tracing::info!(
                delivered,
                failed,
                owners = outcomes.len(),
                "owner digest run finished"
            );
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn preference() -> DigestPreference {
        DigestPreference {
            network: "testnet".to_owned(),
            contract_id: "test-contract".to_owned(),
            owner: "GOWNER".to_owned(),
            email: "owner@example.com".to_owned(),
            enabled: true,
            notify_pending: true,
            notify_ready: true,
        }
    }

    fn proposal(id: i64, status: &str, approvers: &[&str]) -> DigestProposal {
        DigestProposal {
            proposal_id: id,
            status: status.to_owned(),
            category: "Payroll".to_owned(),
            description: "Pay the team".to_owned(),
            recipient: "GRECIPIENT".to_owned(),
            amount: "100".to_owned(),
            token: "USDC".to_owned(),
            deadline: Utc.with_ymd_and_hms(2026, 12, 1, 12, 0, 0).unwrap(),
            approver_addresses: SqlJson(approvers.iter().map(|a| (*a).to_owned()).collect()),
        }
    }

    fn at() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 23, 8, 0, 0).unwrap()
    }

    #[test]
    fn digest_lists_pending_and_ready_proposals_with_direct_links() {
        let proposals = vec![
            proposal(3, STATUS_READY, &[]),
            proposal(2, STATUS_PENDING, &[]),
        ];
        let email = build_digest(&preference(), &proposals, "https://app.example", at()).unwrap();

        assert_eq!(email.to, "owner@example.com");
        assert_eq!(email.subject, "Accord: 2 proposals need your attention");
        assert!(email.text.contains("Ready to execute:"));
        assert!(email.text.contains("Pending approval:"));
        assert!(email.text.contains("Hello GOWNER,"));
        assert!(
            email.text.contains(
                "https://app.example/proposals/3?contractId=test-contract&network=testnet"
            )
        );
        assert!(
            email.text.contains(
                "https://app.example/proposals/2?contractId=test-contract&network=testnet"
            )
        );
        assert!(email.text.contains("100 USDC"));
        assert!(email.text.contains("2026-12-01"));
    }

    #[test]
    fn a_single_proposal_uses_a_singular_subject() {
        let email =
            build_digest(&preference(), &[proposal(1, STATUS_PENDING, &[])], "", at()).unwrap();

        assert_eq!(email.subject, "Accord: 1 proposal needs your attention");
        assert!(email.text.contains("1 proposal needs your attention"));
    }

    #[test]
    fn pending_preferences_are_respected() {
        let mut pref = preference();
        pref.notify_pending = false;
        let proposals = vec![
            proposal(3, STATUS_READY, &[]),
            proposal(2, STATUS_PENDING, &[]),
        ];
        let email = build_digest(&pref, &proposals, "", at()).unwrap();

        assert!(email.text.contains("#3"));
        assert!(!email.text.contains("#2"));
        assert!(!email.text.contains("Pending approval:"));
        assert_eq!(email.subject, "Accord: 1 proposal needs your attention");
    }

    #[test]
    fn ready_preferences_are_respected() {
        let mut pref = preference();
        pref.notify_ready = false;
        let proposals = vec![
            proposal(3, STATUS_READY, &[]),
            proposal(2, STATUS_PENDING, &[]),
        ];
        let email = build_digest(&pref, &proposals, "", at()).unwrap();

        assert!(email.text.contains("#2"));
        assert!(!email.text.contains("#3"));
        assert!(!email.text.contains("Ready to execute:"));
    }

    #[test]
    fn proposals_the_owner_already_approved_are_skipped_when_pending() {
        let proposals = vec![
            proposal(3, STATUS_READY, &["GOWNER"]),
            proposal(2, STATUS_PENDING, &["GOWNER"]),
            proposal(1, STATUS_PENDING, &["GOTHER"]),
        ];
        let email = build_digest(&preference(), &proposals, "", at()).unwrap();

        assert!(
            email.text.contains("#3"),
            "a ready proposal still needs executing"
        );
        assert!(
            !email.text.contains("#2"),
            "an approved pending proposal needs nothing"
        );
        assert!(email.text.contains("#1"));
        assert_eq!(email.subject, "Accord: 2 proposals need your attention");
    }

    #[test]
    fn no_actionable_proposals_means_no_email() {
        assert!(build_digest(&preference(), &[], "", at()).is_none());

        let mut pref = preference();
        pref.notify_pending = false;
        pref.notify_ready = false;
        assert!(build_digest(&pref, &[proposal(1, STATUS_PENDING, &[])], "", at()).is_none());
    }

    #[test]
    fn a_disabled_owner_receives_nothing() {
        let mut pref = preference();
        pref.enabled = false;

        assert!(build_digest(&pref, &[proposal(1, STATUS_PENDING, &[])], "", at()).is_none());
    }

    #[test]
    fn link_base_trailing_slash_is_normalised() {
        let link = proposal_link("https://app.example/", "pubnet", "CABC", 7);

        assert_eq!(
            link,
            "https://app.example/proposals/7?contractId=CABC&network=pubnet"
        );
    }

    #[test]
    fn descriptions_are_collapsed_and_truncated_in_one_line() {
        let mut p = proposal(1, STATUS_PENDING, &[]);
        p.description = format!("line one\nline two\t{}", "x".repeat(300));
        let email = build_digest(&preference(), &[p], "", at()).unwrap();
        let line = email
            .text
            .lines()
            .find(|line| line.contains("#1 ["))
            .unwrap();

        assert!(!line.contains('\n'));
        assert!(line.contains("line one line two"));
        assert!(line.contains("..."));
    }

    #[test]
    fn preferences_parse_with_defaults_and_trimming() {
        let parsed = parse_preferences(
            r#"[
                {"network":" testnet ","contractId":" CABC ","owner":" GOWNER ",
                 "email":" owner@example.com "}
            ]"#,
        )
        .unwrap();

        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].network, "testnet");
        assert_eq!(parsed[0].contract_id, "CABC");
        assert_eq!(parsed[0].owner, "GOWNER");
        assert_eq!(parsed[0].email, "owner@example.com");
        assert!(parsed[0].enabled);
        assert!(parsed[0].notify_pending);
        assert!(parsed[0].notify_ready);
    }

    #[test]
    fn preferences_honour_explicit_toggles() {
        let parsed = parse_preferences(
            r#"[{"network":"testnet","contractId":"CABC","owner":"GOWNER",
                 "email":"owner@example.com","enabled":false,
                 "notifyPending":false,"notifyReady":false}]"#,
        )
        .unwrap();

        assert!(!parsed[0].enabled);
        assert!(!parsed[0].notify_pending);
        assert!(!parsed[0].notify_ready);
    }

    #[test]
    fn preferences_reject_invalid_email_and_duplicates() {
        assert!(
            parse_preferences(
                r#"[{"network":"testnet","contractId":"CABC","owner":"GOWNER","email":"nope"}]"#
            )
            .is_err()
        );
        assert!(
            parse_preferences(
                r#"[
                    {"network":"testnet","contractId":"CABC","owner":"GOWNER","email":"a@example.com"},
                    {"network":"testnet","contractId":"CABC","owner":"GOWNER","email":"b@example.com"}
                ]"#
            )
            .is_err()
        );
        assert!(
            parse_preferences(
                r#"[{"network":"testnet","contractId":"CABC","owner":"GOWNER",
                     "email":"a@example.com","unknown":true}]"#
            )
            .is_err()
        );
    }

    fn config(expression: &str) -> DigestConfig {
        DigestConfig {
            schedule: Some(Schedule::from_str(expression).unwrap()),
            expression: Some(expression.to_owned()),
            link_base: DEFAULT_LINK_BASE.to_owned(),
            preferences: Vec::new(),
            max_attempts: 3,
            retry_backoff: Duration::from_millis(10),
        }
    }

    #[test]
    fn computes_the_next_run_from_a_cron_expression() {
        // 08:00 UTC every Monday.
        let config = config("0 0 8 * * Mon");
        let after = Utc.with_ymd_and_hms(2026, 11, 23, 9, 0, 0).unwrap();

        assert_eq!(
            config.next_run_after(after),
            Some(Utc.with_ymd_and_hms(2026, 11, 30, 8, 0, 0).unwrap())
        );
    }

    #[test]
    fn no_schedule_means_no_runs() {
        let mut config = config("0 0 8 * * Mon");
        config.schedule = None;
        config.expression = None;

        assert_eq!(config.next_run_after(Utc::now()), None);
    }
}
