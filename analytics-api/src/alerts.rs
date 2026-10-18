//! Alerting on indexed data: spend thresholds and unusual approval patterns.
//!
//! Rules are configured from the environment (`ALERT_RULES` or
//! `ALERT_RULES_FILE`, a JSON array). The watcher polls the indexed `transfers`
//! and `proposal_approvals` tables for rows it has not seen, feeds them to the
//! [`AlertEngine`], records every alert it raises, and hands each one to the
//! configured notification channels.
//!
//! Alert storms are held back three ways: every rule has a per-subject
//! cooldown, the engine caps how many alerts it raises per storm window, and
//! each alert is stored under a dedupe key so reprocessing an event (a restart,
//! a reindex) can never notify twice. All timing uses the *event* time, so the
//! behaviour is deterministic and identical when replaying history.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    env, fs,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Timelike, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;

use crate::{
    limits::Limits,
    mail::{ReportEnvelope, ReportTransport},
    metrics,
};

/// How many event keys the engine remembers to ignore re-delivered events.
const SEEN_CAPACITY: usize = 50_000;
/// Rows read from each source per poll, so a large backlog is drained in steps.
const POLL_BATCH: i64 = 500;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Info,
    Warning,
    Critical,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warning => "warning",
            Self::Critical => "critical",
        }
    }
}

fn default_severity() -> Severity {
    Severity::Warning
}

/// What a rule watches for.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuleKind {
    /// Total transferred out within a rolling window reaches `threshold`
    /// (in the token's smallest unit). `token` limits it to one asset.
    #[serde(rename_all = "camelCase")]
    SpendThreshold {
        token: Option<String>,
        threshold: String,
        window_secs: u64,
    },
    /// One owner approves more than `max_approvals` proposals within a window.
    #[serde(rename_all = "camelCase")]
    ApprovalBurst {
        max_approvals: u32,
        window_secs: u64,
    },
    /// An approval lands inside the UTC hours `[startHour, endHour)`, which wrap
    /// past midnight when `startHour > endHour`.
    #[serde(rename_all = "camelCase")]
    OffHoursApproval { start_hour: u32, end_hour: u32 },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    #[serde(flatten)]
    pub kind: RuleKind,
    #[serde(default = "default_severity")]
    pub severity: Severity,
    /// Overrides the engine-wide cooldown for this rule.
    #[serde(default)]
    pub cooldown_secs: Option<u64>,
}

impl Rule {
    fn validate(&self) -> Result<()> {
        if self.id.trim().is_empty() {
            bail!("an alert rule needs a non-empty id");
        }
        match &self.kind {
            RuleKind::SpendThreshold {
                threshold,
                window_secs,
                ..
            } => {
                let parsed: i128 = threshold.parse().with_context(|| {
                    format!(
                        "rule {}: threshold must be an integer in the token's smallest unit",
                        self.id
                    )
                })?;
                if parsed <= 0 {
                    bail!("rule {}: threshold must be positive", self.id);
                }
                if *window_secs == 0 {
                    bail!("rule {}: windowSecs must be at least 1", self.id);
                }
            }
            RuleKind::ApprovalBurst {
                max_approvals,
                window_secs,
            } => {
                if *max_approvals == 0 {
                    bail!("rule {}: maxApprovals must be at least 1", self.id);
                }
                if *window_secs == 0 {
                    bail!("rule {}: windowSecs must be at least 1", self.id);
                }
            }
            RuleKind::OffHoursApproval {
                start_hour,
                end_hour,
            } => {
                if *start_hour > 23 || *end_hour > 23 || start_hour == end_hour {
                    bail!(
                        "rule {}: startHour and endHour must be different hours between 0 and 23",
                        self.id
                    );
                }
            }
        }
        Ok(())
    }

    fn kind_name(&self) -> &'static str {
        match self.kind {
            RuleKind::SpendThreshold { .. } => "spend_threshold",
            RuleKind::ApprovalBurst { .. } => "approval_burst",
            RuleKind::OffHoursApproval { .. } => "off_hours_approval",
        }
    }
}

fn reject_unknown_fields(rule: &serde_json::Value) -> Result<()> {
    let common = ["id", "type", "severity", "cooldownSecs"];
    let specific: &[&str] = match rule.get("type").and_then(serde_json::Value::as_str) {
        Some("spend_threshold") => &["token", "threshold", "windowSecs"],
        Some("approval_burst") => &["maxApprovals", "windowSecs"],
        Some("off_hours_approval") => &["startHour", "endHour"],
        _ => bail!(
            "alert rules need a type of spend_threshold, approval_burst or off_hours_approval"
        ),
    };
    if let Some(fields) = rule.as_object() {
        for field in fields.keys() {
            if !common.contains(&field.as_str()) && !specific.contains(&field.as_str()) {
                bail!(
                    "alert rule {} has an unknown field \"{field}\"",
                    rule.get("id")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("?")
                );
            }
        }
    }
    Ok(())
}

/// Parses and validates a JSON array of rules. Ids must be unique.
pub fn parse_rules(json: &str) -> Result<Vec<Rule>> {
    let raw: Vec<serde_json::Value> =
        serde_json::from_str(json).context("alert rules must be a JSON array of rule objects")?;
    // serde cannot reject unknown fields on a flattened enum, so a typo such as
    // `cooldownSec` is caught here instead of silently turning a setting off.
    for rule in &raw {
        reject_unknown_fields(rule)?;
    }
    let rules: Vec<Rule> =
        serde_json::from_str(json).context("alert rules must be a JSON array of rule objects")?;
    let mut ids = HashSet::new();
    for rule in &rules {
        rule.validate()?;
        if !ids.insert(rule.id.clone()) {
            bail!("alert rule id \"{}\" is used more than once", rule.id);
        }
    }
    Ok(rules)
}

/// Limits on how many alerts the engine may raise.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StormSettings {
    /// Default quiet period per (rule, subject) after it alerts.
    pub cooldown: Duration,
    /// At most this many alerts per `window`, across every rule.
    pub max_alerts: u32,
    pub window: Duration,
}

impl Default for StormSettings {
    fn default() -> Self {
        Self {
            cooldown: Duration::from_secs(900),
            max_alerts: 20,
            window: Duration::from_secs(600),
        }
    }
}

/// An indexed event the engine can evaluate. `key` is the event's chain
/// position (`ledger:tx:index`), used to ignore re-delivered events.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AlertEvent {
    Transfer {
        key: String,
        network: String,
        contract_id: String,
        token: String,
        amount: i128,
        occurred_at: DateTime<Utc>,
    },
    Approval {
        key: String,
        network: String,
        contract_id: String,
        owner: String,
        proposal_id: Option<i64>,
        occurred_at: DateTime<Utc>,
    },
}

impl AlertEvent {
    fn key(&self) -> &str {
        match self {
            Self::Transfer { key, .. } | Self::Approval { key, .. } => key,
        }
    }

    fn occurred_at(&self) -> DateTime<Utc> {
        match self {
            Self::Transfer { occurred_at, .. } | Self::Approval { occurred_at, .. } => *occurred_at,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    pub rule_id: String,
    pub kind: String,
    pub severity: Severity,
    pub network: String,
    pub contract_id: String,
    pub subject: String,
    pub message: String,
    pub details: serde_json::Value,
    pub fired_at: DateTime<Utc>,
    /// Stable identity: the same rule, subject and triggering event always map
    /// to the same key, so storing it twice is a no-op.
    pub dedupe_key: String,
}

/// What evaluating one event produced.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Evaluation {
    pub alerts: Vec<Alert>,
    /// Rule matches held back by a cooldown or the storm cap.
    pub suppressed: u32,
}

type SubjectKey = (usize, String, String, String);

#[derive(Default)]
struct EngineState {
    /// Rolling samples per (rule, network, contract, subject).
    windows: HashMap<SubjectKey, VecDeque<(DateTime<Utc>, i128)>>,
    last_fired: HashMap<SubjectKey, DateTime<Utc>>,
    fired_recently: VecDeque<DateTime<Utc>>,
    seen: HashSet<String>,
    seen_order: VecDeque<String>,
}

pub struct AlertEngine {
    rules: Vec<Rule>,
    settings: StormSettings,
    state: Mutex<EngineState>,
}

fn secs(seconds: u64) -> chrono::Duration {
    chrono::Duration::seconds(i64::try_from(seconds).unwrap_or(i64::MAX / 1000))
}

fn within(duration: Duration) -> chrono::Duration {
    secs(duration.as_secs())
}

impl AlertEngine {
    pub fn new(rules: Vec<Rule>, settings: StormSettings) -> Self {
        Self {
            rules,
            settings,
            state: Mutex::new(EngineState::default()),
        }
    }

    pub fn rules(&self) -> &[Rule] {
        &self.rules
    }

    pub fn settings(&self) -> &StormSettings {
        &self.settings
    }

    /// Evaluates one event against every rule. An event the engine has already
    /// seen is ignored, so replaying events never produces a second alert.
    pub fn evaluate(&self, event: &AlertEvent) -> Evaluation {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        if !state.seen.insert(event.key().to_owned()) {
            return Evaluation::default();
        }
        state.seen_order.push_back(event.key().to_owned());
        if state.seen_order.len() > SEEN_CAPACITY
            && let Some(oldest) = state.seen_order.pop_front()
        {
            state.seen.remove(&oldest);
        }

        let mut evaluation = Evaluation::default();
        let at = event.occurred_at();
        for (index, rule) in self.rules.iter().enumerate() {
            let Some(hit) = self.observe(&mut state, index, rule, event) else {
                continue;
            };
            let subject_key = (
                index,
                hit.network.clone(),
                hit.contract_id.clone(),
                hit.subject.clone(),
            );

            let cooldown = rule
                .cooldown_secs
                .map_or_else(|| within(self.settings.cooldown), secs);
            let cooling = state
                .last_fired
                .get(&subject_key)
                .is_some_and(|last| at - *last < cooldown);

            let storm_window = within(self.settings.window);
            while state
                .fired_recently
                .front()
                .is_some_and(|fired| at - *fired >= storm_window)
            {
                state.fired_recently.pop_front();
            }
            let capped = state.fired_recently.len() >= self.settings.max_alerts as usize;

            if cooling || capped {
                evaluation.suppressed += 1;
                continue;
            }

            state.last_fired.insert(subject_key, at);
            state.fired_recently.push_back(at);
            evaluation.alerts.push(Alert {
                rule_id: rule.id.clone(),
                kind: rule.kind_name().to_owned(),
                severity: rule.severity,
                dedupe_key: format!(
                    "{}:{}:{}:{}:{}",
                    rule.id,
                    hit.network,
                    hit.contract_id,
                    hit.subject,
                    event.key()
                ),
                network: hit.network,
                contract_id: hit.contract_id,
                subject: hit.subject,
                message: hit.message,
                details: hit.details,
                fired_at: at,
            });
        }
        evaluation
    }

    /// Updates the rule's window with the event and reports whether the rule
    /// now matches.
    fn observe(
        &self,
        state: &mut EngineState,
        index: usize,
        rule: &Rule,
        event: &AlertEvent,
    ) -> Option<Hit> {
        match (&rule.kind, event) {
            (
                RuleKind::SpendThreshold {
                    token,
                    threshold,
                    window_secs,
                },
                AlertEvent::Transfer {
                    network,
                    contract_id,
                    token: event_token,
                    amount,
                    occurred_at,
                    ..
                },
            ) => {
                if token.as_deref().is_some_and(|wanted| wanted != event_token) {
                    return None;
                }
                let limit: i128 = threshold.parse().ok()?;
                let total = push_sample(
                    state,
                    (
                        index,
                        network.clone(),
                        contract_id.clone(),
                        event_token.clone(),
                    ),
                    *occurred_at,
                    *amount,
                    secs(*window_secs),
                );
                (total >= limit).then(|| Hit {
                    network: network.clone(),
                    contract_id: contract_id.clone(),
                    subject: event_token.clone(),
                    message: format!(
                        "Spend of {total} {event_token} in the last {window_secs}s reached the \
                         {limit} threshold on {contract_id} ({network})"
                    ),
                    details: serde_json::json!({
                        "token": event_token,
                        "total": total.to_string(),
                        "threshold": threshold,
                        "windowSecs": window_secs,
                    }),
                })
            }
            (
                RuleKind::ApprovalBurst {
                    max_approvals,
                    window_secs,
                },
                AlertEvent::Approval {
                    network,
                    contract_id,
                    owner,
                    occurred_at,
                    ..
                },
            ) => {
                let count = push_sample(
                    state,
                    (index, network.clone(), contract_id.clone(), owner.clone()),
                    *occurred_at,
                    1,
                    secs(*window_secs),
                );
                (count > i128::from(*max_approvals)).then(|| Hit {
                    network: network.clone(),
                    contract_id: contract_id.clone(),
                    subject: owner.clone(),
                    message: format!(
                        "{owner} approved {count} proposals in {window_secs}s (limit \
                         {max_approvals}) on {contract_id} ({network})"
                    ),
                    details: serde_json::json!({
                        "owner": owner,
                        "approvals": count,
                        "maxApprovals": max_approvals,
                        "windowSecs": window_secs,
                    }),
                })
            }
            (
                RuleKind::OffHoursApproval {
                    start_hour,
                    end_hour,
                },
                AlertEvent::Approval {
                    network,
                    contract_id,
                    owner,
                    proposal_id,
                    occurred_at,
                    ..
                },
            ) => {
                let hour = occurred_at.hour();
                let inside = if start_hour < end_hour {
                    (*start_hour..*end_hour).contains(&hour)
                } else {
                    hour >= *start_hour || hour < *end_hour
                };
                inside.then(|| Hit {
                    network: network.clone(),
                    contract_id: contract_id.clone(),
                    subject: owner.clone(),
                    message: format!(
                        "{owner} approved a proposal at {hour:02}:00 UTC, inside the \
                         {start_hour:02}:00-{end_hour:02}:00 off-hours window on {contract_id} \
                         ({network})"
                    ),
                    details: serde_json::json!({
                        "owner": owner,
                        "proposalId": proposal_id,
                        "hourUtc": hour,
                    }),
                })
            }
            _ => None,
        }
    }
}

struct Hit {
    network: String,
    contract_id: String,
    subject: String,
    message: String,
    details: serde_json::Value,
}

/// Adds a sample, drops samples that left the window, and returns the sum.
fn push_sample(
    state: &mut EngineState,
    key: SubjectKey,
    at: DateTime<Utc>,
    value: i128,
    window: chrono::Duration,
) -> i128 {
    let samples = state.windows.entry(key).or_default();
    samples.push_back((at, value));
    while samples
        .front()
        .is_some_and(|(sampled, _)| at - *sampled >= window)
    {
        samples.pop_front();
    }
    samples.iter().map(|(_, value)| *value).sum()
}

// --- notification channels -------------------------------------------------

pub type ChannelFuture<'a> = Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;

/// Where an alert is delivered.
pub trait AlertChannel: Send + Sync {
    fn name(&self) -> String;

    fn send<'a>(&'a self, alert: &'a Alert) -> ChannelFuture<'a>;
}

/// Writes alerts to the service log, so there is always at least one channel.
pub struct LogChannel;

impl AlertChannel for LogChannel {
    fn name(&self) -> String {
        "log".to_owned()
    }

    fn send<'a>(&'a self, alert: &'a Alert) -> ChannelFuture<'a> {
        Box::pin(async move {
            tracing::warn!(
                rule = %alert.rule_id,
                severity = alert.severity.as_str(),
                subject = %alert.subject,
                "ALERT: {}",
                alert.message
            );
            Ok(())
        })
    }
}

/// Emails alerts through the same transport scheduled reports use.
pub struct EmailChannel {
    transport: Arc<dyn ReportTransport>,
    recipients: Vec<String>,
}

impl EmailChannel {
    pub fn new(transport: Arc<dyn ReportTransport>, recipients: Vec<String>) -> Self {
        Self {
            transport,
            recipients,
        }
    }
}

impl AlertChannel for EmailChannel {
    fn name(&self) -> String {
        format!("email({})", self.transport.describe())
    }

    fn send<'a>(&'a self, alert: &'a Alert) -> ChannelFuture<'a> {
        Box::pin(async move {
            let envelope = ReportEnvelope {
                subject: format!(
                    "[Accord {}] {}",
                    alert.severity.as_str().to_uppercase(),
                    alert.rule_id
                ),
                body: format!(
                    "{}\n\nrule: {} ({})\nnetwork: {}\ncontract: {}\nat: {}\ndetails: {}\n",
                    alert.message,
                    alert.rule_id,
                    alert.kind,
                    alert.network,
                    alert.contract_id,
                    alert.fired_at.to_rfc3339(),
                    alert.details
                ),
                recipients: self.recipients.clone(),
                attachments: Vec::new(),
            };
            self.transport.send(&envelope).await
        })
    }
}

/// The outcome of routing one alert through every channel.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
pub struct Delivery {
    pub delivered: Vec<String>,
    pub failed: Vec<String>,
}

/// Sends the alert to every channel. One failing channel never blocks the rest.
pub async fn dispatch(channels: &[Arc<dyn AlertChannel>], alert: &Alert) -> Delivery {
    let mut delivery = Delivery::default();
    for channel in channels {
        match channel.send(alert).await {
            Ok(()) => delivery.delivered.push(channel.name()),
            Err(error) => {
                tracing::error!(channel = %channel.name(), %error, "alert delivery failed");
                metrics::record_labeled(metrics::ALERTS, "delivery_failed");
                delivery.failed.push(channel.name());
            }
        }
    }
    delivery
}

// --- configuration ---------------------------------------------------------

#[derive(Clone)]
pub struct AlertConfig {
    pub rules: Vec<Rule>,
    pub settings: StormSettings,
    pub channels: Vec<String>,
    pub recipients: Vec<String>,
    pub poll_interval: Duration,
    /// Evaluate history already indexed when alerting is first switched on.
    /// Off by default so enabling alerts does not replay an old backlog.
    pub backfill: bool,
}

fn env_number<T: std::str::FromStr>(name: &str, default: T) -> Result<T>
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

fn split_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect()
}

impl AlertConfig {
    /// `None` when no rules are configured: alerting is then off entirely.
    pub fn from_env() -> Result<Option<Self>> {
        let json = match (env::var("ALERT_RULES_FILE"), env::var("ALERT_RULES")) {
            (Ok(path), _) if !path.trim().is_empty() => Some(
                fs::read_to_string(path.trim())
                    .with_context(|| format!("failed to read ALERT_RULES_FILE {}", path.trim()))?,
            ),
            (_, Ok(inline)) if !inline.trim().is_empty() => Some(inline),
            _ => None,
        };
        let Some(json) = json else {
            return Ok(None);
        };
        let rules = parse_rules(&json)?;
        if rules.is_empty() {
            return Ok(None);
        }

        let defaults = StormSettings::default();
        let max_alerts = env_number("ALERT_MAX_PER_WINDOW", defaults.max_alerts)?;
        let window_secs = env_number("ALERT_STORM_WINDOW_SECS", defaults.window.as_secs())?;
        if max_alerts == 0 || window_secs == 0 {
            bail!("ALERT_MAX_PER_WINDOW and ALERT_STORM_WINDOW_SECS must be at least 1");
        }
        let poll_secs: u64 = env_number("ALERT_POLL_SECS", 15)?;
        if poll_secs == 0 {
            bail!("ALERT_POLL_SECS must be at least 1");
        }

        Ok(Some(Self {
            rules,
            settings: StormSettings {
                cooldown: Duration::from_secs(env_number(
                    "ALERT_COOLDOWN_SECS",
                    defaults.cooldown.as_secs(),
                )?),
                max_alerts,
                window: Duration::from_secs(window_secs),
            },
            channels: split_list(&env::var("ALERT_CHANNELS").unwrap_or_else(|_| "log".into())),
            recipients: split_list(&env::var("ALERT_RECIPIENTS").unwrap_or_default()),
            poll_interval: Duration::from_secs(poll_secs),
            backfill: env_number("ALERT_BACKFILL", false)?,
        }))
    }

    /// Builds the channels named by `ALERT_CHANNELS`.
    pub fn build_channels(
        &self,
        transport: Option<Arc<dyn ReportTransport>>,
    ) -> Result<Vec<Arc<dyn AlertChannel>>> {
        let mut channels: Vec<Arc<dyn AlertChannel>> = Vec::new();
        for name in &self.channels {
            match name.as_str() {
                "log" => channels.push(Arc::new(LogChannel)),
                "email" => {
                    let transport = transport.clone().context(
                        "ALERT_CHANNELS includes email, which needs SMTP_URL or REPORT_OUTPUT_DIR",
                    )?;
                    if self.recipients.is_empty() {
                        bail!("ALERT_CHANNELS includes email, which needs ALERT_RECIPIENTS");
                    }
                    channels.push(Arc::new(EmailChannel::new(
                        transport,
                        self.recipients.clone(),
                    )));
                }
                other => {
                    bail!("ALERT_CHANNELS names an unknown channel \"{other}\" (use log, email)")
                }
            }
        }
        if channels.is_empty() {
            bail!("ALERT_CHANNELS must name at least one channel (log, email)");
        }
        Ok(channels)
    }
}

// --- the event watcher -----------------------------------------------------

#[derive(sqlx::FromRow)]
struct TransferRow {
    ledger: i64,
    tx_hash: String,
    event_index: i32,
    token: String,
    amount: String,
    occurred_at: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct ApprovalRow {
    ledger: i64,
    tx_hash: String,
    event_index: i32,
    owner: String,
    proposal_id: i64,
    occurred_at: DateTime<Utc>,
}

const TRANSFERS: &str = "transfers";
const APPROVALS: &str = "proposal_approvals";

async fn read_cursor(
    pool: &PgPool,
    source: &str,
    network: &str,
    contract_id: &str,
) -> Result<Option<i64>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT last_ledger FROM alert_cursors \
         WHERE source = $1 AND network = $2 AND contract_id = $3",
    )
    .bind(source)
    .bind(network)
    .bind(contract_id)
    .fetch_optional(pool)
    .await
}

async fn write_cursor(
    pool: &PgPool,
    source: &str,
    network: &str,
    contract_id: &str,
    ledger: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO alert_cursors (source, network, contract_id, last_ledger) \
         VALUES ($1, $2, $3, $4) \
         ON CONFLICT (source, network, contract_id) \
         DO UPDATE SET last_ledger = EXCLUDED.last_ledger, updated_at = NOW()",
    )
    .bind(source)
    .bind(network)
    .bind(contract_id)
    .bind(ledger)
    .execute(pool)
    .await
    .map(|_| ())
}

/// The newest ledger across every indexed source for a pair; a cheap stamp that
/// moves whenever the indexer writes anything.
async fn data_stamp(pool: &PgPool, pairs: &[(String, String)]) -> Result<i64, sqlx::Error> {
    let networks: Vec<&str> = pairs.iter().map(|(network, _)| network.as_str()).collect();
    let contracts: Vec<&str> = pairs
        .iter()
        .map(|(_, contract)| contract.as_str())
        .collect();
    sqlx::query_scalar(
        "SELECT COALESCE(GREATEST( \
            (SELECT MAX(ledger) FROM events WHERE network = ANY($1) AND contract_id = ANY($2)), \
            (SELECT MAX(ledger) FROM transfers WHERE network = ANY($1) AND contract_id = ANY($2)), \
            (SELECT MAX(ledger) FROM proposal_approvals WHERE network = ANY($1) AND contract_id = ANY($2)) \
         ), 0)::bigint",
    )
    .bind(&networks)
    .bind(&contracts)
    .fetch_one(pool)
    .await
}

async fn current_tip(
    pool: &PgPool,
    table: &str,
    network: &str,
    contract_id: &str,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(&format!(
        "SELECT COALESCE(MAX(ledger), 0)::bigint FROM {table} \
         WHERE network = $1 AND contract_id = $2"
    ))
    .bind(network)
    .bind(contract_id)
    .fetch_one(pool)
    .await
}

/// Reads the cursor, seeding it at the current tip the first time unless the
/// operator asked for history to be evaluated.
async fn cursor_or_seed(
    pool: &PgPool,
    source: &str,
    network: &str,
    contract_id: &str,
    backfill: bool,
) -> Result<i64, sqlx::Error> {
    if let Some(cursor) = read_cursor(pool, source, network, contract_id).await? {
        return Ok(cursor);
    }
    let seed = if backfill {
        0
    } else {
        current_tip(pool, source, network, contract_id).await?
    };
    write_cursor(pool, source, network, contract_id, seed).await?;
    Ok(seed)
}

async fn record_alert(pool: &PgPool, alert: &Alert) -> Result<Option<i64>, sqlx::Error> {
    sqlx::query_scalar(
        "INSERT INTO alerts (dedupe_key, rule_id, kind, severity, network, contract_id, \
         subject, message, details, fired_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) \
         ON CONFLICT (dedupe_key) DO NOTHING RETURNING id",
    )
    .bind(&alert.dedupe_key)
    .bind(&alert.rule_id)
    .bind(&alert.kind)
    .bind(alert.severity.as_str())
    .bind(&alert.network)
    .bind(&alert.contract_id)
    .bind(&alert.subject)
    .bind(&alert.message)
    .bind(sqlx::types::Json(&alert.details))
    .bind(alert.fired_at)
    .fetch_optional(pool)
    .await
}

async fn record_delivery(pool: &PgPool, id: i64, delivery: &Delivery) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE alerts SET delivered_channels = $2, failed_channels = $3 WHERE id = $1")
        .bind(id)
        .bind(sqlx::types::Json(&delivery.delivered))
        .bind(sqlx::types::Json(&delivery.failed))
        .execute(pool)
        .await
        .map(|_| ())
}

async fn handle_evaluation(
    pool: &PgPool,
    channels: &[Arc<dyn AlertChannel>],
    evaluation: Evaluation,
) -> Result<u32, sqlx::Error> {
    for _ in 0..evaluation.suppressed {
        metrics::record_labeled(metrics::ALERTS, "suppressed");
    }
    let mut fired = 0;
    for alert in &evaluation.alerts {
        // An alert already stored (a restart replaying an event) is not sent again.
        let Some(id) = record_alert(pool, alert).await? else {
            continue;
        };
        fired += 1;
        metrics::record_labeled(metrics::ALERTS, "fired");
        let delivery = dispatch(channels, alert).await;
        record_delivery(pool, id, &delivery).await?;
    }
    Ok(fired)
}

/// Evaluates every row indexed since the last poll for one (network, contract).
/// Returns how many alerts were raised.
pub async fn poll_pair(
    pool: &PgPool,
    engine: &AlertEngine,
    channels: &[Arc<dyn AlertChannel>],
    network: &str,
    contract_id: &str,
    backfill: bool,
) -> Result<u32, sqlx::Error> {
    let mut fired = 0;

    let cursor = cursor_or_seed(pool, TRANSFERS, network, contract_id, backfill).await?;
    let transfers: Vec<TransferRow> = sqlx::query_as(
        "SELECT ledger, tx_hash, event_index, token, amount, occurred_at FROM transfers \
         WHERE network = $1 AND contract_id = $2 AND ledger > $3 \
         ORDER BY ledger ASC, event_index ASC LIMIT $4",
    )
    .bind(network)
    .bind(contract_id)
    .bind(cursor)
    .bind(POLL_BATCH)
    .fetch_all(pool)
    .await?;
    // A full batch may end mid-ledger; only advance past ledgers fully read.
    let transfer_ledger = batch_end(transfers.iter().map(|row| row.ledger), POLL_BATCH);
    for row in transfers.iter().filter(|row| row.ledger <= transfer_ledger) {
        let Ok(amount) = row.amount.trim().parse::<i128>() else {
            tracing::warn!(amount = %row.amount, "skipping a transfer with a non-integer amount");
            continue;
        };
        fired += handle_evaluation(
            pool,
            channels,
            engine.evaluate(&AlertEvent::Transfer {
                key: format!(
                    "transfer:{}:{}:{}",
                    row.ledger, row.tx_hash, row.event_index
                ),
                network: network.to_owned(),
                contract_id: contract_id.to_owned(),
                token: row.token.clone(),
                amount,
                occurred_at: row.occurred_at,
            }),
        )
        .await?;
    }
    if transfer_ledger > cursor {
        write_cursor(pool, TRANSFERS, network, contract_id, transfer_ledger).await?;
    }

    let cursor = cursor_or_seed(pool, APPROVALS, network, contract_id, backfill).await?;
    let approvals: Vec<ApprovalRow> = sqlx::query_as(
        "SELECT ledger, tx_hash, event_index, owner, proposal_id, occurred_at \
         FROM proposal_approvals \
         WHERE network = $1 AND contract_id = $2 AND ledger > $3 \
         ORDER BY ledger ASC, event_index ASC LIMIT $4",
    )
    .bind(network)
    .bind(contract_id)
    .bind(cursor)
    .bind(POLL_BATCH)
    .fetch_all(pool)
    .await?;
    let approval_ledger = batch_end(approvals.iter().map(|row| row.ledger), POLL_BATCH);
    for row in approvals.iter().filter(|row| row.ledger <= approval_ledger) {
        fired += handle_evaluation(
            pool,
            channels,
            engine.evaluate(&AlertEvent::Approval {
                key: format!(
                    "approval:{}:{}:{}",
                    row.ledger, row.tx_hash, row.event_index
                ),
                network: network.to_owned(),
                contract_id: contract_id.to_owned(),
                owner: row.owner.clone(),
                proposal_id: Some(row.proposal_id),
                occurred_at: row.occurred_at,
            }),
        )
        .await?;
    }
    if approval_ledger > cursor {
        write_cursor(pool, APPROVALS, network, contract_id, approval_ledger).await?;
    }

    Ok(fired)
}

/// The last ledger that is safe to checkpoint. A batch shorter than the limit
/// was read completely; a full one may have cut a ledger in half, so the
/// checkpoint stops before its last ledger and that ledger is read again.
fn batch_end(ledgers: impl Iterator<Item = i64>, limit: i64) -> i64 {
    let ledgers: Vec<i64> = ledgers.collect();
    let Some(&last) = ledgers.last() else {
        return 0;
    };
    if (ledgers.len() as i64) < limit {
        return last;
    }
    ledgers
        .iter()
        .rev()
        .find(|ledger| **ledger < last)
        .copied()
        .unwrap_or(last)
}

/// One watcher tick: drop the response cache if the indexer wrote anything new,
/// then evaluate alert rules against the new rows.
pub struct Watcher {
    pub pool: PgPool,
    pub pairs: Vec<(String, String)>,
    pub limits: Arc<Limits>,
    pub alerts: Option<AlertRuntime>,
}

/// Everything the watcher needs to evaluate rules and notify.
pub struct AlertRuntime {
    pub engine: Arc<AlertEngine>,
    pub channels: Vec<Arc<dyn AlertChannel>>,
    pub backfill: bool,
}

impl Watcher {
    pub async fn tick(&self, last_stamp: &mut Option<i64>) -> Result<u32, sqlx::Error> {
        let stamp = data_stamp(&self.pool, &self.pairs).await?;
        // The first tick only records the baseline: nothing was cached yet.
        if last_stamp.is_some_and(|previous| previous != stamp) {
            let dropped = self.limits.invalidate_cache();
            tracing::debug!(stamp, dropped, "new indexed events; response cache cleared");
        }
        *last_stamp = Some(stamp);

        let mut fired = 0;
        if let Some(runtime) = &self.alerts {
            for (network, contract_id) in &self.pairs {
                fired += poll_pair(
                    &self.pool,
                    &runtime.engine,
                    &runtime.channels,
                    network,
                    contract_id,
                    runtime.backfill,
                )
                .await?;
            }
        }
        Ok(fired)
    }
}

/// Runs the watcher until the process exits.
pub fn spawn(watcher: Watcher, interval: Duration) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut last_stamp = None;
        loop {
            if let Err(error) = watcher.tick(&mut last_stamp).await {
                tracing::error!(%error, "event watcher tick failed");
                metrics::record_error("watcher");
            }
            tokio::time::sleep(interval).await;
        }
    })
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    fn at(hour: u32, minute: u32, second: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 27, hour, minute, second)
            .unwrap()
    }

    fn engine(rules: &str, settings: StormSettings) -> AlertEngine {
        AlertEngine::new(parse_rules(rules).unwrap(), settings)
    }

    fn settings(cooldown: u64, max_alerts: u32, window: u64) -> StormSettings {
        StormSettings {
            cooldown: Duration::from_secs(cooldown),
            max_alerts,
            window: Duration::from_secs(window),
        }
    }

    fn transfer(key: &str, token: &str, amount: i128, when: DateTime<Utc>) -> AlertEvent {
        AlertEvent::Transfer {
            key: key.to_owned(),
            network: "testnet".to_owned(),
            contract_id: "C1".to_owned(),
            token: token.to_owned(),
            amount,
            occurred_at: when,
        }
    }

    fn approval(key: &str, owner: &str, when: DateTime<Utc>) -> AlertEvent {
        AlertEvent::Approval {
            key: key.to_owned(),
            network: "testnet".to_owned(),
            contract_id: "C1".to_owned(),
            owner: owner.to_owned(),
            proposal_id: Some(1),
            occurred_at: when,
        }
    }

    const SPEND: &str = r#"[{"id":"big-spend","type":"spend_threshold","token":"USDC",
        "threshold":"1000","windowSecs":3600,"severity":"critical"}]"#;

    #[test]
    fn parses_every_rule_kind_with_defaults() {
        let rules = parse_rules(
            r#"[
              {"id":"a","type":"spend_threshold","threshold":"5","windowSecs":60},
              {"id":"b","type":"approval_burst","maxApprovals":3,"windowSecs":600,"cooldownSecs":30},
              {"id":"c","type":"off_hours_approval","startHour":22,"endHour":5,"severity":"info"}
            ]"#,
        )
        .unwrap();

        assert_eq!(rules.len(), 3);
        assert_eq!(
            rules[0].severity,
            Severity::Warning,
            "warning is the default"
        );
        assert_eq!(rules[1].cooldown_secs, Some(30));
        assert_eq!(rules[2].severity, Severity::Info);
    }

    #[test]
    fn rejects_invalid_rules() {
        for (rules, message) in [
            ("{}", "JSON array"),
            (
                r#"[{"id":"","type":"approval_burst","maxApprovals":1,"windowSecs":1}]"#,
                "id",
            ),
            (
                r#"[{"id":"a","type":"spend_threshold","threshold":"abc","windowSecs":1}]"#,
                "threshold",
            ),
            (
                r#"[{"id":"a","type":"spend_threshold","threshold":"-5","windowSecs":1}]"#,
                "positive",
            ),
            (
                r#"[{"id":"a","type":"spend_threshold","threshold":"5","windowSecs":0}]"#,
                "windowSecs",
            ),
            (
                r#"[{"id":"a","type":"approval_burst","maxApprovals":0,"windowSecs":1}]"#,
                "maxApprovals",
            ),
            (
                r#"[{"id":"a","type":"off_hours_approval","startHour":3,"endHour":3}]"#,
                "different hours",
            ),
            (
                r#"[{"id":"a","type":"off_hours_approval","startHour":3,"endHour":30}]"#,
                "between 0 and 23",
            ),
            (r#"[{"id":"a","type":"mystery"}]"#, "need a type"),
            (
                r#"[{"id":"a","type":"approval_burst","maxApprovals":1,"windowSecs":1,"cooldownSec":5}]"#,
                "unknown field",
            ),
            (
                r#"[{"id":"a","type":"approval_burst","maxApprovals":1,"windowSecs":1},
                    {"id":"a","type":"approval_burst","maxApprovals":1,"windowSecs":1}]"#,
                "more than once",
            ),
        ] {
            let error = format!("{:#}", parse_rules(rules).unwrap_err());
            assert!(error.contains(message), "{rules} -> {error}");
        }
    }

    #[test]
    fn spend_below_the_threshold_is_quiet_and_reaching_it_alerts() {
        let engine = engine(SPEND, settings(900, 20, 600));

        assert!(
            engine
                .evaluate(&transfer("t1", "USDC", 600, at(9, 0, 0)))
                .alerts
                .is_empty()
        );
        let result = engine.evaluate(&transfer("t2", "USDC", 400, at(9, 10, 0)));

        assert_eq!(result.alerts.len(), 1);
        let alert = &result.alerts[0];
        assert_eq!(alert.rule_id, "big-spend");
        assert_eq!(alert.kind, "spend_threshold");
        assert_eq!(alert.severity, Severity::Critical);
        assert_eq!(alert.subject, "USDC");
        assert_eq!(alert.details["total"], "1000");
    }

    #[test]
    fn spend_outside_the_window_does_not_count() {
        let engine = engine(SPEND, settings(900, 20, 600));

        engine.evaluate(&transfer("t1", "USDC", 900, at(9, 0, 0)));
        let result = engine.evaluate(&transfer("t2", "USDC", 900, at(11, 0, 0)));

        assert!(
            result.alerts.is_empty(),
            "the first transfer left the one-hour window"
        );
    }

    #[test]
    fn spend_rules_ignore_other_tokens() {
        let engine = engine(SPEND, settings(900, 20, 600));

        let result = engine.evaluate(&transfer("t1", "XLM", 5000, at(9, 0, 0)));

        assert!(result.alerts.is_empty());
    }

    #[test]
    fn a_rule_without_a_token_watches_each_token_separately() {
        let engine = engine(
            r#"[{"id":"any","type":"spend_threshold","threshold":"100","windowSecs":3600}]"#,
            settings(900, 20, 600),
        );

        engine.evaluate(&transfer("t1", "USDC", 60, at(9, 0, 0)));
        let mixed = engine.evaluate(&transfer("t2", "XLM", 60, at(9, 1, 0)));
        let same = engine.evaluate(&transfer("t3", "USDC", 60, at(9, 2, 0)));

        assert!(
            mixed.alerts.is_empty(),
            "60 USDC + 60 XLM is not 120 of anything"
        );
        assert_eq!(same.alerts[0].subject, "USDC");
    }

    #[test]
    fn approval_bursts_alert_only_above_the_limit() {
        let engine = engine(
            r#"[{"id":"burst","type":"approval_burst","maxApprovals":2,"windowSecs":600}]"#,
            settings(900, 20, 600),
        );

        assert!(
            engine
                .evaluate(&approval("a1", "GAAA", at(9, 0, 0)))
                .alerts
                .is_empty()
        );
        assert!(
            engine
                .evaluate(&approval("a2", "GAAA", at(9, 1, 0)))
                .alerts
                .is_empty()
        );
        let result = engine.evaluate(&approval("a3", "GAAA", at(9, 2, 0)));

        assert_eq!(result.alerts.len(), 1);
        assert_eq!(result.alerts[0].subject, "GAAA");
        assert_eq!(result.alerts[0].details["approvals"], 3);
        // A different owner has an independent count.
        assert!(
            engine
                .evaluate(&approval("a4", "GBBB", at(9, 3, 0)))
                .alerts
                .is_empty()
        );
    }

    #[test]
    fn off_hours_approvals_alert_inside_the_window_including_across_midnight() {
        let engine = engine(
            r#"[{"id":"night","type":"off_hours_approval","startHour":22,"endHour":5}]"#,
            settings(0, 20, 600),
        );

        // Event time moves forward, as it does when the indexer feeds the engine.
        assert_eq!(
            engine
                .evaluate(&approval("a1", "G1", at(2, 0, 0)))
                .alerts
                .len(),
            1
        );
        assert!(
            engine
                .evaluate(&approval("a2", "G1", at(5, 0, 0)))
                .alerts
                .is_empty(),
            "end hour is exclusive"
        );
        assert!(
            engine
                .evaluate(&approval("a3", "G1", at(12, 0, 0)))
                .alerts
                .is_empty()
        );
        assert_eq!(
            engine
                .evaluate(&approval("a4", "G1", at(23, 30, 0)))
                .alerts
                .len(),
            1
        );
    }

    #[test]
    fn the_cooldown_suppresses_repeats_until_it_passes() {
        let engine = engine(SPEND, settings(900, 20, 600));

        assert_eq!(
            engine
                .evaluate(&transfer("t1", "USDC", 1000, at(9, 0, 0)))
                .alerts
                .len(),
            1
        );
        let during = engine.evaluate(&transfer("t2", "USDC", 1000, at(9, 5, 0)));
        let after = engine.evaluate(&transfer("t3", "USDC", 1000, at(9, 20, 0)));

        assert!(during.alerts.is_empty());
        assert_eq!(during.suppressed, 1);
        assert_eq!(
            after.alerts.len(),
            1,
            "15 minutes later the rule may alert again"
        );
    }

    #[test]
    fn a_rule_can_override_the_cooldown() {
        let engine = engine(
            r#"[{"id":"r","type":"spend_threshold","threshold":"1","windowSecs":3600,"cooldownSecs":60}]"#,
            settings(900, 20, 600),
        );

        assert_eq!(
            engine
                .evaluate(&transfer("t1", "USDC", 5, at(9, 0, 0)))
                .alerts
                .len(),
            1
        );
        assert_eq!(
            engine
                .evaluate(&transfer("t2", "USDC", 5, at(9, 2, 0)))
                .alerts
                .len(),
            1
        );
    }

    #[test]
    fn the_cooldown_is_per_subject() {
        let engine = engine(
            r#"[{"id":"burst","type":"approval_burst","maxApprovals":1,"windowSecs":600}]"#,
            settings(900, 20, 600),
        );

        engine.evaluate(&approval("a1", "G1", at(9, 0, 0)));
        assert_eq!(
            engine
                .evaluate(&approval("a2", "G1", at(9, 1, 0)))
                .alerts
                .len(),
            1
        );
        engine.evaluate(&approval("a3", "G2", at(9, 1, 5)));
        let other = engine.evaluate(&approval("a4", "G2", at(9, 1, 10)));

        assert_eq!(
            other.alerts.len(),
            1,
            "G2 is not cooling down because G1 alerted"
        );
    }

    #[test]
    fn the_storm_cap_limits_alerts_across_all_subjects() {
        let engine = engine(
            r#"[{"id":"night","type":"off_hours_approval","startHour":0,"endHour":6}]"#,
            settings(0, 2, 600),
        );

        let results: Vec<Evaluation> = (0..4)
            .map(|index| {
                engine.evaluate(&approval(
                    &format!("a{index}"),
                    &format!("G{index}"),
                    at(1, 0, index),
                ))
            })
            .collect();

        assert_eq!(results.iter().map(|r| r.alerts.len()).sum::<usize>(), 2);
        assert_eq!(results[2].suppressed, 1);
        assert_eq!(results[3].suppressed, 1);

        let later = engine.evaluate(&approval("late", "G9", at(1, 20, 0)));
        assert_eq!(
            later.alerts.len(),
            1,
            "the cap lifts when the storm window passes"
        );
    }

    #[test]
    fn replaying_an_event_never_alerts_twice() {
        let engine = engine(SPEND, settings(0, 20, 600));
        let event = transfer("t1", "USDC", 5000, at(9, 0, 0));

        assert_eq!(engine.evaluate(&event).alerts.len(), 1);
        assert_eq!(engine.evaluate(&event), Evaluation::default());
    }

    #[test]
    fn the_dedupe_key_identifies_rule_subject_and_event() {
        let first = engine(SPEND, settings(900, 20, 600)).evaluate(&transfer(
            "t1",
            "USDC",
            5000,
            at(9, 0, 0),
        ));
        let again = engine(SPEND, settings(900, 20, 600)).evaluate(&transfer(
            "t1",
            "USDC",
            5000,
            at(9, 0, 0),
        ));

        assert_eq!(first.alerts[0].dedupe_key, again.alerts[0].dedupe_key);
        assert!(first.alerts[0].dedupe_key.contains("t1"));
    }

    struct Recording {
        name: &'static str,
        fail: bool,
        sent: Arc<Mutex<Vec<String>>>,
    }

    impl AlertChannel for Recording {
        fn name(&self) -> String {
            self.name.to_owned()
        }

        fn send<'a>(&'a self, alert: &'a Alert) -> ChannelFuture<'a> {
            Box::pin(async move {
                if self.fail {
                    return Err("channel down".to_owned());
                }
                self.sent.lock().unwrap().push(alert.message.clone());
                Ok(())
            })
        }
    }

    #[tokio::test]
    async fn dispatch_reaches_every_channel_even_when_one_fails() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let channels: Vec<Arc<dyn AlertChannel>> = vec![
            Arc::new(Recording {
                name: "broken",
                fail: true,
                sent: Arc::clone(&sent),
            }),
            Arc::new(Recording {
                name: "working",
                fail: false,
                sent: Arc::clone(&sent),
            }),
        ];
        let alert = engine(SPEND, settings(0, 20, 600))
            .evaluate(&transfer("t1", "USDC", 5000, at(9, 0, 0)))
            .alerts
            .remove(0);

        let delivery = dispatch(&channels, &alert).await;

        assert_eq!(delivery.delivered, vec!["working".to_owned()]);
        assert_eq!(delivery.failed, vec!["broken".to_owned()]);
        assert_eq!(sent.lock().unwrap().len(), 1);
    }

    #[test]
    fn batch_end_never_checkpoints_inside_a_partly_read_ledger() {
        assert_eq!(batch_end([].into_iter(), 3), 0);
        assert_eq!(
            batch_end([5, 5, 6].into_iter(), 4),
            6,
            "a short batch was read fully"
        );
        assert_eq!(
            batch_end([5, 6, 6].into_iter(), 3),
            5,
            "ledger 6 may continue; re-read it"
        );
        assert_eq!(
            batch_end([7, 7, 7].into_iter(), 3),
            7,
            "one huge ledger must still advance"
        );
    }

    #[test]
    fn email_and_unknown_channels_are_validated_at_startup() {
        let config = |channels: &[&str], recipients: &[&str]| AlertConfig {
            rules: Vec::new(),
            settings: StormSettings::default(),
            channels: channels.iter().map(|c| (*c).to_owned()).collect(),
            recipients: recipients.iter().map(|r| (*r).to_owned()).collect(),
            poll_interval: Duration::from_secs(1),
            backfill: false,
        };

        assert_eq!(config(&["log"], &[]).build_channels(None).unwrap().len(), 1);
        assert!(
            config(&["email"], &["ops@example.com"])
                .build_channels(None)
                .is_err()
        );
        assert!(config(&["pager"], &[]).build_channels(None).is_err());
        assert!(config(&[], &[]).build_channels(None).is_err());
    }
}
