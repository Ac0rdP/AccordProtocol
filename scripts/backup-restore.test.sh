#!/usr/bin/env bash
# Offline unit & fixture tests for scripts/backup-restore.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BR_SCRIPT="$SCRIPT_DIR/backup-restore.sh"

TMP_ROOT="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

export REPORT_DIR="$TMP_ROOT/report"
export BACKUP_ENCRYPTION_KEY="unit-test-ephemeral-key-do-not-reuse"

echo "Test 1: Dry-run backup + verify-restore round-trip"
bash "$BR_SCRIPT" backup --dry-run
bash "$BR_SCRIPT" verify-restore --dry-run
bash "$BR_SCRIPT" prune --dry-run

echo "Test 2: Corrupted encrypted backup must fail nonzero"
printf 'corrupted-bytes' >> "$REPORT_DIR/accord-backup.tar.gz.enc"
if bash "$BR_SCRIPT" verify-restore --dry-run 2>/dev/null; then
  echo "FAIL: Expected corrupted backup to fail checksum verification" >&2
  exit 1
fi
echo "PASS: Corrupted backup rejected"

echo "Test 3: Exceeded RPO limit must fail nonzero"
rm -rf "$REPORT_DIR"
mkdir -p "$REPORT_DIR"
bash "$BR_SCRIPT" backup --dry-run
python3 - "$REPORT_DIR/backup-manifest.json" <<'PY'
import json, sys
p = sys.argv[1]
m = json.load(open(p))
m["timestamp"] = "2020-01-01T00:00:00Z"
json.dump(m, open(p, "w"))
PY
if MAX_RPO_SECONDS=60 bash "$BR_SCRIPT" verify-restore --dry-run 2>/dev/null; then
  echo "FAIL: Expected stale backup exceeding MAX_RPO_SECONDS to fail" >&2
  exit 1
fi
echo "PASS: Stale RPO rejected"

echo "All backup-restore.sh tests passed."
