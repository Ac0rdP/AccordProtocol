import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  appendAuditRecord,
  deletePersonalData,
  exportPersonalData,
  preflightTreasuryTransfer,
  updatePolicyList,
  verifyAuditLog,
  readAuditLog,
  issueApiKey,
  rotateApiKey,
  revokeApiKey,
  verifyApiKey,
  checkApiKeyReminders,
  formatSiemEvent,
  formatSiemBatch,
  streamSiemEvents,
  sanitizeForSiem,
  SOC2_CONTROL_MAPPINGS,
  generateSoc2EvidencePackage,
  verifyDataResidency,
  backupWorkspace,
  exportWorkspaceData,
  deleteWorkspaceData,
} from "./security-controls.mjs";

const policy = {
  roles: {
    operator: ["treasury_operator"],
    privacy: ["privacy_admin"],
    admin: ["apikey_admin", "policy_admin"],
    auditor: ["security_auditor", "compliance_export"],
    infra: ["infra_operator"],
  },
  permissions: {
    treasury_transfer: ["treasury_operator"],
    privacy_export: ["privacy_admin"],
    privacy_delete: ["privacy_admin"],
    policy_change: ["policy_admin"],
    apikey_admin: ["apikey_admin"],
    compliance_export: ["compliance_export"],
    infra_operator: ["infra_operator"],
  },
  allowRecipients: ["RECIPIENT-1"],
  contractAllowList: ["CONTRACT-1"],
  screening: {
    provider: "fixture-provider",
    results: { "recipient-1": "clear" },
  },
  allowedRegions: ["us-east-1", "eu-central-1"],
  workspaces: {
    "ws-us": { pinnedRegion: "us-east-1", dataClassification: "restricted" },
    "ws-eu": { pinnedRegion: "eu-central-1", dataClassification: "confidential" },
  },
};

test("audit records form a tamper-evident chain", () => {
  const directory = mkdtempSync(join(tmpdir(), "accord-controls-"));
  const path = join(directory, "audit.jsonl");
  appendAuditRecord(path, {
    timestamp: "2026-11-18T00:00:00.000Z",
    actor: "operator",
    action: "treasury_transfer",
    resource: "CONTRACT-1",
  });
  appendAuditRecord(path, {
    timestamp: "2026-11-18T00:01:00.000Z",
    actor: "operator",
    action: "treasury_screen",
    resource: "RECIPIENT-1",
  });
  assert.equal(verifyAuditLog(readAuditLog(path)).records, 2);
  const tampered = JSON.parse(readFileSync(path, "utf8").split("\n")[0]);
  tampered.actor = "attacker";
  assert.throws(() => verifyAuditLog([tampered]), /hash mismatch/);
});

test("treasury preflight fails closed and accepts a cleared allowlisted recipient", () => {
  assert.equal(
    preflightTreasuryTransfer(policy, {
      actor: "operator",
      recipient: "recipient-1",
      contract: "contract-1",
    }).permitted,
    true,
  );
  assert.throws(
    () =>
      preflightTreasuryTransfer(policy, {
        actor: "operator",
        recipient: "recipient-2",
        contract: "contract-1",
      }),
    /allowlist/,
  );
  assert.throws(
    () =>
      preflightTreasuryTransfer(policy, {
        actor: "unknown",
        recipient: "recipient-1",
        contract: "contract-1",
      }),
    /authorization denied/,
  );
});

test("privacy export returns subject records and deletion preserves audit metadata", () => {
  const records = [
    { id: "1", subjectId: "user-1", personalData: { email: "a@example.test" } },
    { id: "2", subjectId: "user-2", personalData: { email: "b@example.test" } },
  ];
  assert.equal(exportPersonalData(records, "user-1").length, 1);
  const result = deletePersonalData(records, "user-1", [], new Date("2026-11-18T00:00:00Z"));
  assert.equal(result.deleted, 1);
  assert.equal(result.records[0].personalData, "[REDACTED]");
  assert.equal(result.records[0].id, "1");
});

test("retention exceptions block deletion", () => {
  assert.throws(
    () =>
      deletePersonalData(
        [{ id: "1", subjectId: "user-1", personalData: "secret" }],
        "user-1",
        [{ subjectId: "user-1", retainUntil: "2026-12-01T00:00:00Z", reason: "legal hold" }],
        new Date("2026-11-18T00:00:00Z"),
      ),
    /retention exception/,
  );
});

test("allowlist updates are explicit and reversible", () => {
  const added = updatePolicyList(policy, "allowRecipients", "RECIPIENT-2");
  assert.deepEqual(added.allowRecipients, ["RECIPIENT-1", "RECIPIENT-2"]);
  const removed = updatePolicyList(added, "allowRecipients", "RECIPIENT-1", "remove");
  assert.deepEqual(removed.allowRecipients, ["RECIPIENT-2"]);
  assert.throws(() => updatePolicyList(policy, "unknown", "value"), /unsupported policy list/);
});

// ============================================================================
// API Key Lifecycle, Overlap Windows, Reminders & Revocation Tests
// ============================================================================

test("api key issuance enforces least-privilege scopes and hashes stored tokens", () => {
  const store = { version: 1, keys: [] };
  const baseTime = new Date("2026-11-18T00:00:00.000Z");

  const { token, key } = issueApiKey(store, {
    id: "key-indexer",
    name: "Indexer Ingestion",
    actor: "indexer-bot",
    scopes: ["audit:append", "indexer:ingest"],
    expiresInDays: 90,
    now: baseTime,
  });

  assert.ok(token.startsWith("accord_key-indexer_"));
  assert.equal(key.id, "key-indexer");
  assert.equal(key.status, "active");
  assert.deepEqual(key.scopes, ["audit:append", "indexer:ingest"]);
  assert.equal(store.keys[0].keyHash !== token, true); // Raw token is NOT stored
  assert.equal(key.expiresAt, "2027-02-16T00:00:00.000Z");

  // Verify key with matching scope
  const verified = verifyApiKey(store, { token, requiredScope: "indexer:ingest", now: baseTime });
  assert.equal(verified.valid, true);
  assert.equal(verified.keyId, "key-indexer");

  // Verify fails with missing scope
  assert.throws(
    () => verifyApiKey(store, { token, requiredScope: "treasury:preflight", now: baseTime }),
    /lacks required scope/,
  );

  // Reject duplicate ID
  assert.throws(
    () =>
      issueApiKey(store, {
        id: "key-indexer",
        name: "duplicate",
        actor: "bot",
        scopes: ["audit:read"],
      }),
    /already exists/,
  );
});

test("api key rotation provides overlap grace window and expires correctly", () => {
  const store = { version: 1, keys: [] };
  const t0 = new Date("2026-11-18T00:00:00.000Z");
  const { token: oldToken, key: oldKey } = issueApiKey(store, {
    id: "key-analytics",
    name: "Analytics Service",
    actor: "analytics-app",
    scopes: ["metrics:read"],
    expiresInDays: 30,
    now: t0,
  });

  // Rotate key at t + 10 days, with 7 days overlap window
  const t1 = new Date("2026-11-28T00:00:00.000Z");
  const { token: newToken, newKey, rotatedKey } = rotateApiKey(store, {
    keyId: "key-analytics",
    actor: "admin",
    newKeyId: "key-analytics-v2",
    overlapDays: 7,
    expiresInDays: 90,
    now: t1,
  });

  assert.equal(rotatedKey.status, "rotating");
  assert.equal(rotatedKey.overlapUntil, "2026-12-05T00:00:00.000Z");
  assert.equal(newKey.id, "key-analytics-v2");
  assert.equal(newKey.status, "active");
  assert.equal(newKey.previousKeyId, "key-analytics");

  // During overlap window (t1 + 3 days): BOTH old and new tokens are valid
  const tMid = new Date("2026-12-01T00:00:00.000Z");
  assert.equal(verifyApiKey(store, { token: oldToken, requiredScope: "metrics:read", now: tMid }).valid, true);
  assert.equal(verifyApiKey(store, { token: newToken, requiredScope: "metrics:read", now: tMid }).valid, true);

  // After overlap window (t1 + 8 days): old token is rejected, new token is valid
  const tAfterOverlap = new Date("2026-12-06T00:00:00.000Z");
  assert.throws(
    () => verifyApiKey(store, { token: oldToken, requiredScope: "metrics:read", now: tAfterOverlap }),
    /overlap window expired/,
  );
  assert.equal(
    verifyApiKey(store, { token: newToken, requiredScope: "metrics:read", now: tAfterOverlap }).valid,
    true,
  );
});

test("api key reminders flag keys approaching expiration", () => {
  const store = { version: 1, keys: [] };
  const t0 = new Date("2026-11-18T00:00:00.000Z");

  issueApiKey(store, {
    id: "key-soon",
    name: "Expiring Soon",
    actor: "bot-1",
    scopes: ["audit:read"],
    expiresInDays: 10, // within 14 day reminder window
    now: t0,
  });

  issueApiKey(store, {
    id: "key-far",
    name: "Expiring Far",
    actor: "bot-2",
    scopes: ["audit:read"],
    expiresInDays: 60,
    now: t0,
  });

  const reminders = checkApiKeyReminders(store, { reminderWindowDays: 14, now: t0 });
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].id, "key-soon");
  assert.equal(reminders[0].daysRemaining, 10);
});

test("api key revocation fails closed immediately", () => {
  const store = { version: 1, keys: [] };
  const now = new Date("2026-11-18T00:00:00.000Z");

  const { token, key } = issueApiKey(store, {
    id: "key-compromised",
    name: "Compromised Key",
    actor: "relayer",
    scopes: ["treasury:preflight"],
    now,
  });

  assert.equal(verifyApiKey(store, { token, now }).valid, true);

  revokeApiKey(store, { keyId: "key-compromised", actor: "sec-admin", reason: "credential leak in dev", now });
  assert.equal(key.status, "revoked");
  assert.equal(key.revocationReason, "credential leak in dev");

  assert.throws(() => verifyApiKey(store, { token, now }), /revoked/);
  assert.throws(
    () => rotateApiKey(store, { keyId: "key-compromised", actor: "sec-admin", now }),
    /cannot rotate revoked/,
  );
});

// ============================================================================
// SIEM Event Streaming & Sanitization Tests
// ============================================================================

test("siem events are categorized, prioritized, and sanitized", () => {
  const testRecord = {
    version: 1,
    timestamp: "2026-11-18T12:00:00.000Z",
    actor: "treasury-admin",
    action: "treasury_transfer_deny",
    resource: "CONTRACT-1",
    details: {
      recipient: "ADDR-1",
      private_key: "my_very_secret_key",
      apiKeyToken: "accord_test_0123456789abcdef0123456789",
    },
    previousHash: "GENESIS",
    hash: "abc123hash",
  };

  const sanitized = sanitizeForSiem(testRecord);
  assert.equal(sanitized.details.private_key, "[REDACTED_SECRET]");
  assert.equal(sanitized.details.apiKeyToken, "[REDACTED_SECRET]");
  assert.equal(sanitized.details.recipient, "ADDR-1");

  // Splunk format
  const splunk = formatSiemEvent(testRecord, { target: "splunk", host: "prod-accord-1" });
  assert.equal(splunk.host, "prod-accord-1");
  assert.equal(splunk.sourcetype, "accord:audit:json");
  assert.equal(splunk.event.category, "authorization");
  assert.equal(splunk.event.severity, "WARN");
  assert.equal(splunk.event.details.private_key, "[REDACTED_SECRET]");

  // Datadog format
  const dd = formatSiemEvent(testRecord, { target: "datadog", host: "prod-accord-1" });
  assert.equal(dd.service, "accord-protocol");
  assert.equal(dd.status, "warn");
  assert.equal(dd.audit.category, "authorization");

  // Generic SIEM format
  const generic = formatSiemEvent(testRecord, { target: "generic" });
  assert.equal(generic.category, "authorization");
  assert.equal(generic.severity, "WARN");
});

test("streamSiemEvents handles dry-run and mock network streaming", async () => {
  const records = [
    {
      timestamp: "2026-11-18T00:00:00.000Z",
      actor: "admin",
      action: "apikey_issue",
      resource: "key-1",
      details: {},
      previousHash: "GENESIS",
      hash: "h1",
    },
  ];

  // Dry run
  const dryResult = await streamSiemEvents(records, { dryRun: true });
  assert.equal(dryResult.dryRun, true);
  assert.equal(dryResult.events.length, 1);

  // Live streaming mock
  let capturedBody = null;
  let capturedHeaders = null;
  const mockFetch = async (url, options) => {
    capturedHeaders = options.headers;
    capturedBody = JSON.parse(options.body);
    return { ok: true, status: 200, statusText: "OK" };
  };

  const streamResult = await streamSiemEvents(records, {
    target: "splunk",
    endpoint: "https://splunk.example.test/hec",
    token: "splunk-token-123",
    fetchFn: mockFetch,
  });

  assert.equal(streamResult.shipped, 1);
  assert.equal(capturedHeaders["Authorization"], "Splunk splunk-token-123");
  assert.equal(capturedBody[0].source, "accord:security-controls");
});

// ============================================================================
// SOC 2 Trust Services Criteria Mapping & Evidence Package Tests
// ============================================================================

test("soc 2 control mapping includes all required criteria", () => {
  const criteriaList = SOC2_CONTROL_MAPPINGS.map((c) => c.criteria);
  const expectedCriteria = [
    "CC6.1",
    "CC6.2",
    "CC6.3",
    "CC6.6",
    "CC6.7",
    "CC6.8",
    "CC7.1",
    "CC7.2",
    "CC7.3",
    "CC8.1",
    "A1.2",
    "C1.1",
    "P1.1",
    "P4.1",
  ];

  for (const exp of expectedCriteria) {
    assert.ok(criteriaList.includes(exp), `missing SOC 2 criterion: ${exp}`);
  }
});

test("generateSoc2EvidencePackage compiles compliant package with sha256 manifest", () => {
  const directory = mkdtempSync(join(tmpdir(), "accord-soc2-"));
  const auditPath = join(directory, "audit.jsonl");
  appendAuditRecord(auditPath, {
    timestamp: "2026-11-18T00:00:00.000Z",
    actor: "operator",
    action: "treasury_transfer",
    resource: "CONTRACT-1",
  });

  const keyStore = {
    version: 1,
    keys: [
      {
        id: "key-1",
        name: "test",
        actor: "bot",
        scopes: ["audit:read"],
        status: "active",
        createdAt: "2026-11-18T00:00:00Z",
        expiresAt: "2027-02-18T00:00:00Z",
      },
    ],
  };

  const residencyPolicy = {
    allowedRegions: ["us-east-1"],
    workspaces: { "ws-1": { pinnedRegion: "us-east-1" } },
  };

  const pkg = generateSoc2EvidencePackage({
    policy,
    auditLogPath: auditPath,
    keyStore,
    residencyPolicy,
  });

  assert.equal(pkg.overallStatus, "COMPLIANT");
  assert.equal(pkg.summary.auditChainValid, true);
  assert.equal(pkg.summary.totalAuditRecords, 1);
  assert.equal(pkg.summary.activeApiKeys, 1);
  assert.ok(pkg.evidenceManifest.some((f) => f.file === "security-audit.jsonl" && f.status === "VERIFIED"));
  assert.ok(pkg.evidenceManifest.some((f) => f.file === "security-policy.json" && f.status === "VERIFIED"));
});

// ============================================================================
// Data Residency & Regional Workspace Lifecycle Tests
// ============================================================================

test("verifyDataResidency enforces regional pinning and fails closed on cross-border mismatch", () => {
  // Allowed and matches pinned
  const res1 = verifyDataResidency(policy, "ws-us", "us-east-1");
  assert.equal(res1.compliant, true);
  assert.equal(res1.region, "us-east-1");

  // Region not in allowedRegions
  assert.throws(() => verifyDataResidency(policy, "ws-us", "ap-southeast-1"), /not in policy.allowedRegions/);

  // Region in allowedRegions, but mismatched with workspace-pinned region
  assert.throws(
    () => verifyDataResidency(policy, "ws-us", "eu-central-1"),
    /data residency violation.*pinned to 'us-east-1'/,
  );
});

test("workspace backup and export enforce regional residency and compute checksums", () => {
  const workspaceData = [
    { id: "record-1", name: "agreement-alpha", balance: 5000 },
    { id: "record-2", name: "agreement-beta", balance: 12000 },
  ];

  // Backup in compliant region
  const backup = backupWorkspace(workspaceData, {
    workspaceId: "ws-us",
    region: "us-east-1",
    policy,
    actor: "infra-lead",
  });

  assert.ok(backup.backupId.startsWith("backup_ws-us_"));
  assert.equal(backup.region, "us-east-1");
  assert.equal(backup.recordCount, 2);
  assert.ok(backup.checksum.length === 64); // SHA-256 hex string

  // Backup rejected for wrong region
  assert.throws(
    () =>
      backupWorkspace(workspaceData, {
        workspaceId: "ws-us",
        region: "eu-central-1",
        policy,
        actor: "infra-lead",
      }),
    /data residency violation/,
  );

  // Export with provenance in compliant region
  const exported = exportWorkspaceData(workspaceData, {
    workspaceId: "ws-eu",
    region: "eu-central-1",
    policy,
    actor: "privacy-officer",
  });

  assert.equal(exported.region, "eu-central-1");
  assert.equal(exported.provenance.dataClassification, "confidential");
});

test("workspace deletion blocks on active retention exceptions and purges when clear", () => {
  const workspaceData = [{ id: "record-1" }];
  const now = new Date("2026-11-18T00:00:00Z");

  const exceptions = [
    {
      workspaceId: "ws-us",
      retainUntil: "2026-12-31T00:00:00Z",
      reason: "regulatory audit freeze",
    },
  ];

  // Blocked by active hold
  assert.throws(
    () =>
      deleteWorkspaceData(workspaceData, {
        workspaceId: "ws-us",
        region: "us-east-1",
        policy,
        exceptions,
        actor: "privacy-admin",
        now,
      }),
    /retention exception until 2026-12-31T00:00:00Z/,
  );

  // Cleared after retention expiry
  const futureTime = new Date("2027-01-01T00:00:00Z");
  const result = deleteWorkspaceData(workspaceData, {
    workspaceId: "ws-us",
    region: "us-east-1",
    policy,
    exceptions,
    actor: "privacy-admin",
    now: futureTime,
  });

  assert.equal(result.deleted, true);
  assert.equal(result.recordsPurged, 1);
  assert.equal(result.region, "us-east-1");
});
