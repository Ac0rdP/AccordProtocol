/**
 * Versioned schema registry for Accord contract events.
 *
 * `catalog.json` describes every event at the *current* schema version. The
 * contract bumps a single global version (`EVENT_SCHEMA_VERSION`, see
 * docs/EVENTS.md) whenever any event changes, so a schema is identified by
 * `(topic, version)`. Older versions are derived by undoing the recorded
 * changes in `SCHEMA_CHANGES`, and events from deployments that predate
 * versioning (no `version` field) get an "unversioned" schema.
 *
 * Adding a version to the contract means: bump `CURRENT_EVENT_SCHEMA_VERSION`,
 * update `catalog.json`, and add a `SCHEMA_CHANGES` entry describing what the
 * bump changed so the previous version stays valid.
 */
import { eventCatalog } from "./catalog.js";

export const CURRENT_EVENT_SCHEMA_VERSION = 2;

/**
 * What each version bump did, newest first. `removed` fields existed before the
 * bump and not after; `added` ones are new in it. Used to reconstruct old versions.
 */
export const SCHEMA_CHANGES = [
  { version: 2, topic: "executed", removed: { transfers: "Vec<Transfer>" } },
];

/** Contract structs referenced by event fields. Anything not listed here is treated as opaque. */
export const KNOWN_TYPES = {
  Transfer: { to: "Address", token: "Address", amount: "i128" },
};

const INTEGER_RANGES = {
  u32: [0n, 2n ** 32n - 1n],
  i32: [-(2n ** 31n), 2n ** 31n - 1n],
  u64: [0n, 2n ** 64n - 1n],
  i64: [-(2n ** 63n), 2n ** 63n - 1n],
  u128: [0n, 2n ** 128n - 1n],
  i128: [-(2n ** 127n), 2n ** 127n - 1n],
};

const ADDRESS = /^(?:[GC][A-Z2-7]{55}|M[A-Z2-7]{68})$/;

/** Version key for events with no `version` field. */
export const UNVERSIONED = null;
export const versionLabel = (version) => (version === UNVERSIONED ? "unversioned" : String(version));

function fieldsAt(topic, version, currentFields, changes) {
  const fields = { ...currentFields };
  for (const change of changes) {
    if (change.topic !== topic || change.version <= version) continue;
    for (const name of Object.keys(change.added ?? {})) delete fields[name];
    Object.assign(fields, change.removed ?? {});
  }
  return fields;
}

/**
 * Builds a registry.
 *
 * @param {object} [options]
 * @param {object} [options.catalog]  topic -> {struct, fields} at the current version
 * @param {number} [options.currentVersion]
 * @param {object[]} [options.changes]  see `SCHEMA_CHANGES`
 */
export function createSchemaRegistry({
  catalog = eventCatalog,
  currentVersion = CURRENT_EVENT_SCHEMA_VERSION,
  changes = SCHEMA_CHANGES,
  types = KNOWN_TYPES,
} = {}) {
  // topic -> Map(version|null -> schema)
  const schemas = new Map();

  function register({ topic, version, struct = null, fields }) {
    if (!topic || typeof topic !== "string") throw new Error("schema topic must be a non-empty string");
    if (version !== UNVERSIONED && !(Number.isSafeInteger(version) && version >= 1)) {
      throw new Error("schema version must be a positive integer or null (unversioned)");
    }
    if (!fields || typeof fields !== "object") throw new Error("schema fields must be an object");
    if (!schemas.has(topic)) schemas.set(topic, new Map());
    schemas.get(topic).set(version, Object.freeze({ topic, version, struct, fields: Object.freeze({ ...fields }) }));
  }

  for (const [topic, definition] of Object.entries(catalog)) {
    for (let version = 1; version <= currentVersion; version += 1) {
      register({ topic, version, struct: definition.struct, fields: fieldsAt(topic, version, definition.fields, changes) });
    }
    // Pre-versioning events carry the first schema's fields minus the `version` marker itself.
    const { version: _marker, ...unversioned } = fieldsAt(topic, 1, definition.fields, changes);
    register({ topic, version: UNVERSIONED, struct: definition.struct, fields: unversioned });
  }

  return {
    currentVersion,
    types,
    register,
    hasTopic: (topic) => schemas.has(topic),
    get: (topic, version) => schemas.get(topic)?.get(version) ?? null,
    topics: () => [...schemas.keys()],
    versions: (topic) => [...(schemas.get(topic)?.keys() ?? [])],
    /** A serialisable view for the `/schemas` endpoint. */
    describe() {
      return [...schemas.entries()].map(([topic, byVersion]) => ({
        topic,
        struct: [...byVersion.values()][0]?.struct ?? null,
        versions: [...byVersion.entries()]
          .sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : a - b))
          .map(([version, schema]) => ({ version: versionLabel(version), current: version === currentVersion, fields: schema.fields })),
      }));
    },
  };
}

function toBigInt(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return null;
}

function checkType(type, value, path, errors, { types, strict }) {
  if (value === undefined) {
    errors.push(`${path}: missing value`);
    return;
  }

  if (INTEGER_RANGES[type]) {
    const integer = toBigInt(value);
    const [min, max] = INTEGER_RANGES[type];
    if (integer === null) errors.push(`${path}: expected ${type}, got ${describe(value)}`);
    else if (integer < min || integer > max) errors.push(`${path}: ${integer} is out of range for ${type}`);
    return;
  }

  switch (type) {
    case "bool":
      if (typeof value !== "boolean") errors.push(`${path}: expected bool, got ${describe(value)}`);
      return;
    case "String":
    case "Symbol":
      if (typeof value !== "string") errors.push(`${path}: expected ${type}, got ${describe(value)}`);
      return;
    case "Address":
      if (typeof value !== "string" || !ADDRESS.test(value)) errors.push(`${path}: expected a Stellar address, got ${describe(value)}`);
      return;
    default:
  }

  const wrapper = type.match(/^(Vec|Option)<(.+)>$/);
  if (wrapper) {
    const [, kind, inner] = wrapper;
    if (kind === "Option") {
      if (value !== null) checkType(inner, value, path, errors, { types, strict });
    } else if (!Array.isArray(value)) {
      errors.push(`${path}: expected ${type}, got ${describe(value)}`);
    } else {
      value.forEach((item, index) => checkType(inner, item, `${path}[${index}]`, errors, { types, strict }));
    }
    return;
  }

  const bytes = type.match(/^BytesN<(\d+)>$/);
  if (bytes) {
    const length = Number(bytes[1]);
    const actual = value instanceof Uint8Array ? value.length : typeof value === "string" && /^[0-9a-fA-F]*$/.test(value) ? value.length / 2 : -1;
    if (actual !== length) errors.push(`${path}: expected ${type}, got ${describe(value)}`);
    return;
  }

  if (types[type]) {
    checkObject(types[type], value, path, errors, { types, strict });
    return;
  }
  // Contract enums and other custom types are not modelled; they only have to be present.
}

function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Uint8Array) return "bytes";
  return typeof value;
}

function checkObject(fields, value, path, errors, context) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) {
    errors.push(`${path || "payload"}: expected an object, got ${describe(value)}`);
    return;
  }
  const prefix = path ? `${path}.` : "";
  for (const [name, type] of Object.entries(fields)) {
    checkType(type, value[name], `${prefix}${name}`, errors, context);
  }
  if (context.strict) {
    for (const name of Object.keys(value)) {
      if (!(name in fields)) errors.push(`${prefix}${name}: unexpected field`);
    }
  }
}

/**
 * Checks a decoded payload against a schema.
 *
 * @returns {string[]} human-readable violations; empty when the payload is valid
 */
export function validatePayload(schema, payload, { types = KNOWN_TYPES, strict = true } = {}) {
  const errors = [];
  checkObject(schema.fields, payload, "", errors, { types, strict });
  if (errors.length === 0 && schema.version !== UNVERSIONED && toBigInt(payload.version) !== BigInt(schema.version)) {
    errors.push(`version: expected ${schema.version}`);
  }
  return errors;
}

export const defaultRegistry = createSchemaRegistry();
