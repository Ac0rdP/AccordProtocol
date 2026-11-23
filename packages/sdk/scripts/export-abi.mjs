#!/usr/bin/env node
// Writes a versioned ABI JSON artifact (accord-abi.v<contractVersion>.json).
//
//   stellar contract info interface --wasm accord.wasm --output json > accord-spec.json
//   npm run build
//   node scripts/export-abi.mjs --spec=accord-spec.json --contract-version=1 \
//     --event-schema=2 --storage-schema=1 --out=abi
//
// Options: --name=<kebab-case> (default accord),
//          --previous=<artifact.json> prints a diff and, on breaking changes
//          without a --contract-version bump, exits 1 without writing.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(root, "dist/esm/index.js");

function option(name, fallback) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (arg) return arg.slice(name.length + 3);
  if (fallback === undefined) {
    console.error(`missing required option --${name}=`);
    process.exit(2);
  }
  return fallback;
}

const { createVersionedAbi, diffAbi, parseSorobanSpec, parseVersionedAbi, serializeVersionedAbi, versionedAbiFileName } =
  await import(entry).catch((err) => {
    console.error(`Cannot load ${relative(root, entry)}; run \`npm run build\` first.\n${err.message}`);
    process.exit(2);
  });

try {
  const artifact = createVersionedAbi(parseSorobanSpec(readFileSync(resolve(option("spec")), "utf8")), {
    name: option("name", "accord"),
    contractVersion: Number(option("contract-version")),
    eventSchemaVersion: Number(option("event-schema")),
    storageSchemaVersion: Number(option("storage-schema")),
  });

  const previousPath = option("previous", "");
  if (previousPath) {
    const previous = parseVersionedAbi(readFileSync(resolve(previousPath), "utf8"));
    const diff = diffAbi(previous, artifact);
    console.log(JSON.stringify(diff, null, 2));
    if (diff.breaking && artifact.contract.contractVersion <= previous.contract.contractVersion) {
      throw new Error("breaking ABI change without a --contract-version bump; nothing written");
    }
  }

  const outDir = resolve(option("out", "abi"));
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, versionedAbiFileName(artifact));
  writeFileSync(file, serializeVersionedAbi(artifact));
  console.log(`${artifact.fingerprint}: ${file}`);
} catch (err) {
  console.error(`abi export failed: ${err.message}`);
  process.exitCode = 1;
}
