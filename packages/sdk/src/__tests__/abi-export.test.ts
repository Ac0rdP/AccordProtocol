import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSorobanSpec } from "../abi.js";
import type { ContractAbi } from "../abi.js";
import {
  ABI_ARTIFACT_FORMAT_VERSION,
  abiFingerprint,
  createVersionedAbi,
  diffAbi,
  parseVersionedAbi,
  serializeVersionedAbi,
  versionedAbiFileName,
} from "../abi-export.js";
import { AccordValidationError } from "../errors.js";

const spec = readFileSync(new URL("./fixtures/accord-spec.json", import.meta.url), "utf8");
const abi = parseSorobanSpec(spec);
const versions = { contractVersion: 1, eventSchemaVersion: 2, storageSchemaVersion: 1 };

describe("versioned ABI export", () => {
  it("wraps the ABI with contract versions and a fingerprint", () => {
    const artifact = createVersionedAbi(abi, versions);
    expect(artifact).toMatchObject({
      format: "accord-abi",
      formatVersion: ABI_ARTIFACT_FORMAT_VERSION,
      contract: { name: "accord", ...versions },
    });
    expect(artifact.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(versionedAbiFileName(artifact)).toBe("accord-abi.v1.json");
  });

  it("serializes deterministically and round-trips", () => {
    const artifact = createVersionedAbi(abi, versions);
    const json = serializeVersionedAbi(artifact);
    expect(serializeVersionedAbi(createVersionedAbi(parseSorobanSpec(spec), versions))).toBe(json);
    expect(json.endsWith("\n")).toBe(true);
    expect(parseVersionedAbi(json)).toEqual(parseVersionedAbi(artifact));
  });

  it("fingerprints content, not key order", () => {
    const reordered = JSON.parse(JSON.stringify(abi), (_k, v) =>
      v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v
    ) as ContractAbi;
    expect(abiFingerprint(reordered)).toBe(abiFingerprint(abi));
    const renamed = { ...abi, functions: abi.functions.map((f, i) => (i ? f : { ...f, doc: "changed" })) };
    expect(abiFingerprint(renamed)).not.toBe(abiFingerprint(abi));
  });

  it("rejects invalid export options", () => {
    expect(() => createVersionedAbi(abi, { ...versions, contractVersion: -1 })).toThrow(AccordValidationError);
    expect(() => createVersionedAbi(abi, { ...versions, eventSchemaVersion: 1.5 })).toThrow(/eventSchemaVersion/);
    expect(() => createVersionedAbi(abi, { ...versions, name: "Accord Treasury" })).toThrow(/kebab-case/);
  });

  it("rejects tampered, unknown or malformed artifacts", () => {
    const artifact = JSON.parse(serializeVersionedAbi(createVersionedAbi(abi, versions)));
    const tampered = { ...artifact, abi: { ...artifact.abi, functions: artifact.abi.functions.slice(1) } };
    expect(() => parseVersionedAbi(tampered)).toThrow(/fingerprint/);
    expect(() => parseVersionedAbi({ ...artifact, format: "other" })).toThrow(/format/);
    expect(() => parseVersionedAbi({ ...artifact, formatVersion: ABI_ARTIFACT_FORMAT_VERSION + 1 })).toThrow(
      /upgrade the SDK/
    );
    expect(() => parseVersionedAbi("{not json")).toThrow(/Not valid JSON/);
    expect(() => parseVersionedAbi([])).toThrow(AccordValidationError);
    expect(() => parseVersionedAbi({ ...artifact, abi: undefined })).toThrow(/Missing/);
    expect(() =>
      parseVersionedAbi({ ...artifact, abi: { functions: [{ name: "f" }], types: [] } })
    ).toThrow(AccordValidationError);
  });
});

describe("diffAbi", () => {
  it("treats additions as compatible", () => {
    const next: ContractAbi = {
      ...abi,
      functions: [...abi.functions, { name: "get_new_view", doc: "", inputs: [], outputs: [] }],
    };
    const diff = diffAbi(createVersionedAbi(abi, versions), next);
    expect(diff.addedFunctions).toEqual(["get_new_view"]);
    expect(diff.breaking).toBe(false);
  });

  it("flags removed and changed entries as breaking", () => {
    const [first, ...rest] = abi.functions;
    const next: ContractAbi = {
      functions: rest,
      types: abi.types.map((t, i) => (i === 0 ? { ...t, doc: "changed" } : t)),
    };
    const diff = diffAbi(abi, next);
    expect(diff.removedFunctions).toEqual([first.name]);
    expect(diff.changedTypes).toEqual([abi.types[0].name]);
    expect(diff.breaking).toBe(true);
  });
});
