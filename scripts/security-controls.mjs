#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REDACTED = "[REDACTED]";

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
  security-controls.mjs audit verify --log=PATH
  security-controls.mjs audit append --log=PATH --policy=PATH --actor=ID --action=ACTION --resource=ID [--details=JSON]
  security-controls.mjs treasury preflight --policy=PATH --actor=ID --recipient=ADDR --contract=ID
  security-controls.mjs privacy export --data=PATH --policy=PATH --actor=ID --subject=ID --out=PATH --audit=PATH
  security-controls.mjs privacy delete --data=PATH --exceptions=PATH --policy=PATH --actor=ID --subject=ID --out=PATH --audit=PATH`);
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
      const updated = updatePolicyList(readJson(policyPath), list, value, option(args, "mode", false) ?? "add");
      writeFileSync(policyPath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
      appendAuditRecord(option(args, "audit"), {
        actor,
        action: "policy_change",
        resource: list,
        details: { mode: option(args, "mode", false) ?? "add", value },
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
    usage();
    process.exitCode = 2;
  } catch (error) {
    console.error(`security control failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
