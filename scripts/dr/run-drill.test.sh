#!/usr/bin/env bash
# Offline fixture tests for scripts/dr/run-drill.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRILL_SCRIPT="$SCRIPT_DIR/run-drill.sh"

TMP_ROOT="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

export REPORT_DIR="$TMP_ROOT/dr-report"
export BACKUP_ENCRYPTION_KEY="dr-unit-test-ephemeral-key"

echo "Test 1: Dry-run DR drill passes and removes raw backup file from report dir"
bash "$DRILL_SCRIPT" --dry-run
if [[ -f "$REPORT_DIR/backup-stage/accord-backup.tar.gz.enc" ]]; then
  echo "FAIL: Raw encrypted backup should not remain in drill report directory" >&2
  exit 1
fi
test -f "$REPORT_DIR/drill-report.json"
test -f "$REPORT_DIR/invariants-results.json"

echo "Test 2: Exceeded RTO objective must fail nonzero"
if RTO_OBJECTIVE_SECONDS=-1 bash "$DRILL_SCRIPT" --dry-run 2>/dev/null; then
  echo "FAIL: Expected RTO objective failure" >&2
  exit 1
fi
echo "PASS: Exceeded RTO objective rejected"

echo "All DR drill tests passed."
