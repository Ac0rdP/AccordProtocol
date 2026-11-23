#!/usr/bin/env python3
"""Tests for check-ci-budgets.py.

Scenarios tested:
  1. Under budget (all jobs well within limit)
  2. At warn threshold (soft breach reported, passes overall)
  3. Over fail threshold (hard breach reported, fails overall)
  4. Missing / unbudgeted job (flags unbudgeted, applies default budget)
  5. Cancelled or skipped job (does not cause false breach)
  6. Empty run history (handles gracefully without errors)
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "check-ci-budgets.py"

# Import check-ci-budgets dynamically
spec = importlib.util.spec_from_file_location("check_ci_budgets", SCRIPT_PATH)
budgets_mod = importlib.util.module_from_spec(spec)
sys.modules["check_ci_budgets"] = budgets_mod
spec.loader.exec_module(budgets_mod)

SAMPLE_CONFIG = {
    "rates_per_minute_usd": {
        "ubuntu-latest": 0.008,
        "macos-latest": 0.080,
    },
    "default_budget": {
        "warn_minutes": 10.0,
        "fail_minutes": 20.0,
        "runner_type": "ubuntu-latest",
    },
    "jobs": {
        "Contract CI": {
            "warn_minutes": 8.0,
            "fail_minutes": 15.0,
            "runner_type": "ubuntu-latest",
        },
        "Mutation Testing (cargo-mutants)": {
            "warn_minutes": 90.0,
            "fail_minutes": 130.0,
            "runner_type": "ubuntu-latest",
        },
    },
}

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


def test_scenario_under_budget():
    print("\n--- Test Scenario 1: Under budget ---")
    jobs = [
        {
            "name": "Contract CI",
            "status": "completed",
            "conclusion": "success",
            "started_at": "2026-11-19T10:00:00Z",
            "completed_at": "2026-11-19T10:04:30Z",  # 4.5m
        }
    ]
    res = budgets_mod.evaluate_job_budgets(jobs, SAMPLE_CONFIG)

    check("passed overall", res["passed"] is True)
    check("no hard breaches", len(res["hard_breaches"]) == 0)
    check("no soft breaches", len(res["soft_breaches"]) == 0)
    check("cost estimated correctly", res["total_cost_usd"] == round(4.5 * 0.008, 4))
    check("row outcome is PASS", res["summary"][0]["outcome"] == "PASS")


def test_scenario_at_warn_threshold():
    print("\n--- Test Scenario 2: At warn threshold ---")
    jobs = [
        {
            "name": "Contract CI",
            "status": "completed",
            "conclusion": "success",
            "started_at": "2026-11-19T10:00:00Z",
            "completed_at": "2026-11-19T10:09:00Z",  # 9.0m (warn is 8.0m, fail is 15.0m)
        }
    ]
    res = budgets_mod.evaluate_job_budgets(jobs, SAMPLE_CONFIG)

    check("passed overall despite warn", res["passed"] is True)
    check("has soft breach", len(res["soft_breaches"]) == 1)
    check("no hard breach", len(res["hard_breaches"]) == 0)
    check("row outcome is WARN", res["summary"][0]["outcome"] == "WARN")


def test_scenario_over_fail_threshold():
    print("\n--- Test Scenario 3: Over fail threshold ---")
    jobs = [
        {
            "name": "Contract CI",
            "status": "completed",
            "conclusion": "success",
            "started_at": "2026-11-19T10:00:00Z",
            "completed_at": "2026-11-19T10:16:30Z",  # 16.5m (fail is 15.0m)
        }
    ]
    res = budgets_mod.evaluate_job_budgets(jobs, SAMPLE_CONFIG)

    check("failed overall", res["passed"] is False)
    check("has hard breach", len(res["hard_breaches"]) == 1)
    check("hard breach job identified", res["hard_breaches"][0]["job"] == "Contract CI")
    check("row outcome is FAIL", res["summary"][0]["outcome"] == "FAIL")


def test_scenario_unbudgeted_job():
    print("\n--- Test Scenario 4: Missing / unbudgeted job ---")
    jobs = [
        {
            "name": "Brand New Unconfigured Job",
            "status": "completed",
            "conclusion": "success",
            "started_at": "2026-11-19T10:00:00Z",
            "completed_at": "2026-11-19T10:05:00Z",  # 5.0m
        }
    ]
    res = budgets_mod.evaluate_job_budgets(jobs, SAMPLE_CONFIG)

    check("identified as unbudgeted", "Brand New Unconfigured Job" in res["unbudgeted"])
    check("applied default warn limit (10m)", res["summary"][0]["warn_limit"] == 10.0)
    check("applied default fail limit (20m)", res["summary"][0]["fail_limit"] == 20.0)
    check("passed under default limits", res["passed"] is True)


def test_scenario_cancelled_job():
    print("\n--- Test Scenario 5: Cancelled job ---")
    jobs = [
        {
            "name": "Contract CI",
            "status": "completed",
            "conclusion": "cancelled",
            "started_at": "2026-11-19T10:00:00Z",
            "completed_at": "2026-11-19T10:25:00Z",  # 25m but was cancelled
        },
        {
            "name": "Contract CI",
            "status": "completed",
            "conclusion": "skipped",
            "started_at": None,
            "completed_at": None,
        },
    ]
    res = budgets_mod.evaluate_job_budgets(jobs, SAMPLE_CONFIG)

    check("skipped/cancelled excluded from breaches", len(res["hard_breaches"]) == 0)
    check("tracked under skipped_or_cancelled", len(res["skipped_or_cancelled"]) == 2)
    check("passed overall", res["passed"] is True)


def test_scenario_empty_run_history():
    print("\n--- Test Scenario 6: Empty run history ---")
    res = budgets_mod.evaluate_job_budgets([], SAMPLE_CONFIG)

    check("handles empty history without crashing", res["passed"] is True)
    check("flagged as empty", res.get("empty") is True)
    check("total minutes is 0", res["total_minutes"] == 0.0)

    report = budgets_mod.format_markdown_report(res)
    check("markdown report mentions no jobs", "No completed CI jobs" in report)


def main():
    print("CI Time and Cost Budget Evaluation Tests")
    print("=" * 50)

    test_scenario_under_budget()
    test_scenario_at_warn_threshold()
    test_scenario_over_fail_threshold()
    test_scenario_unbudgeted_job()
    test_scenario_cancelled_job()
    test_scenario_empty_run_history()

    print(f"\n{'=' * 50}")
    print(f"Results: {PASS} passed, {FAIL} failed")
    return 1 if FAIL > 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
