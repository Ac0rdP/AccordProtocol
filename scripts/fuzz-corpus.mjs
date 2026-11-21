#!/usr/bin/env node

/**
 * Contract fuzz corpus management, minimization, and failure-redaction tool.
 *
 * Manages persisted libFuzzer / cargo-fuzz corpus inputs under `contracts/fuzz/corpus/`,
 * enforces corpus hygiene and regression-fixture gates in CI, minimizes newly
 * discovered inputs, and produces sanitized failure/crash reports that identify
 * the offending target and input digest without exposing secrets.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CORPUS_DIR = join(ROOT, "contracts/fuzz/corpus");
const DEFAULT_CARGO_TOML = join(ROOT, "contracts/fuzz/Cargo.toml");

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA|EC|OPENSSH|PRIVATE) KEY-----[\s\S]*?-----END (?:RSA|EC|OPENSSH|PRIVATE) KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~-]{16,}\b/gi,
  /\b(?:postgres|postgresql|mysql|redis|smtps?):\/\/[^\s"'<>]+/gi,
  /\b(SECRET|API_TOKEN|ACCESS_TOKEN|PRIVATE_KEY|RPC_KEY|DATABASE_URL)\s*=\s*([^\s"'<>]+)/gi,
  /\bS[A-Z2-7]{55}\b/g,
];

/**
 * Redacts any credential, token, connection URI, or Stellar secret seed from text.
 */
export function redactSecrets(input) {
  let text = String(input ?? "");
  text = text.replace(
    /-----BEGIN (?:RSA|EC|OPENSSH|PRIVATE) KEY-----[\s\S]*?-----END (?:RSA|EC|OPENSSH|PRIVATE) KEY-----/g,
    "[REDACTED_PRIVATE_KEY]",
  );
  text = text.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]");
  text = text.replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GH_TOKEN]");
  text = text.replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, "[REDACTED_SLACK_TOKEN]");
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~-]{12,}\b/gi, "Bearer [REDACTED_TOKEN]");
  text = text.replace(
    /\b((?:postgres|postgresql|mysql|redis|smtps?):\/\/)[^\s"'<>]+/gi,
    "$1[REDACTED_URI]",
  );
  text = text.replace(
    /\b(SECRET|API_TOKEN|ACCESS_TOKEN|PRIVATE_KEY|RPC_KEY|DATABASE_URL|PASSWORD)\s*=\s*([^\s"'<>]+)/gi,
    "$1=[REDACTED]",
  );
  text = text.replace(/\bS[A-Z2-7]{55}\b/g, "[REDACTED_STELLAR_SEED]");
  return text;
}

/**
 * Detects whether a buffer or string contains raw secret material.
 */
export function containsSecretMaterial(bufferOrText) {
  const text = Buffer.isBuffer(bufferOrText)
    ? bufferOrText.toString("utf8")
    : String(bufferOrText ?? "");
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}

export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Parses `[[bin]]` fuzz target names from `contracts/fuzz/Cargo.toml`.
 */
export function parseCargoFuzzTargets(cargoTomlText) {
  const targets = [];
  const blocks = cargoTomlText.split(/\n\[\[bin\]\]\s*\n/).slice(1);
  for (const block of blocks) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const path = /^path\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (name) {
      targets.push({ name, path: path ?? `fuzz_targets/${name}.rs` });
    }
  }
  return targets;
}

/**
 * Decodes the 12-byte header used by `proposal_input_validation.rs` to verify
 * structural coverage of committed corpus seeds and regression fixtures.
 */
export function decodeProposalInputHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }
  const deadlineSelector = buffer[0];
  const categorySelector = buffer[1];
  const rawDeadline = buffer.readBigUInt64LE(2);
  const descLenHint = buffer.readUInt16LE(10);
  const restLen = buffer.length - 12;
  const effectiveDescLen = Math.min(descLenHint % 601, restLen);
  return {
    deadlineSelector,
    deadlineBranch: deadlineSelector % 10,
    categorySelector,
    categoryBranch: categorySelector % 6,
    rawDeadline: rawDeadline.toString(),
    descLenHint,
    effectiveDescLen,
    categoryBytesLen: restLen - effectiveDescLen,
  };
}

/**
 * Validates the fuzz corpus directory against `manifest.json` and `Cargo.toml`.
 */
export function validateCorpus({
  corpusDir = DEFAULT_CORPUS_DIR,
  cargoTomlPath = DEFAULT_CARGO_TOML,
} = {}) {
  const manifestPath = join(corpusDir, "manifest.json");
  const violations = [];
  const targetSummaries = [];

  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      violations: [
        {
          code: "MANIFEST_MISSING",
          target: "manifest.json",
          caseId: "manifest.json",
          message: "Corpus manifest.json is missing from contracts/fuzz/corpus.",
        },
      ],
      targets: [],
    };
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return {
      ok: false,
      violations: [
        {
          code: "MANIFEST_INVALID_JSON",
          target: "manifest.json",
          caseId: "manifest.json",
          message: `Corpus manifest.json is not valid JSON: ${redactSecrets(err.message)}`,
        },
      ],
      targets: [],
    };
  }

  const policy = {
    minSeedBytes: manifest?.policy?.minSeedBytes ?? 1,
    maxSeedBytes: manifest?.policy?.maxSeedBytes ?? 4096,
    maxFilesPerTarget: manifest?.policy?.maxFilesPerTarget ?? 64,
    requiredRegressionPrefix: manifest?.policy?.requiredRegressionPrefix ?? "regression-",
  };

  const cargoTargets = existsSync(cargoTomlPath)
    ? parseCargoFuzzTargets(readFileSync(cargoTomlPath, "utf8"))
    : Object.keys(manifest?.targets ?? {}).map((name) => ({ name }));

  const manifestTargets = manifest?.targets ?? {};

  for (const { name: targetName } of cargoTargets) {
    if (!manifestTargets[targetName]) {
      violations.push({
        code: "TARGET_UNREGISTERED",
        target: targetName,
        caseId: targetName,
        message: `Fuzz target "${targetName}" from Cargo.toml is missing from corpus/manifest.json.`,
      });
    }
  }

  for (const [targetName, targetMeta] of Object.entries(manifestTargets)) {
    const targetDir = join(corpusDir, targetName);
    const minInputBytes = Math.max(policy.minSeedBytes, targetMeta.minInputBytes ?? 1);
    const expectedRegressions = Array.isArray(targetMeta.regressionFixtures)
      ? targetMeta.regressionFixtures
      : [];

    if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
      violations.push({
        code: "TARGET_DIR_MISSING",
        target: targetName,
        caseId: targetName,
        message: `Corpus directory is missing for target "${targetName}".`,
      });
      continue;
    }

    const entries = readdirSync(targetDir)
      .filter((name) => !name.startsWith("."))
      .sort();

    if (entries.length === 0) {
      violations.push({
        code: "CORPUS_EMPTY",
        target: targetName,
        caseId: targetName,
        message: `Target "${targetName}" has an empty corpus directory.`,
      });
    }

    if (entries.length > policy.maxFilesPerTarget) {
      violations.push({
        code: "CORPUS_FILE_LIMIT_EXCEEDED",
        target: targetName,
        caseId: targetName,
        message: `Target "${targetName}" has ${entries.length} corpus files, exceeding maxFilesPerTarget (${policy.maxFilesPerTarget}). Run minimize first.`,
      });
    }

    const digestToFirstFile = new Map();
    const files = [];
    let regressionCount = 0;

    for (const fileName of entries) {
      const fullPath = join(targetDir, fileName);
      const st = statSync(fullPath);
      if (!st.isFile()) continue;

      const bytes = readFileSync(fullPath);
      const digest = sha256Hex(bytes);
      const isRegression = fileName.startsWith(policy.requiredRegressionPrefix);
      if (isRegression) regressionCount += 1;

      if (bytes.length < minInputBytes) {
        violations.push({
          code: "INPUT_TOO_SMALL",
          target: targetName,
          caseId: fileName,
          digest,
          message: `Case "${targetName}/${fileName}" (${bytes.length} bytes, sha256:${digest.slice(0, 12)}) is smaller than minimum ${minInputBytes} bytes.`,
        });
      }

      if (bytes.length > policy.maxSeedBytes) {
        violations.push({
          code: "INPUT_TOO_LARGE",
          target: targetName,
          caseId: fileName,
          digest,
          message: `Case "${targetName}/${fileName}" (${bytes.length} bytes, sha256:${digest.slice(0, 12)}) exceeds maxSeedBytes (${policy.maxSeedBytes} bytes).`,
        });
      }

      if (containsSecretMaterial(bytes)) {
        violations.push({
          code: "SECRET_DETECTED_IN_CORPUS",
          target: targetName,
          caseId: fileName,
          digest,
          message: `Case "${targetName}/${fileName}" (sha256:${digest.slice(0, 12)}) contains secret-like material and must not be committed [REDACTED].`,
        });
      }

      if (digestToFirstFile.has(digest)) {
        const first = digestToFirstFile.get(digest);
        violations.push({
          code: "DUPLICATE_CORPUS_INPUT",
          target: targetName,
          caseId: fileName,
          digest,
          message: `Case "${targetName}/${fileName}" duplicates "${targetName}/${first}" (sha256:${digest.slice(0, 12)}).`,
        });
      } else {
        digestToFirstFile.set(digest, fileName);
      }

      files.push({
        name: fileName,
        bytes: bytes.length,
        sha256: digest,
        isRegression,
      });
    }

    if (regressionCount === 0) {
      violations.push({
        code: "REGRESSION_FIXTURE_MISSING",
        target: targetName,
        caseId: targetName,
        message: `Target "${targetName}" must include at least one "${policy.requiredRegressionPrefix}*" fixture.`,
      });
    }

    for (const expectedFixture of expectedRegressions) {
      if (!entries.includes(expectedFixture)) {
        violations.push({
          code: "DECLARED_REGRESSION_MISSING",
          target: targetName,
          caseId: expectedFixture,
          message: `Declared regression fixture "${targetName}/${expectedFixture}" is missing from disk.`,
        });
      }
    }

    targetSummaries.push({
      target: targetName,
      totalFiles: files.length,
      regressionFixtures: regressionCount,
      totalBytes: files.reduce((acc, f) => acc + f.bytes, 0),
      minInputBytes,
      files,
    });
  }

  return {
    ok: violations.length === 0,
    policy,
    nightly: manifest?.nightly ?? {},
    targets: targetSummaries,
    violations,
  };
}

/**
 * Deterministically minimizes a corpus directory:
 *  - Drops inputs smaller than `minInputBytes`, larger than `maxSeedBytes`, or containing secrets.
 *  - Deduplicates identical inputs by SHA-256, prioritizing `regression-*` fixtures.
 *  - Enforces `maxFilesPerTarget` by keeping all `regression-*` fixtures and the shortest unique seeds.
 */
export function minimizeCorpus({
  corpusDir = DEFAULT_CORPUS_DIR,
  target = null,
} = {}) {
  const manifestPath = join(corpusDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const policy = {
    minSeedBytes: manifest?.policy?.minSeedBytes ?? 1,
    maxSeedBytes: manifest?.policy?.maxSeedBytes ?? 4096,
    maxFilesPerTarget: manifest?.policy?.maxFilesPerTarget ?? 64,
    requiredRegressionPrefix: manifest?.policy?.requiredRegressionPrefix ?? "regression-",
  };

  const targetEntries = Object.entries(manifest.targets ?? {}).filter(
    ([name]) => !target || name === target,
  );

  const summary = [];

  for (const [targetName, targetMeta] of targetEntries) {
    const targetDir = join(corpusDir, targetName);
    if (!existsSync(targetDir)) continue;

    const minInputBytes = Math.max(policy.minSeedBytes, targetMeta.minInputBytes ?? 1);
    const rawFiles = readdirSync(targetDir)
      .filter((name) => !name.startsWith("."))
      .sort()
      .map((name) => {
        const fullPath = join(targetDir, name);
        const bytes = readFileSync(fullPath);
        return {
          name,
          fullPath,
          bytes,
          length: bytes.length,
          sha256: sha256Hex(bytes),
          isRegression: name.startsWith(policy.requiredRegressionPrefix),
        };
      });

    // Sort: regression fixtures first, then shortest inputs first, then lexicographical name.
    const sorted = [...rawFiles].sort((a, b) => {
      if (a.isRegression !== b.isRegression) return a.isRegression ? -1 : 1;
      if (a.length !== b.length) return a.length - b.length;
      return a.name.localeCompare(b.name);
    });

    const seenDigests = new Set();
    const kept = [];
    const removed = [];

    for (const entry of sorted) {
      const invalidSize =
        entry.length < minInputBytes || entry.length > policy.maxSeedBytes;
      const hasSecret = containsSecretMaterial(entry.bytes);
      const duplicate = seenDigests.has(entry.sha256);
      const overCap = !entry.isRegression && kept.length >= policy.maxFilesPerTarget;

      if (invalidSize || hasSecret || duplicate || overCap) {
        rmSync(entry.fullPath, { force: true });
        removed.push({
          name: entry.name,
          sha256: entry.sha256,
          reason: hasSecret
            ? "secret_redacted"
            : invalidSize
              ? "out_of_bounds_size"
              : duplicate
                ? "duplicate_digest"
                : "max_files_cap",
        });
      } else {
        seenDigests.add(entry.sha256);
        kept.push({
          name: entry.name,
          bytes: entry.length,
          sha256: entry.sha256,
          isRegression: entry.isRegression,
        });
      }
    }

    summary.push({
      target: targetName,
      beforeCount: rawFiles.length,
      afterCount: kept.length,
      removedCount: removed.length,
      kept,
      removed,
    });
  }

  return { ok: true, targets: summary };
}

/**
 * Formats a sanitized crash or invariant failure report without exposing secrets.
 */
export function buildSanitizedCrashReport({
  target,
  inputPath = null,
  inputBytes = null,
  rawOutput = "",
}) {
  const bytes =
    inputBytes ??
    (inputPath && existsSync(inputPath) ? readFileSync(inputPath) : Buffer.alloc(0));
  const digest = sha256Hex(bytes);
  const caseId = inputPath ? basename(inputPath) : `sha256-${digest.slice(0, 16)}`;
  const sanitizedLog = redactSecrets(rawOutput);
  const hasSecretInInput = containsSecretMaterial(bytes);
  const safeHexPreview = hasSecretInInput
    ? "[REDACTED_INPUT_BYTES]"
    : bytes.subarray(0, 32).toString("hex");

  return {
    target,
    caseId,
    sha256: digest,
    byteLength: bytes.length,
    hexPreview32: safeHexPreview,
    inputRedacted: hasSecretInInput,
    summary: `Fuzz target "${target}" failed on case "${caseId}" (${bytes.length} bytes, sha256:${digest.slice(0, 16)})`,
    sanitizedOutput: sanitizedLog,
  };
}

/**
 * Renders a Markdown summary report for CI step summaries and artifacts.
 */
export function renderMarkdownReport(validation) {
  const lines = [
    "# Contract Fuzz Corpus Report",
    "",
    `- **Status:** ${validation.ok ? "PASSED" : "FAILED"}`,
    `- **Targets Verified:** ${validation.targets.length}`,
    `- **Violations:** ${validation.violations.length}`,
    "",
    "## Target Corpus Summary",
    "",
    "| Target | Total Inputs | Regression Fixtures | Total Bytes | Min Bytes |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const t of validation.targets) {
    lines.push(
      `| \`${t.target}\` | ${t.totalFiles} | ${t.regressionFixtures} | ${t.totalBytes} B | ${t.minInputBytes} B |`,
    );
  }

  if (validation.violations.length > 0) {
    lines.push("", "## Offending Cases", "");
    for (const v of validation.violations) {
      lines.push(
        `- **[${v.code}]** target=\`${v.target}\` case=\`${v.caseId}\`: ${redactSecrets(v.message)}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export function writeReports(reportDir, validation) {
  mkdirSync(reportDir, { recursive: true });
  const jsonPath = join(reportDir, "report.json");
  const mdPath = join(reportDir, "report.md");
  writeFileSync(jsonPath, `${JSON.stringify(validation, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, renderMarkdownReport(validation), "utf8");
  return { jsonPath, mdPath };
}

function parseCliArgs(argv) {
  const args = {
    command: "validate",
    corpusDir: DEFAULT_CORPUS_DIR,
    reportDir: null,
    target: null,
    inputPath: null,
    logFile: null,
  };

  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--corpus-dir") {
      args.corpusDir = resolve(argv[(i += 1)]);
    } else if (arg === "--report-dir") {
      args.reportDir = resolve(argv[(i += 1)]);
    } else if (arg === "--target") {
      args.target = argv[(i += 1)];
    } else if (arg === "--input") {
      args.inputPath = resolve(argv[(i += 1)]);
    } else if (arg === "--log-file") {
      args.logFile = resolve(argv[(i += 1)]);
    } else if (!arg.startsWith("-")) {
      positionals.push(arg);
    }
  }
  if (positionals[0]) args.command = positionals[0];
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);

  if (args.command === "minimize") {
    const minResult = minimizeCorpus({
      corpusDir: args.corpusDir,
      target: args.target,
    });
    const validation = validateCorpus({ corpusDir: args.corpusDir });
    if (args.reportDir) {
      writeReports(args.reportDir, { ...validation, minimization: minResult });
    }
    if (!validation.ok) {
      for (const v of validation.violations) {
        console.error(`Fuzz corpus failure [${v.code}] (${v.target}/${v.caseId}): ${redactSecrets(v.message)}`);
      }
      process.exit(1);
    }
    console.log(
      `Fuzz corpus minimized and validated (${validation.targets.length} targets).`,
    );
    return;
  }

  if (args.command === "record-crash") {
    const rawOutput =
      args.logFile && existsSync(args.logFile)
        ? readFileSync(args.logFile, "utf8")
        : "";
    const crash = buildSanitizedCrashReport({
      target: args.target ?? "unknown",
      inputPath: args.inputPath,
      rawOutput,
    });
    if (args.reportDir) {
      mkdirSync(args.reportDir, { recursive: true });
      writeFileSync(
        join(args.reportDir, "crash-report.json"),
        `${JSON.stringify(crash, null, 2)}\n`,
        "utf8",
      );
      writeFileSync(
        join(args.reportDir, "crash-report.md"),
        [
          "# Nightly Contract Fuzz Failure",
          "",
          `- **Target:** \`${crash.target}\``,
          `- **Offending Case:** \`${crash.caseId}\``,
          `- **Input Digest:** \`sha256:${crash.sha256}\``,
          `- **Byte Length:** ${crash.byteLength} B`,
          `- **Hex Preview (first 32B):** \`${crash.hexPreview32}\``,
          "",
          "## Sanitized Output",
          "",
          "```text",
          crash.sanitizedOutput || "(no output captured)",
          "```",
          "",
        ].join("\n"),
        "utf8",
      );
    }
    console.error(crash.summary);
    return;
  }

  const validation = validateCorpus({ corpusDir: args.corpusDir });
  if (args.reportDir) {
    writeReports(args.reportDir, validation);
  }

  if (!validation.ok) {
    for (const v of validation.violations) {
      console.error(
        `Fuzz corpus failure [${v.code}] (${v.target}/${v.caseId}): ${redactSecrets(v.message)}`,
      );
    }
    process.exit(1);
  }

  console.log(
    `Fuzz corpus OK (${validation.targets.length} targets, ${validation.targets.reduce((a, t) => a + t.totalFiles, 0)} inputs).`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
