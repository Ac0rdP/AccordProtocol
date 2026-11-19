#!/usr/bin/env python3
"""Evaluate CI workflow job durations and runner costs against configured budgets.

Compares completed jobs from GitHub Actions against thresholds in .github/ci-budgets.json.
Warns on soft breaches, fails on hard breaches, and prints a markdown summary.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG_PATH = ROOT / ".github" / "ci-budgets.json"


def parse_iso8601(timestamp_str: str | None) -> datetime | None:
    if not timestamp_str:
        return None
    # Python 3.11+ handles Z, earlier might need replace
    clean_ts = timestamp_str.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(clean_ts)
    except Exception:
        return None


def calculate_duration_minutes(job: dict[str, Any]) -> float | None:
    """Calculate job duration in minutes from started_at and completed_at."""
    if "duration_seconds" in job:
        return round(float(job["duration_seconds"]) / 60.0, 2)

    started_at = parse_iso8601(job.get("started_at"))
    completed_at = parse_iso8601(job.get("completed_at"))

    if not started_at or not completed_at:
        return None

    duration = (completed_at - started_at).total_seconds()
    if duration < 0:
        return 0.0
    return round(duration / 60.0, 2)


def evaluate_job_budgets(
    jobs_data: list[dict[str, Any]],
    config: dict[str, Any],
) -> dict[str, Any]:
    """Evaluate jobs against the configured budget.

    Returns:
      {
        "summary": [...],
        "hard_breaches": [...],
        "soft_breaches": [...],
        "unbudgeted": [...],
        "skipped_or_cancelled": [...],
        "total_cost_usd": float,
        "total_minutes": float,
        "passed": bool,
      }
    """
    job_budgets = config.get("jobs", {})
    rates = config.get("rates_per_minute_usd", {})
    default_budget = config.get("default_budget", {"warn_minutes": 10.0, "fail_minutes": 20.0, "runner_type": "ubuntu-latest"})

    rows = []
    hard_breaches = []
    soft_breaches = []
    unbudgeted = []
    skipped_or_cancelled = []
    total_cost = 0.0
    total_minutes = 0.0

    if not jobs_data:
        return {
            "summary": [],
            "hard_breaches": [],
            "soft_breaches": [],
            "unbudgeted": [],
            "skipped_or_cancelled": [],
            "total_cost_usd": 0.0,
            "total_minutes": 0.0,
            "passed": True,
            "empty": True,
        }

    for job in jobs_data:
        name = job.get("name", "Unknown Job")
        status = job.get("status", "completed")
        conclusion = job.get("conclusion")

        # Skip cancelled or skipped jobs from failing duration budget
        if status != "completed" or conclusion in ("skipped", "cancelled"):
            skipped_or_cancelled.append({
                "name": name,
                "status": status,
                "conclusion": conclusion,
            })
            continue

        duration_mins = calculate_duration_minutes(job)
        if duration_mins is None:
            continue

        total_minutes += duration_mins

        # Find matching budget
        is_unbudgeted = False
        if name in job_budgets:
            budget = job_budgets[name]
        else:
            budget = default_budget
            is_unbudgeted = True
            unbudgeted.append(name)

        warn_limit = float(budget.get("warn_minutes", 10.0))
        fail_limit = float(budget.get("fail_minutes", 20.0))
        runner_type = budget.get("runner_type", "ubuntu-latest")
        rate = float(rates.get(runner_type, 0.008))

        cost = round(duration_mins * rate, 4)
        total_cost += cost

        # Check status
        if duration_mins >= fail_limit:
            outcome = "FAIL"
            hard_breaches.append({
                "job": name,
                "duration": duration_mins,
                "limit": fail_limit,
                "cost": cost,
            })
        elif duration_mins >= warn_limit:
            outcome = "WARN"
            soft_breaches.append({
                "job": name,
                "duration": duration_mins,
                "limit": warn_limit,
                "cost": cost,
            })
        else:
            outcome = "PASS"

        rows.append({
            "name": name,
            "duration_mins": duration_mins,
            "warn_limit": warn_limit,
            "fail_limit": fail_limit,
            "runner_type": runner_type,
            "cost_usd": cost,
            "outcome": outcome,
            "is_unbudgeted": is_unbudgeted,
        })

    passed = len(hard_breaches) == 0

    return {
        "summary": rows,
        "hard_breaches": hard_breaches,
        "soft_breaches": soft_breaches,
        "unbudgeted": unbudgeted,
        "skipped_or_cancelled": skipped_or_cancelled,
        "total_cost_usd": round(total_cost, 4),
        "total_minutes": round(total_minutes, 2),
        "passed": passed,
        "empty": False,
    }


def format_markdown_report(eval_result: dict[str, Any]) -> str:
    """Format evaluation results into a Markdown report for job summary."""
    lines = []
    lines.append("## CI Time and Cost Budget Report")
    lines.append("")

    if eval_result.get("empty"):
        lines.append("*No completed CI jobs to evaluate in this run.*")
        return "\n".join(lines) + "\n"

    lines.append(f"**Overall Status:** {'✅ PASSED' if eval_result['passed'] else '❌ FAILED'}")
    lines.append(f"**Total Run Time:** {eval_result['total_minutes']} minutes")
    lines.append(f"**Estimated Runner Cost:** ${eval_result['total_cost_usd']:.4f} USD *(configurable assumption)*")
    lines.append("")

    # Summary table
    lines.append("| Job Name | Duration | Warn Limit | Fail Limit | Runner | Est. Cost (USD) | Status |")
    lines.append("|:---|:---:|:---:|:---:|:---:|:---:|:---:|")

    for row in eval_result["summary"]:
        status_icon = "🟢 PASS"
        if row["outcome"] == "WARN":
            status_icon = "🟡 WARN"
        elif row["outcome"] == "FAIL":
            status_icon = "🔴 FAIL"

        unbud_note = " *(unbudgeted)*" if row.get("is_unbudgeted") else ""
        lines.append(
            f"| {row['name']}{unbud_note} | {row['duration_mins']}m | {row['warn_limit']}m | {row['fail_limit']}m | {row['runner_type']} | ${row['cost_usd']:.4f} | {status_icon} |"
        )
    lines.append("")

    if eval_result["hard_breaches"]:
        lines.append("### 🔴 Hard Budget Breaches (Failed)")
        for b in eval_result["hard_breaches"]:
            lines.append(f"- **{b['job']}**: ran for **{b['duration']}m** (exceeded fail threshold of **{b['limit']}m**)")
        lines.append("")

    if eval_result["soft_breaches"]:
        lines.append("### 🟡 Soft Budget Warnings")
        for b in eval_result["soft_breaches"]:
            lines.append(f"- **{b['job']}**: ran for **{b['duration']}m** (exceeded warn threshold of **{b['limit']}m**)")
        lines.append("")

    if eval_result["unbudgeted"]:
        lines.append("### ℹ️ Unbudgeted Jobs")
        lines.append("The following jobs had no explicit entry in `.github/ci-budgets.json` and used default thresholds:")
        for name in eval_result["unbudgeted"]:
            lines.append(f"- {name}")
        lines.append("")

    if eval_result["skipped_or_cancelled"]:
        lines.append("### ⏸️ Skipped or Cancelled Jobs")
        for sc in eval_result["skipped_or_cancelled"]:
            lines.append(f"- **{sc['name']}** ({sc.get('conclusion') or sc.get('status')})")
        lines.append("")

    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="CI Time & Cost Budget Checker")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG_PATH), help="Path to ci-budgets.json")
    parser.add_argument("--jobs-json", required=True, help="Path to jobs JSON from GitHub API or sample file")
    parser.add_argument("--output", default="", help="Path to write markdown summary to")

    args = parser.parse_args()

    config_path = Path(args.config)
    if not config_path.exists():
        print(f"ERROR: Budget config not found at {config_path}", file=sys.stderr)
        return 1

    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"ERROR: Malformed budget config: {e}", file=sys.stderr)
        return 1

    jobs_path = Path(args.jobs_json)
    if not jobs_path.exists():
        print(f"ERROR: Jobs JSON not found at {jobs_path}", file=sys.stderr)
        return 1

    try:
        jobs_raw = json.loads(jobs_path.read_text(encoding="utf-8"))
        if isinstance(jobs_raw, dict) and "jobs" in jobs_raw:
            jobs_list = jobs_raw["jobs"]
        elif isinstance(jobs_raw, list):
            jobs_list = jobs_raw
        else:
            jobs_list = []
    except Exception as e:
        print(f"ERROR: Malformed jobs JSON: {e}", file=sys.stderr)
        return 1

    eval_result = evaluate_job_budgets(jobs_list, config)
    report = format_markdown_report(eval_result)

    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(report, encoding="utf-8")
        print(f"Budget report written to {out_path}")
    else:
        print(report)

    if not eval_result["passed"]:
        print("\nERROR: One or more jobs exceeded their failure threshold budget.", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
