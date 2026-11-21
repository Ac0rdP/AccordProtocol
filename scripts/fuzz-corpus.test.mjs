import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildSanitizedCrashReport,
  decodeProposalInputHeader,
  minimizeCorpus,
  parseCargoFuzzTargets,
  redactSecrets,
  renderMarkdownReport,
  validateCorpus,
  writeReports,
} from "./fuzz-corpus.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_CORPUS_DIR = join(ROOT, "contracts/fuzz/corpus");
const REPO_CARGO_TOML = join(ROOT, "contracts/fuzz/Cargo.toml");

const tempDirs = [];

function makeTempCorpus({
  maxSeedBytes = 4096,
  maxFilesPerTarget = 64,
  minInputBytes = 4,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "accord-fuzz-corpus-test-"));
  tempDirs.push(dir);

  const manifest = {
    version: 1,
    policy: {
      minSeedBytes: 1,
      maxSeedBytes,
      maxFilesPerTarget,
      requiredRegressionPrefix: "regression-",
    },
    nightly: {
      secondsPerTarget: 60,
      minimizeAfterRun: true,
    },
    targets: {
      weight_arithmetic: {
        source: "contracts/fuzz/fuzz_targets/weight_arithmetic.rs",
        minInputBytes,
        regressionFixtures: ["regression-sample"],
      },
    },
  };

  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  mkdirSync(join(dir, "weight_arithmetic"), { recursive: true });
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("contract fuzz corpus management and nightly fuzzing gate", () => {
  describe("success cases", () => {
    it("validates the committed repository fuzz corpus and Cargo.toml targets", () => {
      const cargoTargets = parseCargoFuzzTargets(
        readFileSync(REPO_CARGO_TOML, "utf8"),
      );
      assert.deepEqual(
        cargoTargets.map((t) => t.name),
        [
          "weight_arithmetic",
          "proposal_bookkeeping",
          "proposal_input_validation",
        ],
      );

      const result = validateCorpus({
        corpusDir: REPO_CORPUS_DIR,
        cargoTomlPath: REPO_CARGO_TOML,
      });
      assert.equal(result.ok, true, JSON.stringify(result.violations));
      assert.equal(result.violations.length, 0);
      assert.equal(result.targets.length, 3);

      for (const target of result.targets) {
        assert.ok(
          target.totalFiles >= 3,
          `Expected at least 3 committed seeds for ${target.target}`,
        );
        assert.ok(
          target.regressionFixtures >= 1,
          `Expected at least 1 regression fixture for ${target.target}`,
        );
      }
    });

    it("minimizes a corpus by deduplicating identical inputs while preserving regression fixtures", () => {
      const dir = makeTempCorpus({ maxFilesPerTarget: 3, minInputBytes: 4 });
      const targetDir = join(dir, "weight_arithmetic");

      writeFileSync(join(targetDir, "regression-sample"), "REGRESSION_SEED_01");
      writeFileSync(join(targetDir, "seed-short"), "ABCD");
      writeFileSync(join(targetDir, "seed-duplicate-of-short"), "ABCD");
      writeFileSync(join(targetDir, "seed-medium"), "ABCDEFGH");
      writeFileSync(join(targetDir, "seed-longer-overflow"), "ABCDEFGHIJKLMNOP");

      const minResult = minimizeCorpus({ corpusDir: dir });
      assert.equal(minResult.ok, true);
      const summary = minResult.targets[0];
      assert.equal(summary.beforeCount, 5);
      assert.equal(summary.afterCount, 3);
      assert.ok(
        summary.kept.some((k) => k.name === "regression-sample"),
        "Regression fixture must always be preserved",
      );
      assert.ok(
        summary.removed.some((r) => r.reason === "duplicate_digest"),
        "Duplicate digest must be removed during minimization",
      );

      const postValidation = validateCorpus({
        corpusDir: dir,
        cargoTomlPath: join(dir, "nonexistent-Cargo.toml"),
      });
      assert.equal(postValidation.ok, true);
    });

    it("writes deterministic JSON and Markdown reports for CI artifacts", () => {
      const reportDir = mkdtempSync(join(tmpdir(), "accord-fuzz-report-"));
      tempDirs.push(reportDir);

      const validation = validateCorpus({
        corpusDir: REPO_CORPUS_DIR,
        cargoTomlPath: REPO_CARGO_TOML,
      });
      const { jsonPath, mdPath } = writeReports(reportDir, validation);

      assert.ok(existsSync(jsonPath));
      assert.ok(existsSync(mdPath));
      const md = readFileSync(mdPath, "utf8");
      assert.match(md, /# Contract Fuzz Corpus Report/);
      assert.match(md, /\*\*Status:\*\* PASSED/);
      assert.match(md, /`weight_arithmetic`/);
      assert.match(md, /`proposal_bookkeeping`/);
      assert.match(md, /`proposal_input_validation`/);
    });
  });

  describe("boundary cases", () => {
    it("accepts inputs at exact minInputBytes (12B) and maxSeedBytes (4096B) boundaries and rejects 11B / 4097B", () => {
      const dir = makeTempCorpus({ maxSeedBytes: 4096, minInputBytes: 12 });
      const targetDir = join(dir, "weight_arithmetic");

      writeFileSync(join(targetDir, "regression-sample"), "A".repeat(12));
      writeFileSync(join(targetDir, "seed-exact-max"), "B".repeat(4096));

      const exactBoundary = validateCorpus({
        corpusDir: dir,
        cargoTomlPath: join(dir, "no-cargo.toml"),
      });
      assert.equal(exactBoundary.ok, true);

      // Now add 11-byte underflow and 4097-byte overflow
      writeFileSync(join(targetDir, "seed-too-small-11b"), "C".repeat(11));
      writeFileSync(join(targetDir, "seed-too-large-4097b"), "D".repeat(4097));

      const outOfBounds = validateCorpus({
        corpusDir: dir,
        cargoTomlPath: join(dir, "no-cargo.toml"),
      });
      assert.equal(outOfBounds.ok, false);
      assert.ok(
        outOfBounds.violations.some(
          (v) =>
            v.code === "INPUT_TOO_SMALL" && v.caseId === "seed-too-small-11b",
        ),
      );
      assert.ok(
        outOfBounds.violations.some(
          (v) =>
            v.code === "INPUT_TOO_LARGE" &&
            v.caseId === "seed-too-large-4097b",
        ),
      );
    });

    it("enforces the exact maxFilesPerTarget boundary", () => {
      const dir = makeTempCorpus({ maxFilesPerTarget: 2, minInputBytes: 4 });
      const targetDir = join(dir, "weight_arithmetic");

      writeFileSync(join(targetDir, "regression-sample"), "SEED_ONE_1111");
      writeFileSync(join(targetDir, "seed-two"), "SEED_TWO_2222");

      const atLimit = validateCorpus({
        corpusDir: dir,
        cargoTomlPath: join(dir, "no-cargo.toml"),
      });
      assert.equal(atLimit.ok, true);

      writeFileSync(join(targetDir, "seed-three"), "SEED_THREE_3333");
      const overLimit = validateCorpus({
        corpusDir: dir,
        cargoTomlPath: join(dir, "no-cargo.toml"),
      });
      assert.equal(overLimit.ok, false);
      assert.ok(
        overLimit.violations.some(
          (v) => v.code === "CORPUS_FILE_LIMIT_EXCEEDED",
        ),
      );
    });

    it("verifies boundary seeds for proposal_bookkeeping 50-active-proposal cap and proposal_input_validation headers", () => {
      const activeCapSeed = readFileSync(
        join(
          REPO_CORPUS_DIR,
          "proposal_bookkeeping/seed-boundary-active-cap",
        ),
      );
      assert.equal(
        activeCapSeed[0],
        50,
        "First byte must equal 50 (ACTIVE_PROPOSAL_CAP) to exercise cap boundary",
      );

      const emptyDescBoundary = readFileSync(
        join(
          REPO_CORPUS_DIR,
          "proposal_input_validation/seed-boundary-empty-and-max-deadline",
        ),
      );
      const decoded = decodeProposalInputHeader(emptyDescBoundary);
      assert.ok(decoded);
      assert.equal(
        decoded.effectiveDescLen,
        0,
        "Boundary seed must decode to an empty 0-byte description",
      );
      assert.equal(
        decoded.deadlineBranch,
        5,
        "Boundary seed must select branch 5 (NOW + MAX_PROPOSAL_DURATION)",
      );
    });
  });

  describe("failure cases and secret redaction", () => {
    it("identifies duplicate inputs and missing regression fixtures by offending case ID", () => {
      const dir = makeTempCorpus({ minInputBytes: 4 });
      const targetDir = join(dir, "weight_arithmetic");

      writeFileSync(join(targetDir, "seed-a"), "IDENTICAL_PAYLOAD");
      writeFileSync(join(targetDir, "seed-b"), "IDENTICAL_PAYLOAD");

      const res = validateCorpus({
        corpusDir: dir,
        cargoTomlPath: join(dir, "no-cargo.toml"),
      });
      assert.equal(res.ok, false);
      assert.ok(
        res.violations.some(
          (v) =>
            v.code === "DUPLICATE_CORPUS_INPUT" &&
            v.target === "weight_arithmetic" &&
            v.caseId === "seed-b",
        ),
      );
      assert.ok(
        res.violations.some((v) => v.code === "REGRESSION_FIXTURE_MISSING"),
      );
    });

    it("rejects and redacts secret material in corpus files and crash logs without exposing secrets", () => {
      const dir = makeTempCorpus({ minInputBytes: 4 });
      const targetDir = join(dir, "weight_arithmetic");

      const syntheticToken = ["ghp", "99887766554433221100aabbccddeeff"].join(
        "_",
      );
      const syntheticBearer = `Bearer ${["eyJhbGciOiJIUzI1NiJ9", "supersecretpayload12345"].join(".")}`;
      const syntheticDb = [
        "postgres://accord:",
        " ultra_secret_db_pass",
        "@db.internal:5432/accord",
      ]
        .join("")
        .replace(" ", "");

      writeFileSync(join(targetDir, "regression-sample"), "SAFE_REGRESSION_1");
      writeFileSync(
        join(targetDir, "seed-leaked-secret"),
        `FUZZ_HEADER_${syntheticToken}`,
      );

      const validation = validateCorpus({
        corpusDir: dir,
        cargoTomlPath: join(dir, "no-cargo.toml"),
      });
      assert.equal(validation.ok, false);
      const violation = validation.violations.find(
        (v) => v.code === "SECRET_DETECTED_IN_CORPUS",
      );
      assert.ok(violation, "Must flag secret-bearing corpus file");
      assert.equal(violation.caseId, "seed-leaked-secret");

      const markdown = renderMarkdownReport(validation);
      assert.ok(
        !markdown.includes(syntheticToken),
        "Markdown report must never expose raw secret token",
      );

      const crashReport = buildSanitizedCrashReport({
        target: "proposal_input_validation",
        inputBytes: Buffer.from(`CRASH_${syntheticToken}`),
        rawOutput: `thread panicked with auth=${syntheticBearer} and db=${syntheticDb}`,
      });

      assert.equal(crashReport.inputRedacted, true);
      assert.equal(crashReport.hexPreview32, "[REDACTED_INPUT_BYTES]");
      assert.ok(!crashReport.sanitizedOutput.includes(syntheticToken));
      assert.ok(!crashReport.sanitizedOutput.includes("supersecretpayload12345"));
      assert.ok(!crashReport.sanitizedOutput.includes("ultra_secret_db_pass"));
      assert.ok(! redactSecrets(syntheticBearer).includes("supersecretpayload12345"));
    });
  });

  describe("regression fixture verification", () => {
    it("verifies committed regression fixtures for all three contract fuzz targets", () => {
      const weightReg = readFileSync(
        join(
          REPO_CORPUS_DIR,
          "weight_arithmetic/regression-total-weight-drift-guard",
        ),
      );
      assert.ok(weightReg.length >= 16);

      const bookkeepingReg = readFileSync(
        join(
          REPO_CORPUS_DIR,
          "proposal_bookkeeping/regression-active-count-expiry-reuse",
        ),
      );
      assert.ok(bookkeepingReg.length >= 32);

      const validationReg = readFileSync(
        join(
          REPO_CORPUS_DIR,
          "proposal_input_validation/regression-malformed-category-and-overflow-deadline",
        ),
      );
      const decoded = decodeProposalInputHeader(validationReg);
      assert.ok(decoded, "Regression fixture must have a valid 12-byte header");
      assert.equal(
        decoded.deadlineBranch,
        7,
        "Regression fixture must exercise u64::MAX deadline branch (selector % 10 == 7)",
      );
      assert.equal(
        decoded.categoryBranch,
        3,
        "Regression fixture must exercise malformed primitive ProposalCategory branch (selector % 6 == 3)",
      );
      assert.equal(
        decoded.effectiveDescLen,
        16,
        "Regression fixture must supply a valid 16-byte description so category validation is reached",
      );
    });
  });
});
