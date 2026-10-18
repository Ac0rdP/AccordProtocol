use std::{
    fs,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    time::Duration,
};

use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
    message::{Attachment, Mailbox, MultiPart, SinglePart, header::ContentType},
};

pub struct ReportAttachment {
    pub filename: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

pub struct ReportEnvelope {
    pub subject: String,
    pub body: String,
    pub recipients: Vec<String>,
    pub attachments: Vec<ReportAttachment>,
}

type SendFuture<'a> = Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;

/// How a generated report leaves the service. Boxed rather than generic so the
/// scheduler and the manual endpoint share one configured transport, and so
/// tests can substitute a transport that fails on demand.
pub trait ReportTransport: Send + Sync {
    /// Short description used in logs and in the `GET /reports` payload.
    fn describe(&self) -> String;

    fn send<'a>(&'a self, envelope: &'a ReportEnvelope) -> SendFuture<'a>;
}

fn build_message(from: &Mailbox, envelope: &ReportEnvelope) -> Result<Message, String> {
    let mut multipart = MultiPart::mixed().singlepart(
        SinglePart::builder()
            .header(ContentType::TEXT_PLAIN)
            .body(envelope.body.clone()),
    );
    for attachment in &envelope.attachments {
        let content_type = ContentType::parse(&attachment.content_type)
            .map_err(|error| format!("invalid attachment content type: {error}"))?;
        multipart = multipart.singlepart(
            Attachment::new(attachment.filename.clone())
                .body(attachment.bytes.clone(), content_type),
        );
    }

    let mut builder = Message::builder()
        .from(from.clone())
        .subject(envelope.subject.clone());
    for recipient in &envelope.recipients {
        builder = builder.to(recipient
            .parse::<Mailbox>()
            .map_err(|error| format!("invalid recipient \"{recipient}\": {error}"))?);
    }

    builder
        .multipart(multipart)
        .map_err(|error| format!("failed to build report email: {error}"))
}

pub struct SmtpReportTransport {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    from: Mailbox,
    endpoint: String,
}

impl SmtpReportTransport {
    /// `url` is a lettre SMTP URL, for example
    /// `smtps://user:password@smtp.example.com:465`.
    pub fn new(url: &str, from: &str) -> Result<Self, String> {
        let transport = AsyncSmtpTransport::<Tokio1Executor>::from_url(url)
            .map_err(|error| format!("SMTP_URL is not a valid SMTP URL: {error}"))?
            .build();
        let from = from
            .parse::<Mailbox>()
            .map_err(|error| format!("REPORT_FROM is not a valid mailbox: {error}"))?;
        // Keep credentials out of logs and payloads.
        let endpoint = url
            .split('@')
            .next_back()
            .unwrap_or("smtp")
            .trim_end_matches('/')
            .to_owned();
        Ok(Self {
            transport,
            from,
            endpoint,
        })
    }
}

impl ReportTransport for SmtpReportTransport {
    fn describe(&self) -> String {
        format!("smtp({})", self.endpoint)
    }

    fn send<'a>(&'a self, envelope: &'a ReportEnvelope) -> SendFuture<'a> {
        Box::pin(async move {
            let message = build_message(&self.from, envelope)?;
            self.transport
                .send(message)
                .await
                .map(|_| ())
                .map_err(|error| format!("SMTP delivery failed: {error}"))
        })
    }
}

/// Writes the report and a delivery manifest to a directory instead of sending
/// it. Used when no `SMTP_URL` is configured, so scheduled reports can be
/// exercised end to end without mail credentials.
pub struct DirectoryReportTransport {
    directory: PathBuf,
}

impl DirectoryReportTransport {
    pub fn new(directory: impl AsRef<Path>) -> Self {
        Self {
            directory: directory.as_ref().to_path_buf(),
        }
    }
}

impl ReportTransport for DirectoryReportTransport {
    fn describe(&self) -> String {
        format!("directory({})", self.directory.display())
    }

    fn send<'a>(&'a self, envelope: &'a ReportEnvelope) -> SendFuture<'a> {
        Box::pin(async move {
            fs::create_dir_all(&self.directory).map_err(|error| {
                format!("failed to create {}: {error}", self.directory.display())
            })?;
            for attachment in &envelope.attachments {
                let path = self.directory.join(&attachment.filename);
                fs::write(&path, &attachment.bytes)
                    .map_err(|error| format!("failed to write {}: {error}", path.display()))?;
            }
            let manifest = format!(
                "To: {}\nSubject: {}\n\n{}\n\nAttachments: {}\n",
                envelope.recipients.join(", "),
                envelope.subject,
                envelope.body,
                envelope
                    .attachments
                    .iter()
                    .map(|attachment| attachment.filename.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            let stem = envelope
                .attachments
                .first()
                .map(|attachment| attachment.filename.clone())
                .unwrap_or_else(|| "report".to_owned());
            let path = self.directory.join(format!("{stem}.delivery.txt"));
            fs::write(&path, manifest)
                .map_err(|error| format!("failed to write {}: {error}", path.display()))
        })
    }
}

/// Delivers `envelope`, retrying with linear backoff. Returns the number of
/// attempts the delivery took, or the attempts spent and the last error.
pub async fn deliver_with_retry(
    transport: &dyn ReportTransport,
    envelope: &ReportEnvelope,
    max_attempts: u32,
    backoff: Duration,
) -> Result<u32, (u32, String)> {
    let attempts = max_attempts.max(1);
    let mut last_error = String::from("delivery was never attempted");

    for attempt in 1..=attempts {
        match transport.send(envelope).await {
            Ok(()) => return Ok(attempt),
            Err(error) => {
                tracing::warn!(
                    attempt,
                    max_attempts = attempts,
                    transport = %transport.describe(),
                    %error,
                    "report delivery attempt failed"
                );
                last_error = error;
                if attempt < attempts && !backoff.is_zero() {
                    tokio::time::sleep(backoff * attempt).await;
                }
            }
        }
    }

    Err((attempts, last_error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct FlakyTransport {
        failures: u32,
        calls: AtomicU32,
    }

    impl ReportTransport for FlakyTransport {
        fn describe(&self) -> String {
            "flaky".to_owned()
        }

        fn send<'a>(&'a self, _envelope: &'a ReportEnvelope) -> SendFuture<'a> {
            Box::pin(async move {
                let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
                if call <= self.failures {
                    return Err(format!("transient failure {call}"));
                }
                Ok(())
            })
        }
    }

    fn envelope() -> ReportEnvelope {
        ReportEnvelope {
            subject: "Accord treasury report".to_owned(),
            body: "Attached.".to_owned(),
            recipients: vec!["treasury@example.com".to_owned()],
            attachments: vec![ReportAttachment {
                filename: "report.csv".to_owned(),
                content_type: "text/csv".to_owned(),
                bytes: b"network,amount\ntestnet,1\n".to_vec(),
            }],
        }
    }

    #[tokio::test]
    async fn succeeds_on_the_first_attempt() {
        let transport = FlakyTransport {
            failures: 0,
            calls: AtomicU32::new(0),
        };

        let attempts = deliver_with_retry(&transport, &envelope(), 3, Duration::ZERO)
            .await
            .unwrap();

        assert_eq!(attempts, 1);
        assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn retries_until_delivery_succeeds() {
        let transport = FlakyTransport {
            failures: 2,
            calls: AtomicU32::new(0),
        };

        let attempts = deliver_with_retry(&transport, &envelope(), 3, Duration::ZERO)
            .await
            .unwrap();

        assert_eq!(attempts, 3);
    }

    #[tokio::test]
    async fn reports_the_last_error_once_attempts_are_exhausted() {
        let transport = FlakyTransport {
            failures: 5,
            calls: AtomicU32::new(0),
        };

        let (attempts, error) = deliver_with_retry(&transport, &envelope(), 3, Duration::ZERO)
            .await
            .unwrap_err();

        assert_eq!(attempts, 3);
        assert_eq!(transport.calls.load(Ordering::SeqCst), 3);
        assert_eq!(error, "transient failure 3");
    }

    #[tokio::test]
    async fn always_attempts_delivery_at_least_once() {
        let transport = FlakyTransport {
            failures: 1,
            calls: AtomicU32::new(0),
        };

        let outcome = deliver_with_retry(&transport, &envelope(), 0, Duration::ZERO).await;

        assert!(outcome.is_err());
        assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn directory_transport_writes_the_report_and_a_manifest() {
        let directory = std::env::temp_dir().join(format!(
            "accord-report-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let transport = DirectoryReportTransport::new(&directory);

        deliver_with_retry(&transport, &envelope(), 1, Duration::ZERO)
            .await
            .unwrap();

        let report = fs::read_to_string(directory.join("report.csv")).unwrap();
        let manifest = fs::read_to_string(directory.join("report.csv.delivery.txt")).unwrap();
        assert!(report.contains("testnet,1"));
        assert!(manifest.contains("To: treasury@example.com"));
        assert!(manifest.contains("Attachments: report.csv"));

        fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn builds_a_multipart_message_with_the_report_attached() {
        let from = "reports@example.com".parse::<Mailbox>().unwrap();
        let message = build_message(&from, &envelope()).unwrap();
        let formatted = String::from_utf8(message.formatted()).unwrap();

        assert!(formatted.contains("To: treasury@example.com"));
        assert!(formatted.contains("Subject: Accord treasury report"));
        assert!(formatted.contains("report.csv"));
        assert!(formatted.contains("multipart/mixed"));
    }

    #[test]
    fn rejects_a_malformed_recipient() {
        let from = "reports@example.com".parse::<Mailbox>().unwrap();
        let mut envelope = envelope();
        envelope.recipients = vec!["not-an-address".to_owned()];

        let error = build_message(&from, &envelope).unwrap_err();

        assert!(error.contains("invalid recipient"));
    }

    // Dropping a pooled SMTP transport needs a running reactor, so this test
    // runs on the tokio runtime even though it never sends anything.
    #[tokio::test]
    async fn smtp_transport_keeps_credentials_out_of_its_description() {
        let transport = SmtpReportTransport::new(
            "smtp://user:secret@mail.example.com:587",
            "reports@example.com",
        )
        .unwrap();

        let description = transport.describe();
        assert!(description.contains("mail.example.com:587"));
        assert!(!description.contains("secret"));
    }
}
