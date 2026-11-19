/**
 * Versioned ABI JSON artifact for Accord Protocol.
 * Wraps a `ContractAbi` (see `abi.ts`) with the contract, event-schema and
 * storage-schema versions it was built from, plus a content fingerprint, and
 * serializes it deterministically so the artifact can be committed, diffed and
 * published for tooling and code generation (`npm run abi:export`).
 *
 * Dependency-free so it tree-shakes away from `AccordClient`.
 */

import { validateAbi } from "./abi.js";
import type { AbiFunction, AbiTypeDef, ContractAbi } from "./abi.js";
import { AccordValidationError } from "./errors.js";

/** Identifies the artifact format; bump `ABI_ARTIFACT_FORMAT_VERSION` on shape changes. */
export const ABI_ARTIFACT_FORMAT = "accord-abi";
export const ABI_ARTIFACT_FORMAT_VERSION = 1;

/** Versions of the deployed contract that the ABI was extracted from. */
export interface AbiContractVersions {
  /** `get_version` / `CONTRACT_VERSION`. */
  contractVersion: number;
  /** `EVENT_SCHEMA_VERSION`, carried on every event payload. */
  eventSchemaVersion: number;
  /** `get_storage_version` / `STORAGE_SCHEMA_VERSION`. */
  storageSchemaVersion: number;
}

export interface AbiExportOptions extends AbiContractVersions {
  /** Contract name recorded in the artifact (default: "accord"). */
  name?: string;
}

export interface VersionedAbi {
  format: typeof ABI_ARTIFACT_FORMAT;
  formatVersion: number;
  contract: AbiContractVersions & { name: string };
  /** FNV-1a (32-bit, hex) of the canonical ABI JSON; changes iff the ABI changes. */
  fingerprint: string;
  abi: ContractAbi;
}

function requireVersion(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new AccordValidationError(field, "Expected a non-negative integer.");
  }
  return value as number;
}

/** JSON with object keys sorted at every level; arrays keep their order. */
function canonicalJson(value: unknown, indent?: number): string {
  return JSON.stringify(
    value,
    (_key, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
        : v,
    indent
  );
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Fingerprint of an ABI, independent of key order in the source spec. */
export function abiFingerprint(abi: ContractAbi): string {
  return fnv1a(canonicalJson(abi));
}

/** Builds a versioned artifact from a parsed ABI (see `parseSorobanSpec`). */
export function createVersionedAbi(abi: ContractAbi, options: AbiExportOptions): VersionedAbi {
  validateAbi(abi);
  const name = options.name ?? "accord";
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new AccordValidationError("name", `'${name}' must be lowercase kebab-case.`);
  }
  return {
    format: ABI_ARTIFACT_FORMAT,
    formatVersion: ABI_ARTIFACT_FORMAT_VERSION,
    contract: {
      name,
      contractVersion: requireVersion(options.contractVersion, "contractVersion"),
      eventSchemaVersion: requireVersion(options.eventSchemaVersion, "eventSchemaVersion"),
      storageSchemaVersion: requireVersion(options.storageSchemaVersion, "storageSchemaVersion"),
    },
    fingerprint: abiFingerprint(abi),
    abi,
  };
}

/** Deterministic, pretty-printed JSON for committing or publishing. */
export function serializeVersionedAbi(artifact: VersionedAbi): string {
  return `${canonicalJson(artifact, 2)}\n`;
}

/** File name for an artifact, e.g. `accord-abi.v1.json`. */
export function versionedAbiFileName(artifact: VersionedAbi): string {
  return `${artifact.contract.name}-abi.v${artifact.contract.contractVersion}.json`;
}

/**
 * Parses and verifies a published artifact. Rejects unknown formats, newer
 * format versions, invalid ABIs and fingerprint mismatches (hand-edited files).
 */
export function parseVersionedAbi(input: unknown): VersionedAbi {
  let doc: unknown = input;
  if (typeof input === "string") {
    try {
      doc = JSON.parse(input);
    } catch (err) {
      throw new AccordValidationError("artifact", `Not valid JSON: ${(err as Error).message}`);
    }
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new AccordValidationError("artifact", "Expected a JSON object.");
  }
  const raw = doc as Record<string, unknown>;
  if (raw.format !== ABI_ARTIFACT_FORMAT) {
    throw new AccordValidationError("format", `Expected '${ABI_ARTIFACT_FORMAT}'.`);
  }
  const formatVersion = requireVersion(raw.formatVersion, "formatVersion");
  if (formatVersion > ABI_ARTIFACT_FORMAT_VERSION) {
    throw new AccordValidationError(
      "formatVersion",
      `Artifact format v${formatVersion} is newer than supported v${ABI_ARTIFACT_FORMAT_VERSION}; upgrade the SDK.`
    );
  }
  const contract = raw.contract as Record<string, unknown> | undefined;
  const abi = raw.abi as ContractAbi | undefined;
  if (!contract || typeof contract !== "object" || !abi || !Array.isArray(abi.functions) || !Array.isArray(abi.types)) {
    throw new AccordValidationError("artifact", "Missing 'contract' or 'abi' section.");
  }

  let artifact: VersionedAbi;
  try {
    artifact = createVersionedAbi(abi, {
      name: contract.name as string,
      contractVersion: contract.contractVersion as number,
      eventSchemaVersion: contract.eventSchemaVersion as number,
      storageSchemaVersion: contract.storageSchemaVersion as number,
    });
  } catch (err) {
    if (err instanceof AccordValidationError) throw err;
    throw new AccordValidationError("abi", `Malformed ABI: ${(err as Error).message}`);
  }
  if (raw.fingerprint !== artifact.fingerprint) {
    throw new AccordValidationError(
      "fingerprint",
      `Expected ${artifact.fingerprint}, got ${String(raw.fingerprint)}; the ABI was modified after export.`
    );
  }
  return artifact;
}

export interface AbiDiff {
  addedFunctions: string[];
  removedFunctions: string[];
  changedFunctions: string[];
  addedTypes: string[];
  removedTypes: string[];
  changedTypes: string[];
  /** True when anything was removed or changed; additions alone are compatible. */
  breaking: boolean;
}

function diffByName<T extends AbiFunction | AbiTypeDef>(before: T[], after: T[]) {
  const prev = new Map(before.map((e) => [e.name, canonicalJson(e)]));
  const next = new Map(after.map((e) => [e.name, canonicalJson(e)]));
  return {
    added: [...next.keys()].filter((n) => !prev.has(n)).sort(),
    removed: [...prev.keys()].filter((n) => !next.has(n)).sort(),
    changed: [...next.keys()].filter((n) => prev.has(n) && prev.get(n) !== next.get(n)).sort(),
  };
}

/** Compares two ABIs (or artifacts) to decide whether a release is breaking. */
export function diffAbi(before: ContractAbi | VersionedAbi, after: ContractAbi | VersionedAbi): AbiDiff {
  const a = "abi" in before ? before.abi : before;
  const b = "abi" in after ? after.abi : after;
  const fns = diffByName(a.functions, b.functions);
  const types = diffByName(a.types, b.types);
  return {
    addedFunctions: fns.added,
    removedFunctions: fns.removed,
    changedFunctions: fns.changed,
    addedTypes: types.added,
    removedTypes: types.removed,
    changedTypes: types.changed,
    breaking: fns.removed.length + fns.changed.length + types.removed.length + types.changed.length > 0,
  };
}
