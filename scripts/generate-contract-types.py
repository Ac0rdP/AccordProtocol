#!/usr/bin/env python3
"""Generate TypeScript contract types from the Accord Soroban interface.

The contract's Rust source (``contracts/accord/src/lib.rs``) is the single
source of truth for the on-chain data model. This script extracts every
``#[contracttype]`` struct/enum plus the ``#[contracterror]`` enum and emits
``frontend/src/types/contract.generated.ts``.

Keeping the generated file checked in means the frontend can import the
contract types without a Rust toolchain, while CI verifies that the file is
not stale:

    python3 scripts/generate-contract-types.py
    git diff --exit-code -- frontend/src/types/contract.generated.ts

Run the regeneration command after changing any ``#[contracttype]`` or
``#[contracterror]`` definition (see docs/CONTRACT_TYPES.md).
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTRACT_SRC = ROOT / "contracts" / "accord" / "src" / "lib.rs"
OUTPUT = ROOT / "frontend" / "src" / "types" / "contract.generated.ts"

HEADER = """// AUTO-GENERATED FILE - DO NOT EDIT BY HAND.
//
// Source: contracts/accord/src/lib.rs
// Regenerate with: python3 scripts/generate-contract-types.py
//
// CI runs the generator and fails if this file is out of date. Do not edit
// this file directly; change the contract definition instead.

"""

# Rust primitive -> TypeScript mapping. i128/u128 are bigint because Soroban
# token amounts routinely exceed Number.MAX_SAFE_INTEGER.
PRIMITIVES = {
    "u8": "number",
    "u16": "number",
    "u32": "number",
    "u64": "number",
    "usize": "number",
    "i8": "number",
    "i16": "number",
    "i32": "number",
    "i64": "bigint",
    "i128": "bigint",
    "i256": "bigint",
    "u128": "bigint",
    "u256": "bigint",
    "bool": "boolean",
    "String": "string",
    "Address": "string",
    "Symbol": "string",
    "Bytes": "string",
}


def strip_comments(text: str) -> str:
    """Remove Rust line comments that sit outside string literals.

    The contract has no string literals inside contracttype definitions, so a
    line-oriented strip is sufficient and keeps the parser simple.
    """
    lines = []
    for line in text.splitlines():
        stripped = line.lstrip()
        if stripped.startswith("//"):
            continue
        lines.append(line)
    return "\n".join(lines)


def split_top_level(value: str, separator: str = ",") -> list[str]:
    """Split on ``separator`` while respecting nested angle/bracket depth."""
    parts: list[str] = []
    depth = 0
    current: list[str] = []
    for char in value:
        if char in "<([":
            depth += 1
        elif char in ">)]":
            depth -= 1
        if char == separator and depth == 0:
            parts.append("".join(current).strip())
            current = []
        else:
            current.append(char)
    tail = "".join(current).strip()
    if tail:
        parts.append(tail)
    return parts


def extract_blocks(source: str, attribute: str) -> list[tuple[str, str, str]]:
    """Return (kind, name, body) for annotated ``pub struct``/``pub enum``."""
    pattern = re.compile(
        r"#\[" + re.escape(attribute) + r"\]\s*"
        r"(?:#\[[^\]]*\]\s*)*"
        r"pub\s+(struct|enum)\s+(\w+)\s*\{",
        re.MULTILINE,
    )
    blocks: list[tuple[str, str, str]] = []
    for match in pattern.finditer(source):
        kind, name = match.group(1), match.group(2)
        index = match.end()
        depth = 1
        while index < len(source) and depth:
            if source[index] == "{":
                depth += 1
            elif source[index] == "}":
                depth -= 1
            index += 1
        body = source[match.end() : index - 1]
        blocks.append((kind, name, body))
    return blocks


def map_type(rust_type: str, known: set[str]) -> str:
    rust_type = rust_type.strip()

    if not rust_type:
        return "never"

    # Option<T> -> T | null
    option = re.fullmatch(r"Option\s*<(.+)>", rust_type, re.DOTALL)
    if option:
        return f"{map_type(option.group(1), known)} | null"

    # Vec<T> -> T[]
    vec = re.fullmatch(r"Vec\s*<(.+)>", rust_type, re.DOTALL)
    if vec:
        inner = map_type(vec.group(1), known)
        return f"({inner})[]" if "|" in inner else f"{inner}[]"

    # Map<K, V> -> Record<string, V>
    mapping = re.fullmatch(r"Map\s*<(.+),\s*(.+)>", rust_type, re.DOTALL)
    if mapping:
        return f"Record<string, {map_type(mapping.group(2), known)}>"

    # BytesN<32> and friends are returned by the SDK as base64 strings.
    if re.fullmatch(r"BytesN\s*<.+>", rust_type):
        return "string"

    # Tuples -> fixed-length tuples.
    if rust_type.startswith("(") and rust_type.endswith(")"):
        inner = rust_type[1:-1]
        return "[" + ", ".join(map_type(part, known) for part in split_top_level(inner)) + "]"

    if rust_type in PRIMITIVES:
        return PRIMITIVES[rust_type]

    if rust_type in known:
        return f"Contract{rust_type}"

    # Arrays such as [u8; 32] are not used in the interface today.
    if rust_type.startswith("[") and rust_type.endswith("]"):
        return "number[]"

    return "unknown"


def parse_struct(body: str) -> list[tuple[str, str]]:
    fields: list[tuple[str, str]] = []
    for line in strip_comments(body).splitlines():
        line = line.strip().rstrip(",")
        match = re.match(r"pub\s+(\w+)\s*:\s*(.+)", line)
        if match:
            fields.append((match.group(1), match.group(2).strip()))
    return fields


def parse_enum(body: str) -> list[tuple[str, list[str] | None, int | None]]:
    """Return (variant, payload_types, discriminant)."""
    variants: list[tuple[str, list[str] | None, int | None]] = []
    for line in strip_comments(body).splitlines():
        line = line.strip().rstrip(",")
        match = re.match(r"(\w+)\s*=\s*(\d+)", line)
        if match:
            variants.append((match.group(1), None, int(match.group(2))))
            continue
        match = re.match(r"(\w+)\s*(?:\((.*)\))?", line)
        if match:
            payload = None
            if match.group(2) is not None:
                payload = split_top_level(match.group(2)) if match.group(2).strip() else []
            variants.append((match.group(1), payload, None))
    return variants


def render_union(name: str, variants: list[str], indent: str = "") -> str:
    joined = " | ".join(f'"{variant}"' for variant in variants)
    if len(f'export type {name} = {joined};') <= 88:
        return f"export type {name} = {joined};"
    lines = [f"export type {name} ="]
    for index, variant in enumerate(variants):
        suffix = ";" if index == len(variants) - 1 else ""
        lines.append(f'  | "{variant}"{suffix}')
    return "\n".join(lines)


def generate() -> str:
    source = CONTRACT_SRC.read_text(encoding="utf-8")
    contract_types = extract_blocks(source, "contracttype")
    error_types = extract_blocks(source, "contracterror")

    known = {name for _, name, _ in contract_types + error_types}

    chunks: list[str] = [HEADER.rstrip()]

    for kind, name, body in contract_types:
        ts_name = "ContractError" if name == "ContractError" else f"Contract{name}"
        if kind == "struct":
            fields = parse_struct(body)
            lines = [f"export type {ts_name} = {{"]
            for field_name, rust_type in fields:
                lines.append(f"  {field_name}: {map_type(rust_type, known)};")
            lines.append("};")
            chunks.append("\n".join(lines))
        else:
            variants = parse_enum(body)
            simple = [variant for variant, payload, _ in variants if payload is None]
            if all(payload is None for _, payload, _ in variants):
                chunks.append(render_union(ts_name, simple))
            else:
                lines = [f"export type {ts_name} ="]
                for index, (variant, payload, _) in enumerate(variants):
                    suffix = ";" if index == len(variants) - 1 else ""
                    if payload is None:
                        lines.append(f'  | {{ {variant}: true }}{suffix}')
                    elif len(payload) == 1:
                        lines.append(
                            f"  | {{ {variant}: {map_type(payload[0], known)} }}{suffix}"
                        )
                    else:
                        mapped = ", ".join(map_type(part, known) for part in payload)
                        lines.append(f"  | {{ {variant}: [{mapped}] }}{suffix}")
                chunks.append("\n".join(lines))

    for _, name, body in error_types:
        variants = parse_enum(body)
        ts_name = "ContractError" if name == "ContractError" else f"Contract{name}"
        lines = [f"export enum {ts_name} {{"]
        for variant, _, discriminant in variants:
            lines.append(f"  {variant} = {discriminant},")
        lines.append("}")
        chunks.append("\n".join(lines))

    return "\n\n".join(chunks) + "\n"


def main() -> int:
    if not CONTRACT_SRC.exists():
        print(f"Contract source not found: {CONTRACT_SRC}", file=sys.stderr)
        return 1

    generated = generate()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(generated, encoding="utf-8")
    print(f"Wrote {OUTPUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
