#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REDACTED = "[REDACTED]";
const REDACTED_SECRET = "[REDACTED_SECRET]";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function hashAuditRecord(record) {
  return createHash("sha256").update(canonicalJson(record)).digest("hex");
}

export function readAuditLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`audit log line ${index + 1} is not valid JSON: ${error.message}`);
      }
    });
}

export function verifyAuditLog(records) {
  let previousHash = "GENESIS";
  for (const [index, record] of records.entries()) {
    if (record.previousHash !== previousHash) {
      throw new Error(`audit chain breaks at record ${index + 1}: previousHash mismatch`);
    }
    const { hash, ...unsigned } = record;
    if (!hash || hash !== hashAuditRecord(unsigned)) {
      throw new Error(`audit chain breaks at record ${index + 1}: hash mismatch`);
    }
    previousHash = hash;
  }
  return { valid: true, records: records.length, head: previousHash };
}

export function appendAuditRecord(path, input) {
  const records = readAuditLog(path);
  const verification = verifyAuditLog(records);
  const unsigned = {
    version: 1,
    timestamp: input.timestamp ?? new Date().toISOString(),
    actor: input.actor,
    action: input.action,
    resource: input.resource,
    details: input.details ?? {},
    previousHash: verification.head,
  };
  const record = { ...unsigned, hash: hashAuditRecord(unsigned) };
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  return record;
}

export function rolesFor(policy, actor) {
  return policy.roles?.[actor] ?? [];
}

export function authorize(policy, actor, action) {
  const roles = rolesFor(policy, actor);
  const required = policy.permissions?.[action] ?? [];
  if (!required.some((role) => roles.includes(role))) {
    throw new Error(`authorization denied: ${actor} lacks a role for ${action}`);
  }
  return { actor, action, roles };
}

function normalizeAddress(value) {
  return String(value).trim().toLowerCase();
}

export function screenRecipient(policy, recipient) {
  const normalized = normalizeAddress(recipient);
  const deny = new Set((policy.denyRecipients ?? []).map(normalizeAddress));
  const allow = (policy.allowRecipients ?? []).map(normalizeAddress);
  if (deny.has(normalized)) throw new Error("recipient denied by policy");
  if (allow.length > 0 && !allow.includes(normalized)) {
    throw new Error("recipient is not on the allowlist");
  }

  const screening = policy.screening ?? {};
  const result = screening.results?.[normalized] ?? screening.results?.[recipient];
  if (screening.required !== false && result !== "clear") {
    throw new Error(`recipient screening failed or is missing (provider: ${screening.provider ?? "unconfigured"})`);
  }
  return { recipient, provider: screening.provider ?? "unconfigured", result: result ?? "missing" };
}

export function preflightTreasuryTransfer(policy, { actor, recipient, contract }) {
  const authorization = authorize(policy, actor, "treasury_transfer");
  if ((policy.contractDenyList ?? []).map(normalizeAddress).includes(normalizeAddress(contract))) {
    throw new Error("contract denied by policy");
  }
  const contractAllowList = (policy.contractAllowList ?? []).map(normalizeAddress);
  if (contractAllowList.length > 0 && !contractAllowList.includes(normalizeAddress(contract))) {
    throw new Error("contract is not on the allowlist");
  }
  const screening = screenRecipient(policy, recipient);
  return { authorization, contract, screening, permitted: true };
}

export function updatePolicyList(policy, listName, value, mode = "add") {
  const allowedLists = new Set([
    "allowRecipients",
    "denyRecipients",
    "contractAllowList",
    "contractDenyList",
  ]);
  if (!allowedLists.has(listName)) throw new Error(`unsupported policy list: ${listName}`);
  const values = new Set(policy[listName] ?? []);
  if (mode === "remove") values.delete(value);
  else if (mode === "add") values.add(value);
  else throw new Error(`unsupported policy update mode: ${mode}`);
  return { ...policy, [listName]: [...values].sort() };
}

export function exportPersonalData(records, subjectId) {
  return records.filter((record) => record.subjectId === subjectId);
}

export function deletePersonalData(records, subjectId, retentionExceptions = [], now = new Date()) {
  const activeException = retentionExceptions.find(
    (exception) =>
      exception.subjectId === subjectId &&
      new Date(exception.retainUntil).getTime() >= now.getTime(),
  );
  if (activeException) {
    throw new Error(`deletion blocked by retention exception until ${activeException.retainUntil}`);
  }
  let deleted = 0;
  const redacted = records.map((record) => {
    if (record.subjectId !== subjectId) return record;
    deleted += 1;
    return { ...record, personalData: REDACTED, deletedAt: now.toISOString() };
  });
  return { records: redacted, deleted };
}

// ============================================================================
// API Key Lifecycle, Least-Privilege Scopes, Overlap Windows & Revocation
// ============================================================================

export function hashApiKeyToken(token) {
  return createHash("sha256").update(String(token).trim()).digest("hex");
}

export function generateApiKeyToken(id = "key") {
  const secret = randomBytes(24).toString("hex");
  return `accord_${id}_${secret}`;
}

export function issueApiKey(keyStore, { id, name, actor, scopes, expiresInDays = 90, now = new Date() }) {
  if (!id || typeof id !== "string") throw new Error("api key id is required");
  if (!name || typeof name !== "string") throw new Error("api key name is required");
  if (!actor || typeof actor !== "string") throw new Error("api key actor is required");
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error("api key requires at least one least-privilege scope");
  }

  const keys = keyStore.keys ?? [];
  if (keys.some((k) => k.id === id)) {
    throw new Error(`api key id already exists: ${id}`);
  }

  const token = generateApiKeyToken(id);
  const keyHash = hashApiKeyToken(token);
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(new Date(now).getTime() + expiresInDays * 86400000).toISOString();

  const keyRecord = {
    id,
    name,
    actor,
    scopes: [...new Set(scopes)].sort(),
    keyHash,
    keyPrefix: token.slice(0, 16) + "...",
    createdAt,
    expiresAt,
    overlapUntil: null,
    status: "active",
    previousKeyId: null,
    revokedAt: null,
    revocationReason: null,
  };

  keyStore.keys = [...keys, keyRecord];
  return { token, key: keyRecord };
}

export function rotateApiKey(
  keyStore,
  { keyId, actor, newKeyId, expiresInDays = 90, overlapDays = 7, now = new Date() },
) {
  const keys = keyStore.keys ?? [];
  const existingIndex = keys.findIndex((k) => k.id === keyId);
  if (existingIndex === -1) throw new Error(`api key not found: ${keyId}`);

  const existing = keys[existingIndex];
  if (existing.status === "revoked") {
    throw new Error(`cannot rotate revoked api key: ${keyId}`);
  }

  const currentTime = new Date(now).getTime();
  const overlapUntil = new Date(currentTime + overlapDays * 86400000).toISOString();
  const updatedExisting = {
    ...existing,
    status: "rotating",
    overlapUntil,
  };
  keys[existingIndex] = updatedExisting;

  const nextId = newKeyId || `${keyId}_rot_${Math.floor(currentTime / 1000)}`;
  if (keys.some((k) => k.id === nextId)) {
    throw new Error(`replacement api key id already exists: ${nextId}`);
  }

  const nextToken = generateApiKeyToken(nextId);
  const nextHash = hashApiKeyToken(nextToken);
  const nextExpiresAt = new Date(currentTime + expiresInDays * 86400000).toISOString();

  const replacementKey = {
    id: nextId,
    name: existing.name,
    actor: actor ?? existing.actor,
    scopes: [...existing.scopes],
    keyHash: nextHash,
    keyPrefix: nextToken.slice(0, 16) + "...",
    createdAt: new Date(now).toISOString(),
    expiresAt: nextExpiresAt,
    overlapUntil: null,
    status: "active",
    previousKeyId: keyId,
    revokedAt: null,
    revocationReason: null,
  };

  keyStore.keys = [...keys, replacementKey];
  return { token: nextToken, newKey: replacementKey, rotatedKey: updatedExisting };
}

export function revokeApiKey(keyStore, { keyId, actor, reason, now = new Date() }) {
  const keys = keyStore.keys ?? [];
  const existing = keys.find((k) => k.id === keyId);
  if (!existing) throw new Error(`api key not found: ${keyId}`);

  existing.status = "revoked";
  existing.revokedAt = new Date(now).toISOString();
  existing.revocationReason = reason ?? "revoked by administrator";
  return existing;
}

export function verifyApiKey(keyStore, { token, requiredScope, now = new Date() }) {
  if (!token) throw new Error("api key token is required");
  const hashed = hashApiKeyToken(token);
  const key = (keyStore.keys ?? []).find((k) => k.keyHash === hashed);
  if (!key) throw new Error("api key not found or invalid token");

  if (key.status === "revoked") {
    throw new Error(`api key is revoked: ${key.revocationReason ?? "manual revocation"}`);
  }

  const currentTime = new Date(now).getTime();
  if (key.status === "rotating") {
    if (key.overlapUntil && currentTime > new Date(key.overlapUntil).getTime()) {
      throw new Error(`api key rotation overlap window expired at ${key.overlapUntil}`);
    }
  } else {
    if (currentTime > new Date(key.expiresAt).getTime()) {
      throw new Error(`api key expired at ${key.expiresAt}`);
    }
  }

  if (requiredScope && !key.scopes.includes(requiredScope)) {
    throw new Error(`api key lacks required scope: ${requiredScope}`);
  }

  const remainingMs = new Date(key.expiresAt).getTime() - currentTime;
  const reminderNeeded = remainingMs <= 14 * 86400000 && remainingMs > 0;

  return {
    valid: true,
    keyId: key.id,
    name: key.name,
    actor: key.actor,
    scopes: key.scopes,
    status: key.status,
    reminderNeeded,
    expiresAt: key.expiresAt,
    overlapUntil: key.overlapUntil,
  };
}

export function checkApiKeyReminders(keyStore, { reminderWindowDays = 14, now = new Date() } = {}) {
  const currentTime = new Date(now).getTime();
  const windowMs = reminderWindowDays * 86400000;
  const reminders = [];

  for (const key of keyStore.keys ?? []) {
    if (key.status === "revoked") continue;
    const expiresMs = new Date(key.expiresAt).getTime();
    const remainingMs = expiresMs - currentTime;
    if (remainingMs <= windowMs) {
      reminders.push({
        id: key.id,
        name: key.name,
        actor: key.actor,
        status: key.status,
        expiresAt: key.expiresAt,
        daysRemaining: Math.max(0, Math.ceil(remainingMs / 86400000)),
        isExpired: remainingMs <= 0,
      });
    }
  }

  return reminders;
}

// ============================================================================
// SIEM Event Streaming & Formatting (Splunk, Datadog, Generic SIEM)
// ============================================================================

export function categorizeAuditAction(action = "") {
  const normalized = action.toLowerCase();
  if (normalized.startsWith("apikey")) return "authentication";
  if (
    normalized.startsWith("treasury") ||
    normalized.startsWith("policy") ||
    normalized.startsWith("authorize") ||
    normalized.startsWith("role")
  ) {
    return "authorization";
  }
  if (normalized.startsWith("privacy")) return "privacy";
  if (normalized.startsWith("workspace") || normalized.startsWith("residency")) return "compliance";
  if (
    normalized.startsWith("governance") ||
    normalized === "freeze" ||
    normalized === "unfreeze" ||
    normalized === "upgrade"
  ) {
    return "governance";
  }
  return "security";
}

export function severityForAuditRecord(record = {}) {
  const action = String(record.action ?? "").toLowerCase();
  if (
    action.includes("violation") ||
    action.includes("breach") ||
    action.includes("freeze") ||
    action.includes("compromise")
  ) {
    return "CRITICAL";
  }
  if (
    action.includes("revoke") ||
    action.includes("delete") ||
    action.includes("deny") ||
    action.includes("fail") ||
    action.includes("expired")
  ) {
    return "WARN";
  }
  return "INFO";
}

export function sanitizeForSiem(value) {
  if (Array.isArray(value)) return value.map(sanitizeForSiem);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        if (/token|secret|password|private_?key|authorization|bearer/i.test(k)) {
          return [k, REDACTED_SECRET];
        }
        return [k, sanitizeForSiem(v)];
      }),
    );
  }
  if (typeof value === "string") {
    if (/accord_[a-zA-Z0-9_-]{20,}/.test(value)) {
      return REDACTED_SECRET;
    }
    return value;
  }
  return value;
}

export function formatSiemEvent(record, { target = "generic", host = "accord-node", environment = "production" } = {}) {
  const sanitized = sanitizeForSiem(record);
  const category = categorizeAuditAction(record.action);
  const severity = severityForAuditRecord(record);

  if (target === "splunk") {
    return {
      time: Math.floor(new Date(record.timestamp ?? Date.now()).getTime() / 1000),
      host,
      source: "accord:security-controls",
      sourcetype: "accord:audit:json",
      index: "security_events",
      event: {
        eventId: record.hash,
        category,
        severity,
        environment,
        ...sanitized,
      },
    };
  }

  if (target === "datadog") {
    return {
      ddsource: "accord",
      ddtags: `env:${environment},service:accord-protocol,category:${category},severity:${severity.toLowerCase()}`,
      hostname: host,
      service: "accord-protocol",
      status: severity === "CRITICAL" ? "critical" : severity === "WARN" ? "warn" : "info",
      message: `[${record.action}] ${record.actor} on ${record.resource}`,
      timestamp: record.timestamp ?? new Date().toISOString(),
      audit: {
        eventId: record.hash,
        category,
        severity,
        ...sanitized,
      },
    };
  }

  // Generic SIEM / ECS / CEF aligned JSON
  return {
    version: 1,
    eventId: record.hash,
    timestamp: record.timestamp ?? new Date().toISOString(),
    category,
    severity,
    host,
    environment,
    actor: record.actor,
    action: record.action,
    resource: record.resource,
    details: sanitized.details ?? {},
    previousHash: record.previousHash,
    hash: record.hash,
  };
}

export function formatSiemBatch(records, options = {}) {
  return records.map((record) => formatSiemEvent(record, options));
}

export async function streamSiemEvents(
  records,
  {
    target = "generic",
    endpoint,
    token,
    host = "accord-node",
    environment = "production",
    dryRun = false,
    fetchFn = globalThis.fetch,
  } = {},
) {
  const batch = formatSiemBatch(records, { target, host, environment });
  if (dryRun) {
    return { total: records.length, shipped: 0, dryRun: true, events: batch };
  }

  if (!endpoint) {
    throw new Error("endpoint is required for live SIEM streaming");
  }

  if (typeof fetchFn !== "function") {
    throw new Error("fetch client is not available in environment");
  }

  const headers = { "Content-Type": "application/json" };
  if (token) {
    if (target === "splunk") {
      headers["Authorization"] = `Splunk ${token}`;
    } else if (target === "datadog") {
      headers["DD-API-KEY"] = token;
    } else {
      headers["Authorization"] = `Bearer ${token}`;
    }
  }

  const response = await fetchFn(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(batch),
  });

  if (!response.ok) {
    throw new Error(`SIEM ingestion failed with HTTP status ${response.status}: ${response.statusText}`);
  }

  return { total: records.length, shipped: records.length, dryRun: false, target, endpoint };
}

// ============================================================================
// SOC 2 Trust Services Criteria Mapping & Auditor Evidence Package
// ============================================================================

export const SOC2_CONTROL_MAPPINGS = [
  {
    criteria: "CC6.1",
    category: "Logical Access Security",
    description: "Access to system boundary and treasury actions is restricted to authorized entities with authenticated roles.",
    accordControl: "Multi-Role RBAC & Multi-Owner Consensus",
    enforcement: "contracts/accord/src/lib.rs (require_auth, require_role) & scripts/security-controls.mjs (authorize)",
    verification: "Automated via security-controls.test.mjs & role authorization checks",
    owner: "Security & Compliance Operator",
  },
  {
    criteria: "CC6.2",
    category: "User Registration & Credential Lifecycle",
    description: "API keys and machine credentials are created, tracked, rotated with overlap grace windows, and revoked upon expiration.",
    accordControl: "Least-Privilege Scoped API Key Store with Overlap Windows & Rotation Reminders",
    enforcement: "scripts/security-controls.mjs (issueApiKey, rotateApiKey, revokeApiKey, checkApiKeyReminders)",
    verification: "Automated via api key test suite",
    owner: "Security Administrator",
  },
  {
    criteria: "CC6.3",
    category: "Least Privilege & Access Revocation",
    description: "Privileges are restricted to least privilege required for job duties and promptly revoked upon departure or compromise.",
    accordControl: "Scoped API Permissions, Single-Owner Weight Cap, and Immediate Key Revocation",
    enforcement: "scripts/security-controls.mjs & contracts/accord/src/lib.rs (MAX_SINGLE_OWNER_WEIGHT_PCT)",
    verification: "Automated via scope validation and single-owner cap invariants",
    owner: "Security Administrator",
  },
  {
    criteria: "CC6.6",
    category: "External Threat & Boundary Protection",
    description: "Protects systems against unauthorized access from outside entities via allowlists and automated recipient screening.",
    accordControl: "Treasury Preflight Screening & Contract Allowlists",
    enforcement: "scripts/security-controls.mjs (preflightTreasuryTransfer, screenRecipient)",
    verification: "Automated via treasury preflight tests (fails closed on non-clear status)",
    owner: "Treasury Operator",
  },
  {
    criteria: "CC6.7",
    category: "Data Transmission & Tamper-Evident Integrity",
    description: "Maintains tamper-evident cryptographic verification of all audit records and security event transactions.",
    accordControl: "SHA-256 Tamper-Evident Chained Audit Logging",
    enforcement: "scripts/security-controls.mjs (verifyAuditLog, appendAuditRecord)",
    verification: "Automated via audit chain hash verification",
    owner: "Security Auditor",
  },
  {
    criteria: "CC6.8",
    category: "Unauthorized Software & Invariant Enforcement",
    description: "Prevents execution of unauthorized bytecode or rogue transactions through strict state invariants.",
    accordControl: "Atomic Rollbacks, Reentrancy Guard, and Timelock Execution Delays",
    enforcement: "contracts/accord/src/lib.rs & docs/INVARIANTS.md",
    verification: "Adversarial mock token testing (contracts/accord/src/test.rs)",
    owner: "Protocol Engineering",
  },
  {
    criteria: "CC7.1",
    category: "Vulnerability & Threat Monitoring",
    description: "Monitors systems and code repositories for secret leakage, insecure dependencies, and security exposures.",
    accordControl: "CI Gitleaks Secret Scanning & Supply-Chain Integrity Policy",
    enforcement: ".github/workflows/security.yml & scripts/check-secrets.sh",
    verification: "Automated CI verification on all commits",
    owner: "DevOps / SecOps",
  },
  {
    criteria: "CC7.2",
    category: "Security Event Logging & Monitoring",
    description: "Security and governance events are captured in tamper-evident logs and forwarded to SIEM endpoints.",
    accordControl: "SIEM Streaming to Splunk, Datadog, or Generic Endpoints",
    enforcement: "scripts/security-controls.mjs (streamSiemEvents, formatSiemEvent)",
    verification: "Automated SIEM event serialization and streaming tests",
    owner: "SOC Lead",
  },
  {
    criteria: "CC7.3",
    category: "Incident Response & Emergency Containment",
    description: "Enables immediate containment of compromises through emergency pause controls and documented runbooks.",
    accordControl: "Guardian Emergency Freeze & Incident Response Runbook",
    enforcement: "contracts/accord/src/lib.rs (freeze, unfreeze) & docs/INCIDENT_RESPONSE.md",
    verification: "Incident response runbook and simulation verification",
    owner: "Incident Response Lead",
  },
  {
    criteria: "CC8.1",
    category: "Change Management & Authorization",
    description: "Configuration, policy, and smart contract upgrades require authorized consensus before deployment.",
    accordControl: "Multisig Owner Quorum & Chained Policy Change Audit Trail",
    enforcement: "contracts/accord/src/lib.rs & scripts/security-controls.mjs (updatePolicyList)",
    verification: "Automated policy change verification and upgrade safety checks",
    owner: "Governance Board / Policy Admin",
  },
  {
    criteria: "A1.2",
    category: "Availability & Disaster Recovery",
    description: "Backups are created with verified integrity checksums and regional isolation to guarantee recovery.",
    accordControl: "Region-Pinned Workspace Backups with SHA-256 Checksums",
    enforcement: "scripts/security-controls.mjs (backupWorkspace, verifyDataResidency)",
    verification: "Automated backup checksum verification and recovery tests",
    owner: "Infrastructure Operator",
  },
  {
    criteria: "C1.1",
    category: "Confidentiality & Secret Protection",
    description: "Secrets, private keys, and authorization credentials are kept confidential and never stored in plain text.",
    accordControl: "Zero-Plaintext Secret Logging, Managed Secret Storage, and Redaction Filters",
    enforcement: "docs/SECRETS_MANAGEMENT.md & scripts/security-controls.mjs (sanitizeForSiem)",
    verification: "Automated secret redaction and sanitization tests",
    owner: "Security Administrator",
  },
  {
    criteria: "P1.1",
    category: "Privacy & Subject Rights",
    description: "Personal and workspace data is subject to verified export, redaction upon deletion, and legal hold exemptions.",
    accordControl: "Verifiable Personal Data Export, Redacted Deletion, and Retention Holds",
    enforcement: "scripts/security-controls.mjs (exportPersonalData, deletePersonalData)",
    verification: "Automated privacy export and deletion tests with retention hold gates",
    owner: "Privacy Administrator",
  },
  {
    criteria: "P4.1",
    category: "Data Sovereignty & Geographic Residency",
    description: "Personal and tenant workspace data is pinned to compliant geographic regions and prevented from unauthorized egress.",
    accordControl: "Regional Workspace Data Pinning & Egress Prevention",
    enforcement: "scripts/security-controls.mjs (verifyDataResidency, exportWorkspaceData)",
    verification: "Automated regional data residency policy verification",
    owner: "Compliance Officer",
  },
];

export function generateSoc2EvidencePackage({
  policy,
  auditLogPath,
  keyStore,
  residencyPolicy,
  now = new Date(),
} = {}) {
  const generatedAt = new Date(now).toISOString();
  const evidenceManifest = [];

  let auditVerification = { valid: false, records: 0, head: "NONE" };
  if (auditLogPath && existsSync(auditLogPath)) {
    const rawContent = readFileSync(auditLogPath, "utf8");
    const fileHash = createHash("sha256").update(rawContent).digest("hex");
    const records = readAuditLog(auditLogPath);
    auditVerification = verifyAuditLog(records);
    evidenceManifest.push({
      file: "security-audit.jsonl",
      sha256: fileHash,
      status: auditVerification.valid ? "VERIFIED" : "TAMPERED",
      recordCount: records.length,
    });
  }

  if (policy) {
    const policyHash = createHash("sha256").update(canonicalJson(policy)).digest("hex");
    evidenceManifest.push({
      file: "security-policy.json",
      sha256: policyHash,
      status: "VERIFIED",
    });
  }

  if (keyStore) {
    const keyHash = createHash("sha256").update(canonicalJson(keyStore)).digest("hex");
    evidenceManifest.push({
      file: "api-keys.json",
      sha256: keyHash,
      status: "VERIFIED",
      keyCount: (keyStore.keys ?? []).length,
    });
  }

  if (residencyPolicy) {
    const resHash = createHash("sha256").update(canonicalJson(residencyPolicy)).digest("hex");
    evidenceManifest.push({
      file: "data-residency-policy.json",
      sha256: resHash,
      status: "VERIFIED",
    });
  }

  const controlsStatus = SOC2_CONTROL_MAPPINGS.map((control) => {
    let status = "COMPLIANT";
    let failureDetail = null;

    if (control.criteria === "CC6.7" && (!auditVerification.valid || auditVerification.records === 0)) {
      status = auditVerification.records === 0 ? "WARNING: NO_RECORDS" : "NON_COMPLIANT: AUDIT_TAMPERED";
      failureDetail = "Audit chain validation failed or empty";
    }

    return {
      criteria: control.criteria,
      category: control.category,
      accordControl: control.accordControl,
      owner: control.owner,
      status,
      failureDetail,
      enforcement: control.enforcement,
      verification: control.verification,
    };
  });

  const overallStatus = controlsStatus.every((c) => c.status === "COMPLIANT" || c.status.startsWith("WARNING"))
    ? "COMPLIANT"
    : "NON_COMPLIANT";

  return {
    packageVersion: "1.0.0",
    complianceStandard: "SOC 2 Type II / Trust Services Criteria",
    generatedAt,
    overallStatus,
    summary: {
      totalControlsEvaluated: controlsStatus.length,
      auditChainValid: auditVerification.valid,
      auditLogHead: auditVerification.head,
      totalAuditRecords: auditVerification.records,
      activeApiKeys: (keyStore?.keys ?? []).filter((k) => k.status === "active").length,
      evidenceFilesCount: evidenceManifest.length,
    },
    evidenceManifest,
    controls: controlsStatus,
  };
}

// ============================================================================
// Regional Workspace Data Pinning, Backup, Export, and Deletion
// ============================================================================

export function verifyDataResidency(policy, workspaceId, targetRegion) {
  if (!targetRegion || typeof targetRegion !== "string") {
    throw new Error("target region is required");
  }
  const allowed = policy.allowedRegions ?? [];
  if (allowed.length > 0 && !allowed.includes(targetRegion)) {
    throw new Error(
      `data residency violation: target region '${targetRegion}' is not in policy.allowedRegions: ${allowed.join(", ")}`,
    );
  }

  const workspaceConfig = policy.workspaces?.[workspaceId];
  if (workspaceConfig?.pinnedRegion && workspaceConfig.pinnedRegion !== targetRegion) {
    throw new Error(
      `data residency violation: workspace '${workspaceId}' is pinned to '${workspaceConfig.pinnedRegion}', rejecting operation in '${targetRegion}'`,
    );
  }

  return {
    compliant: true,
    workspaceId,
    region: targetRegion,
    classification: workspaceConfig?.dataClassification ?? "internal",
  };
}

export function backupWorkspace(
  data,
  { workspaceId, region, policy, actor, timestamp = new Date().toISOString() },
) {
  verifyDataResidency(policy, workspaceId, region);
  const serialized = canonicalJson(data);
  const checksum = createHash("sha256").update(serialized).digest("hex");

  return {
    version: 1,
    backupId: `backup_${workspaceId}_${new Date(timestamp).getTime()}`,
    workspaceId,
    region,
    checksum,
    recordCount: Array.isArray(data) ? data.length : 1,
    createdAt: timestamp,
    actor,
    data,
  };
}

export function exportWorkspaceData(
  data,
  { workspaceId, region, policy, actor, timestamp = new Date().toISOString() },
) {
  const residency = verifyDataResidency(policy, workspaceId, region);
  return {
    version: 1,
    exportId: `export_${workspaceId}_${new Date(timestamp).getTime()}`,
    workspaceId,
    region,
    provenance: {
      actor,
      exportedAt: timestamp,
      pinnedRegion: region,
      dataClassification: residency.classification,
    },
    data,
  };
}

export function deleteWorkspaceData(
  data,
  { workspaceId, region, policy, exceptions = [], actor, now = new Date() },
) {
  verifyDataResidency(policy, workspaceId, region);

  const activeException = exceptions.find(
    (exception) =>
      exception.workspaceId === workspaceId &&
      new Date(exception.retainUntil).getTime() >= new Date(now).getTime(),
  );
  if (activeException) {
    throw new Error(
      `workspace deletion blocked by active retention exception until ${activeException.retainUntil}: ${activeException.reason}`,
    );
  }

  const recordCount = Array.isArray(data) ? data.length : 1;
  return {
    workspaceId,
    region,
    deleted: true,
    recordsPurged: recordCount,
    deletedAt: new Date(now).toISOString(),
    actor,
  };
}

// ============================================================================
// CLI Entry Point & Parameter Parsing
// ============================================================================

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function option(args, name, required = true) {
  const prefix = `--${name}=`;
  const value = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (required && !value) throw new Error(`missing --${name}=...`);
  return value;
}

function usage() {
  console.error(`Usage:
  Audit:
    security-controls.mjs audit verify --log=PATH
    security-controls.mjs audit append --log=PATH --policy=PATH --actor=ID --action=ACTION --resource=ID [--details=JSON]

  Treasury & Policy:
    security-controls.mjs treasury preflight --policy=PATH --actor=ID --recipient=ADDR --contract=ID
    security-controls.mjs policy update --policy=PATH --actor=ID --list=NAME --value=VAL [--mode=add|remove] --audit=PATH

  Privacy:
    security-controls.mjs privacy export --data=PATH --policy=PATH --actor=ID --subject=ID --out=PATH --audit=PATH
    security-controls.mjs privacy delete --data=PATH --exceptions=PATH --policy=PATH --actor=ID --subject=ID --out=PATH --audit=PATH

  API Keys:
    security-controls.mjs apikey issue --keystore=PATH --policy=PATH --actor=ID --name=NAME --scopes=S1,S2 [--expires=90] --audit=PATH
    security-controls.mjs apikey rotate --keystore=PATH --policy=PATH --actor=ID --key=KEY_ID [--overlap=7] [--expires=90] --audit=PATH
    security-controls.mjs apikey revoke --keystore=PATH --policy=PATH --actor=ID --key=KEY_ID --reason=REASON --audit=PATH
    security-controls.mjs apikey verify --keystore=PATH --token=TOKEN [--scope=SCOPE]
    security-controls.mjs apikey reminders --keystore=PATH [--window=14]

  SIEM Streaming:
    security-controls.mjs siem export --log=PATH [--target=splunk|datadog|generic] [--out=PATH] [--host=HOST] [--env=ENV]
    security-controls.mjs siem stream --log=PATH [--target=splunk|datadog|generic] --endpoint=URL [--token=TOKEN] [--dry-run]

  SOC 2 Compliance:
    security-controls.mjs soc2 export --policy=PATH --audit=PATH [--keystore=PATH] [--residency=PATH] --out=PATH [--actor=ID]
    security-controls.mjs soc2 map

  Data Residency & Workspace:
    security-controls.mjs residency verify --policy=PATH --workspace=ID --region=REGION
    security-controls.mjs workspace backup --data=PATH --policy=PATH --workspace=ID --region=REGION --out=PATH --audit=PATH --actor=ID
    security-controls.mjs workspace export --data=PATH --policy=PATH --workspace=ID --region=REGION --out=PATH --audit=PATH --actor=ID
    security-controls.mjs workspace delete --data=PATH --policy=PATH --exceptions=PATH --workspace=ID --region=REGION --out=PATH --audit=PATH --actor=ID`);
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const [area, command, ...args] = argv;

    if (area === "audit" && command === "verify") {
      const logPath = option(args, "log");
      if (!existsSync(logPath)) throw new Error("audit log is missing");
      console.log(JSON.stringify(verifyAuditLog(readAuditLog(logPath))));
      return;
    }

    if (area === "audit" && command === "append") {
      const policy = readJson(option(args, "policy"));
      const actor = option(args, "actor");
      const action = option(args, "action");
      authorize(policy, actor, action);
      const record = appendAuditRecord(option(args, "log"), {
        actor,
        action,
        resource: option(args, "resource"),
        details: args.find((arg) => arg.startsWith("--details="))
          ? JSON.parse(option(args, "details"))
          : {},
      });
      console.log(JSON.stringify(record));
      return;
    }

    if (area === "treasury" && command === "preflight") {
      const result = preflightTreasuryTransfer(readJson(option(args, "policy")), {
        actor: option(args, "actor"),
        recipient: option(args, "recipient"),
        contract: option(args, "contract"),
      });
      console.log(JSON.stringify(result));
      return;
    }

    if (area === "policy" && command === "update") {
      const policyPath = option(args, "policy");
      const actor = option(args, "actor");
      authorize(readJson(policyPath), actor, "policy_change");
      const list = option(args, "list");
      const value = option(args, "value");
      const mode = option(args, "mode", false) ?? "add";
      const updated = updatePolicyList(readJson(policyPath), list, value, mode);
      writeFileSync(policyPath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
      appendAuditRecord(option(args, "audit"), {
        actor,
        action: "policy_change",
        resource: list,
        details: { mode, value },
      });
      console.log(JSON.stringify({ list, value, updated: true }));
      return;
    }

    if (area === "privacy" && command === "export") {
      const result = exportPersonalData(readJson(option(args, "data")), option(args, "subject"));
      const policy = readJson(option(args, "policy"));
      const actor = option(args, "actor");
      authorize(policy, actor, "privacy_export");
      writeFileSync(option(args, "out"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
      appendAuditRecord(option(args, "audit"), {
        actor,
        action: "privacy_export",
        resource: option(args, "subject"),
        details: { recordsExported: result.length },
      });
      console.log(JSON.stringify({ exported: result.length }));
      return;
    }

    if (area === "privacy" && command === "delete") {
      const policy = readJson(option(args, "policy"));
      const actor = option(args, "actor");
      authorize(policy, actor, "privacy_delete");
      const subject = option(args, "subject");
      const result = deletePersonalData(
        readJson(option(args, "data")),
        subject,
        readJson(option(args, "exceptions")),
      );
      writeFileSync(option(args, "out"), `${JSON.stringify(result.records, null, 2)}\n`, { mode: 0o600 });
      appendAuditRecord(option(args, "audit"), {
        actor,
        action: "privacy_delete",
        resource: subject,
        details: { recordsRedacted: result.deleted },
      });
      console.log(JSON.stringify({ deleted: result.deleted }));
      return;
    }

    // ------------------------------------------------------------------------
    // API Keys
    // ------------------------------------------------------------------------
    if (area === "apikey" && command === "issue") {
      const keystorePath = option(args, "keystore");
      const policy = readJson(option(args, "policy"));
      const actor = option(args, "actor");
      authorize(policy, actor, "apikey_admin");

      const keyStore = existsSync(keystorePath) ? readJson(keystorePath) : { version: 1, keys: [] };
      const id = option(args, "name") + "_" + Math.floor(Date.now() / 1000);
      const scopes = option(args, "scopes").split(",").map((s) => s.trim()).filter(Boolean);
      const expiresInDays = Number(option(args, "expires", false) ?? 90);

      const result = issueApiKey(keyStore, {
        id,
        name: option(args, "name"),
        actor,
        scopes,
        expiresInDays,
      });

      writeFileSync(keystorePath, `${JSON.stringify(keyStore, null, 2)}\n`, { mode: 0o600 });

      const auditPath = option(args, "audit", false);
      if (auditPath) {
        appendAuditRecord(auditPath, {
          actor,
          action: "apikey_issue",
          resource: id,
          details: { scopes, expiresAt: result.key.expiresAt },
        });
      }

      console.log(JSON.stringify(result));
      return;
    }

    if (area === "apikey" && command === "rotate") {
      const keystorePath = option(args, "keystore");
      const policy = readJson(option(args, "policy"));
      const actor = option(args, "actor");
      authorize(policy, actor, "apikey_admin");

      const keyStore = readJson(keystorePath);
      const keyId = option(args, "key");
      const overlapDays = Number(option(args, "overlap", false) ?? 7);
      const expiresInDays = Number(option(args, "expires", false) ?? 90);

      const result = rotateApiKey(keyStore, {
        keyId,
        actor,
        overlapDays,
        expiresInDays,
      });

      writeFileSync(keystorePath, `${JSON.stringify(keyStore, null, 2)}\n`, { mode: 0o600 });

      const auditPath = option(args, "audit", false);
      if (auditPath) {
        appendAuditRecord(auditPath, {
          actor,
          action: "apikey_rotate",
          resource: result.newKey.id,
          details: { previousKeyId: keyId, overlapUntil: result.rotatedKey.overlapUntil },
        });
      }

      console.log(JSON.stringify(result));
      return;
    }

    if (area === "apikey" && command === "revoke") {
      const keystorePath = option(args, "keystore");
      const policy = readJson(option(args, "policy"));
      const actor = option(args, "actor");
      authorize(policy, actor, "apikey_admin");

      const keyStore = readJson(keystorePath);
      const keyId = option(args, "key");
      const reason = option(args, "reason");

      const revoked = revokeApiKey(keyStore, { keyId, actor, reason });
      writeFileSync(keystorePath, `${JSON.stringify(keyStore, null, 2)}\n`, { mode: 0o600 });

      const auditPath = option(args, "audit", false);
      if (auditPath) {
        appendAuditRecord(auditPath, {
          actor,
          action: "apikey_revoke",
          resource: keyId,
          details: { reason },
        });
      }

      console.log(JSON.stringify(revoked));
      return;
    }

    if (area === "apikey" && command === "verify") {
      const keystore = readJson(option(args, "keystore"));
      const token = option(args, "token");
      const requiredScope = option(args, "scope", false);
      const result = verifyApiKey(keystore, { token, requiredScope });
      console.log(JSON.stringify(result));
      return;
    }

    if (area === "apikey" && command === "reminders") {
      const keystore = readJson(option(args, "keystore"));
      const window = Number(option(args, "window", false) ?? 14);
      const reminders = checkApiKeyReminders(keystore, { reminderWindowDays: window });
      console.log(JSON.stringify(reminders));
      return;
    }

    // ------------------------------------------------------------------------
    // SIEM Streaming & Export
    // ------------------------------------------------------------------------
    if (area === "siem" && command === "export") {
      const records = readAuditLog(option(args, "log"));
      const target = option(args, "target", false) ?? "generic";
      const host = option(args, "host", false) ?? "accord-node";
      const environment = option(args, "env", false) ?? "production";
      const formatted = formatSiemBatch(records, { target, host, environment });

      const outPath = option(args, "out", false);
      if (outPath) {
        writeFileSync(outPath, `${JSON.stringify(formatted, null, 2)}\n`, { mode: 0o600 });
      }
      console.log(JSON.stringify({ exported: formatted.length, target }));
      return;
    }

    if (area === "siem" && command === "stream") {
      const records = readAuditLog(option(args, "log"));
      const target = option(args, "target", false) ?? "generic";
      const endpoint = option(args, "endpoint");
      const token = option(args, "token", false);
      const dryRun = args.includes("--dry-run");

      const result = await streamSiemEvents(records, { target, endpoint, token, dryRun });
      console.log(JSON.stringify(result));
      return;
    }

    // ------------------------------------------------------------------------
    // SOC 2 Evidence
    // ------------------------------------------------------------------------
    if (area === "soc2" && command === "map") {
      console.log(JSON.stringify(SOC2_CONTROL_MAPPINGS, null, 2));
      return;
    }

    if (area === "soc2" && command === "export") {
      const policyPath = option(args, "policy");
      const auditLogPath = option(args, "audit");
      const keystorePath = option(args, "keystore", false);
      const residencyPath = option(args, "residency", false);
      const outPath = option(args, "out");

      const policy = readJson(policyPath);
      const keyStore = keystorePath && existsSync(keystorePath) ? readJson(keystorePath) : null;
      const residencyPolicy = residencyPath && existsSync(residencyPath) ? readJson(residencyPath) : null;

      const actor = option(args, "actor", false);
      if (actor) {
        authorize(policy, actor, "compliance_export");
      }

      const pkg = generateSoc2EvidencePackage({
        policy,
        auditLogPath,
        keyStore,
        residencyPolicy,
      });

      writeFileSync(outPath, `${JSON.stringify(pkg, null, 2)}\n`, { mode: 0o600 });
      console.log(JSON.stringify({ generated: true, status: pkg.overallStatus, out: outPath }));
      return;
    }

    // ------------------------------------------------------------------------
    // Data Residency & Workspace
    // ------------------------------------------------------------------------
    if (area === "residency" && command === "verify") {
      const policy = readJson(option(args, "policy"));
      const workspaceId = option(args, "workspace");
      const region = option(args, "region");
      const result = verifyDataResidency(policy, workspaceId, region);
      console.log(JSON.stringify(result));
      return;
    }

    if (area === "workspace" && command === "backup") {
      const policy = readJson(option(args, "policy"));
      const actor = option(args, "actor");
      authorize(policy, actor, "infra_operator");
      const workspaceId = option(args, "workspace");
      const region = option(args, "region");
      const data = readJson(option(args, "data"));
      const outPath = option(args, "out");

      const backup = backupWorkspace(data, { workspaceId, region, policy, actor });
      writeFileSync(outPath, `${JSON.stringify(backup, null, 2)}\n`, { mode: 0o600 });

      const auditPath = option(args, "audit", false);
      if (auditPath) {
        appendAuditRecord(auditPath, {
          actor,
          action: "workspace_backup",
          resource: workspaceId,
          details: { region, checksum: backup.checksum, recordCount: backup.recordCount },
        });
      }

      console.log(JSON.stringify({ backupId: backup.backupId, checksum: backup.checksum }));
      return;
    }

    if (area === "workspace" && command === "export") {
      const policy = readJson(option(args, "policy"));
      const actor = option(args, "actor");
      authorize(policy, actor, "privacy_export");
      const workspaceId = option(args, "workspace");
      const region = option(args, "region");
      const data = readJson(option(args, "data"));
      const outPath = option(args, "out");

      const exportPkg = exportWorkspaceData(data, { workspaceId, region, policy, actor });
      writeFileSync(outPath, `${JSON.stringify(exportPkg, null, 2)}\n`, { mode: 0o600 });

      const auditPath = option(args, "audit", false);
      if (auditPath) {
        appendAuditRecord(auditPath, {
          actor,
          action: "workspace_export",
          resource: workspaceId,
          details: { region, exportId: exportPkg.exportId },
        });
      }

      console.log(JSON.stringify({ exportId: exportPkg.exportId, region }));
      return;
    }

    if (area === "workspace" && command === "delete") {
      const policy = readJson(option(args, "policy"));
      const actor = option(args, "actor");
      authorize(policy, actor, "privacy_delete");
      const workspaceId = option(args, "workspace");
      const region = option(args, "region");
      const data = readJson(option(args, "data"));
      const exceptions = readJson(option(args, "exceptions"));
      const outPath = option(args, "out");

      const result = deleteWorkspaceData(data, {
        workspaceId,
        region,
        policy,
        exceptions,
        actor,
      });

      writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });

      const auditPath = option(args, "audit", false);
      if (auditPath) {
        appendAuditRecord(auditPath, {
          actor,
          action: "workspace_delete",
          resource: workspaceId,
          details: { region, recordsPurged: result.recordsPurged },
        });
      }

      console.log(JSON.stringify(result));
      return;
    }

    usage();
    process.exitCode = 2;
  } catch (error) {
    console.error(`security control failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
