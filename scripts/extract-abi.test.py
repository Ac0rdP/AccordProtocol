#!/usr/bin/env python3
"""Tests for the ABI compatibility checker (scripts/extract-abi.py).

Covers: success (unchanged ABI), additive changes, breaking changes (removed
function, changed argument type, missing baseline, malformed baseline), version
bump with breaking change, and regression fixtures.
"""

from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXTRACT_SCRIPT = ROOT / "scripts" / "extract-abi.py"
BASELINE_PATH = ROOT / "contracts" / "accord" / "abi-baseline.json"

PASS = 0
FAIL = 0


def check(name: str, condition: bool, detail: str = ""):
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        msg = f"  ✗ {name}"
        if detail:
            msg += f" — {detail}"
        print(msg)


def run_check(baseline_path: str | None = None, extra_args: list[str] | None = None):
    """Run the ABI checker and return (exit_code, stdout, stderr)."""
    cmd = [sys.executable, str(EXTRACT_SCRIPT), "--check"]
    if baseline_path:
        cmd.extend(["--base", baseline_path])
    if extra_args:
        cmd.extend(extra_args)
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=str(ROOT))
    return result.returncode, result.stdout, result.stderr


def test_unchanged_abi():
    """Check passes when ABI matches the baseline."""
    print("\n--- Test: unchanged ABI ---")
    code, stdout, _ = run_check()
    check("exit code is 0", code == 0, f"got {code}")
    check("reports no changes", "no changes detected" in stdout, stdout[:200])


def test_missing_baseline():
    """Check fails loudly when baseline is missing."""
    print("\n--- Test: missing baseline ---")
    code, _, stderr = run_check(baseline_path="/tmp/nonexistent-abi-baseline.json")
    check("exit code is 1", code == 1, f"got {code}")
    check("error mentions missing baseline", "baseline not found" in stderr.lower(), stderr[:200])


def test_malformed_baseline():
    """Check fails on malformed baseline JSON."""
    print("\n--- Test: malformed baseline ---")
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        f.write("{ this is not valid json }")
        f.flush()
        code, _, stderr = run_check(baseline_path=f.name)
    check("exit code is 1", code == 1, f"got {code}")
    check("error mentions malformed", "malformed" in stderr.lower(), stderr[:200])


def test_relative_output_path():
    """Relative output paths are written and reported without crashing."""
    print("\n--- Test: relative output path ---")
    output_exists = False
    with tempfile.TemporaryDirectory(dir=ROOT) as temp_dir:
        output_path = Path(temp_dir) / "abi.json"
        relative_output_path = output_path.relative_to(ROOT)
        result = subprocess.run(
            [
                sys.executable,
                str(EXTRACT_SCRIPT),
                "--output",
                str(relative_output_path),
            ],
            capture_output=True,
            text=True,
            cwd=str(ROOT),
        )
        output_exists = output_path.exists()
    check("exit code is 0", result.returncode == 0, result.stderr[:300])
    check(
        "reports output path",
        "ABI baseline written to" in result.stdout,
        result.stdout[:300],
    )
    check("writes requested output", output_exists)


def test_removed_function():
    """Breaking change: a function is removed without version bump."""
    print("\n--- Test: removed function (breaking) ---")
    baseline = json.loads(BASELINE_PATH.read_text())
    # Remove a function
    removed_fn = baseline["functions"][0]["name"]
    baseline["functions"] = baseline["functions"][1:]
    # We write a modified *current* ABI to check against. But since the checker
    # compares *current source* vs *baseline file*, we instead modify the baseline
    # to have an extra function that doesn't exist in source.
    extra_fn = {
        "name": "zzz_nonexistent_function_removed_regression",
        "args": [{"name": "caller", "type": "Address"}],
        "return_type": "Result<(), ContractError>",
    }
    baseline["functions"].append(extra_fn)
    baseline["functions"].sort(key=lambda f: f["name"])

    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(baseline, f, indent=2)
        f.flush()
        code, stdout, _ = run_check(baseline_path=f.name)
    check("exit code is 1", code == 1, f"got {code}")
    check(
        "names the removed function",
        "zzz_nonexistent_function_removed_regression" in stdout,
        stdout[:300],
    )


def test_changed_argument_type():
    """Breaking change: argument type changed without version bump."""
    print("\n--- Test: changed argument type (breaking) ---")
    baseline = json.loads(BASELINE_PATH.read_text())
    # Modify a function's argument type in the baseline so it mismatches the source
    for fn in baseline["functions"]:
        if fn["args"]:
            original_type = fn["args"][0]["type"]
            fn["args"][0]["type"] = "MODIFIED_TYPE_FOR_TEST"
            fn_name = fn["name"]
            break

    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(baseline, f, indent=2)
        f.flush()
        code, stdout, _ = run_check(baseline_path=f.name)
    check("exit code is 1", code == 1, f"got {code}")
    check(
        "names the offending function",
        fn_name in stdout,
        stdout[:400],
    )
    check("mentions argument change", "argument" in stdout.lower(), stdout[:400])


def test_version_bumped_allows_breaking():
    """Breaking change with version bump passes."""
    print("\n--- Test: version bumped with breaking change ---")
    baseline = json.loads(BASELINE_PATH.read_text())
    # Set baseline to an older version
    baseline["contract_version"] = 0
    # Add a fake function that will appear as "removed" (breaking)
    extra_fn = {
        "name": "zzz_old_version_function",
        "args": [],
    }
    baseline["functions"].append(extra_fn)
    baseline["functions"].sort(key=lambda f: f["name"])

    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(baseline, f, indent=2)
        f.flush()
        code, stdout, _ = run_check(baseline_path=f.name)
    check("exit code is 0", code == 0, f"got {code}")
    check("mentions version bump", "version was bumped" in stdout.lower(), stdout[:400])


def test_additive_change():
    """Additive change (new function) is non-breaking."""
    print("\n--- Test: additive change (new function in source) ---")
    baseline = json.loads(BASELINE_PATH.read_text())
    # Remove a function from the baseline so current source has an "added" one
    if len(baseline["functions"]) > 1:
        removed = baseline["functions"].pop()
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump(baseline, f, indent=2)
            f.flush()
            code, stdout, _ = run_check(baseline_path=f.name)
        check("exit code is 0", code == 0, f"got {code}")
        check("reports additive change", "additive" in stdout.lower(), stdout[:300])
    else:
        check("skip (not enough functions)", False, "need 2+ functions")


def test_regression_fixture_breaking_error_code_change():
    """Regression: changing an error code discriminant is a breaking change."""
    print("\n--- Test: regression — error code discriminant change ---")
    baseline = json.loads(BASELINE_PATH.read_text())
    # Modify an error code discriminant
    for err in baseline["errors"]:
        for variant in err.get("variants", []):
            if "discriminant" in variant:
                variant["discriminant"] = 99999
                modified_name = variant["name"]
                break
        break

    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(baseline, f, indent=2)
        f.flush()
        code, stdout, _ = run_check(baseline_path=f.name)
    check("exit code is 1", code == 1, f"got {code}")
    check(
        "names the error code",
        modified_name in stdout,
        stdout[:400],
    )


def main():
    print("ABI Compatibility Checker Tests")
    print("=" * 50)

    test_unchanged_abi()
    test_missing_baseline()
    test_malformed_baseline()
    test_relative_output_path()
    test_removed_function()
    test_changed_argument_type()
    test_version_bumped_allows_breaking()
    test_additive_change()
    test_regression_fixture_breaking_error_code_change()

    print(f"\n{'=' * 50}")
    print(f"Results: {PASS} passed, {FAIL} failed")
    return 1 if FAIL > 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
