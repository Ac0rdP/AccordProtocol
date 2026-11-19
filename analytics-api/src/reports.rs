use std::{collections::BTreeMap, fmt, str::FromStr};

use chrono::{DateTime, Duration, Utc};
use printpdf::{
    BuiltinFont, Color, Mm, Op, PdfDocument, PdfFontHandle, PdfPage, PdfSaveOptions, Point, Pt,
    Rgb, TextItem,
};
use serde::Serialize;
use sqlx::PgPool;

use crate::templates::{ReportTemplate, Section};

/// The inclusive-start, exclusive-end window a report covers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ReportPeriod {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
}

impl ReportPeriod {
    /// The `days` ending at `end` — the window a scheduled run reports on.
    pub fn ending_at(end: DateTime<Utc>, days: i64) -> Self {
        Self {
            start: end - Duration::days(days.max(1)),
            end,
        }
    }

    fn label(&self) -> String {
        format!(
            "{} to {}",
            self.start.format("%Y-%m-%d"),
            self.end.format("%Y-%m-%d")
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReportFormat {
    Csv,
    Pdf,
}

impl ReportFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Pdf => "pdf",
        }
    }

    pub fn content_type(self) -> &'static str {
        match self {
            Self::Csv => "text/csv",
            Self::Pdf => "application/pdf",
        }
    }
}

impl fmt::Display for ReportFormat {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for ReportFormat {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "csv" => Ok(Self::Csv),
            "pdf" => Ok(Self::Pdf),
            other => Err(format!(
                "unsupported report format \"{other}\", expected csv or pdf"
            )),
        }
    }
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct ReportLine {
    pub proposal_id: i64,
    pub executed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub category: String,
    pub kind: String,
    pub recipient: String,
    pub token: String,
    pub amount: String,
    pub proposer: String,
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct TokenTotal {
    pub token: String,
    pub total: String,
    pub count: i64,
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct CategoryTotal {
    pub category: String,
    pub token: String,
    pub total: String,
    pub count: i64,
}

/// One treasury statement: the executed transfers in a period for a single
/// (network, contract) pair, plus the totals an accountant needs to tie out.
#[derive(Clone, Debug)]
pub struct TreasuryReport {
    pub network: String,
    pub contract_id: String,
    pub period: ReportPeriod,
    pub generated_at: DateTime<Utc>,
    pub lines: Vec<ReportLine>,
    pub token_totals: Vec<TokenTotal>,
    pub category_totals: Vec<CategoryTotal>,
    /// The workspace's branding, when it has customised its reports. `None`
    /// renders the default layout that existed before templates.
    pub template: Option<ReportTemplate>,
}

impl TreasuryReport {
    pub async fn load(
        pool: &PgPool,
        network: &str,
        contract_id: &str,
        period: ReportPeriod,
        generated_at: DateTime<Utc>,
    ) -> sqlx::Result<Self> {
        let lines = sqlx::query_as::<_, ReportLine>(
            "SELECT proposal_id, executed_at, created_at, category, kind, recipient, token, \
             amount, proposer FROM proposals \
             WHERE network = $1 AND contract_id = $2 AND status = 'executed' \
               AND executed_at >= $3 AND executed_at < $4 \
             ORDER BY executed_at ASC, proposal_id ASC",
        )
        .bind(network)
        .bind(contract_id)
        .bind(period.start)
        .bind(period.end)
        .fetch_all(pool)
        .await?;

        let token_totals = sqlx::query_as::<_, TokenTotal>(
            "SELECT token, COALESCE(SUM(amount::numeric), 0)::text AS total, \
             COUNT(*)::bigint AS count FROM proposals \
             WHERE network = $1 AND contract_id = $2 AND status = 'executed' \
               AND executed_at >= $3 AND executed_at < $4 \
             GROUP BY token ORDER BY token",
        )
        .bind(network)
        .bind(contract_id)
        .bind(period.start)
        .bind(period.end)
        .fetch_all(pool)
        .await?;

        let category_totals = sqlx::query_as::<_, CategoryTotal>(
            "SELECT category, token, COALESCE(SUM(amount::numeric), 0)::text AS total, \
             COUNT(*)::bigint AS count FROM proposals \
             WHERE network = $1 AND contract_id = $2 AND status = 'executed' \
               AND executed_at >= $3 AND executed_at < $4 \
             GROUP BY category, token ORDER BY category, token",
        )
        .bind(network)
        .bind(contract_id)
        .bind(period.start)
        .bind(period.end)
        .fetch_all(pool)
        .await?;

        Ok(Self {
            network: network.to_owned(),
            contract_id: contract_id.to_owned(),
            period,
            generated_at,
            lines,
            token_totals,
            category_totals,
            template: None,
        })
    }

    pub fn title(&self) -> String {
        let default = format!(
            "Accord treasury report — {} — {}",
            self.network,
            self.period.label()
        );
        match &self.template {
            Some(template) => template.resolve_title(
                default,
                &self.network,
                &self.contract_id,
                &self.period.label(),
            ),
            None => default,
        }
    }

    /// The delivery email body with the template's header, logo and footer
    /// around it. Unchanged when the workspace has no template.
    pub fn email_body(&self, body: String) -> String {
        let Some(template) = &self.template else {
            return body;
        };
        let mut parts = Vec::new();
        parts.extend(template.brand_name.clone());
        parts.extend(template.header_text.clone());
        parts.push(body);
        parts.extend(template.logo_url.as_ref().map(|url| format!("Logo: {url}")));
        parts.extend(template.footer_text.clone());
        parts.join("\n\n")
    }

    /// A stable, filesystem-safe name: `accord-<network>-<contract>-<start>-<end>`.
    pub fn file_stem(&self) -> String {
        let contract = self
            .contract_id
            .chars()
            .filter(|character| character.is_ascii_alphanumeric())
            .take(12)
            .collect::<String>()
            .to_ascii_lowercase();
        format!(
            "accord-{}-{}-{}-{}",
            self.network,
            contract,
            self.period.start.format("%Y%m%d"),
            self.period.end.format("%Y%m%d")
        )
    }

    pub fn filename(&self, format: ReportFormat) -> String {
        format!("{}.{}", self.file_stem(), format.as_str())
    }

    pub fn render(&self, format: ReportFormat) -> Result<Vec<u8>, String> {
        match format {
            ReportFormat::Csv => self.to_csv(),
            ReportFormat::Pdf => Ok(self.to_pdf()),
        }
    }

    pub fn to_csv(&self) -> Result<Vec<u8>, String> {
        match &self.template {
            None => self.plain_csv(),
            Some(template) => self.branded_csv(template),
        }
    }

    /// The branded layout: the template's identity rows first, then each
    /// chosen section as its own block, in the template's order.
    fn branded_csv(&self, template: &ReportTemplate) -> Result<Vec<u8>, String> {
        let mut writer = csv::WriterBuilder::new()
            .flexible(true)
            .from_writer(Vec::new());
        let write_error = |error: csv::Error| format!("failed to write report CSV: {error}");
        let row = |writer: &mut csv::Writer<Vec<u8>>, fields: &[&str]| {
            let safe: Vec<String> = fields.iter().map(|field| csv_safe(field)).collect();
            writer.write_record(&safe).map_err(write_error)
        };

        if let Some(brand) = &template.brand_name {
            row(&mut writer, &["brand", brand])?;
        }
        row(&mut writer, &["title", &self.title()])?;
        if let Some(header) = &template.header_text {
            row(&mut writer, &["header", header])?;
        }
        if let Some(logo) = &template.logo_url {
            row(&mut writer, &["logo", logo])?;
        }

        for section in template.section_list() {
            writer
                .write_record::<[&str; 0], &str>([])
                .map_err(write_error)?;
            match section {
                Section::Summary => {
                    row(&mut writer, &["section", "key", "value"])?;
                    for (key, value) in [
                        ("network", self.network.clone()),
                        ("contract_id", self.contract_id.clone()),
                        ("period", self.period.label()),
                        ("generated_at", self.generated_at.to_rfc3339()),
                        ("executed_transfers", self.lines.len().to_string()),
                    ] {
                        row(&mut writer, &["summary", key, &value])?;
                    }
                }
                Section::Transactions => {
                    row(&mut writer, &TRANSACTION_HEADER)?;
                    for line in &self.lines {
                        row(
                            &mut writer,
                            &[
                                &self.network,
                                &self.contract_id,
                                &line.proposal_id.to_string(),
                                &line
                                    .executed_at
                                    .map(|at| at.to_rfc3339())
                                    .unwrap_or_default(),
                                &line.created_at.to_rfc3339(),
                                &line.category,
                                &line.kind,
                                &line.recipient,
                                &line.token,
                                &line.amount,
                                &line.proposer,
                            ],
                        )?;
                    }
                }
                Section::TokenTotals => {
                    row(&mut writer, &["section", "token", "category", "total", "count"])?;
                    for total in &self.token_totals {
                        row(
                            &mut writer,
                            &[
                                "token_total",
                                &total.token,
                                "",
                                &total.total,
                                &total.count.to_string(),
                            ],
                        )?;
                    }
                }
                Section::CategoryTotals => {
                    row(&mut writer, &["section", "token", "category", "total", "count"])?;
                    for total in &self.category_totals {
                        row(
                            &mut writer,
                            &[
                                "category_total",
                                &total.token,
                                &total.category,
                                &total.total,
                                &total.count.to_string(),
                            ],
                        )?;
                    }
                }
            }
        }

        if let Some(footer) = &template.footer_text {
            writer
                .write_record::<[&str; 0], &str>([])
                .map_err(write_error)?;
            row(&mut writer, &["footer", footer])?;
        }

        writer
            .into_inner()
            .map_err(|error| format!("failed to finish report CSV: {error}"))
    }

    fn plain_csv(&self) -> Result<Vec<u8>, String> {
        // Flexible records let the totals section use its own, narrower header
        // below the transaction rows in the same file.
        let mut writer = csv::WriterBuilder::new()
            .flexible(true)
            .from_writer(Vec::new());
        let write_error = |error: csv::Error| format!("failed to write report CSV: {error}");

        writer
            .write_record(TRANSACTION_HEADER)
            .map_err(write_error)?;

        for line in &self.lines {
            writer
                .write_record([
                    self.network.as_str(),
                    self.contract_id.as_str(),
                    &line.proposal_id.to_string(),
                    &line
                        .executed_at
                        .map(|at| at.to_rfc3339())
                        .unwrap_or_default(),
                    &line.created_at.to_rfc3339(),
                    line.category.as_str(),
                    line.kind.as_str(),
                    line.recipient.as_str(),
                    line.token.as_str(),
                    line.amount.as_str(),
                    line.proposer.as_str(),
                ])
                .map_err(write_error)?;
        }

        // Totals follow the detail rows, each prefixed so a spreadsheet filter
        // can separate them from the transactions.
        writer
            .write_record::<[&str; 0], &str>([])
            .map_err(write_error)?;
        writer
            .write_record(["section", "token", "category", "total", "count"])
            .map_err(write_error)?;
        for total in &self.token_totals {
            writer
                .write_record([
                    "token_total",
                    total.token.as_str(),
                    "",
                    total.total.as_str(),
                    &total.count.to_string(),
                ])
                .map_err(write_error)?;
        }
        for total in &self.category_totals {
            writer
                .write_record([
                    "category_total",
                    total.token.as_str(),
                    total.category.as_str(),
                    total.total.as_str(),
                    &total.count.to_string(),
                ])
                .map_err(write_error)?;
        }

        writer
            .into_inner()
            .map_err(|error| format!("failed to finish report CSV: {error}"))
    }

    pub fn to_pdf(&self) -> Vec<u8> {
        const PAGE_WIDTH: f32 = 297.0; // A4 landscape, so transfer rows fit.
        const PAGE_HEIGHT: f32 = 210.0;
        const TOP: f32 = 190.0;
        const BOTTOM: f32 = 18.0;
        const LINE: f32 = 5.0;

        let template = self.template.as_ref();
        let sections = template.map_or_else(|| Section::ALL.to_vec(), ReportTemplate::section_list);
        let show_transactions = sections.contains(&Section::Transactions);
        let title = self.title();
        let summary = self.summary_lines(&sections);
        let preface = preface_lines(template);
        let brand = template.and_then(|template| template.brand_name.as_deref());
        let accent = template.and_then(ReportTemplate::accent_rgb);
        let footer = template.and_then(|template| template.footer_text.as_deref());

        let mut document = PdfDocument::new(&title);
        let mut pages = Vec::new();
        let mut ops = start_page(&title, brand, accent, &preface, &summary, TOP);
        let extra = preface.len() + usize::from(brand.is_some());
        let mut cursor = TOP - LINE * ((summary.len() + extra) as f32 + 3.0);

        if show_transactions {
            for line in &self.lines {
                if cursor < BOTTOM {
                    pages.push(PdfPage::new(
                        Mm(PAGE_WIDTH),
                        Mm(PAGE_HEIGHT),
                        close_page(ops, footer),
                    ));
                    ops = start_page(
                        &format!("{title} (continued)"),
                        brand,
                        accent,
                        &[],
                        &[],
                        TOP,
                    );
                    cursor = TOP - LINE * (3.0 + usize::from(brand.is_some()) as f32);
                }
                ops.push(Op::ShowText {
                    items: vec![TextItem::Text(format!(
                        "{}  #{}  {}  {}  {} {}  -> {}",
                        line.executed_at
                            .unwrap_or(line.created_at)
                            .format("%Y-%m-%d"),
                        line.proposal_id,
                        line.category,
                        line.kind,
                        line.amount,
                        line.token,
                        truncate(&line.recipient, 24),
                    ))],
                });
                ops.push(Op::AddLineBreak);
                cursor -= LINE;
            }

            if self.lines.is_empty() {
                ops.push(Op::ShowText {
                    items: vec![TextItem::Text(
                        "No executed transfers in this period.".to_owned(),
                    )],
                });
                ops.push(Op::AddLineBreak);
            }
        }

        pages.push(PdfPage::new(
            Mm(PAGE_WIDTH),
            Mm(PAGE_HEIGHT),
            close_page(ops, footer),
        ));

        document
            .with_pages(pages)
            .save(&PdfSaveOptions::default(), &mut Vec::new())
    }

    /// The summary block at the top of the PDF: the chosen sections, in the
    /// template's order. The default is the layout every report used before
    /// templates existed.
    fn summary_lines(&self, sections: &[Section]) -> Vec<String> {
        let mut lines = Vec::new();
        for section in sections {
            match section {
                Section::Summary => lines.extend([
                    format!("Network: {}", self.network),
                    format!("Contract: {}", self.contract_id),
                    format!("Period: {}", self.period.label()),
                    format!("Generated: {}", self.generated_at.to_rfc3339()),
                    format!("Executed transfers: {}", self.lines.len()),
                ]),
                Section::TokenTotals => {
                    for total in &self.token_totals {
                        lines.push(format!(
                            "Total {}: {} across {} proposals",
                            total.token, total.total, total.count
                        ));
                    }
                }
                Section::CategoryTotals => {
                    let mut by_category: BTreeMap<&str, Vec<String>> = BTreeMap::new();
                    for total in &self.category_totals {
                        by_category
                            .entry(total.category.as_str())
                            .or_default()
                            .push(format!("{} {}", total.total, total.token));
                    }
                    for (category, totals) in by_category {
                        lines.push(format!("{category}: {}", totals.join(", ")));
                    }
                }
                // Transaction rows follow the summary block on every page.
                Section::Transactions => {}
            }
        }
        lines
    }
}

/// The template's header text and logo reference, printed under the heading.
fn preface_lines(template: Option<&ReportTemplate>) -> Vec<String> {
    let Some(template) = template else {
        return Vec::new();
    };
    let mut lines = Vec::new();
    lines.extend(template.header_text.clone());
    lines.extend(template.logo_url.as_ref().map(|url| format!("Logo: {url}")));
    lines
}

fn fill(rgb: (f32, f32, f32)) -> Op {
    Op::SetFillColor {
        col: Color::Rgb(Rgb {
            r: rgb.0,
            g: rgb.1,
            b: rgb.2,
            icc_profile: None,
        }),
    }
}

/// Ends a page's text, stamps the template footer at the bottom edge and
/// restores the graphics state.
fn close_page(mut ops: Vec<Op>, footer: Option<&str>) -> Vec<Op> {
    ops.push(Op::EndTextSection);
    if let Some(footer) = footer {
        ops.extend([
            Op::StartTextSection,
            Op::SetTextCursor {
                pos: Point::new(Mm(15.0), Mm(10.0)),
            },
            Op::SetFont {
                font: PdfFontHandle::Builtin(BuiltinFont::Helvetica),
                size: Pt(8.0),
            },
            Op::ShowText {
                items: vec![TextItem::Text(footer.to_owned())],
            },
            Op::EndTextSection,
        ]);
    }
    ops.push(Op::RestoreGraphicsState);
    ops
}

const TRANSACTION_HEADER: [&str; 11] = [
    "network",
    "contract_id",
    "proposal_id",
    "executed_at",
    "created_at",
    "category",
    "kind",
    "recipient",
    "token",
    "amount",
    "proposer",
];

/// Spreadsheets run a cell that starts with `=`, `+`, `-` or `@` as a formula.
/// Template text is free-form, so neutralise it with a leading apostrophe.
fn csv_safe(value: &str) -> String {
    if value.starts_with(['=', '+', '-', '@']) {
        format!("'{value}")
    } else {
        value.to_owned()
    }
}

fn truncate(value: &str, width: usize) -> String {
    if value.chars().count() <= width {
        return value.to_owned();
    }
    format!(
        "{}…",
        value
            .chars()
            .take(width.saturating_sub(1))
            .collect::<String>()
    )
}

fn start_page(
    heading: &str,
    brand: Option<&str>,
    accent: Option<(f32, f32, f32)>,
    preface: &[String],
    summary: &[String],
    top: f32,
) -> Vec<Op> {
    let mut ops = vec![
        Op::SaveGraphicsState,
        Op::StartTextSection,
        Op::SetTextCursor {
            pos: Point::new(Mm(15.0), Mm(top)),
        },
        Op::SetLineHeight { lh: Pt(14.0) },
    ];
    if let Some(accent) = accent {
        ops.push(fill(accent));
    }
    if let Some(brand) = brand {
        ops.extend([
            Op::SetFont {
                font: PdfFontHandle::Builtin(BuiltinFont::HelveticaBold),
                size: Pt(18.0),
            },
            Op::SetLineHeight { lh: Pt(20.0) },
            Op::ShowText {
                items: vec![TextItem::Text(brand.to_owned())],
            },
            Op::AddLineBreak,
            Op::SetLineHeight { lh: Pt(14.0) },
        ]);
    }
    ops.extend([
        Op::SetFont {
            font: PdfFontHandle::Builtin(BuiltinFont::HelveticaBold),
            size: Pt(14.0),
        },
        Op::ShowText {
            items: vec![TextItem::Text(heading.to_owned())],
        },
        Op::AddLineBreak,
    ]);
    if accent.is_some() {
        // Only the heading takes the accent colour; the body stays black.
        ops.push(fill((0.0, 0.0, 0.0)));
    }
    ops.extend([
        Op::SetFont {
            font: PdfFontHandle::Builtin(BuiltinFont::Helvetica),
            size: Pt(9.0),
        },
        Op::SetLineHeight { lh: Pt(11.0) },
    ]);
    for line in preface.iter().chain(summary) {
        ops.push(Op::ShowText {
            items: vec![TextItem::Text(line.clone())],
        });
        ops.push(Op::AddLineBreak);
    }
    ops.push(Op::SetFont {
        font: PdfFontHandle::Builtin(BuiltinFont::Courier),
        size: Pt(8.0),
    });
    ops.push(Op::SetLineHeight { lh: Pt(10.0) });
    ops
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn timestamp(day: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, day, 12, 0, 0).unwrap()
    }

    fn report(lines: Vec<ReportLine>) -> TreasuryReport {
        TreasuryReport {
            network: "testnet".to_owned(),
            contract_id: "CONTRACTAAAAAAAAAAAAAAAAAAAAAAAA".to_owned(),
            period: ReportPeriod {
                start: timestamp(1),
                end: timestamp(30),
            },
            generated_at: timestamp(30),
            lines,
            token_totals: vec![TokenTotal {
                token: "USDC".to_owned(),
                total: "1500.0000000".to_owned(),
                count: 2,
            }],
            category_totals: vec![CategoryTotal {
                category: "Payroll".to_owned(),
                token: "USDC".to_owned(),
                total: "1500.0000000".to_owned(),
                count: 2,
            }],
            template: None,
        }
    }

    fn line(proposal_id: i64, amount: &str) -> ReportLine {
        ReportLine {
            proposal_id,
            executed_at: Some(timestamp(2)),
            created_at: timestamp(1),
            category: "Payroll".to_owned(),
            kind: "transfer".to_owned(),
            recipient: "GRECIPIENTADDRESSTHATISQUITELONGINDEED".to_owned(),
            token: "USDC".to_owned(),
            amount: amount.to_owned(),
            proposer: "GPROPOSER".to_owned(),
        }
    }

    #[test]
    fn csv_contains_a_header_every_transfer_and_the_totals() {
        let csv = report(vec![line(1, "500.0000000"), line(2, "1000.0000000")])
            .to_csv()
            .unwrap();
        let text = String::from_utf8(csv).unwrap();
        let lines: Vec<&str> = text.lines().collect();

        assert_eq!(
            lines[0],
            "network,contract_id,proposal_id,executed_at,created_at,category,kind,recipient,token,amount,proposer"
        );
        assert!(lines[1].starts_with("testnet,CONTRACTAAAAAAAAAAAAAAAAAAAAAAAA,1,"));
        assert!(lines[1].contains("500.0000000"));
        assert!(lines[2].contains(",2,"));
        assert!(text.contains("token_total,USDC,,1500.0000000,2"));
        assert!(text.contains("category_total,USDC,Payroll,1500.0000000,2"));
    }

    #[test]
    fn csv_for_an_empty_period_still_has_its_header_and_totals_section() {
        let text = String::from_utf8(report(Vec::new()).to_csv().unwrap()).unwrap();

        assert!(text.starts_with("network,contract_id,proposal_id"));
        assert!(text.contains("section,token,category,total,count"));
    }

    fn branded(sections: &[&str]) -> TreasuryReport {
        use sqlx::types::Json;
        let mut report = report(vec![line(1, "500.0000000"), line(2, "1000.0000000")]);
        report.template = Some(ReportTemplate {
            id: 1,
            network: "testnet".to_owned(),
            contract_id: report.contract_id.clone(),
            brand_name: Some("Acme Treasury".to_owned()),
            title: Some("{network} statement for {period}".to_owned()),
            header_text: Some("=HYPERLINK(\"http://evil\")".to_owned()),
            footer_text: Some("Acme Inc. - confidential".to_owned()),
            logo_url: Some("https://cdn.example.com/logo.png".to_owned()),
            accent_color: Some("#1a73e8".to_owned()),
            sections: Json(sections.iter().map(|name| (*name).to_owned()).collect()),
            created_at: timestamp(1),
            updated_at: timestamp(1),
        });
        report
    }

    #[test]
    fn a_template_title_replaces_the_default_and_fills_placeholders() {
        let report = branded(&["summary"]);

        assert_eq!(
            report.title(),
            "testnet statement for 2026-09-01 to 2026-09-30"
        );
        assert!(report.template.is_some());
    }

    #[test]
    fn branded_csv_has_identity_rows_and_only_the_chosen_sections_in_order() {
        let csv = branded(&["transactions", "token_totals"]).to_csv().unwrap();
        let text = String::from_utf8(csv).unwrap();
        let lines: Vec<&str> = text.lines().collect();

        assert_eq!(lines[0], "brand,Acme Treasury");
        assert_eq!(
            lines[1],
            "title,testnet statement for 2026-09-01 to 2026-09-30"
        );
        assert!(
            lines[2].starts_with("header,\"'=HYPERLINK"),
            "formula-looking text is neutralised: {}",
            lines[2]
        );
        assert_eq!(lines[3], "logo,https://cdn.example.com/logo.png");
        let transactions = text.find("network,contract_id,proposal_id").unwrap();
        let totals = text.find("token_total,USDC,,1500.0000000,2").unwrap();
        assert!(transactions < totals, "sections follow the template order");
        assert!(!text.contains("category_total"), "dropped sections are absent");
        assert!(!text.contains("summary,network"), "dropped sections are absent");
        assert!(text.trim_end().ends_with("footer,Acme Inc. - confidential"));
    }

    #[test]
    fn branded_csv_can_lead_with_the_summary() {
        let text = String::from_utf8(branded(&["summary"]).to_csv().unwrap()).unwrap();

        assert!(text.contains("summary,network,testnet"));
        assert!(text.contains("summary,executed_transfers,2"));
        assert!(!text.contains("network,contract_id,proposal_id"));
    }

    #[test]
    fn an_unbranded_report_keeps_its_original_csv_layout() {
        let plain = report(vec![line(1, "500.0000000")]);
        let text = String::from_utf8(plain.to_csv().unwrap()).unwrap();

        assert!(text.starts_with("network,contract_id,proposal_id"));
        assert!(!text.contains("brand,"));
        assert!(!text.contains("footer,"));
    }

    #[test]
    fn branded_pdf_is_a_real_document_and_differs_from_the_default() {
        let plain = report(vec![line(1, "500.0000000"), line(2, "1000.0000000")]).to_pdf();
        let branded = branded(&["summary", "token_totals", "category_totals", "transactions"])
            .to_pdf();

        assert!(branded.starts_with(b"%PDF-"));
        assert!(branded.len() > 500);
        assert_ne!(plain, branded);
    }

    #[test]
    fn branded_pdf_paginates_and_may_omit_the_transactions() {
        let mut long = branded(&["summary", "transactions"]);
        long.lines = (1..=200).map(|id| line(id, "1.0000000")).collect();
        let without = branded(&["summary"]).to_pdf();

        assert!(long.to_pdf().len() > without.len());
        assert!(without.starts_with(b"%PDF-"));
    }

    #[test]
    fn the_email_body_is_wrapped_only_when_branded() {
        let wrapped = branded(&["summary"]).email_body("Attached.".to_owned());
        let plain = report(Vec::new()).email_body("Attached.".to_owned());

        assert!(wrapped.starts_with("Acme Treasury"));
        assert!(wrapped.contains("Attached."));
        assert!(wrapped.contains("Logo: https://cdn.example.com/logo.png"));
        assert!(wrapped.ends_with("Acme Inc. - confidential"));
        assert_eq!(plain, "Attached.");
    }

    #[test]
    fn pdf_is_a_real_pdf_document() {
        let bytes = report(vec![line(1, "500.0000000")]).to_pdf();

        assert!(bytes.starts_with(b"%PDF-"), "has a PDF header");
        assert!(
            bytes.ends_with(b"%%EOF\n") || bytes.ends_with(b"%%EOF"),
            "has a PDF trailer"
        );
        assert!(bytes.len() > 500, "is not an empty shell");
    }

    #[test]
    fn pdf_paginates_long_periods() {
        let many = (1..=200).map(|id| line(id, "1.0000000")).collect();
        let single = report(vec![line(1, "1.0000000")]).to_pdf();
        let paginated = report(many).to_pdf();

        assert!(paginated.len() > single.len());
        assert!(paginated.starts_with(b"%PDF-"));
    }

    #[test]
    fn file_names_are_stable_and_filesystem_safe() {
        let report = report(Vec::new());

        assert_eq!(
            report.file_stem(),
            "accord-testnet-contractaaaa-20260901-20260930"
        );
        assert_eq!(
            report.filename(ReportFormat::Csv),
            "accord-testnet-contractaaaa-20260901-20260930.csv"
        );
        assert_eq!(
            report.filename(ReportFormat::Pdf),
            "accord-testnet-contractaaaa-20260901-20260930.pdf"
        );
    }

    #[test]
    fn periods_run_back_from_their_end() {
        let period = ReportPeriod::ending_at(timestamp(30), 7);

        assert_eq!(period.end, timestamp(30));
        assert_eq!(period.start, timestamp(23));
    }

    #[test]
    fn formats_parse_case_insensitively_and_reject_anything_else() {
        assert_eq!("CSV".parse::<ReportFormat>().unwrap(), ReportFormat::Csv);
        assert_eq!(" pdf ".parse::<ReportFormat>().unwrap(), ReportFormat::Pdf);
        assert!("xlsx".parse::<ReportFormat>().is_err());
    }
}
