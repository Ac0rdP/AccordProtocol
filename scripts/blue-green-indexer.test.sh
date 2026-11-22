#!/usr/bin/env bash
# Unit and dry-run tests for scripts/blue-green-indexer.sh (offline, no network).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BG_SCRIPT="$SCRIPT_DIR/blue-green-indexer.sh"

TMP_ROOT="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

export REPORT_DIR="$TMP_ROOT/report"

echo "Test 1: Dry-run precheck, compare, shift, health, soak"
bash "$BG_SCRIPT" precheck --dry-run
bash "$BG_SCRIPT" compare --dry-run
bash "$BG_SCRIPT" shift --target green --dry-run
bash "$BG_SCRIPT" health --dry-run
bash "$BG_SCRIPT" soak --minutes 1 --dry-run

echo "Test 2: Invalid shift target must fail nonzero"
if bash "$BG_SCRIPT" shift --target purple --dry-run 2>/dev/null; then
  echo "FAIL: Expected invalid target 'purple' to fail" >&2
  exit 1
fi
echo "PASS: Invalid shift target rejected"

echo "Test 3: Live shift without TRAFFIC_SHIFT_CMD must fail nonzero"
if DRY_RUN=0 bash "$BG_SCRIPT" shift --target green 2>/dev/null; then
  echo "FAIL: Expected missing TRAFFIC_SHIFT_CMD to fail" >&2
  exit 1
fi
echo "PASS: Missing TRAFFIC_SHIFT_CMD rejected"

echo "Test 4: Live compare without BLUE_URL/GREEN_URL must fail nonzero"
if DRY_RUN=0 bash "$BG_SCRIPT" compare 2>/dev/null; then
  echo "FAIL: Expected missing BLUE_URL/GREEN_URL to fail" >&2
  exit 1
fi
echo "PASS: Missing URLs rejected"

echo "All blue-green-indexer.sh tests passed."
