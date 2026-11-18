import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
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
} from "./security-controls.mjs";

const policy = {
  roles: { operator: ["treasury_operator"], privacy: ["privacy_admin"] },
  permissions: {
    treasury_transfer: ["treasury_operator"],
    privacy_delete: ["privacy_admin"],
  },
  allowRecipients: ["RECIPIENT-1"],
  contractAllowList: ["CONTRACT-1"],
  screening: {
    provider: "fixture-provider",
    results: { "recipient-1": "clear" },
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
    () => preflightTreasuryTransfer(policy, {
      actor: "operator",
      recipient: "recipient-2",
      contract: "contract-1",
    }),
    /allowlist/,
  );
  assert.throws(
    () => preflightTreasuryTransfer(policy, {
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
    () => deletePersonalData(
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
