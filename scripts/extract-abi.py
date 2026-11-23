#!/usr/bin/env python3
"""Extract a deterministic ABI snapshot from the Accord Soroban contract.

The contract's Rust source (``contracts/accord/src/lib.rs``) is the single
source of truth for the on-chain ABI. This script extracts:

  - All public contract functions (name, arguments with types, return type)
  - All ``#[contracttype]`` struct and enum definitions (fields/variants/types)
  - All ``#[contracterror]`` error codes (name and discriminant)
  - The ``CONTRACT_VERSION`` constant

Output is a deterministic JSON snapshot (sorted keys, stable ordering) that
can be compared across commits to detect ABI changes.

Usage:
    python3 scripts/extract-abi.py                         # write baseline
    python3 scripts/extract-abi.py --check                 # compare with baseline
    python3 scripts/extract-abi.py --check --base FILE     # compare with a specific file
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTRACT_SRC = ROOT / "contracts" / "accord" / "src" / "lib.rs"
CARGO_TOML = ROOT / "contracts" / "accord" / "Cargo.toml"
DEFAULT_BASELINE = ROOT / "contracts" / "accord" / "abi-baseline.json"


def strip_doc_comments(text: str) -> str:
    """Remove Rust doc and line comments."""
    lines = []
    for line in text.splitlines():
        stripped = line.lstrip()
        if stripped.startswith("//"):
            continue
        lines.append(line)
    return "\n".join(lines)


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


def parse_struct_fields(body: str) -> list[dict]:
    """Extract struct fields as [{name, type}]."""
    fields = []
    for line in strip_doc_comments(body).splitlines():
        line = line.strip().rstrip(",")
        m = re.match(r"pub\s+(\w+)\s*:\s*(.+)", line)
        if m:
            fields.append({"name": m.group(1), "type": m.group(2).strip()})
    return fields


def parse_enum_variants(body: str) -> list[dict]:
    """Extract enum variants as [{name, payload?, discriminant?}]."""
    variants = []
    for line in strip_doc_comments(body).splitlines():
        line = line.strip().rstrip(",")
        if not line:
            continue
        # Discriminant form: Name = 42
        m = re.match(r"(\w+)\s*=\s*(\d+)", line)
        if m:
            variants.append({"name": m.group(1), "discriminant": int(m.group(2))})
            continue
        # Variant with payload: Name(Type1, Type2)
        m = re.match(r"(\w+)\s*\((.+)\)", line)
        if m:
            payload = [p.strip() for p in split_top_level(m.group(2))]
            variants.append({"name": m.group(1), "payload": payload})
            continue
        # Simple variant: Name
        m = re.match(r"(\w+)$", line)
        if m:
            variants.append({"name": m.group(1)})
    return variants


def split_top_level(value: str, separator: str = ",") -> list[str]:
    """Split on separator while respecting nested angle/bracket depth."""
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


def extract_contract_functions(source: str) -> list[dict]:
    """Extract public contract functions from the #[contractimpl] block."""
    functions = []

    # Find all pub fn inside the contractimpl block
    # Pattern: pub fn name(args) -> ReturnType {
    fn_pattern = re.compile(
        r"pub\s+fn\s+(\w+)\s*\((.*?)\)\s*(?:->\s*(.*?))?\s*\{",
        re.DOTALL,
    )

    # We need to find the contractimpl block first
    impl_start = source.find("#[contractimpl]")
    if impl_start == -1:
        return functions

    # Find the impl block opening brace
    impl_block_start = source.find("{", source.find("impl ", impl_start))
    if impl_block_start == -1:
        return functions

    # Find matching closing brace
    depth = 1
    idx = impl_block_start + 1
    while idx < len(source) and depth > 0:
        if source[idx] == "{":
            depth += 1
        elif source[idx] == "}":
            depth -= 1
        idx += 1
    impl_block = source[impl_block_start:idx]

    for m in fn_pattern.finditer(impl_block):
        name = m.group(1)
        raw_args = m.group(2).strip()
        return_type = m.group(3).strip() if m.group(3) else None

        # Parse arguments, skip env: Env and &self
        args = []
        for arg in split_top_level(raw_args):
            arg = arg.strip()
            if not arg or arg == "env: Env" or arg.startswith("&"):
                continue
            # Parse name: Type
            am = re.match(r"(?:mut\s+)?(\w+)\s*:\s*(.+)", arg)
            if am:
                args.append({"name": am.group(1), "type": am.group(2).strip()})

        fn_entry: dict = {"name": name, "args": args}
        if return_type:
            fn_entry["return_type"] = return_type
        functions.append(fn_entry)

    # Sort by function name for deterministic output
    functions.sort(key=lambda f: f["name"])
    return functions


def extract_contract_version(source: str) -> int | None:
    """Extract the CONTRACT_VERSION constant."""
    m = re.search(r"const\s+CONTRACT_VERSION\s*:\s*u32\s*=\s*(\d+)\s*;", source)
    if m:
        return int(m.group(1))
    return None


def extract_package_version(cargo_toml_path: Path) -> str | None:
    """Extract the package version from Cargo.toml."""
    if not cargo_toml_path.exists():
        return None
    text = cargo_toml_path.read_text(encoding="utf-8")
    m = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
    if m:
        return m.group(1)
    return None


def generate_abi(source: str) -> dict:
    """Generate the full ABI snapshot."""
    contract_types = extract_blocks(source, "contracttype")
    error_types = extract_blocks(source, "contracterror")

    types = []
    for kind, name, body in sorted(contract_types, key=lambda x: x[1]):
        entry: dict = {"name": name, "kind": kind}
        if kind == "struct":
            entry["fields"] = parse_struct_fields(body)
        else:
            entry["variants"] = parse_enum_variants(body)
        types.append(entry)

    errors = []
    for _, name, body in sorted(error_types, key=lambda x: x[1]):
        entry = {"name": name, "variants": parse_enum_variants(body)}
        errors.append(entry)

    functions = extract_contract_functions(source)
    contract_version = extract_contract_version(source)
    package_version = extract_package_version(CARGO_TOML)

    abi: dict = {
        "schema_version": 1,
        "contract_version": contract_version,
        "package_version": package_version,
        "functions": functions,
        "types": types,
        "errors": errors,
    }
    return abi


def classify_changes(baseline: dict, current: dict) -> tuple[list[str], list[str], bool]:
    """Compare two ABI snapshots and classify changes.

    Returns (breaking_changes, additive_changes, version_bumped).
    """
    breaking: list[str] = []
    additive: list[str] = []

    # Check version bump
    old_ver = baseline.get("contract_version")
    new_ver = current.get("contract_version")
    version_bumped = old_ver is not None and new_ver is not None and new_ver > old_ver

    old_pkg = baseline.get("package_version")
    new_pkg = current.get("package_version")
    pkg_bumped = old_pkg is not None and new_pkg is not None and old_pkg != new_pkg
    version_bumped = version_bumped or pkg_bumped

    # --- Functions ---
    old_fns = {f["name"]: f for f in baseline.get("functions", [])}
    new_fns = {f["name"]: f for f in current.get("functions", [])}

    for name in sorted(old_fns):
        if name not in new_fns:
            breaking.append(f"Function removed: {name}")
        else:
            old_f = old_fns[name]
            new_f = new_fns[name]
            # Compare argument types
            old_args = [(a["name"], a["type"]) for a in old_f.get("args", [])]
            new_args = [(a["name"], a["type"]) for a in new_f.get("args", [])]
            if old_args != new_args:
                breaking.append(
                    f"Function '{name}': argument types changed: "
                    f"{old_args} -> {new_args}"
                )
            # Compare return type
            old_ret = old_f.get("return_type")
            new_ret = new_f.get("return_type")
            if old_ret != new_ret:
                breaking.append(
                    f"Function '{name}': return type changed: "
                    f"{old_ret} -> {new_ret}"
                )

    for name in sorted(new_fns):
        if name not in old_fns:
            additive.append(f"Function added: {name}")

    # --- Types ---
    old_types = {t["name"]: t for t in baseline.get("types", [])}
    new_types = {t["name"]: t for t in current.get("types", [])}

    for name in sorted(old_types):
        if name not in new_types:
            breaking.append(f"Type removed: {name}")
        else:
            old_t = old_types[name]
            new_t = new_types[name]
            if old_t["kind"] != new_t["kind"]:
                breaking.append(
                    f"Type '{name}': kind changed from {old_t['kind']} to {new_t['kind']}"
                )
            elif old_t["kind"] == "struct":
                old_fields = old_t.get("fields", [])
                new_fields = new_t.get("fields", [])
                if old_fields != new_fields:
                    breaking.append(
                        f"Type '{name}' (struct): fields changed"
                    )
            else:
                old_variants = old_t.get("variants", [])
                new_variants = new_t.get("variants", [])
                if old_variants != new_variants:
                    # Check if it's purely additive
                    old_names = [v["name"] for v in old_variants]
                    new_names = [v["name"] for v in new_variants]
                    removed = set(old_names) - set(new_names)
                    if removed:
                        breaking.append(
                            f"Type '{name}' (enum): variants removed: {sorted(removed)}"
                        )
                    else:
                        # Check if existing variant shapes changed
                        old_by_name = {v["name"]: v for v in old_variants}
                        changed = False
                        for v in new_variants:
                            if v["name"] in old_by_name and v != old_by_name[v["name"]]:
                                changed = True
                                break
                        if changed:
                            breaking.append(
                                f"Type '{name}' (enum): variant shape changed"
                            )
                        else:
                            added = set(new_names) - set(old_names)
                            additive.append(
                                f"Type '{name}' (enum): variants added: {sorted(added)}"
                            )

    for name in sorted(new_types):
        if name not in old_types:
            additive.append(f"Type added: {name}")

    # --- Errors ---
    old_errs = {e["name"]: e for e in baseline.get("errors", [])}
    new_errs = {e["name"]: e for e in current.get("errors", [])}

    for name in sorted(old_errs):
        if name not in new_errs:
            breaking.append(f"Error type removed: {name}")
        else:
            old_e = old_errs[name]
            new_e = new_errs[name]
            old_variants = old_e.get("variants", [])
            new_variants = new_e.get("variants", [])
            old_by_name = {v["name"]: v for v in old_variants}
            new_by_name = {v["name"]: v for v in new_variants}
            for vname in sorted(old_by_name):
                if vname not in new_by_name:
                    breaking.append(f"Error '{name}': code removed: {vname}")
                elif old_by_name[vname] != new_by_name[vname]:
                    breaking.append(
                        f"Error '{name}': code '{vname}' changed: "
                        f"{old_by_name[vname]} -> {new_by_name[vname]}"
                    )
            for vname in sorted(new_by_name):
                if vname not in old_by_name:
                    additive.append(f"Error '{name}': code added: {vname}")

    for name in sorted(new_errs):
        if name not in old_errs:
            additive.append(f"Error type added: {name}")

    return breaking, additive, version_bumped


def main() -> int:
    parser = argparse.ArgumentParser(description="Accord ABI compatibility checker")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Compare current ABI against the baseline and report changes",
    )
    parser.add_argument(
        "--base",
        type=str,
        default=None,
        help="Path to the baseline ABI file (default: contracts/accord/abi-baseline.json)",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Path to write the current ABI snapshot (default: contracts/accord/abi-baseline.json)",
    )
    args = parser.parse_args()

    if not CONTRACT_SRC.exists():
        print(f"ERROR: Contract source not found: {CONTRACT_SRC}", file=sys.stderr)
        return 1

    source = CONTRACT_SRC.read_text(encoding="utf-8")
    current_abi = generate_abi(source)

    if not args.check:
        output_path = Path(args.output) if args.output else DEFAULT_BASELINE
        if not output_path.is_absolute():
            output_path = ROOT / output_path
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(
            json.dumps(current_abi, indent=2, sort_keys=False) + "\n",
            encoding="utf-8",
        )
        try:
            display_path = output_path.relative_to(ROOT)
        except ValueError:
            display_path = output_path
        print(f"ABI baseline written to {display_path}")
        print(f"  Functions: {len(current_abi['functions'])}")
        print(f"  Types: {len(current_abi['types'])}")
        print(f"  Errors: {len(current_abi['errors'])}")
        print(f"  Contract version: {current_abi['contract_version']}")
        return 0

    # Check mode
    baseline_path = Path(args.base) if args.base else DEFAULT_BASELINE
    if not baseline_path.exists():
        print(
            f"ERROR: ABI baseline not found at {baseline_path}. "
            "Run 'python3 scripts/extract-abi.py' to generate it.",
            file=sys.stderr,
        )
        return 1

    try:
        baseline_text = baseline_path.read_text(encoding="utf-8")
        baseline_abi = json.loads(baseline_text)
    except (json.JSONDecodeError, ValueError) as exc:
        print(
            f"ERROR: Malformed ABI baseline at {baseline_path}: {exc}",
            file=sys.stderr,
        )
        return 1

    if baseline_abi.get("schema_version") != 1:
        print(
            f"ERROR: Unsupported ABI baseline schema version: "
            f"{baseline_abi.get('schema_version')}",
            file=sys.stderr,
        )
        return 1

    breaking, additive, version_bumped = classify_changes(baseline_abi, current_abi)

    if not breaking and not additive:
        print("ABI check passed: no changes detected.")
        return 0

    if additive:
        print("Additive ABI changes (non-breaking):")
        for change in additive:
            print(f"  + {change}")
        print()

    if breaking:
        print("BREAKING ABI changes detected:")
        for change in breaking:
            print(f"  ! {change}")
        print()

        if version_bumped:
            print(
                "Version was bumped "
                f"({baseline_abi.get('contract_version')} -> {current_abi.get('contract_version')}, "
                f"pkg {baseline_abi.get('package_version')} -> {current_abi.get('package_version')}). "
                "Breaking changes are allowed with a version bump."
            )
            print(
                "ACTION REQUIRED: Update the ABI baseline with "
                "'python3 scripts/extract-abi.py' and commit it."
            )
            return 0
        else:
            print(
                "ERROR: Breaking ABI changes without a version bump. "
                "Either bump CONTRACT_VERSION in contracts/accord/src/lib.rs "
                "(or the package version in contracts/accord/Cargo.toml), "
                "or revert the breaking change."
            )
            return 1

    # Additive only
    print(
        "Additive changes detected. Update the ABI baseline with "
        "'python3 scripts/extract-abi.py' and commit it."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
