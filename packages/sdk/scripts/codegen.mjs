#!/usr/bin/env node
// Generates typed clients in other languages from the Accord contract ABI.
//
//   stellar contract info interface --wasm accord.wasm --output json > accord-spec.json
//   npm run build
//   node scripts/codegen.mjs --spec=accord-spec.json --out=generated --lang=python,go
//
// Options: --client=<PascalName> (default AccordContractClient),
//          --package=<go package> (default accord).

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

const { generateClients, parseSorobanSpec, SUPPORTED_LANGUAGES } = await import(entry).catch((err) => {
  console.error(`Cannot load ${relative(root, entry)}; run \`npm run build\` first.\n${err.message}`);
  process.exit(2);
});

try {
  const abi = parseSorobanSpec(readFileSync(resolve(option("spec")), "utf8"));
  const languages = option("lang", SUPPORTED_LANGUAGES.join(",")).split(",").filter(Boolean);
  const outDir = resolve(option("out", "generated"));
  const clients = generateClients(abi, languages, {
    clientName: option("client", "AccordContractClient"),
    packageName: option("package", "accord"),
  });

  mkdirSync(outDir, { recursive: true });
  for (const client of clients) {
    const file = join(outDir, client.fileName);
    writeFileSync(file, client.source);
    console.log(`${client.language}: ${file}`);
  }
} catch (err) {
  console.error(`codegen failed: ${err.message}`);
  process.exitCode = 1;
}
