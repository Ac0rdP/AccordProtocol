/**
 * Contract ABI model for Accord Protocol
 * Normalizes the Soroban contract spec (as emitted by
 * `stellar contract info interface --output json`) into a language-neutral
 * shape that the code generators in `codegen.ts` consume.
 *
 * This module has no runtime dependencies so it tree-shakes independently of
 * `AccordClient` and `@stellar/stellar-sdk`.
 */

import { AccordValidationError } from "./errors.js";

export const ABI_PRIMITIVES = [
  "bool",
  "void",
  "error",
  "u32",
  "i32",
  "u64",
  "i64",
  "timepoint",
  "duration",
  "u128",
  "i128",
  "u256",
  "i256",
  "bytes",
  "string",
  "symbol",
  "address",
  "muxed_address",
  "val",
] as const;

export type AbiPrimitive = (typeof ABI_PRIMITIVES)[number];

export type AbiType =
  | { kind: "primitive"; name: AbiPrimitive }
  | { kind: "vec"; element: AbiType }
  | { kind: "option"; value: AbiType }
  | { kind: "map"; key: AbiType; value: AbiType }
  | { kind: "tuple"; elements: AbiType[] }
  | { kind: "bytesN"; size: number }
  | { kind: "result"; ok: AbiType; error: AbiType }
  | { kind: "udt"; name: string };

export interface AbiParam {
  name: string;
  doc: string;
  type: AbiType;
}

export interface AbiFunction {
  name: string;
  doc: string;
  inputs: AbiParam[];
  /** Soroban functions return at most one value; an empty list means `void`. */
  outputs: AbiType[];
}

export interface AbiStruct {
  kind: "struct";
  name: string;
  doc: string;
  fields: AbiParam[];
}

export interface AbiUnionCase {
  name: string;
  doc: string;
  /** Empty for unit cases (`void_v0`). */
  values: AbiType[];
}

export interface AbiUnion {
  kind: "union";
  name: string;
  doc: string;
  cases: AbiUnionCase[];
}

export interface AbiEnumCase {
  name: string;
  doc: string;
  value: number;
}

export interface AbiEnum {
  kind: "enum" | "errorEnum";
  name: string;
  doc: string;
  cases: AbiEnumCase[];
}

export type AbiTypeDef = AbiStruct | AbiUnion | AbiEnum;

export interface ContractAbi {
  functions: AbiFunction[];
  types: AbiTypeDef[];
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Tuple structs (`struct Foo(u32, u32)`) expose positional field names.
const FIELD_NAME = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+)$/;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new AccordValidationError(path, "Expected a string.");
  }
  return value;
}

function name(value: unknown, path: string, pattern = IDENTIFIER): string {
  const s = str(value, path);
  if (!pattern.test(s)) {
    throw new AccordValidationError(path, `'${s}' is not a valid identifier.`);
  }
  return s;
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new AccordValidationError(path, "Expected an array.");
  }
  return value;
}

/** Returns the single `{ tag: body }` pair of an externally-tagged spec value. */
function tagged(value: unknown, path: string): [string, unknown] {
  if (!isObject(value)) {
    throw new AccordValidationError(path, "Expected a tagged object.");
  }
  const keys = Object.keys(value);
  if (keys.length !== 1) {
    throw new AccordValidationError(path, `Expected exactly one tag, got ${keys.length}.`);
  }
  return [keys[0], value[keys[0]]];
}

function doc(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Parses a single spec type, e.g. `"u32"`, `{ "vec": { "element_type": "address" } }`
 * or `{ "udt": { "name": "Proposal" } }`.
 */
export function parseAbiType(value: unknown, path = "type"): AbiType {
  if (typeof value === "string") {
    if ((ABI_PRIMITIVES as readonly string[]).includes(value)) {
      return { kind: "primitive", name: value as AbiPrimitive };
    }
    throw new AccordValidationError(path, `Unknown primitive type '${value}'.`);
  }

  const [tag, body] = tagged(value, path);
  if (!isObject(body)) {
    throw new AccordValidationError(`${path}.${tag}`, "Expected an object body.");
  }

  switch (tag) {
    case "vec":
      return { kind: "vec", element: parseAbiType(body.element_type, `${path}.vec.element_type`) };
    case "option":
      return { kind: "option", value: parseAbiType(body.value_type, `${path}.option.value_type`) };
    case "map":
      return {
        kind: "map",
        key: parseAbiType(body.key_type, `${path}.map.key_type`),
        value: parseAbiType(body.value_type, `${path}.map.value_type`),
      };
    case "tuple":
      return {
        kind: "tuple",
        elements: list(body.value_types, `${path}.tuple.value_types`).map((t, i) =>
          parseAbiType(t, `${path}.tuple.value_types[${i}]`)
        ),
      };
    case "bytes_n": {
      const size = body.n;
      if (!Number.isInteger(size) || (size as number) < 1) {
        throw new AccordValidationError(`${path}.bytes_n.n`, "Expected a positive integer.");
      }
      return { kind: "bytesN", size: size as number };
    }
    case "result":
      return {
        kind: "result",
        ok: parseAbiType(body.ok_type, `${path}.result.ok_type`),
        error: parseAbiType(body.error_type, `${path}.result.error_type`),
      };
    case "udt":
      return { kind: "udt", name: name(body.name, `${path}.udt.name`) };
    default:
      throw new AccordValidationError(path, `Unknown type tag '${tag}'.`);
  }
}

function parseParams(value: unknown, path: string, pattern = IDENTIFIER): AbiParam[] {
  return list(value, path).map((raw, i) => {
    const p = `${path}[${i}]`;
    if (!isObject(raw)) throw new AccordValidationError(p, "Expected an object.");
    return {
      name: name(raw.name, `${p}.name`, pattern),
      doc: doc(raw.doc),
      type: parseAbiType(raw.type_, `${p}.type_`),
    };
  });
}

function parseEnumCases(value: unknown, path: string): AbiEnumCase[] {
  return list(value, path).map((raw, i) => {
    const p = `${path}[${i}]`;
    if (!isObject(raw)) throw new AccordValidationError(p, "Expected an object.");
    if (!Number.isInteger(raw.value) || (raw.value as number) < 0) {
      throw new AccordValidationError(`${p}.value`, "Expected a non-negative integer.");
    }
    return { name: name(raw.name, `${p}.name`), doc: doc(raw.doc), value: raw.value as number };
  });
}

function parseUnionCases(value: unknown, path: string): AbiUnionCase[] {
  return list(value, path).map((raw, i) => {
    const p = `${path}[${i}]`;
    const [tag, body] = tagged(raw, p);
    if (!isObject(body)) throw new AccordValidationError(`${p}.${tag}`, "Expected an object.");
    if (tag === "void_v0") {
      return { name: name(body.name, `${p}.void_v0.name`), doc: doc(body.doc), values: [] };
    }
    if (tag === "tuple_v0") {
      return {
        name: name(body.name, `${p}.tuple_v0.name`),
        doc: doc(body.doc),
        values: list(body.type_, `${p}.tuple_v0.type_`).map((t, j) =>
          parseAbiType(t, `${p}.tuple_v0.type_[${j}]`)
        ),
      };
    }
    throw new AccordValidationError(p, `Unknown union case tag '${tag}'.`);
  });
}

function collectUdtRefs(type: AbiType, out: Set<string>): void {
  switch (type.kind) {
    case "udt":
      out.add(type.name);
      return;
    case "vec":
      return collectUdtRefs(type.element, out);
    case "option":
      return collectUdtRefs(type.value, out);
    case "map":
      collectUdtRefs(type.key, out);
      return collectUdtRefs(type.value, out);
    case "tuple":
      return type.elements.forEach((t) => collectUdtRefs(t, out));
    case "result":
      collectUdtRefs(type.ok, out);
      return collectUdtRefs(type.error, out);
    default:
      return;
  }
}

/**
 * Checks cross-entry invariants: unique names and that every `udt` reference
 * resolves to a declared type. Throws `AccordValidationError` on the first problem.
 */
export function validateAbi(abi: ContractAbi): void {
  const seenFns = new Set<string>();
  for (const fn of abi.functions) {
    if (seenFns.has(fn.name)) {
      throw new AccordValidationError("functions", `Duplicate function '${fn.name}'.`);
    }
    seenFns.add(fn.name);
    if (fn.outputs.length > 1) {
      throw new AccordValidationError(`functions.${fn.name}`, "Soroban functions return at most one value.");
    }
  }

  const declared = new Set<string>();
  for (const t of abi.types) {
    if (declared.has(t.name)) {
      throw new AccordValidationError("types", `Duplicate type '${t.name}'.`);
    }
    declared.add(t.name);
  }

  const refs = new Set<string>();
  for (const fn of abi.functions) {
    fn.inputs.forEach((p) => collectUdtRefs(p.type, refs));
    fn.outputs.forEach((t) => collectUdtRefs(t, refs));
  }
  for (const t of abi.types) {
    if (t.kind === "struct") t.fields.forEach((f) => collectUdtRefs(f.type, refs));
    if (t.kind === "union") t.cases.forEach((c) => c.values.forEach((v) => collectUdtRefs(v, refs)));
  }
  for (const ref of refs) {
    if (!declared.has(ref)) {
      throw new AccordValidationError("types", `Type '${ref}' is referenced but never declared.`);
    }
  }
}

/**
 * Parses a Soroban contract spec into a validated `ContractAbi`.
 *
 * Accepts either the JSON array produced by
 * `stellar contract info interface --wasm accord.wasm --output json`
 * or that same JSON as a string. Entry kinds that do not affect the client
 * surface (for example `event_v0`) are ignored.
 */
export function parseSorobanSpec(spec: unknown): ContractAbi {
  let entries: unknown = spec;
  if (typeof spec === "string") {
    try {
      entries = JSON.parse(spec);
    } catch (err) {
      throw new AccordValidationError("spec", `Spec is not valid JSON: ${(err as Error).message}`);
    }
  }

  const abi: ContractAbi = { functions: [], types: [] };
  list(entries, "spec").forEach((entry, i) => {
    const path = `spec[${i}]`;
    const [tag, body] = tagged(entry, path);
    if (!isObject(body)) throw new AccordValidationError(`${path}.${tag}`, "Expected an object.");
    const p = `${path}.${tag}`;

    switch (tag) {
      case "function_v0":
        abi.functions.push({
          name: name(body.name, `${p}.name`),
          doc: doc(body.doc),
          inputs: parseParams(body.inputs, `${p}.inputs`),
          outputs: list(body.outputs, `${p}.outputs`).map((t, j) => parseAbiType(t, `${p}.outputs[${j}]`)),
        });
        return;
      case "udt_struct_v0":
        abi.types.push({
          kind: "struct",
          name: name(body.name, `${p}.name`),
          doc: doc(body.doc),
          fields: parseParams(body.fields, `${p}.fields`, FIELD_NAME),
        });
        return;
      case "udt_union_v0":
        abi.types.push({
          kind: "union",
          name: name(body.name, `${p}.name`),
          doc: doc(body.doc),
          cases: parseUnionCases(body.cases, `${p}.cases`),
        });
        return;
      case "udt_enum_v0":
      case "udt_error_enum_v0":
        abi.types.push({
          kind: tag === "udt_enum_v0" ? "enum" : "errorEnum",
          name: name(body.name, `${p}.name`),
          doc: doc(body.doc),
          cases: parseEnumCases(body.cases, `${p}.cases`),
        });
        return;
      default:
        // Events and future spec entry kinds do not change the callable surface.
        return;
    }
  });

  validateAbi(abi);
  return abi;
}
