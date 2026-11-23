//! Branded report templates: `GET|PUT|DELETE /report-templates`.
//!
//! A workspace (one network + contract pair) can customise the header, footer,
//! logo reference, accent colour and sections of the treasury reports it
//! receives. The template is applied by the report pipeline (`reports.rs`) to
//! the scheduled run, the manual run, the CSV, the PDF and the delivery email.

use std::collections::HashMap;

use axum::{
    Json,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, QueryBuilder, postgres::Postgres, types::Json as SqlJson};

use crate::{
    AppState, admin,
    proposals::{self, ApiError, ErrorDetail},
    scope::{ScopeConfig, push_scope},
};

/// Largest request body a template write may carry.
pub(crate) const MAX_BODY_BYTES: usize = 16 * 1024;

/// Query parameters `GET /report-templates` accepts.
pub(crate) const LIST_PARAMS: &[&str] = &["limit", "offset", "contractId", "network"];
/// Query parameters `PUT` and `DELETE /report-templates` accept.
pub(crate) const WRITE_PARAMS: &[&str] = &["contractId", "network"];

const MAX_NAME: usize = 80;
const MAX_TITLE: usize = 120;
const MAX_TEXT: usize = 500;
const MAX_LOGO_URL: usize = 2048;
const PLACEHOLDERS: &[&str] = &["{network}", "{contract}", "{period}"];

pub(crate) const SECTION_NAMES: &[&str] =
    &["summary", "token_totals", "category_totals", "transactions"];

/// A block of a report a template can include, drop or reorder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Section {
    Summary,
    TokenTotals,
    CategoryTotals,
    Transactions,
}

impl Section {
    /// Every section, in the order the unbranded report uses.
    pub const ALL: [Section; 4] = [
        Section::Summary,
        Section::TokenTotals,
        Section::CategoryTotals,
        Section::Transactions,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Summary => "summary",
            Self::TokenTotals => "token_totals",
            Self::CategoryTotals => "category_totals",
            Self::Transactions => "transactions",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|section| section.as_str() == value)
    }
}

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ReportTemplate {
    pub id: i64,
    pub network: String,
    pub contract_id: String,
    pub brand_name: Option<String>,
    pub title: Option<String>,
    pub header_text: Option<String>,
    pub footer_text: Option<String>,
    pub logo_url: Option<String>,
    pub accent_color: Option<String>,
    pub sections: SqlJson<Vec<String>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

const COLUMNS: &str = "id, network, contract_id, brand_name, title, header_text, footer_text, \
                       logo_url, accent_color, sections, created_at, updated_at";

impl ReportTemplate {
    /// The template for one workspace, if it has customised its reports.
    pub async fn load(
        pool: &PgPool,
        network: &str,
        contract_id: &str,
    ) -> sqlx::Result<Option<Self>> {
        sqlx::query_as::<_, Self>(&format!(
            "SELECT {COLUMNS} FROM report_templates WHERE network = $1 AND contract_id = $2"
        ))
        .bind(network)
        .bind(contract_id)
        .fetch_optional(pool)
        .await
    }

    /// The sections to render, in the template's order.
    pub fn section_list(&self) -> Vec<Section> {
        let sections: Vec<Section> = self
            .sections
            .0
            .iter()
            .filter_map(|name| Section::parse(name))
            .collect();
        if sections.is_empty() {
            Section::ALL.to_vec()
        } else {
            sections
        }
    }

    /// The accent colour as 0.0–1.0 RGB components.
    pub fn accent_rgb(&self) -> Option<(f32, f32, f32)> {
        let hex = self.accent_color.as_deref()?.strip_prefix('#')?;
        let channel = |range: std::ops::Range<usize>| {
            u8::from_str_radix(hex.get(range)?, 16)
                .ok()
                .map(|value| f32::from(value) / 255.0)
        };
        Some((channel(0..2)?, channel(2..4)?, channel(4..6)?))
    }

    /// The report title: the template's own, with `{network}`, `{contract}` and
    /// `{period}` filled in, or `default` when the template sets none.
    pub fn resolve_title(
        &self,
        default: String,
        network: &str,
        contract_id: &str,
        period: &str,
    ) -> String {
        match self.title.as_deref() {
            None => default,
            Some(title) => title
                .replace("{network}", network)
                .replace("{contract}", contract_id)
                .replace("{period}", period),
        }
    }
}

/// The body of `PUT /report-templates`. A `PUT` replaces the whole template, so
/// an omitted field goes back to its default.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TemplateInput {
    brand_name: Option<String>,
    title: Option<String>,
    header_text: Option<String>,
    footer_text: Option<String>,
    logo_url: Option<String>,
    accent_color: Option<String>,
    sections: Option<Vec<String>>,
}

/// A template that passed validation and is ready to store.
#[derive(Debug, PartialEq)]
struct ValidTemplate {
    brand_name: Option<String>,
    title: Option<String>,
    header_text: Option<String>,
    footer_text: Option<String>,
    logo_url: Option<String>,
    accent_color: Option<String>,
    sections: Vec<String>,
}

fn invalid(field: &str, message: &str, code: &'static str) -> ErrorDetail {
    proposals::detail(field, message, code)
}

/// Trims a text field; an empty value means "not set". Single line only, so a
/// value can never smuggle extra headers into an email or extra rows into a CSV.
fn text(
    value: Option<String>,
    field: &str,
    max: usize,
    details: &mut Vec<ErrorDetail>,
) -> Option<String> {
    let value = value?.trim().to_owned();
    if value.is_empty() {
        return None;
    }
    if value.chars().count() > max {
        details.push(invalid(
            field,
            &format!("must be at most {max} characters"),
            "INVALID_TEMPLATE_FIELD",
        ));
        return None;
    }
    if value.chars().any(char::is_control) {
        details.push(invalid(
            field,
            "must be a single line without control characters",
            "INVALID_TEMPLATE_FIELD",
        ));
        return None;
    }
    Some(value)
}

fn validate(input: TemplateInput) -> Result<ValidTemplate, Vec<ErrorDetail>> {
    let mut details = Vec::new();

    let brand_name = text(input.brand_name, "brandName", MAX_NAME, &mut details);
    let title = text(input.title, "title", MAX_TITLE, &mut details);
    if let Some(title) = &title {
        let mut rest = title.as_str();
        while let Some(start) = rest.find('{') {
            let Some(length) = rest[start..].find('}') else {
                details.push(invalid(
                    "title",
                    "has an unclosed placeholder",
                    "INVALID_TEMPLATE_FIELD",
                ));
                break;
            };
            let placeholder = &rest[start..=start + length];
            if !PLACEHOLDERS.contains(&placeholder) {
                details.push(invalid(
                    "title",
                    "may only use the placeholders {network}, {contract} and {period}",
                    "INVALID_TEMPLATE_FIELD",
                ));
                break;
            }
            rest = &rest[start + length + 1..];
        }
    }
    let header_text = text(input.header_text, "headerText", MAX_TEXT, &mut details);
    let footer_text = text(input.footer_text, "footerText", MAX_TEXT, &mut details);

    let logo_url = text(input.logo_url, "logoUrl", MAX_LOGO_URL, &mut details);
    if let Some(url) = &logo_url {
        let host = url.strip_prefix("https://").unwrap_or_default();
        let clean = !host.is_empty()
            && !host.starts_with('/')
            && !url.chars().any(|c| c.is_whitespace() || "\"'<>\\".contains(c));
        if !clean {
            details.push(invalid(
                "logoUrl",
                "must be an https:// URL",
                "INVALID_LOGO_URL",
            ));
        }
    }

    let accent_color = input.accent_color.map(|value| value.trim().to_owned());
    let accent_color = match accent_color.as_deref() {
        None | Some("") => None,
        Some(value)
            if value.len() == 7
                && value.starts_with('#')
                && value[1..].chars().all(|c| c.is_ascii_hexdigit()) =>
        {
            Some(value.to_ascii_lowercase())
        }
        Some(_) => {
            details.push(invalid(
                "accentColor",
                "must be a hex colour such as #1a73e8",
                "INVALID_COLOR",
            ));
            None
        }
    };

    let sections = match input.sections {
        None => Section::ALL
            .iter()
            .map(|section| section.as_str().to_owned())
            .collect(),
        Some(sections) => {
            let mut seen: Vec<&String> = Vec::new();
            let (mut unknown, mut repeated) = (false, false);
            for name in &sections {
                if Section::parse(name).is_none() {
                    unknown = true;
                } else if seen.contains(&name) {
                    repeated = true;
                } else {
                    seen.push(name);
                }
            }
            if unknown {
                details.push(invalid(
                    "sections",
                    "may only contain summary, token_totals, category_totals and transactions",
                    "INVALID_SECTION",
                ));
            }
            if repeated {
                details.push(invalid(
                    "sections",
                    "must not list a section twice",
                    "INVALID_SECTION",
                ));
            }
            if sections.is_empty() {
                details.push(invalid(
                    "sections",
                    "must include at least one section",
                    "INVALID_SECTION",
                ));
            }
            sections
        }
    };

    if !details.is_empty() {
        return Err(details);
    }
    Ok(ValidTemplate {
        brand_name,
        title,
        header_text,
        footer_text,
        logo_url,
        accent_color,
        sections,
    })
}

/// Parses the JSON body, reporting malformed JSON, unknown fields and wrong
/// types as one `INVALID_BODY` detail rather than the framework's plain text.
fn parse_body(body: &Bytes) -> Result<TemplateInput, ErrorDetail> {
    if body.is_empty() {
        return Ok(TemplateInput::default());
    }
    serde_json::from_slice(body).map_err(|error| {
        invalid(
            "body",
            &format!("must be a JSON object of template fields: {error}"),
            "INVALID_BODY",
        )
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TemplatePage {
    items: Vec<ReportTemplate>,
    total: i64,
    limit: i64,
    offset: i64,
}

type ApiResult<T> = Result<T, (StatusCode, Json<ApiError>)>;

fn rejected(details: Vec<ErrorDetail>) -> (StatusCode, Json<ApiError>) {
    (StatusCode::BAD_REQUEST, Json(ApiError::invalid(details)))
}

fn internal_error(error: sqlx::Error) -> (StatusCode, Json<ApiError>) {
    tracing::error!(%error, "failed to access report templates");
    proposals::internal_error(error)
}

fn reject_unknown(raw: &HashMap<String, String>, allowed: &[&str], details: &mut Vec<ErrorDetail>) {
    for key in raw.keys() {
        if !allowed.contains(&key.as_str()) {
            details.push(proposals::detail(
                key,
                "is not a supported query parameter",
                "UNKNOWN_PARAMETER",
            ));
        }
    }
}

/// `GET /report-templates` — the configured templates, ordered by network and
/// contract. Not cached, so an edit shows up on the next read.
pub(crate) async fn list(
    State(state): State<AppState>,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<Json<TemplatePage>> {
    let mut details = Vec::new();
    reject_unknown(&raw, LIST_PARAMS, &mut details);
    let limit = proposals::parse_integer(&raw, "limit", 20, 1, 100, &mut details);
    let offset = proposals::parse_integer(&raw, "offset", 0, 0, i64::MAX, &mut details);
    let scope = state.scope.resolve(&raw, &mut details);
    if !details.is_empty() {
        return Err(rejected(details));
    }

    let mut count =
        QueryBuilder::<Postgres>::new("SELECT COUNT(*) FROM report_templates WHERE TRUE");
    push_scope(&mut count, "", &scope);
    let total: i64 = count
        .build_query_scalar()
        .fetch_one(&state.pool)
        .await
        .map_err(internal_error)?;

    let mut rows = QueryBuilder::<Postgres>::new(format!(
        "SELECT {COLUMNS} FROM report_templates WHERE TRUE"
    ));
    push_scope(&mut rows, "", &scope);
    rows.push(" ORDER BY network ASC, contract_id ASC LIMIT ");
    rows.push_bind(limit);
    rows.push(" OFFSET ");
    rows.push_bind(offset);
    let items = rows
        .build_query_as::<ReportTemplate>()
        .fetch_all(&state.pool)
        .await
        .map_err(internal_error)?;

    Ok(Json(TemplatePage {
        items,
        total,
        limit,
        offset,
    }))
}

/// The one (network, contract) a write targets. With several configured, the
/// caller must say which; guessing would edit the wrong workspace.
fn target(
    raw: &HashMap<String, String>,
    config: &ScopeConfig,
    details: &mut Vec<ErrorDetail>,
) -> Option<(String, String)> {
    let scope = config.resolve(raw, details);
    let mut missing = false;
    for (field, count) in [
        ("contractId", scope.contract_ids.len()),
        ("network", scope.networks.len()),
    ] {
        if proposals::nonempty(raw, field).is_none() && count != 1 {
            details.push(proposals::detail(
                field,
                "is required because this deployment serves more than one",
                "MISSING_PARAMETER",
            ));
            missing = true;
        }
    }
    if missing {
        return None;
    }
    Some((
        scope.networks.first()?.clone(),
        scope.contract_ids.first()?.clone(),
    ))
}

/// `PUT /report-templates` — creates or replaces a workspace's template.
pub(crate) async fn put(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
    body: Bytes,
) -> ApiResult<Json<ReportTemplate>> {
    admin::require(&state, &headers)?;

    let mut details = Vec::new();
    reject_unknown(&raw, WRITE_PARAMS, &mut details);
    let target = target(&raw, &state.scope, &mut details);
    let template = match parse_body(&body) {
        Ok(input) => validate(input).map_err(|errors| details.extend(errors)).ok(),
        Err(error) => {
            details.push(error);
            None
        }
    };
    let (Some((network, contract_id)), Some(template), true) =
        (target, template, details.is_empty())
    else {
        return Err(rejected(details));
    };

    let stored = sqlx::query_as::<_, ReportTemplate>(&format!(
        "INSERT INTO report_templates (network, contract_id, brand_name, title, header_text, \
         footer_text, logo_url, accent_color, sections) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
         ON CONFLICT (network, contract_id) DO UPDATE SET \
           brand_name = EXCLUDED.brand_name, title = EXCLUDED.title, \
           header_text = EXCLUDED.header_text, footer_text = EXCLUDED.footer_text, \
           logo_url = EXCLUDED.logo_url, accent_color = EXCLUDED.accent_color, \
           sections = EXCLUDED.sections, updated_at = NOW() \
         RETURNING {COLUMNS}"
    ))
    .bind(&network)
    .bind(&contract_id)
    .bind(&template.brand_name)
    .bind(&template.title)
    .bind(&template.header_text)
    .bind(&template.footer_text)
    .bind(&template.logo_url)
    .bind(&template.accent_color)
    .bind(SqlJson(&template.sections))
    .fetch_one(&state.pool)
    .await
    .map_err(internal_error)?;

    Ok(Json(stored))
}

/// `DELETE /report-templates` — drops a workspace's template, so its reports
/// go back to the default layout.
pub(crate) async fn delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(raw): axum::extract::Query<HashMap<String, String>>,
) -> ApiResult<StatusCode> {
    admin::require(&state, &headers)?;

    let mut details = Vec::new();
    reject_unknown(&raw, WRITE_PARAMS, &mut details);
    let target = target(&raw, &state.scope, &mut details);
    let (Some((network, contract_id)), true) = (target, details.is_empty()) else {
        return Err(rejected(details));
    };

    let removed: Option<i64> = sqlx::query_scalar(
        "DELETE FROM report_templates WHERE network = $1 AND contract_id = $2 RETURNING id",
    )
    .bind(&network)
    .bind(&contract_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(internal_error)?;

    match removed {
        Some(_) => Ok(StatusCode::NO_CONTENT),
        None => Err((
            StatusCode::NOT_FOUND,
            Json(ApiError::new(
                "NOT_FOUND",
                "No report template is configured for this workspace",
            )),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(json: &str) -> TemplateInput {
        serde_json::from_str(json).unwrap()
    }

    fn codes(details: &[ErrorDetail]) -> Vec<String> {
        let mut codes: Vec<String> = details
            .iter()
            .map(|detail| {
                serde_json::to_value(detail).unwrap()["code"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        codes.sort();
        codes
    }

    fn template(title: Option<&str>, color: Option<&str>) -> ReportTemplate {
        ReportTemplate {
            id: 1,
            network: "testnet".into(),
            contract_id: "C1".into(),
            brand_name: None,
            title: title.map(str::to_owned),
            header_text: None,
            footer_text: None,
            logo_url: None,
            accent_color: color.map(str::to_owned),
            sections: SqlJson(vec!["summary".into()]),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn an_empty_template_uses_every_section_in_the_default_order() {
        let valid = validate(TemplateInput::default()).unwrap();

        assert_eq!(
            valid.sections,
            ["summary", "token_totals", "category_totals", "transactions"]
        );
        assert_eq!(valid.brand_name, None);
    }

    #[test]
    fn accepts_a_fully_branded_template() {
        let valid = validate(input(
            r##"{"brandName":" Acme Treasury ","title":"{network} statement, {period}",
                "headerText":"Confidential","footerText":"Acme Inc.",
                "logoUrl":"https://cdn.example.com/logo.png","accentColor":"#1A73E8",
                "sections":["transactions","summary"]}"##,
        ))
        .unwrap();

        assert_eq!(valid.brand_name.as_deref(), Some("Acme Treasury"));
        assert_eq!(valid.accent_color.as_deref(), Some("#1a73e8"));
        assert_eq!(valid.sections, ["transactions", "summary"]);
    }

    #[test]
    fn blank_text_means_not_set() {
        let valid = validate(input(r#"{"brandName":"   ","headerText":""}"#)).unwrap();

        assert_eq!(valid.brand_name, None);
        assert_eq!(valid.header_text, None);
    }

    #[test]
    fn rejects_bad_fields_and_reports_each_kind() {
        let body = serde_json::json!({
            "brandName": "line\nbreak",
            "title": "{nope}",
            "logoUrl": "http://insecure.example/x.png",
            "accentColor": "red",
            "sections": ["summary", "summary", "charts"],
            "footerText": "a".repeat(MAX_TEXT + 1),
        });
        let details = validate(input(&body.to_string())).unwrap_err();

        let codes = codes(&details);
        for expected in [
            "INVALID_TEMPLATE_FIELD",
            "INVALID_LOGO_URL",
            "INVALID_COLOR",
            "INVALID_SECTION",
        ] {
            assert!(codes.contains(&expected.to_owned()), "{expected} in {codes:?}");
        }
        assert_eq!(
            codes.iter().filter(|code| *code == "INVALID_SECTION").count(),
            2,
            "unknown and repeated sections are reported once each"
        );
    }

    #[test]
    fn rejects_an_empty_section_list_and_unsafe_logo_urls() {
        assert!(validate(input(r#"{"sections":[]}"#)).is_err());
        for url in [
            "javascript:alert(1)",
            "https://",
            "https:///path",
            "https://a.example/x y.png",
            "https://a.example/\"onerror=1",
        ] {
            let json = serde_json::json!({ "logoUrl": url }).to_string();
            assert!(validate(input(&json)).is_err(), "{url}");
        }
    }

    #[test]
    fn unknown_body_fields_and_bad_json_are_invalid_bodies() {
        for body in [r##"{"colour":"#fff"}"##, "not json", r#"{"sections":"summary"}"#] {
            let error = parse_body(&Bytes::from(body.to_owned())).unwrap_err();
            assert_eq!(codes(&[error]), ["INVALID_BODY"], "{body}");
        }
        assert!(parse_body(&Bytes::new()).is_ok(), "an empty body clears the template");
    }

    #[test]
    fn title_placeholders_are_filled_in() {
        let template = template(Some("{network} / {contract} / {period}"), None);

        assert_eq!(
            template.resolve_title("default".into(), "testnet", "C1", "2026-09-01 to 2026-09-30"),
            "testnet / C1 / 2026-09-01 to 2026-09-30"
        );
        assert_eq!(
            self::template(None, None).resolve_title("default".into(), "n", "c", "p"),
            "default"
        );
    }

    #[test]
    fn accent_colours_become_rgb_components() {
        let (r, g, b) = template(None, Some("#ff8000")).accent_rgb().unwrap();

        assert_eq!(r, 1.0);
        assert!((g - 128.0 / 255.0).abs() < f32::EPSILON);
        assert_eq!(b, 0.0);
        assert_eq!(template(None, None).accent_rgb(), None);
    }

    #[test]
    fn unknown_stored_sections_fall_back_to_the_default_layout() {
        let mut template = template(None, None);
        template.sections = SqlJson(vec!["charts".into()]);

        assert_eq!(template.section_list(), Section::ALL);
    }
}
