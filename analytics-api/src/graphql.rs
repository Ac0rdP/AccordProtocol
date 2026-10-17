//! GraphQL endpoint over the indexed treasury data.
//!
//! Resolvers read straight from the PostgreSQL datastore, scoped to the
//! configured `CONTRACT_ID`. Every list field is a paginated connection and the
//! endpoint is protected by depth, complexity, page-size, body-size and time
//! limits (see [`GraphqlConfig`]).

use std::{collections::HashMap, env, str::FromStr, time::Duration};

use anyhow::{Result as AnyResult, bail};
use async_graphql::{
    ComplexObject, Context, EmptyMutation, EmptySubscription, Enum, Error, ErrorExtensions,
    InputObject, Object, OutputType, Request, Result, Schema, SimpleObject,
    dataloader::{DataLoader, Loader},
};
use axum::{
    Json,
    body::Bytes,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use serde_json::json;
use sqlx::{PgPool, QueryBuilder, postgres::Postgres, types::Json as SqlJson};

use crate::{AppState, metrics};

pub(crate) type AccordSchema = Schema<QueryRoot, EmptyMutation, EmptySubscription>;

/// Largest request body the endpoint reads, in bytes.
pub(crate) const MAX_BODY_BYTES: usize = 64 * 1024;
const DEFAULT_PAGE_SIZE: i32 = 20;
const MAX_PAGE_SIZE: i32 = 100;

const DEPTH_MESSAGE: &str = "Query is nested too deep.";
const COMPLEXITY_MESSAGE: &str = "Query is too complex.";

#[derive(Clone, Debug)]
pub(crate) struct GraphqlConfig {
    pub(crate) max_depth: usize,
    pub(crate) max_complexity: usize,
    pub(crate) timeout: Duration,
    pub(crate) introspection: bool,
}

impl Default for GraphqlConfig {
    fn default() -> Self {
        Self {
            max_depth: 6,
            max_complexity: 500,
            timeout: Duration::from_millis(10_000),
            introspection: true,
        }
    }
}

impl GraphqlConfig {
    pub(crate) fn from_env() -> AnyResult<Self> {
        let defaults = Self::default();
        let max_depth = env_value("GRAPHQL_MAX_DEPTH", defaults.max_depth)?;
        let max_complexity = env_value("GRAPHQL_MAX_COMPLEXITY", defaults.max_complexity)?;
        let timeout_ms: u64 = env_value("GRAPHQL_TIMEOUT_MS", defaults.timeout.as_millis() as u64)?;
        let introspection = env_value("GRAPHQL_INTROSPECTION", defaults.introspection)?;
        if max_depth == 0 || max_complexity == 0 || timeout_ms == 0 {
            bail!(
                "GRAPHQL_MAX_DEPTH, GRAPHQL_MAX_COMPLEXITY and GRAPHQL_TIMEOUT_MS must be positive"
            );
        }
        Ok(Self {
            max_depth,
            max_complexity,
            timeout: Duration::from_millis(timeout_ms),
            introspection,
        })
    }
}

fn env_value<T: FromStr>(name: &str, default: T) -> AnyResult<T> {
    match env::var(name) {
        Ok(raw) => raw
            .trim()
            .parse()
            .map_err(|_| anyhow::anyhow!("{name} has an invalid value: {raw}")),
        Err(_) => Ok(default),
    }
}

pub(crate) fn build_schema(config: &GraphqlConfig) -> AccordSchema {
    let builder = Schema::build(QueryRoot, EmptyMutation, EmptySubscription)
        .limit_depth(config.max_depth)
        .limit_complexity(config.max_complexity);
    if config.introspection {
        builder.finish()
    } else {
        builder.disable_introspection().finish()
    }
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

fn error_body(code: &str, message: &str) -> serde_json::Value {
    json!({ "errors": [{ "message": message, "extensions": { "code": code } }] })
}

pub(crate) async fn handler(State(state): State<AppState>, body: Bytes) -> Response {
    let request = match serde_json::from_slice::<Request>(&body) {
        Ok(request) => request,
        Err(_) => {
            let batch = body.iter().find(|byte| !byte.is_ascii_whitespace()) == Some(&b'[');
            let message = if batch {
                metrics::record_rejection("batch");
                "Batch requests are not supported"
            } else {
                "Request body must be a JSON GraphQL request"
            };
            return (
                StatusCode::BAD_REQUEST,
                Json(error_body("BAD_REQUEST", message)),
            )
                .into_response();
        }
    };

    let db = Db {
        pool: state.pool.clone(),
        contract_id: state.contract_id.clone(),
    };
    let request = request
        .data(DataLoader::new(TimelineLoader(db.clone()), tokio::spawn))
        .data(DataLoader::new(OwnerLoader(db.clone()), tokio::spawn))
        .data(db);

    let response =
        match tokio::time::timeout(state.graphql_timeout, state.schema.execute(request)).await {
            Ok(response) => response,
            Err(_) => {
                metrics::record_rejection("timeout");
                return (
                    StatusCode::GATEWAY_TIMEOUT,
                    Json(error_body(
                        "TIMEOUT",
                        "Query exceeded the execution time limit",
                    )),
                )
                    .into_response();
            }
        };

    let mut status = StatusCode::OK;
    for error in &response.errors {
        match error.message.as_str() {
            DEPTH_MESSAGE => {
                metrics::record_rejection("depth");
                status = StatusCode::BAD_REQUEST;
            }
            COMPLEXITY_MESSAGE => {
                metrics::record_rejection("complexity");
                status = StatusCode::BAD_REQUEST;
            }
            _ => {}
        }
    }
    (status, Json(response)).into_response()
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Db {
    pool: PgPool,
    contract_id: String,
}

fn db<'a>(ctx: &Context<'a>) -> Result<&'a Db> {
    ctx.data::<Db>()
}

fn api_error(code: &'static str, message: impl Into<String>) -> Error {
    Error::new(message).extend_with(|_, extensions| extensions.set("code", code))
}

fn db_error(error: sqlx::Error) -> Error {
    tracing::error!(%error, "failed to query indexed data for graphql");
    metrics::record_error("graphql_database");
    api_error("INTERNAL_ERROR", "Failed to query indexed data")
}

fn encode_cursor(offset: i64) -> String {
    format!("offset:{offset}")
        .bytes()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn decode_cursor(cursor: &str) -> Result<i64> {
    let invalid = || api_error("INVALID_CURSOR", "The `after` cursor is not valid");
    if !cursor.len().is_multiple_of(2) || !cursor.is_ascii() {
        return Err(invalid());
    }
    let bytes: Option<Vec<u8>> = (0..cursor.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&cursor[index..index + 2], 16).ok())
        .collect();
    let text = String::from_utf8(bytes.ok_or_else(invalid)?).map_err(|_| invalid())?;
    text.strip_prefix("offset:")
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|offset| *offset >= 0)
        .ok_or_else(invalid)
}

struct PageRequest {
    limit: i64,
    offset: i64,
}

fn page_request(first: Option<i32>, after: Option<&str>) -> Result<PageRequest> {
    let first = first.unwrap_or(DEFAULT_PAGE_SIZE);
    if !(1..=MAX_PAGE_SIZE).contains(&first) {
        metrics::record_rejection("page_size");
        return Err(api_error(
            "PAGE_SIZE_EXCEEDED",
            format!("`first` must be between 1 and {MAX_PAGE_SIZE}"),
        ));
    }
    let offset = after.map(decode_cursor).transpose()?.unwrap_or(0);
    Ok(PageRequest {
        limit: i64::from(first),
        offset,
    })
}

/// The count query only runs when the query actually selects `totalCount`.
fn wants_total(ctx: &Context<'_>) -> bool {
    ctx.look_ahead().field("totalCount").exists()
}

/// `%`, `_` and `\` are LIKE metacharacters; user input must match literally.
fn like_pattern(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

#[derive(SimpleObject)]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

#[derive(SimpleObject)]
#[graphql(
    concrete(name = "ProposalConnection", params(Proposal)),
    concrete(name = "OwnerConnection", params(Owner)),
    concrete(name = "SpendConnection", params(Spend)),
    concrete(name = "TreasuryFlowConnection", params(TreasuryFlow))
)]
struct Connection<T: OutputType> {
    nodes: Vec<T>,
    page_info: PageInfo,
    /// Only computed when the query selects it.
    total_count: Option<i64>,
}

/// Rows were fetched with `limit + 1` so the extra row signals a next page.
fn connection<T: OutputType>(
    mut rows: Vec<T>,
    page: &PageRequest,
    total_count: Option<i64>,
) -> Connection<T> {
    let has_next_page = rows.len() as i64 > page.limit;
    rows.truncate(page.limit as usize);
    let end_cursor = (!rows.is_empty()).then(|| encode_cursor(page.offset + rows.len() as i64));
    Connection {
        nodes: rows,
        page_info: PageInfo {
            has_next_page,
            end_cursor,
        },
        total_count,
    }
}

fn push_page(builder: &mut QueryBuilder<'_, Postgres>, page: &PageRequest) {
    builder
        .push(" LIMIT ")
        .push_bind(page.limit + 1)
        .push(" OFFSET ")
        .push_bind(page.offset);
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

#[derive(Enum, Copy, Clone, Eq, PartialEq)]
enum ProposalStatus {
    Pending,
    Ready,
    Executed,
    Expired,
    Revoked,
}

impl ProposalStatus {
    fn db(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Ready => "ready",
            Self::Executed => "executed",
            Self::Expired => "expired",
            Self::Revoked => "revoked",
        }
    }

    fn from_db(value: &str) -> Self {
        match value {
            "ready" => Self::Ready,
            "executed" => Self::Executed,
            "expired" => Self::Expired,
            "revoked" => Self::Revoked,
            _ => Self::Pending,
        }
    }
}

#[derive(Enum, Copy, Clone, Eq, PartialEq)]
enum Category {
    Transfer,
    Payroll,
    Grant,
    Ops,
    Other,
}

impl Category {
    fn db(self) -> &'static str {
        match self {
            Self::Transfer => "Transfer",
            Self::Payroll => "Payroll",
            Self::Grant => "Grant",
            Self::Ops => "Ops",
            Self::Other => "Other",
        }
    }

    fn from_db(value: &str) -> Self {
        match value {
            "Transfer" => Self::Transfer,
            "Payroll" => Self::Payroll,
            "Grant" => Self::Grant,
            "Ops" => Self::Ops,
            _ => Self::Other,
        }
    }
}

#[derive(Enum, Copy, Clone, Eq, PartialEq, Default)]
enum ProposalSort {
    #[default]
    CreatedAt,
    Deadline,
    Amount,
}

#[derive(Enum, Copy, Clone, Eq, PartialEq, Default)]
enum SortOrder {
    Asc,
    #[default]
    Desc,
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

#[derive(InputObject, Default, Clone)]
struct ProposalFilter {
    status: Option<ProposalStatus>,
    category: Option<Category>,
    token: Option<String>,
    /// Case-insensitive substring of the proposer address.
    proposer: Option<String>,
    /// Inclusive lower bound on creation time.
    start_date: Option<DateTime<Utc>>,
    /// Inclusive upper bound on creation time.
    end_date: Option<DateTime<Utc>>,
}

#[derive(InputObject, Default, Clone)]
struct OwnerFilter {
    /// Case-insensitive substring of the owner address.
    address: Option<String>,
    min_weight: Option<i32>,
    /// Include owners whose weight is currently zero (removed owners).
    #[graphql(default)]
    include_removed: bool,
}

#[derive(InputObject, Default, Clone)]
struct SpendFilter {
    token: Option<String>,
    category: Option<Category>,
    /// Case-insensitive substring of the recipient address.
    recipient: Option<String>,
    /// Inclusive lower bound on execution time.
    start_date: Option<DateTime<Utc>>,
    /// Inclusive upper bound on execution time.
    end_date: Option<DateTime<Utc>>,
}

#[derive(InputObject, Default, Clone)]
struct TreasuryFlowFilter {
    token: Option<String>,
    /// Case-insensitive substring of the recipient address.
    recipient: Option<String>,
    proposal_id: Option<i64>,
    schedule_id: Option<i64>,
    /// Inclusive lower bound on ledger close time.
    start_date: Option<DateTime<Utc>>,
    /// Inclusive upper bound on ledger close time.
    end_date: Option<DateTime<Utc>>,
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

const PROPOSAL_COLUMNS: &str = "p.proposal_id AS id, p.kind, p.recipient AS to, p.amount, \
     p.token, p.description, p.approvals, p.threshold, p.quorum_weight, p.approval_weight, \
     p.total_weight, p.approver_addresses, p.status, p.deadline, p.created_at, p.proposer, \
     p.category, p.executed_at";

#[derive(sqlx::FromRow)]
struct ProposalRow {
    id: i64,
    kind: String,
    to: String,
    amount: String,
    token: String,
    description: String,
    approvals: i32,
    threshold: i32,
    quorum_weight: Option<i32>,
    approval_weight: Option<i32>,
    total_weight: Option<i32>,
    approver_addresses: SqlJson<Vec<String>>,
    status: String,
    deadline: DateTime<Utc>,
    created_at: DateTime<Utc>,
    proposer: String,
    category: String,
    executed_at: Option<DateTime<Utc>>,
}

#[derive(SimpleObject)]
#[graphql(complex)]
struct Proposal {
    id: i64,
    kind: String,
    /// Recipient of the proposed transfer.
    to: String,
    /// Decimal token-unit string.
    amount: String,
    token: String,
    description: String,
    approvals: i32,
    threshold: i32,
    quorum_weight: Option<i32>,
    approval_weight: Option<i32>,
    total_weight: Option<i32>,
    approver_addresses: Vec<String>,
    status: ProposalStatus,
    deadline: DateTime<Utc>,
    created_at: DateTime<Utc>,
    proposer: String,
    category: Category,
    executed_at: Option<DateTime<Utc>>,
}

impl From<ProposalRow> for Proposal {
    fn from(row: ProposalRow) -> Self {
        Self {
            id: row.id,
            kind: row.kind,
            to: row.to,
            amount: row.amount,
            token: row.token,
            description: row.description,
            approvals: row.approvals,
            threshold: row.threshold,
            quorum_weight: row.quorum_weight,
            approval_weight: row.approval_weight,
            total_weight: row.total_weight,
            approver_addresses: row.approver_addresses.0,
            status: ProposalStatus::from_db(&row.status),
            deadline: row.deadline,
            created_at: row.created_at,
            proposer: row.proposer,
            category: Category::from_db(&row.category),
            executed_at: row.executed_at,
        }
    }
}

#[ComplexObject]
impl Proposal {
    /// Events recorded for this proposal, oldest first.
    #[graphql(complexity = "20 * child_complexity")]
    async fn timeline(&self, ctx: &Context<'_>) -> Result<Vec<ProposalEvent>> {
        let loader = ctx.data::<DataLoader<TimelineLoader>>()?;
        Ok(loader.load_one(self.id).await?.unwrap_or_default())
    }

    /// The proposer's current owner record, if the proposer is an owner.
    async fn proposer_owner(&self, ctx: &Context<'_>) -> Result<Option<Owner>> {
        let loader = ctx.data::<DataLoader<OwnerLoader>>()?;
        loader.load_one(self.proposer.clone()).await
    }
}

fn add_proposal_filters(
    builder: &mut QueryBuilder<'_, Postgres>,
    filter: &ProposalFilter,
    exact_proposer: Option<&str>,
) {
    if let Some(status) = filter.status {
        builder.push(" AND p.status = ").push_bind(status.db());
    }
    if let Some(category) = filter.category {
        builder.push(" AND p.category = ").push_bind(category.db());
    }
    if let Some(token) = &filter.token {
        builder.push(" AND p.token = ").push_bind(token.clone());
    }
    if let Some(proposer) = exact_proposer {
        builder
            .push(" AND p.proposer = ")
            .push_bind(proposer.to_owned());
    } else if let Some(proposer) = &filter.proposer {
        builder
            .push(" AND p.proposer ILIKE ")
            .push_bind(like_pattern(proposer));
    }
    if let Some(start) = filter.start_date {
        builder.push(" AND p.created_at >= ").push_bind(start);
    }
    if let Some(end) = filter.end_date {
        builder.push(" AND p.created_at <= ").push_bind(end);
    }
}

#[allow(clippy::too_many_arguments)]
async fn fetch_proposals(
    ctx: &Context<'_>,
    first: Option<i32>,
    after: Option<String>,
    filter: Option<ProposalFilter>,
    sort: ProposalSort,
    order: SortOrder,
    exact_proposer: Option<&str>,
) -> Result<Connection<Proposal>> {
    let page = page_request(first, after.as_deref())?;
    let filter = filter.unwrap_or_default();
    let db = db(ctx)?;

    let total = if wants_total(ctx) {
        let mut count = QueryBuilder::<Postgres>::new(
            "SELECT COUNT(*) FROM proposals p WHERE p.contract_id = ",
        );
        count.push_bind(db.contract_id.clone());
        add_proposal_filters(&mut count, &filter, exact_proposer);
        Some(
            count
                .build_query_scalar::<i64>()
                .fetch_one(&db.pool)
                .await
                .map_err(db_error)?,
        )
    } else {
        None
    };

    let sort_column = match sort {
        ProposalSort::CreatedAt => "p.created_at",
        ProposalSort::Deadline => "p.deadline",
        ProposalSort::Amount => "p.amount::numeric",
    };
    let direction = if order == SortOrder::Asc {
        "ASC"
    } else {
        "DESC"
    };
    let mut rows = QueryBuilder::<Postgres>::new(format!(
        "SELECT {PROPOSAL_COLUMNS} FROM proposals p WHERE p.contract_id = "
    ));
    rows.push_bind(db.contract_id.clone());
    add_proposal_filters(&mut rows, &filter, exact_proposer);
    rows.push(format!(
        " ORDER BY {sort_column} {direction}, p.proposal_id DESC"
    ));
    push_page(&mut rows, &page);

    let rows = rows
        .build_query_as::<ProposalRow>()
        .fetch_all(&db.pool)
        .await
        .map_err(db_error)?;
    Ok(connection(
        rows.into_iter().map(Proposal::from).collect(),
        &page,
        total,
    ))
}

// ---------------------------------------------------------------------------
// Proposal timeline events
// ---------------------------------------------------------------------------

#[derive(SimpleObject, Clone)]
struct ProposalEvent {
    #[graphql(name = "type")]
    event_type: String,
    actor: String,
    timestamp: DateTime<Utc>,
    ledger: i64,
    schedule_id: Option<i64>,
    amount: Option<String>,
    token: Option<String>,
    recipient: Option<String>,
    details: Option<String>,
}

#[derive(sqlx::FromRow)]
struct EventRow {
    proposal_id: i64,
    topic: String,
    actor: String,
    occurred_at: DateTime<Utc>,
    ledger: i64,
    data: SqlJson<serde_json::Value>,
}

fn json_string(data: &serde_json::Value, key: &str) -> Option<String> {
    data.get(key).and_then(|value| match value {
        serde_json::Value::String(value) => Some(value.clone()),
        serde_json::Value::Number(value) => Some(value.to_string()),
        _ => None,
    })
}

fn json_i64(data: &serde_json::Value, key: &str) -> Option<i64> {
    data.get(key).and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
    })
}

struct TimelineLoader(Db);

impl Loader<i64> for TimelineLoader {
    type Value = Vec<ProposalEvent>;
    type Error = Error;

    async fn load(&self, keys: &[i64]) -> Result<HashMap<i64, Self::Value>> {
        let rows = sqlx::query_as::<_, EventRow>(
            "SELECT proposal_id, topic, actor, occurred_at, ledger, data FROM events \
             WHERE contract_id = $1 AND proposal_id = ANY($2) \
             ORDER BY ledger ASC, event_index ASC",
        )
        .bind(&self.0.contract_id)
        .bind(keys)
        .fetch_all(&self.0.pool)
        .await
        .map_err(db_error)?;

        let mut timelines: HashMap<i64, Vec<ProposalEvent>> = HashMap::new();
        for row in rows {
            let data = row.data.0;
            timelines
                .entry(row.proposal_id)
                .or_default()
                .push(ProposalEvent {
                    event_type: row.topic,
                    actor: row.actor,
                    timestamp: row.occurred_at,
                    ledger: row.ledger,
                    schedule_id: json_i64(&data, "schedule_id"),
                    amount: json_string(&data, "amount"),
                    token: json_string(&data, "token"),
                    recipient: json_string(&data, "recipient"),
                    details: json_string(&data, "details"),
                });
        }
        Ok(timelines)
    }
}

// ---------------------------------------------------------------------------
// Owners
// ---------------------------------------------------------------------------

/// Latest weight change per owner; the owner's current state.
const CURRENT_OWNERS: &str = "SELECT DISTINCT ON (owner) owner AS address, new_weight AS weight, \
     new_total_weight AS total_weight, ledger AS last_changed_ledger, \
     occurred_at AS last_changed_at FROM owner_weight_changes WHERE contract_id = ";
const CURRENT_OWNERS_ORDER: &str = " ORDER BY owner, ledger DESC, event_index DESC";

#[derive(sqlx::FromRow, SimpleObject, Clone)]
#[graphql(complex)]
struct Owner {
    address: String,
    /// Current voting weight; zero for removed owners.
    weight: i32,
    /// Total weight of all owners after the owner's latest change.
    total_weight: i32,
    last_changed_ledger: i64,
    last_changed_at: DateTime<Utc>,
}

#[ComplexObject]
impl Owner {
    /// Proposals created by this owner.
    #[graphql(complexity = "first.unwrap_or(20).clamp(1, 100) as usize * child_complexity")]
    async fn proposals(
        &self,
        ctx: &Context<'_>,
        first: Option<i32>,
        after: Option<String>,
        filter: Option<ProposalFilter>,
        #[graphql(default)] sort: ProposalSort,
        #[graphql(default)] order: SortOrder,
    ) -> Result<Connection<Proposal>> {
        fetch_proposals(ctx, first, after, filter, sort, order, Some(&self.address)).await
    }
}

struct OwnerLoader(Db);

impl Loader<String> for OwnerLoader {
    type Value = Owner;
    type Error = Error;

    async fn load(&self, keys: &[String]) -> Result<HashMap<String, Self::Value>> {
        let mut query = QueryBuilder::<Postgres>::new(CURRENT_OWNERS);
        query
            .push_bind(self.0.contract_id.clone())
            .push(" AND owner = ANY(")
            .push_bind(keys.to_vec())
            .push(")")
            .push(CURRENT_OWNERS_ORDER);
        let owners = query
            .build_query_as::<Owner>()
            .fetch_all(&self.0.pool)
            .await
            .map_err(db_error)?;
        Ok(owners
            .into_iter()
            .map(|owner| (owner.address.clone(), owner))
            .collect())
    }
}

fn add_owner_filters(builder: &mut QueryBuilder<'_, Postgres>, filter: &OwnerFilter) {
    if !filter.include_removed {
        builder.push(" AND o.weight > 0");
    }
    if let Some(min_weight) = filter.min_weight {
        builder.push(" AND o.weight >= ").push_bind(min_weight);
    }
    if let Some(address) = &filter.address {
        builder
            .push(" AND o.address ILIKE ")
            .push_bind(like_pattern(address));
    }
}

fn owners_from(builder: &mut QueryBuilder<'_, Postgres>, contract_id: &str, select: &str) {
    builder.push(select).push(" FROM (");
    builder
        .push(CURRENT_OWNERS)
        .push_bind(contract_id.to_owned());
    builder.push(CURRENT_OWNERS_ORDER).push(") o WHERE TRUE");
}

// ---------------------------------------------------------------------------
// Spends
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct SpendRow {
    proposal_id: i64,
    recipient: String,
    token: String,
    amount: String,
    category: String,
    description: String,
    proposer: String,
    executed_at: Option<DateTime<Utc>>,
}

/// An executed transfer proposal.
#[derive(SimpleObject)]
struct Spend {
    proposal_id: i64,
    recipient: String,
    token: String,
    amount: String,
    category: Category,
    description: String,
    proposer: String,
    executed_at: Option<DateTime<Utc>>,
}

impl From<SpendRow> for Spend {
    fn from(row: SpendRow) -> Self {
        Self {
            proposal_id: row.proposal_id,
            recipient: row.recipient,
            token: row.token,
            amount: row.amount,
            category: Category::from_db(&row.category),
            description: row.description,
            proposer: row.proposer,
            executed_at: row.executed_at,
        }
    }
}

#[derive(SimpleObject)]
struct SpendTotal {
    token: String,
    category: Category,
    /// Sum of executed transfer amounts, as a decimal string.
    total: String,
    count: i64,
}

#[derive(sqlx::FromRow)]
struct SpendTotalRow {
    token: String,
    category: String,
    total: String,
    count: i64,
}

fn add_spend_filters(builder: &mut QueryBuilder<'_, Postgres>, filter: &SpendFilter) {
    if let Some(token) = &filter.token {
        builder.push(" AND p.token = ").push_bind(token.clone());
    }
    if let Some(category) = filter.category {
        builder.push(" AND p.category = ").push_bind(category.db());
    }
    if let Some(recipient) = &filter.recipient {
        builder
            .push(" AND p.recipient ILIKE ")
            .push_bind(like_pattern(recipient));
    }
    if let Some(start) = filter.start_date {
        builder.push(" AND p.executed_at >= ").push_bind(start);
    }
    if let Some(end) = filter.end_date {
        builder.push(" AND p.executed_at <= ").push_bind(end);
    }
}

const SPEND_SCOPE: &str = " FROM proposals p WHERE p.status = 'executed' \
     AND p.kind = 'transfer' AND p.contract_id = ";

// ---------------------------------------------------------------------------
// Treasury flows
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow, SimpleObject)]
struct TreasuryFlow {
    proposal_id: Option<i64>,
    schedule_id: Option<i64>,
    recipient: String,
    token: String,
    /// Decimal token-unit string.
    amount: String,
    ledger: i64,
    tx_hash: String,
    occurred_at: DateTime<Utc>,
}

fn add_flow_filters(builder: &mut QueryBuilder<'_, Postgres>, filter: &TreasuryFlowFilter) {
    if let Some(token) = &filter.token {
        builder.push(" AND t.token = ").push_bind(token.clone());
    }
    if let Some(recipient) = &filter.recipient {
        builder
            .push(" AND t.recipient ILIKE ")
            .push_bind(like_pattern(recipient));
    }
    if let Some(proposal_id) = filter.proposal_id {
        builder.push(" AND t.proposal_id = ").push_bind(proposal_id);
    }
    if let Some(schedule_id) = filter.schedule_id {
        builder.push(" AND t.schedule_id = ").push_bind(schedule_id);
    }
    if let Some(start) = filter.start_date {
        builder.push(" AND t.occurred_at >= ").push_bind(start);
    }
    if let Some(end) = filter.end_date {
        builder.push(" AND t.occurred_at <= ").push_bind(end);
    }
}

// ---------------------------------------------------------------------------
// Query root
// ---------------------------------------------------------------------------

pub(crate) struct QueryRoot;

#[Object]
impl QueryRoot {
    /// Proposals, newest first by default.
    #[graphql(complexity = "first.unwrap_or(20).clamp(1, 100) as usize * child_complexity")]
    async fn proposals(
        &self,
        ctx: &Context<'_>,
        first: Option<i32>,
        after: Option<String>,
        filter: Option<ProposalFilter>,
        #[graphql(default)] sort: ProposalSort,
        #[graphql(default)] order: SortOrder,
    ) -> Result<Connection<Proposal>> {
        fetch_proposals(ctx, first, after, filter, sort, order, None).await
    }

    async fn proposal(&self, ctx: &Context<'_>, id: i64) -> Result<Option<Proposal>> {
        let db = db(ctx)?;
        let mut query = QueryBuilder::<Postgres>::new(format!(
            "SELECT {PROPOSAL_COLUMNS} FROM proposals p WHERE p.contract_id = "
        ));
        query
            .push_bind(db.contract_id.clone())
            .push(" AND p.proposal_id = ")
            .push_bind(id);
        let row = query
            .build_query_as::<ProposalRow>()
            .fetch_optional(&db.pool)
            .await
            .map_err(db_error)?;
        Ok(row.map(Proposal::from))
    }

    /// Current owners ordered by weight, heaviest first.
    #[graphql(complexity = "first.unwrap_or(20).clamp(1, 100) as usize * child_complexity")]
    async fn owners(
        &self,
        ctx: &Context<'_>,
        first: Option<i32>,
        after: Option<String>,
        filter: Option<OwnerFilter>,
    ) -> Result<Connection<Owner>> {
        let page = page_request(first, after.as_deref())?;
        let filter = filter.unwrap_or_default();
        let db = db(ctx)?;

        let total = if wants_total(ctx) {
            let mut count = QueryBuilder::<Postgres>::new("");
            owners_from(&mut count, &db.contract_id, "SELECT COUNT(*)");
            add_owner_filters(&mut count, &filter);
            Some(
                count
                    .build_query_scalar::<i64>()
                    .fetch_one(&db.pool)
                    .await
                    .map_err(db_error)?,
            )
        } else {
            None
        };

        let mut rows = QueryBuilder::<Postgres>::new("");
        owners_from(
            &mut rows,
            &db.contract_id,
            "SELECT o.address, o.weight, o.total_weight, o.last_changed_ledger, o.last_changed_at",
        );
        add_owner_filters(&mut rows, &filter);
        rows.push(" ORDER BY o.weight DESC, o.address ASC");
        push_page(&mut rows, &page);
        let rows = rows
            .build_query_as::<Owner>()
            .fetch_all(&db.pool)
            .await
            .map_err(db_error)?;
        Ok(connection(rows, &page, total))
    }

    async fn owner(&self, ctx: &Context<'_>, address: String) -> Result<Option<Owner>> {
        let loader = ctx.data::<DataLoader<OwnerLoader>>()?;
        loader.load_one(address).await
    }

    /// Executed transfers, most recently executed first.
    #[graphql(complexity = "first.unwrap_or(20).clamp(1, 100) as usize * child_complexity")]
    async fn spends(
        &self,
        ctx: &Context<'_>,
        first: Option<i32>,
        after: Option<String>,
        filter: Option<SpendFilter>,
    ) -> Result<Connection<Spend>> {
        let page = page_request(first, after.as_deref())?;
        let filter = filter.unwrap_or_default();
        let db = db(ctx)?;

        let total = if wants_total(ctx) {
            let mut count = QueryBuilder::<Postgres>::new(format!("SELECT COUNT(*){SPEND_SCOPE}"));
            count.push_bind(db.contract_id.clone());
            add_spend_filters(&mut count, &filter);
            Some(
                count
                    .build_query_scalar::<i64>()
                    .fetch_one(&db.pool)
                    .await
                    .map_err(db_error)?,
            )
        } else {
            None
        };

        let mut rows = QueryBuilder::<Postgres>::new(format!(
            "SELECT p.proposal_id, p.recipient, p.token, p.amount, p.category, p.description, \
             p.proposer, p.executed_at{SPEND_SCOPE}"
        ));
        rows.push_bind(db.contract_id.clone());
        add_spend_filters(&mut rows, &filter);
        rows.push(" ORDER BY p.executed_at DESC NULLS LAST, p.proposal_id DESC");
        push_page(&mut rows, &page);
        let rows = rows
            .build_query_as::<SpendRow>()
            .fetch_all(&db.pool)
            .await
            .map_err(db_error)?;
        Ok(connection(
            rows.into_iter().map(Spend::from).collect(),
            &page,
            total,
        ))
    }

    /// Executed transfer totals grouped by token and category.
    #[graphql(complexity = "25 * child_complexity")]
    async fn spend_totals(
        &self,
        ctx: &Context<'_>,
        filter: Option<SpendFilter>,
    ) -> Result<Vec<SpendTotal>> {
        let filter = filter.unwrap_or_default();
        let db = db(ctx)?;
        let mut query = QueryBuilder::<Postgres>::new(format!(
            "SELECT p.token, p.category, COALESCE(SUM(p.amount::numeric), 0)::text AS total, \
             COUNT(*)::bigint AS count{SPEND_SCOPE}"
        ));
        query.push_bind(db.contract_id.clone());
        add_spend_filters(&mut query, &filter);
        query.push(" GROUP BY p.token, p.category ORDER BY p.token, p.category");
        let rows = query
            .build_query_as::<SpendTotalRow>()
            .fetch_all(&db.pool)
            .await
            .map_err(db_error)?;
        Ok(rows
            .into_iter()
            .map(|row| SpendTotal {
                token: row.token,
                category: Category::from_db(&row.category),
                total: row.total,
                count: row.count,
            })
            .collect())
    }

    /// Token transfers recorded for the treasury, newest first.
    #[graphql(complexity = "first.unwrap_or(20).clamp(1, 100) as usize * child_complexity")]
    async fn treasury_flows(
        &self,
        ctx: &Context<'_>,
        first: Option<i32>,
        after: Option<String>,
        filter: Option<TreasuryFlowFilter>,
    ) -> Result<Connection<TreasuryFlow>> {
        let page = page_request(first, after.as_deref())?;
        let filter = filter.unwrap_or_default();
        let db = db(ctx)?;

        let total = if wants_total(ctx) {
            let mut count = QueryBuilder::<Postgres>::new(
                "SELECT COUNT(*) FROM transfers t WHERE t.contract_id = ",
            );
            count.push_bind(db.contract_id.clone());
            add_flow_filters(&mut count, &filter);
            Some(
                count
                    .build_query_scalar::<i64>()
                    .fetch_one(&db.pool)
                    .await
                    .map_err(db_error)?,
            )
        } else {
            None
        };

        let mut rows = QueryBuilder::<Postgres>::new(
            "SELECT t.proposal_id, t.schedule_id, t.recipient, t.token, t.amount, t.ledger, \
             t.tx_hash, t.occurred_at FROM transfers t WHERE t.contract_id = ",
        );
        rows.push_bind(db.contract_id.clone());
        add_flow_filters(&mut rows, &filter);
        rows.push(" ORDER BY t.ledger DESC, t.event_index DESC");
        push_page(&mut rows, &page);
        let rows = rows
            .build_query_as::<TreasuryFlow>()
            .fetch_all(&db.pool)
            .await
            .map_err(db_error)?;
        Ok(connection(rows, &page, total))
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use serde_json::{Value, json};
    use sqlx::{
        PgPool,
        postgres::{PgConnectOptions, PgPoolOptions},
    };
    use tower::ServiceExt;

    use super::{GraphqlConfig, MAX_BODY_BYTES};
    use crate::{AppState, app};

    const CONTRACT: &str = "C1";

    fn lazy_state(config: GraphqlConfig) -> AppState {
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://accord:accord@localhost/accord_analytics")
            .unwrap();
        AppState::new(pool, CONTRACT.to_owned()).with_graphql(config)
    }

    async fn post_raw(state: AppState, body: String) -> (StatusCode, Value) {
        let response = app(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/graphql")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn query(state: &AppState, query: &str) -> (StatusCode, Value) {
        post_raw(state.clone(), json!({ "query": query }).to_string()).await
    }

    fn first_error_message(body: &Value) -> &str {
        body["errors"][0]["message"].as_str().unwrap_or_default()
    }

    #[tokio::test]
    async fn rejects_queries_nested_too_deeply() {
        let state = lazy_state(GraphqlConfig::default());
        let (status, body) = query(
            &state,
            "{ proposals(first: 1) { nodes { proposerOwner { proposals(first: 1) { nodes { proposerOwner { address } } } } } } }",
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(first_error_message(&body), "Query is nested too deep.");
    }

    #[tokio::test]
    async fn rejects_queries_that_are_too_complex() {
        let state = lazy_state(GraphqlConfig::default());
        let (status, body) = query(
            &state,
            "{ proposals(first: 100) { nodes { id kind to amount token description timeline { type actor } } } }",
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(first_error_message(&body), "Query is too complex.");
    }

    #[tokio::test]
    async fn complexity_limit_is_configurable() {
        let state = lazy_state(GraphqlConfig {
            max_complexity: 5,
            ..GraphqlConfig::default()
        });
        let (status, body) = query(&state, "{ proposals(first: 20) { nodes { id } } }").await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(first_error_message(&body), "Query is too complex.");
    }

    #[tokio::test]
    async fn rejects_page_sizes_above_the_cap() {
        let state = lazy_state(GraphqlConfig::default());
        let (status, body) = query(&state, "{ proposals(first: 101) { nodes { id } } }").await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body["errors"][0]["extensions"]["code"],
            "PAGE_SIZE_EXCEEDED"
        );
    }

    #[tokio::test]
    async fn rejects_malformed_cursors() {
        let state = lazy_state(GraphqlConfig::default());
        let (_, body) = query(&state, r#"{ owners(after: "zz") { nodes { address } } }"#).await;

        assert_eq!(body["errors"][0]["extensions"]["code"], "INVALID_CURSOR");
    }

    #[tokio::test]
    async fn rejects_oversized_bodies() {
        let state = lazy_state(GraphqlConfig::default());
        let padding = " ".repeat(MAX_BODY_BYTES + 1);
        let (status, _) = post_raw(
            state,
            format!(r#"{{"query":"{{ proposals {{ nodes {{ id }} }} }}"{padding}}}"#),
        )
        .await;

        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn rejects_batched_requests() {
        let state = lazy_state(GraphqlConfig::default());
        let (status, body) = post_raw(
            state,
            r#"[{"query":"{ __typename }"},{"query":"{ __typename }"}]"#.to_owned(),
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            first_error_message(&body),
            "Batch requests are not supported"
        );
    }

    #[tokio::test]
    async fn introspection_can_be_disabled() {
        let introspection = "{ __schema { queryType { name } } }";

        let enabled = lazy_state(GraphqlConfig::default());
        let (status, body) = query(&enabled, introspection).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["data"]["__schema"]["queryType"]["name"], "QueryRoot");

        let disabled = lazy_state(GraphqlConfig {
            introspection: false,
            ..GraphqlConfig::default()
        });
        let (_, body) = query(&disabled, introspection).await;
        assert!(
            body["data"]["__schema"].is_null(),
            "introspection should be refused: {body}"
        );
    }

    // -- database-backed tests ------------------------------------------------

    const SEED: &str = r#"
        INSERT INTO proposals (contract_id, proposal_id, kind, recipient, amount, token, description,
            approvals, threshold, status, deadline, created_at, proposer, category, executed_at) VALUES
        ('C1', 1, 'transfer', 'GRECIP1', '100', 'XLM', 'payroll xlm', 2, 2, 'executed', '2026-10-01T00:00:00Z', '2026-09-01T00:00:00Z', 'GAAA', 'Payroll', '2026-09-02T00:00:00Z'),
        ('C1', 2, 'transfer', 'GRECIP2', '50', 'XLM', 'grant xlm', 2, 2, 'executed', '2026-10-01T00:00:00Z', '2026-09-03T00:00:00Z', 'GBBB', 'Grant', '2026-09-04T00:00:00Z'),
        ('C1', 3, 'transfer', 'GRECIP1', '10', 'USDC', 'ops usdc', 1, 2, 'pending', '2026-10-01T00:00:00Z', '2026-09-05T00:00:00Z', 'GAAA', 'Ops', NULL),
        ('C1', 4, 'transfer', 'GRECIP3', '25', 'USDC', 'payroll usdc', 2, 2, 'executed', '2026-10-01T00:00:00Z', '2026-09-06T00:00:00Z', 'GAAA', 'Payroll', '2026-09-07T00:00:00Z'),
        ('C2', 99, 'transfer', 'GOTHER', '999', 'XLM', 'other contract', 2, 2, 'executed', '2026-10-01T00:00:00Z', '2026-09-06T00:00:00Z', 'GAAA', 'Payroll', '2026-09-07T00:00:00Z');
        INSERT INTO events (contract_id, ledger, tx_hash, event_index, proposal_id, topic, actor, occurred_at, data) VALUES
        ('C1', 5, 'h1', 0, 1, 'proposal_created', 'GAAA', '2026-09-01T00:00:00Z', '{"amount": "100", "token": "XLM"}'),
        ('C1', 8, 'h2', 0, 1, 'proposal_executed', 'GBBB', '2026-09-02T00:00:00Z', '{"recipient": "GRECIP1", "schedule_id": 7}'),
        ('C1', 6, 'h3', 0, 2, 'proposal_created', 'GBBB', '2026-09-03T00:00:00Z', '{}');
        INSERT INTO owner_weight_changes (contract_id, owner, old_weight, new_weight, new_total_weight, ledger, tx_hash, event_index, occurred_at) VALUES
        ('C1', 'GAAA', 0, 2, 2, 10, 'o1', 0, '2026-08-01T00:00:00Z'),
        ('C1', 'GAAA', 2, 3, 4, 20, 'o2', 0, '2026-08-05T00:00:00Z'),
        ('C1', 'GBBB', 0, 1, 3, 11, 'o3', 0, '2026-08-02T00:00:00Z'),
        ('C1', 'GCCC', 0, 1, 4, 12, 'o4', 0, '2026-08-03T00:00:00Z'),
        ('C1', 'GCCC', 1, 0, 4, 30, 'o5', 0, '2026-08-06T00:00:00Z');
        INSERT INTO transfers (contract_id, proposal_id, schedule_id, recipient, token, amount, ledger, tx_hash, event_index, occurred_at) VALUES
        ('C1', 1, NULL, 'GRECIP1', 'XLM', '100', 8, 'h2', 1, '2026-09-02T00:00:00Z'),
        ('C1', NULL, 7, 'GRECIP2', 'USDC', '40', 15, 'h9', 0, '2026-09-10T00:00:00Z'),
        ('C2', NULL, NULL, 'GOTHER', 'XLM', '1', 16, 'hx', 0, '2026-09-11T00:00:00Z');
    "#;

    /// A seeded, isolated schema on the database named by `TEST_DATABASE_URL`.
    struct TestDb {
        admin: PgPool,
        schema: String,
        state: AppState,
    }

    impl TestDb {
        async fn connect(name: &str) -> Option<Self> {
            let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
                eprintln!("skipping {name}: TEST_DATABASE_URL is not set");
                return None;
            };
            let schema = format!("gql_{name}_{}", std::process::id());
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
            sqlx::raw_sql(SEED).execute(&pool).await.unwrap();
            let state = AppState::new(pool, CONTRACT.to_owned());
            Some(Self {
                admin,
                schema,
                state,
            })
        }

        async fn run(&self, text: &str) -> Value {
            let (status, body) = query(&self.state, text).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert!(body.get("errors").is_none(), "unexpected errors: {body}");
            body["data"].clone()
        }

        async fn finish(self) {
            sqlx::query(&format!("DROP SCHEMA {} CASCADE", self.schema))
                .execute(&self.admin)
                .await
                .unwrap();
        }
    }

    fn ids(nodes: &Value) -> Vec<i64> {
        nodes
            .as_array()
            .unwrap()
            .iter()
            .map(|node| node["id"].as_i64().unwrap())
            .collect()
    }

    #[tokio::test]
    async fn proposals_filter_sort_and_paginate() {
        let Some(db) = TestDb::connect("proposals").await else {
            return;
        };

        let first = db
            .run(
                "{ proposals(first: 1, filter: { category: PAYROLL }, sort: AMOUNT, order: ASC) \
                 { nodes { id amount status category } pageInfo { hasNextPage endCursor } totalCount } }",
            )
            .await;
        let page = &first["proposals"];
        assert_eq!(ids(&page["nodes"]), vec![4]);
        assert_eq!(page["nodes"][0]["status"], "EXECUTED");
        assert_eq!(page["nodes"][0]["category"], "PAYROLL");
        assert_eq!(page["totalCount"], 2);
        assert_eq!(page["pageInfo"]["hasNextPage"], true);

        let cursor = page["pageInfo"]["endCursor"].as_str().unwrap().to_owned();
        let second = db
            .run(&format!(
                "{{ proposals(first: 1, after: \"{cursor}\", filter: {{ category: PAYROLL }}, \
                 sort: AMOUNT, order: ASC) {{ nodes {{ id }} pageInfo {{ hasNextPage }} }} }}"
            ))
            .await;
        assert_eq!(ids(&second["proposals"]["nodes"]), vec![1]);
        assert_eq!(second["proposals"]["pageInfo"]["hasNextPage"], false);

        // Contract scoping: proposal 99 belongs to another contract.
        let all = db
            .run("{ proposals(first: 100) { nodes { id } totalCount } }")
            .await;
        assert_eq!(all["proposals"]["totalCount"], 4);
        assert!(!ids(&all["proposals"]["nodes"]).contains(&99));

        let filtered = db
            .run(
                "{ proposals(filter: { status: PENDING, token: \"USDC\", proposer: \"aa\", \
                 startDate: \"2026-09-04T00:00:00Z\" }) { nodes { id } } }",
            )
            .await;
        assert_eq!(ids(&filtered["proposals"]["nodes"]), vec![3]);

        let missing = db.run("{ proposal(id: 99) { id } }").await;
        assert!(missing["proposal"].is_null());
        db.finish().await;
    }

    #[tokio::test]
    async fn proposal_timeline_and_proposer_owner_are_nested() {
        let Some(db) = TestDb::connect("timeline").await else {
            return;
        };

        let data = db
            .run(
                "{ proposal(id: 1) { id timeline { type actor ledger scheduleId recipient } \
                 proposerOwner { address weight } } }",
            )
            .await;
        let proposal = &data["proposal"];
        let timeline = proposal["timeline"].as_array().unwrap();
        assert_eq!(timeline.len(), 2);
        assert_eq!(timeline[0]["type"], "proposal_created");
        assert_eq!(timeline[1]["type"], "proposal_executed");
        assert_eq!(timeline[1]["scheduleId"], 7);
        assert_eq!(timeline[1]["recipient"], "GRECIP1");
        assert_eq!(proposal["proposerOwner"]["address"], "GAAA");
        assert_eq!(proposal["proposerOwner"]["weight"], 3);

        let batched = db
            .run("{ proposals { nodes { id timeline { type } proposerOwner { weight } } } }")
            .await;
        let nodes = batched["proposals"]["nodes"].as_array().unwrap();
        assert_eq!(nodes.len(), 4);
        db.finish().await;
    }

    #[tokio::test]
    async fn owners_report_current_weight_and_their_proposals() {
        let Some(db) = TestDb::connect("owners").await else {
            return;
        };

        let current = db
            .run("{ owners { nodes { address weight } totalCount } }")
            .await;
        let nodes = current["owners"]["nodes"].as_array().unwrap();
        assert_eq!(nodes[0]["address"], "GAAA");
        assert_eq!(nodes[0]["weight"], 3, "latest weight change wins");
        assert_eq!(nodes[1]["address"], "GBBB");
        assert_eq!(
            current["owners"]["totalCount"], 2,
            "removed owners are hidden"
        );

        let with_removed = db
            .run("{ owners(filter: { includeRemoved: true }) { totalCount } }")
            .await;
        assert_eq!(with_removed["owners"]["totalCount"], 3);

        let nested = db
            .run(
                "{ owners(first: 2, filter: { address: \"aa\" }) { nodes { address \
                 proposals(first: 10, filter: { status: EXECUTED }) { totalCount nodes { id } } } } }",
            )
            .await;
        let owner = &nested["owners"]["nodes"][0];
        assert_eq!(owner["address"], "GAAA");
        assert_eq!(owner["proposals"]["totalCount"], 2);
        assert_eq!(ids(&owner["proposals"]["nodes"]), vec![4, 1]);

        let single = db
            .run("{ owner(address: \"GBBB\") { weight totalWeight } }")
            .await;
        assert_eq!(single["owner"]["weight"], 1);
        db.finish().await;
    }

    #[tokio::test]
    async fn spends_and_totals_cover_executed_transfers() {
        let Some(db) = TestDb::connect("spends").await else {
            return;
        };

        let spends = db
            .run(
                "{ spends(first: 2) { nodes { proposalId amount token category } \
                 pageInfo { hasNextPage } totalCount } }",
            )
            .await;
        let page = &spends["spends"];
        assert_eq!(page["totalCount"], 3);
        assert_eq!(page["pageInfo"]["hasNextPage"], true);
        assert_eq!(
            page["nodes"][0]["proposalId"], 4,
            "most recently executed first"
        );

        let xlm = db
            .run("{ spends(filter: { token: \"XLM\", category: GRANT }) { nodes { proposalId } } }")
            .await;
        assert_eq!(xlm["spends"]["nodes"][0]["proposalId"], 2);

        let totals = db
            .run("{ spendTotals { token category total count } }")
            .await;
        let totals = totals["spendTotals"].as_array().unwrap();
        assert_eq!(totals.len(), 3);
        let payroll_xlm = totals
            .iter()
            .find(|row| row["token"] == "XLM" && row["category"] == "PAYROLL")
            .unwrap();
        assert_eq!(payroll_xlm["total"], "100");
        assert_eq!(payroll_xlm["count"], 1);
        db.finish().await;
    }

    #[tokio::test]
    async fn treasury_flows_filter_and_paginate() {
        let Some(db) = TestDb::connect("flows").await else {
            return;
        };

        let flows = db
            .run(
                "{ treasuryFlows(first: 1) { nodes { token amount ledger scheduleId } \
                 pageInfo { hasNextPage endCursor } totalCount } }",
            )
            .await;
        let page = &flows["treasuryFlows"];
        assert_eq!(page["totalCount"], 2, "other contracts are excluded");
        assert_eq!(page["nodes"][0]["ledger"], 15, "newest first");
        assert_eq!(page["nodes"][0]["scheduleId"], 7);
        assert_eq!(page["pageInfo"]["hasNextPage"], true);

        let proposal = db
            .run(
                "{ treasuryFlows(filter: { proposalId: 1, token: \"XLM\" }) { nodes { amount } } }",
            )
            .await;
        assert_eq!(proposal["treasuryFlows"]["nodes"][0]["amount"], "100");
        db.finish().await;
    }
}
