#!/usr/bin/env python3
"""Tests for generate-release-notes.py.

Scenarios tested:
  1. All labels present (mapping to proper categories)
  2. No labels (falling back to conventional commits or 'Other Changes')
  3. Conventional commits only (without PR labels)
  4. Breaking changes (via label, ! in subject, or BREAKING CHANGE in body)
  5. Empty range / no items
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "generate-release-notes.py"

# Import generate-release-notes as a module
spec = importlib.util.spec_from_file_location("generate_release_notes", SCRIPT_PATH)
gen_notes = importlib.util.module_from_spec(spec)
sys.modules["generate_release_notes"] = gen_notes
spec.loader.exec_module(gen_notes)

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


def test_scenario_all_labels_present():
    print("\n--- Test Scenario 1: All labels present ---")
    items = [
        {"title": "Upgrade contract storage layout", "labels": ["contract"], "pr_number": 101},
        {"title": "Add wallet switcher UI", "labels": ["frontend"], "pr_number": 102},
        {"title": "Mitigate reentrancy edge case", "labels": ["security"], "pr_number": 103},
        {"title": "Add analytics export route", "labels": ["feature"], "pr_number": 104},
        {"title": "Fix off-by-one in pagination", "labels": ["bug"], "pr_number": 105},
        {"title": "Setup actionlint workflow", "labels": ["ci"], "pr_number": 106},
        {"title": "Update setup instructions", "labels": ["documentation"], "pr_number": 107},
        {"title": "Add proptest suite for voting", "labels": ["testing"], "pr_number": 108},
        {"title": "Optimize storage reads", "labels": ["performance"], "pr_number": 109},
        {"title": "Bump dependencies", "labels": ["dependencies"], "pr_number": 110},
    ]

    notes = gen_notes.generate_notes_from_items(items, current_tag="v1.0.0", previous_tag="v0.9.0")

    check("contains Smart Contract category", "## 📜 Smart Contract" in notes)
    check("contains Frontend category", "## 🖥️ Frontend" in notes)
    check("contains Security category", "## 🔒 Security" in notes)
    check("contains Features category", "## 🚀 New Features" in notes)
    check("contains Bug Fixes category", "## 🐛 Bug Fixes" in notes)
    check("contains CI category", "## 🔧 CI & Infrastructure" in notes)
    check("contains Documentation category", "## 📚 Documentation" in notes)
    check("contains Testing category", "## 🧪 Testing" in notes)
    check("contains Performance category", "## ⚡ Performance" in notes)
    check("contains Maintenance category", "## 🏗️ Maintenance" in notes)
    check("includes PR numbers", "(#101)" in notes and "(#110)" in notes)


def test_scenario_no_labels():
    print("\n--- Test Scenario 2: No labels (fallback behavior) ---")
    items = [
        {"title": "random commit message without convention", "labels": [], "sha": "abcdef123456"},
        {"title": "another untyped change", "labels": [], "pr_number": 200},
    ]

    notes = gen_notes.generate_notes_from_items(items)

    check("categorized into Other Changes", "## 🔀 Other Changes" in notes)
    check("includes untyped entries", "random commit message without convention" in notes)
    check("includes sha reference", "(abcdef12)" in notes)
    check("includes pr reference", "(#200)" in notes)


def test_scenario_conventional_commits_only():
    print("\n--- Test Scenario 3: Conventional commits only ---")
    items = [
        {"title": "feat(core): add threshold migration helper", "labels": [], "pr_number": 301},
        {"title": "fix(api): prevent null pointer on empty query", "labels": [], "pr_number": 302},
        {"title": "docs: document operational runbooks", "labels": [], "pr_number": 303},
        {"title": "chore: clean up unused test snapshots", "labels": [], "pr_number": 304},
    ]

    notes = gen_notes.generate_notes_from_items(items)

    check("feat mapped to New Features", "## 🚀 New Features" in notes)
    check("feat scope formatted", "**core:** add threshold migration helper" in notes)
    check("fix mapped to Bug Fixes", "## 🐛 Bug Fixes" in notes)
    check("fix scope formatted", "**api:** prevent null pointer" in notes)
    check("docs mapped to Documentation", "## 📚 Documentation" in notes)
    check("chore mapped to Maintenance", "## 🏗️ Maintenance" in notes)


def test_scenario_breaking_changes():
    print("\n--- Test Scenario 4: Breaking changes ---")
    items = [
        {
            "title": "feat(contract)!: alter proposal execution signature",
            "labels": [],
            "pr_number": 401,
        },
        {
            "title": "refactor: change ledger entry serialization",
            "body": "BREAKING CHANGE: Old storage formats are deprecated.",
            "labels": ["breaking"],
            "pr_number": 402,
        },
        {
            "title": "fix(client): handle error code 42",
            "labels": ["bug"],
            "pr_number": 403,
        },
    ]

    notes = gen_notes.generate_notes_from_items(items)

    check("contains Breaking Changes section", "## 💥 Breaking Changes" in notes)
    check("breaking item 401 listed under Breaking", "(#401)" in notes)
    check("breaking item 402 listed under Breaking", "(#402)" in notes)
    check("also categorized under category", "## 🚀 New Features" in notes or "## 🏗️ Maintenance" in notes)
    check("non-breaking item listed under Bug Fixes", "## 🐛 Bug Fixes" in notes and "(#403)" in notes)


def test_scenario_empty_range():
    print("\n--- Test Scenario 5: Empty range ---")
    notes = gen_notes.generate_notes_from_items([], current_tag="v2.0.0", previous_tag="v1.9.0")

    check("handles empty items gracefully", "No changes detected" in notes)
    check("includes title and previous tag", "v2.0.0" in notes and "v1.9.0" in notes)


def main():
    print("Release Notes Categorization Tests")
    print("=" * 50)

    test_scenario_all_labels_present()
    test_scenario_no_labels()
    test_scenario_conventional_commits_only()
    test_scenario_breaking_changes()
    test_scenario_empty_range()

    print(f"\n{'=' * 50}")
    print(f"Results: {PASS} passed, {FAIL} failed")
    return 1 if FAIL > 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
