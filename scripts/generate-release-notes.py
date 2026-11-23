#!/usr/bin/env python3
"""Generate categorized release notes from merged PRs and commit history.

Supports:
  - PR label matching against categories
  - Conventional commit prefixes (feat:, fix:, docs:, chore:, etc.)
  - Breaking change markers (! or BREAKING CHANGE)
  - Unlabeled or non-conventional entries mapped to 'Other Changes'
  - Deterministic ordering and deduplication
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

CATEGORY_MAPPING = [
    ("💥 Breaking Changes", ["breaking", "breaking-change"]),
    ("🔒 Security", ["security", "vulnerability"]),
    ("📜 Smart Contract", ["contract", "soroban"]),
    ("🚀 New Features", ["feat", "feature", "enhancement"]),
    ("🐛 Bug Fixes", ["fix", "bug", "bugfix"]),
    ("🖥️ Frontend", ["frontend", "ui"]),
    ("🔧 CI & Infrastructure", ["ci", "infrastructure", "devops", "workflow"]),
    ("📚 Documentation", ["docs", "documentation"]),
    ("🧪 Testing", ["test", "testing"]),
    ("⚡ Performance", ["perf", "performance", "optimization"]),
    ("🏗️ Maintenance", ["chore", "maintenance", "refactor", "dependencies", "build", "style"]),
]

CONVENTIONAL_PREFIX_MAP = {
    "feat": "🚀 New Features",
    "fix": "🐛 Bug Fixes",
    "security": "🔒 Security",
    "docs": "📚 Documentation",
    "test": "🧪 Testing",
    "ci": "🔧 CI & Infrastructure",
    "perf": "⚡ Performance",
    "chore": "🏗️ Maintenance",
    "refactor": "🏗️ Maintenance",
    "build": "🏗️ Maintenance",
    "style": "🏗️ Maintenance",
}

OTHER_CATEGORY = "🔀 Other Changes"
BREAKING_CATEGORY = "💥 Breaking Changes"


def categorize_entry(
    title: str,
    labels: list[str] | None = None,
    body: str = "",
    pr_number: int | str | None = None,
    sha: str | None = None,
) -> tuple[str, bool, str]:
    """Categorize an individual change item.

    Returns:
      (category_title, is_breaking, formatted_entry)
    """
    labels = [l.strip().lower() for l in (labels or [])]
    is_breaking = False

    # Check labels for breaking change
    if any(l in ("breaking", "breaking-change") for l in labels):
        is_breaking = True

    # Check conventional commit breaking indicator: type! or BREAKING CHANGE in body/title
    if "BREAKING CHANGE:" in body or "BREAKING CHANGE:" in title or "BREAKING-CHANGE:" in body:
        is_breaking = True

    conv_match = re.match(r"^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$", title)
    if conv_match:
        conv_type, scope, bang, desc = conv_match.groups()
        if bang:
            is_breaking = True
        desc = desc.strip()
    else:
        conv_type, scope, desc = None, None, title.strip()

    # Determine category
    assigned_category = None

    # 1. First priority: explicitly matching labels (excluding breaking labels)
    for cat_title, cat_labels in CATEGORY_MAPPING:
        if cat_title == BREAKING_CATEGORY:
            continue
        if any(lbl in labels for lbl in cat_labels):
            assigned_category = cat_title
            break

    # 2. Second priority: conventional commit type
    if not assigned_category and conv_type:
        assigned_category = CONVENTIONAL_PREFIX_MAP.get(conv_type.lower())

    # 3. Fallback: Other Changes
    if not assigned_category:
        assigned_category = OTHER_CATEGORY

    # Format entry line
    ref_part = ""
    if pr_number:
        ref_part = f" (#{pr_number})"
    elif sha:
        ref_part = f" ({sha[:8]})"

    if scope:
        entry_text = f"- **{scope}:** {desc}{ref_part}"
    else:
        entry_text = f"- {desc}{ref_part}"

    return assigned_category, is_breaking, entry_text


def generate_notes_from_items(
    items: list[dict[str, Any]],
    current_tag: str = "",
    previous_tag: str = "",
) -> str:
    """Generate markdown release notes from a list of change item dicts."""
    if not items:
        title = f"# Release {current_tag}" if current_tag else "# Release Notes"
        subtitle = f"\nChanges since {previous_tag}\n" if previous_tag else "\n"
        return f"{title}\n{subtitle}\n*No changes detected in this release range.*\n"

    grouped: dict[str, list[str]] = {}
    breaking_items: list[str] = []
    seen_entries: set[str] = set()

    for item in items:
        title = item.get("title", "")
        labels = item.get("labels", [])
        body = item.get("body", "")
        pr_number = item.get("pr_number")
        sha = item.get("sha")

        category, is_breaking, entry_text = categorize_entry(
            title=title,
            labels=labels,
            body=body,
            pr_number=pr_number,
            sha=sha,
        )

        if entry_text in seen_entries:
            continue
        seen_entries.add(entry_text)

        grouped.setdefault(category, []).append(entry_text)
        if is_breaking:
            breaking_items.append(entry_text)

    lines: list[str] = []
    release_title = f"# Release {current_tag}" if current_tag else "# Release Notes"
    lines.append(release_title)
    lines.append("")
    if previous_tag:
        lines.append(f"Changes since {previous_tag}")
        lines.append("")

    if breaking_items:
        lines.append(f"## {BREAKING_CATEGORY}")
        lines.append("")
        for b in breaking_items:
            lines.append(b)
        lines.append("")

    # Standard display ordering
    category_order = [
        "🚀 New Features",
        "🐛 Bug Fixes",
        "🔒 Security",
        "📜 Smart Contract",
        "🖥️ Frontend",
        "🔧 CI & Infrastructure",
        "📚 Documentation",
        "🧪 Testing",
        "⚡ Performance",
        "🏗️ Maintenance",
        OTHER_CATEGORY,
    ]

    for cat in category_order:
        if cat in grouped and grouped[cat]:
            lines.append(f"## {cat}")
            lines.append("")
            for entry in grouped[cat]:
                lines.append(entry)
            lines.append("")

    return "\n".join(lines).strip() + "\n"


def parse_git_commits(range_spec: str) -> list[dict[str, Any]]:
    """Fetch git commit entries in the given range."""
    cmd = ["git", "log", "--pretty=format:%H%x00%s%x00%b%x1e"]
    if range_spec:
        cmd.append(range_spec)

    try:
        raw = subprocess.check_output(cmd, text=True, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        return []

    items = []
    records = raw.strip().split("\x1e")
    for rec in records:
        rec = rec.strip()
        if not rec:
            continue
        parts = rec.split("\x00")
        if len(parts) >= 2:
            sha = parts[0].strip()
            subject = parts[1].strip()
            body = parts[2].strip() if len(parts) > 2 else ""

            # Try to extract PR number if in subject e.g. "feat: foo (#123)"
            pr_match = re.search(r"#(\d+)\)?$", subject)
            pr_number = pr_match.group(1) if pr_match else None

            items.append({
                "sha": sha,
                "title": subject,
                "body": body,
                "pr_number": pr_number,
                "labels": [],
            })
    return items


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate categorized release notes.")
    parser.add_argument("--range", dest="range_spec", default="", help="Git commit range, e.g. v0.1.0..v0.2.0")
    parser.add_argument("--current-tag", default="", help="Tag being released")
    parser.add_argument("--previous-tag", default="", help="Previous tag")
    parser.add_argument("--items-json", default="", help="Path to json file with items list")
    parser.add_argument("--output", default="", help="Path to write notes to")

    args = parser.parse_args()

    items = []
    if args.items_json and Path(args.items_json).exists():
        items = json.loads(Path(args.items_json).read_text(encoding="utf-8"))
    else:
        items = parse_git_commits(args.range_spec)

    notes = generate_notes_from_items(
        items=items,
        current_tag=args.current_tag,
        previous_tag=args.previous_tag,
    )

    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(notes, encoding="utf-8")
        print(f"Release notes written to {out_path}")
    else:
        print(notes)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
