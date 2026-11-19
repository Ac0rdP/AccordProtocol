/**
 * Multi-language Client Code Generation for Accord Protocol
 * Emits typed client bindings for additional languages from the same contract
 * ABI (see `abi.ts`) that backs the TypeScript SDK.
 *
 * Generated clients are transport-agnostic: they own the typed method surface,
 * argument names and ordering, and the data model, and delegate the actual
 * Soroban invocation to a caller-supplied `Invoker`. That keeps signing and
 * RPC concerns (and secrets) in the host application, matching `AccordClient`.
 */

import { validateAbi } from "./abi.js";
import type { AbiParam, AbiType, AbiTypeDef, ContractAbi } from "./abi.js";
import { AccordValidationError } from "./errors.js";

export const SUPPORTED_LANGUAGES = ["python", "go", "rust"] as const;

export type CodegenLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export interface CodegenOptions {
  language: CodegenLanguage;
  /** Name of the generated client class/struct. Defaults to `AccordContractClient`. */
  clientName?: string;
  /** Go package name. Defaults to `accord`. Ignored for other languages. */
  packageName?: string;
}

export interface GeneratedClient {
  language: CodegenLanguage;
  fileName: string;
  source: string;
}

const GENERATED_BY = "@accord-protocol/sdk codegen";

const PYTHON_RESERVED = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
  "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global",
  "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise",
  "return", "self", "try", "while", "with", "yield",
]);

const GO_RESERVED = new Set([
  "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough",
  "for", "func", "go", "goto", "if", "import", "interface", "map", "package", "range",
  "return", "select", "struct", "switch", "type", "var",
]);

const RUST_RESERVED = new Set([
  "as", "break", "const", "continue", "crate", "else", "enum", "extern", "false", "fn",
  "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub",
  "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true",
  "type", "unsafe", "use", "where", "while", "async", "await", "dyn",
]);

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

function pascal(name: string): string {
  return words(name)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

function camel(name: string): string {
  const p = pascal(name);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

function snake(name: string): string {
  return words(name)
    .map((w) => w.toLowerCase())
    .join("_");
}

// ─── Python ──────────────────────────────────────────────────────────────────

function pyIdent(name: string): string {
  const id = /^[0-9]/.test(name) ? `field_${name}` : name;
  return PYTHON_RESERVED.has(id) ? `${id}_` : id;
}

function pyType(type: AbiType): string {
  switch (type.kind) {
    case "primitive":
      switch (type.name) {
        case "bool":
          return "bool";
        case "void":
          return "None";
        case "bytes":
          return "bytes";
        case "string":
        case "symbol":
        case "address":
        case "muxed_address":
          return "str";
        case "val":
        case "error":
          return "Any";
        default:
          return "int";
      }
    case "vec":
      return `List[${pyType(type.element)}]`;
    case "option":
      return `Optional[${pyType(type.value)}]`;
    case "map":
      return `Dict[${pyType(type.key)}, ${pyType(type.value)}]`;
    case "tuple":
      return type.elements.length === 0 ? "Tuple[()]" : `Tuple[${type.elements.map(pyType).join(", ")}]`;
    case "bytesN":
      return "bytes";
    case "result":
      return pyType(type.ok);
    case "udt":
      return type.name;
  }
}

function pyDoc(text: string, indent: string): string[] {
  if (!text) return [];
  const safe = text.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
  const lines = safe.split("\n");
  if (lines.length === 1) return [`${indent}"""${lines[0]}"""`];
  return [`${indent}"""${lines[0]}`, ...lines.slice(1).map((l) => (l ? `${indent}${l}` : "")), `${indent}"""`];
}

function pyTypeDef(def: AbiTypeDef): string[] {
  const out: string[] = [];
  if (def.kind === "struct") {
    out.push("@dataclass", `class ${def.name}:`);
    out.push(...pyDoc(def.doc, "    "));
    if (def.fields.length === 0) out.push("    pass");
    for (const f of def.fields) out.push(`    ${pyIdent(f.name)}: ${pyType(f.type)}`);
  } else if (def.kind === "union") {
    out.push("@dataclass(frozen=True)", `class ${def.name}:`);
    out.push(...pyDoc(def.doc || `Tagged union; \`tag\` is one of ${def.name}.TAGS.`, "    "));
    out.push(`    TAGS: ClassVar[Tuple[str, ...]] = (${def.cases.map((c) => JSON.stringify(c.name)).join(", ")}${def.cases.length === 1 ? "," : ""})`);
    out.push("    tag: str", "    values: Tuple[Any, ...] = ()");
  } else {
    out.push(`class ${def.name}(IntEnum):`);
    out.push(...pyDoc(def.doc, "    "));
    if (def.cases.length === 0) out.push("    pass");
    for (const c of def.cases) out.push(`    ${pyIdent(c.name)} = ${c.value}`);
  }
  return out;
}

function generatePython(abi: ContractAbi, clientName: string): string {
  const lines: string[] = [
    `# Code generated by ${GENERATED_BY}. DO NOT EDIT.`,
    "#",
    "# Typed Accord contract bindings. Transport, signing and XDR decoding are",
    "# delegated to the Invoker you pass to the client constructor.",
    "",
    "from __future__ import annotations",
    "",
    "from dataclasses import dataclass",
    "from enum import IntEnum",
    "from typing import Any, ClassVar, Dict, List, Optional, Protocol, Tuple",
    "",
    "",
    "class Invoker(Protocol):",
    '    """Submits or simulates a contract call and returns the decoded result."""',
    "",
    "    def invoke(self, method: str, args: List[Tuple[str, Any]]) -> Any: ...",
  ];

  for (const def of abi.types) {
    lines.push("", "", ...pyTypeDef(def));
  }

  lines.push("", "", `class ${clientName}:`);
  lines.push("    def __init__(self, invoker: Invoker) -> None:", "        self._invoker = invoker");
  for (const fn of abi.functions) {
    const params = fn.inputs.map((p) => `${pyIdent(p.name)}: ${pyType(p.type)}`);
    const ret = fn.outputs.length ? pyType(fn.outputs[0]) : "None";
    const args = fn.inputs.map((p) => `(${JSON.stringify(p.name)}, ${pyIdent(p.name)})`).join(", ");
    const call = `self._invoker.invoke(${JSON.stringify(fn.name)}, [${args}])`;
    lines.push("", `    def ${pyIdent(fn.name)}(${["self", ...params].join(", ")}) -> ${ret}:`);
    lines.push(...pyDoc(fn.doc, "        "));
    lines.push(ret === "None" ? `        ${call}` : `        return ${call}`);
  }

  return `${lines.join("\n")}\n`;
}

// ─── Go ──────────────────────────────────────────────────────────────────────

interface GoContext {
  usesBig: boolean;
  usesFmt: boolean;
}

function goField(name: string): string {
  return /^[0-9]/.test(name) ? `F${name}` : pascal(name);
}

function goParam(name: string): string {
  const id = camel(name);
  return GO_RESERVED.has(id) ? `${id}_` : id;
}

function goType(type: AbiType, ctx: GoContext): string {
  switch (type.kind) {
    case "primitive":
      switch (type.name) {
        case "bool":
          return "bool";
        case "u32":
          return "uint32";
        case "i32":
          return "int32";
        case "u64":
        case "timepoint":
        case "duration":
          return "uint64";
        case "i64":
          return "int64";
        case "u128":
        case "i128":
        case "u256":
        case "i256":
          ctx.usesBig = true;
          return "*big.Int";
        case "bytes":
          return "[]byte";
        case "string":
        case "symbol":
        case "address":
        case "muxed_address":
          return "string";
        default:
          return "any";
      }
    case "vec":
      return `[]${goType(type.element, ctx)}`;
    case "option":
      return `*${goType(type.value, ctx)}`;
    case "map":
      return `map[${goType(type.key, ctx)}]${goType(type.value, ctx)}`;
    case "tuple":
      return `struct{ ${type.elements.map((e, i) => `F${i} ${goType(e, ctx)}`).join("; ")} }`;
    case "bytesN":
      return `[${type.size}]byte`;
    case "result":
      return goType(type.ok, ctx);
    case "udt":
      return type.name;
  }
}

/** Pads every column but the last to a common width, as gofmt does for a block. */
function goAlign(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.slice(0, -1).forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  }
  return rows.map((row) => `\t${row.map((cell, i) => (i < row.length - 1 ? cell.padEnd(widths[i]) : cell)).join(" ")}`);
}

function goDoc(text: string, indent = ""): string[] {
  return text ? text.split("\n").map((l) => `${indent}//${l ? ` ${l}` : ""}`) : [];
}

function goTypeDef(def: AbiTypeDef, ctx: GoContext): string[] {
  const out: string[] = [...goDoc(def.doc)];
  if (def.kind === "struct") {
    out.push(`type ${def.name} struct {`);
    out.push(...goAlign(def.fields.map((f) => [goField(f.name), goType(f.type, ctx), `\`json:"${f.name}"\``])));
    out.push("}");
  } else if (def.kind === "union") {
    if (!def.doc) out.push(`// ${def.name} is a tagged union; Tag is one of the ${def.name}* constants.`);
    out.push(`type ${def.name} struct {`, "\tTag    string", "\tValues []any", "}", "", "const (");
    out.push(...goAlign(def.cases.map((c) => [`${def.name}${pascal(c.name)}`, `= ${JSON.stringify(c.name)}`])));
    out.push(")");
  } else {
    out.push(`type ${def.name} uint32`, "", "const (");
    out.push(...goAlign(def.cases.map((c) => [`${def.name}${pascal(c.name)}`, `${def.name} = ${c.value}`])));
    out.push(")");
    if (def.kind === "errorEnum") {
      ctx.usesFmt = true;
      const names = `${camel(def.name)}Names`;
      out.push("", `var ${names} = map[${def.name}]string{`);
      out.push(...goAlign(def.cases.map((c) => [`${def.name}${pascal(c.name)}:`, `${JSON.stringify(c.name)},`])));
      out.push("}", "");
      out.push(`func (e ${def.name}) Error() string {`);
      out.push(`\tif name, ok := ${names}[e]; ok {`, `\t\treturn fmt.Sprintf("%s (#%d)", name, uint32(e))`, "\t}");
      out.push(`\treturn fmt.Sprintf("${def.name}(#%d)", uint32(e))`, "}");
    }
  }
  return out;
}

function goArgs(inputs: AbiParam[]): string {
  return `[]Arg{${inputs.map((p) => `{${JSON.stringify(p.name)}, ${goParam(p.name)}}`).join(", ")}}`;
}

function generateGo(abi: ContractAbi, clientName: string, packageName: string): string {
  const ctx: GoContext = { usesBig: false, usesFmt: false };
  const body: string[] = [];

  for (const def of abi.types) body.push("", ...goTypeDef(def, ctx));

  body.push("", `// ${clientName} exposes every contract function as a typed method.`);
  body.push(`type ${clientName} struct {`, "\tinvoker Invoker", "}", "");
  body.push(`func New${clientName}(invoker Invoker) *${clientName} {`, `\treturn &${clientName}{invoker: invoker}`, "}");

  for (const fn of abi.functions) {
    const params = fn.inputs.map((p) => `${goParam(p.name)} ${goType(p.type, ctx)}`).join(", ");
    const method = pascal(fn.name);
    body.push("", ...goDoc(fn.doc));
    // Contract errors surface through the Invoker's error, so Result<T, E> is just T.
    let out = fn.outputs[0];
    while (out?.kind === "result") out = out.ok;
    if (!out || (out.kind === "primitive" && out.name === "void")) {
      body.push(`func (c *${clientName}) ${method}(${params}) error {`);
      body.push(`\treturn c.invoker.Invoke(${JSON.stringify(fn.name)}, ${goArgs(fn.inputs)}, nil)`, "}");
    } else {
      body.push(`func (c *${clientName}) ${method}(${params}) (${goType(out, ctx)}, error) {`);
      body.push(`\tvar out ${goType(out, ctx)}`);
      body.push(`\terr := c.invoker.Invoke(${JSON.stringify(fn.name)}, ${goArgs(fn.inputs)}, &out)`);
      body.push("\treturn out, err", "}");
    }
  }

  const imports = [ctx.usesFmt && '"fmt"', ctx.usesBig && '"math/big"'].filter(Boolean) as string[];
  const header = [
    `// Code generated by ${GENERATED_BY}. DO NOT EDIT.`,
    "",
    `// Package ${packageName} contains typed Accord contract bindings. Transport,`,
    "// signing and XDR decoding are delegated to the Invoker passed to the client.",
    `package ${packageName}`,
  ];
  if (imports.length === 1) header.push("", `import ${imports[0]}`);
  if (imports.length > 1) header.push("", "import (", ...imports.map((i) => `\t${i}`), ")");
  header.push(
    "",
    "// Arg is a named contract argument, in declaration order.",
    "type Arg struct {",
    "\tName  string",
    "\tValue any",
    "}",
    "",
    "// Invoker submits or simulates a contract call and decodes the result into out",
    "// (a pointer to the declared return type, or nil for functions returning nothing).",
    "type Invoker interface {",
    "\tInvoke(method string, args []Arg, out any) error",
    "}"
  );

  return `${[...header, ...body].join("\n")}\n`;
}

// ─── Rust ────────────────────────────────────────────────────────────────────

function rustIdent(name: string): string {
  const id = snake(name);
  return RUST_RESERVED.has(id) ? `r#${id}` : id;
}

function rustType(type: AbiType): string {
  switch (type.kind) {
    case "primitive":
      switch (type.name) {
        case "bool":
          return "bool";
        case "u32":
          return "u32";
        case "i32":
          return "i32";
        case "u64":
        case "timepoint":
        case "duration":
          return "u64";
        case "i64":
          return "i64";
        case "u128":
          return "u128";
        case "i128":
          return "i128";
        case "u256":
        case "i256":
          return "[u8; 32]";
        case "bytes":
          return "Vec<u8>";
        case "string":
        case "symbol":
        case "address":
        case "muxed_address":
          return "String";
        default:
          return "serde_json::Value";
      }
    case "vec":
      return `Vec<${rustType(type.element)}>`;
    case "option":
      return `Option<${rustType(type.value)}>`;
    case "map":
      return `std::collections::BTreeMap<${rustType(type.key)}, ${rustType(type.value)}>`;
    case "tuple":
      return type.elements.length === 0 ? "()" : `(${type.elements.map(rustType).join(", ")})`;
    case "bytesN":
      return `[u8; ${type.size}]`;
    case "result":
      return rustType(type.ok);
    case "udt":
      return type.name;
  }
}

function rustDoc(text: string, indent = ""): string[] {
  return text ? text.split("\n").map((l) => `${indent}///${l ? ` ${l}` : ""}`) : [];
}

function rustTypeDef(def: AbiTypeDef): string[] {
  const out: string[] = [...rustDoc(def.doc)];
  if (def.kind === "struct") {
    out.push("#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]");
    out.push(`pub struct ${def.name} {`);
    for (const f of def.fields) {
      out.push(...rustDoc(f.doc, "    "));
      out.push(`    pub ${rustIdent(f.name)}: ${rustType(f.type)},`);
    }
    out.push("}");
  } else if (def.kind === "union") {
    out.push("#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]");
    out.push("#[serde(tag = \"tag\", content = \"values\")]");
    out.push(`pub enum ${def.name} {`);
    for (const c of def.cases) {
      out.push(...rustDoc(c.doc, "    "));
      out.push(`    ${pascal(c.name)},`);
    }
    out.push("}");
  } else {
    out.push("#[derive(Copy, Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]");
    out.push("#[repr(u32)]");
    out.push(`pub enum ${def.name} {`);
    for (const c of def.cases) {
      out.push(...rustDoc(c.doc, "    "));
      out.push(`    ${pascal(c.name)} = ${c.value},`);
    }
    out.push("}");
    if (def.kind === "errorEnum") {
      out.push("", `impl std::fmt::Display for ${def.name} {`);
      out.push("    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {");
      out.push("        write!(f, \"{:?} ({})\", self, *self as u32)");
      out.push("    }", "}");
      out.push(`impl std::error::Error for ${def.name} {}`);
    }
  }
  return out;
}

function generateRust(abi: ContractAbi, clientName: string): string {
  const body: string[] = [];
  for (const def of abi.types) {
    body.push("", ...rustTypeDef(def));
  }

  body.push("", `/// ${clientName} wraps contract invocations with typed methods.`);
  body.push(`pub struct ${clientName}<I: Invoker> {`, "    invoker: I,", "}");
  body.push("", `impl<I: Invoker> ${clientName}<I> {`);
  body.push(`    pub fn new(invoker: I) -> Self {`, "        Self { invoker }", "    }");

  for (const fn of abi.functions) {
    const params = fn.inputs.map((p) => `${rustIdent(p.name)}: ${rustType(p.type)}`).join(", ");
    let out = fn.outputs[0];
    while (out?.kind === "result") out = out.ok;
    const isVoid = !out || (out.kind === "primitive" && out.name === "void");
    const retType = isVoid ? "Result<(), Box<dyn std::error::Error>>" : `Result<${rustType(out)}, Box<dyn std::error::Error>>`;
    const argList = fn.inputs.map((p) => `(${JSON.stringify(p.name)}, serde_json::to_value(&${rustIdent(p.name)})?)`).join(", ");

    body.push("", ...rustDoc(fn.doc, "    "));
    body.push(`    pub fn ${snake(fn.name)}(&self${params ? `, ${params}` : ""}) -> ${retType} {`);
    body.push(`        self.invoker.invoke(${JSON.stringify(fn.name)}, &[${argList}])`);
    body.push("    }");
  }
  body.push("}");

  const header = [
    `// Code generated by ${GENERATED_BY}. DO NOT EDIT.`,
    "//",
    "// Typed Accord contract bindings for Rust.",
    "",
    "pub trait Invoker {",
    "    fn invoke<T: serde::de::DeserializeOwned>(&self, method: &str, args: &[(&str, serde_json::Value)]) -> Result<T, Box<dyn std::error::Error>>;",
    "}",
  ];

  return `${[...header, ...body].join("\n")}\n`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Generates a typed client for `options.language` from a parsed contract ABI.
 *
 * @throws AccordValidationError for unsupported languages, invalid names, or an
 *   ABI that references undeclared types.
 */
export function generateClient(abi: ContractAbi, options: CodegenOptions): GeneratedClient {
  const language = options?.language;
  if (!(SUPPORTED_LANGUAGES as readonly string[]).includes(language)) {
    throw new AccordValidationError(
      "language",
      `Unsupported language '${String(language)}'. Expected one of: ${SUPPORTED_LANGUAGES.join(", ")}.`
    );
  }

  const clientName = options.clientName ?? "AccordContractClient";
  if (!/^[A-Z][A-Za-z0-9]*$/.test(clientName)) {
    throw new AccordValidationError("clientName", "Client name must be a PascalCase identifier.");
  }
  const reserved = new Set(["Invoker", "Arg", ...abi.types.map((t) => t.name)]);
  if (reserved.has(clientName)) {
    throw new AccordValidationError("clientName", `Client name '${clientName}' collides with a generated type.`);
  }

  validateAbi(abi);

  if (language === "python") {
    return { language, fileName: `${snake(clientName)}.py`, source: generatePython(abi, clientName) };
  }

  if (language === "rust") {
    return { language, fileName: `${snake(clientName)}.rs`, source: generateRust(abi, clientName) };
  }

  const packageName = options.packageName ?? "accord";
  if (!/^[a-z][a-z0-9]*$/.test(packageName) || GO_RESERVED.has(packageName)) {
    throw new AccordValidationError("packageName", "Go package name must be a lowercase identifier.");
  }
  return { language, fileName: `${snake(clientName)}.go`, source: generateGo(abi, clientName, packageName) };
}

/** Generates a typed Python client from a parsed contract ABI. */
export function generatePythonClient(
  abi: ContractAbi,
  options?: Omit<CodegenOptions, "language">
): GeneratedClient {
  return generateClient(abi, { ...options, language: "python" });
}

/** Generates a typed Go client from a parsed contract ABI. */
export function generateGoClient(
  abi: ContractAbi,
  options?: Omit<CodegenOptions, "language">
): GeneratedClient {
  return generateClient(abi, { ...options, language: "go" });
}

/** Generates a typed Rust client from a parsed contract ABI. */
export function generateRustClient(
  abi: ContractAbi,
  options?: Omit<CodegenOptions, "language">
): GeneratedClient {
  return generateClient(abi, { ...options, language: "rust" });
}

/** Generates clients for several languages at once (defaults to all supported). */
export function generateClients(
  abi: ContractAbi,
  languages: readonly CodegenLanguage[] = SUPPORTED_LANGUAGES,
  options: Omit<CodegenOptions, "language"> = {}
): GeneratedClient[] {
  return languages.map((language) => generateClient(abi, { ...options, language }));
}
