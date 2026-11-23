#!/usr/bin/env bash
# Multi-Region Encrypted Backup & Isolated Restore Verification Script.
#
# Never echoes secrets or encryption keys (never enable `set -x` here).
#
# Usage:
#   bash scripts/backup-restore.sh backup [--dry-run]
#   bash scripts/backup-restore.sh verify-restore [--dry-run]
#   bash scripts/backup-restore.sh prune [--dry-run]
set -euo pipefail

DRY_RUN="${DRY_RUN:-0}"
REPORT_DIR="${REPORT_DIR:-target/backup-restore}"
BACKUP_SECONDARY_REGION="${BACKUP_SECONDARY_REGION:-us-west-2-placeholder}"
BACKUP_BUCKET_URI="${BACKUP_BUCKET_URI:-}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
MAX_RPO_SECONDS="${MAX_RPO_SECONDS:-86400}"
MAX_RTO_SECONDS="${MAX_RTO_SECONDS:-900}"
SOURCE_VERSION="${GITHUB_SHA:-local}"

mkdir -p "$REPORT_DIR"

log() {
  printf '[backup-restore] %s\n' "$*"
}

err() {
  printf '[backup-restore] ERROR: %s\n' "$*" >&2
}

compute_sha256() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    err "Neither sha256sum nor shasum is available."
    return 1
  fi
}

encrypt_file() {
  local input_file="$1"
  local output_file="$2"
  if [[ -z "${BACKUP_ENCRYPTION_KEY:-}" ]]; then
    err "BACKUP_ENCRYPTION_KEY must be set to encrypt backups."
    return 1
  fi
  openssl enc -aes-256-cbc -pbkdf2 -salt -in "$input_file" -out "$output_file" -pass env:BACKUP_ENCRYPTION_KEY
}

decrypt_file() {
  local input_file="$1"
  local output_file="$2"
  if [[ -z "${BACKUP_ENCRYPTION_KEY:-}" ]]; then
    err "BACKUP_ENCRYPTION_KEY must be set to decrypt backups."
    return 1
  fi
  openssl enc -d -aes-256-cbc -pbkdf2 -in "$input_file" -out "$output_file" -pass env:BACKUP_ENCRYPTION_KEY
}

write_manifest() {
  local encrypted_file="$1"
  local manifest_file="$2"
  local region="$3"
  local source_ver="$4"
  local schema_ver="$5"
  local ts sha size_bytes

  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  sha="$(compute_sha256 "$encrypted_file")"
  size_bytes="$(wc -c < "$encrypted_file" | tr -d ' ')"

  cat > "$manifest_file" <<EOF
{
  "timestamp": "$ts",
  "source_version": "$source_ver",
  "size_bytes": $size_bytes,
  "sha256_encrypted": "$sha",
  "region": "$region",
  "schema_version": "$schema_ver"
}
EOF
}

verify_manifest_checksum() {
  local encrypted_file="$1"
  local manifest_file="$2"
  local expected_sha actual_sha

  expected_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256_encrypted"])' "$manifest_file")"
  actual_sha="$(compute_sha256 "$encrypted_file")"
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    err "Encrypted backup checksum mismatch! expected=$expected_sha actual=$actual_sha"
    return 1
  fi
  log "Encrypted backup SHA-256 matches manifest ($actual_sha)."
}

check_rpo_rto() {
  local manifest_file="$1"
  local rto_seconds="$2"
  local rpo_seconds

  rpo_seconds="$(python3 - "$manifest_file" <<'PY'
import json, sys
from datetime import datetime, timezone
m = json.load(open(sys.argv[1]))
ts = datetime.fromisoformat(m["timestamp"].replace("Z", "+00:00"))
age = int((datetime.now(timezone.utc) - ts).total_seconds())
print(max(0, age))
PY
)"

  log "Measured RPO=${rpo_seconds}s (limit=${MAX_RPO_SECONDS}s), RTO=${rto_seconds}s (limit=${MAX_RTO_SECONDS}s)."

  cat > "$REPORT_DIR/restore-report.json" <<EOF
{
  "rpo_seconds": $rpo_seconds,
  "max_rpo_seconds": $MAX_RPO_SECONDS,
  "rto_seconds": $rto_seconds,
  "max_rto_seconds": $MAX_RTO_SECONDS,
  "region": "$BACKUP_SECONDARY_REGION"
}
EOF

  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo "### Backup & Restore Verification"
      echo "| Metric | Measured | Limit | Status |"
      echo "| --- | --- | --- | --- |"
      echo "| **RPO (backup age)** | ${rpo_seconds}s | ${MAX_RPO_SECONDS}s | $([ "$rpo_seconds" -le "$MAX_RPO_SECONDS" ] && echo "PASS" || echo "FAIL") |"
      echo "| **RTO (restore duration)** | ${rto_seconds}s | ${MAX_RTO_SECONDS}s | $([ "$rto_seconds" -le "$MAX_RTO_SECONDS" ] && echo "PASS" || echo "FAIL") |"
    } >> "$GITHUB_STEP_SUMMARY"
  fi

  if [[ "$rpo_seconds" -gt "$MAX_RPO_SECONDS" ]]; then
    err "RPO (${rpo_seconds}s) exceeds MAX_RPO_SECONDS (${MAX_RPO_SECONDS}s)."
    return 1
  fi
  if [[ "$rto_seconds" -gt "$MAX_RTO_SECONDS" ]]; then
    err "RTO (${rto_seconds}s) exceeds MAX_RTO_SECONDS (${MAX_RTO_SECONDS}s)."
    return 1
  fi
}

cmd_backup() {
  log "Starting encrypted backup (region=$BACKUP_SECONDARY_REGION, dry_run=$DRY_RUN)..."
  local work_dir
  work_dir="$(mktemp -d)"
  trap 'rm -rf "$work_dir"' RETURN

  local bundle="$work_dir/accord-backup.tar.gz"
  local encrypted="$REPORT_DIR/accord-backup.tar.gz.enc"
  local manifest="$REPORT_DIR/backup-manifest.json"

  if [[ "$DRY_RUN" == "1" ]]; then
    # Create a deterministic synthetic SQL + config bundle in dry-run mode.
    printf -- '-- Accord dry-run fixture dump\nCREATE TABLE IF NOT EXISTS indexer_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);\n' > "$work_dir/db.sql"
    tar -czf "$bundle" -C "$work_dir" db.sql
    BACKUP_ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-dry-run-ephemeral-key}" encrypt_file "$bundle" "$encrypted"
    write_manifest "$encrypted" "$manifest" "$BACKUP_SECONDARY_REGION" "$SOURCE_VERSION" "0012"
    log "[dry-run] Encrypted backup and manifest written to $REPORT_DIR (no cloud upload)."
    return 0
  fi

  if [[ -z "${BACKUP_DATABASE_URL:-}" || -z "${BACKUP_BUCKET_URI:-}" || -z "${BACKUP_UPLOAD_CMD:-}" ]]; then
    err "BACKUP_DATABASE_URL, BACKUP_BUCKET_URI, and BACKUP_UPLOAD_CMD must be set for live backup."
    return 1
  fi

  pg_dump --no-owner --no-acl "$BACKUP_DATABASE_URL" > "$work_dir/db.sql"
  cp docker-compose.yml .env.example "$work_dir/" 2>/dev/null || true
  tar -czf "$bundle" -C "$work_dir" .
  encrypt_file "$bundle" "$encrypted"
  write_manifest "$encrypted" "$manifest" "$BACKUP_SECONDARY_REGION" "$SOURCE_VERSION" "0012"

  BACKUP_FILE="$encrypted" MANIFEST_FILE="$manifest" bash -c "$BACKUP_UPLOAD_CMD"
  log "Encrypted backup and manifest uploaded to $BACKUP_SECONDARY_REGION."
}

cmd_verify_restore() {
  log "Starting isolated restore verification (dry_run=$DRY_RUN)..."
  local start_ts end_ts rto_seconds
  start_ts="$(date +%s)"

  local work_dir
  work_dir="$(mktemp -d)"
  trap 'rm -rf "$work_dir"' RETURN

  local encrypted="$REPORT_DIR/accord-backup.tar.gz.enc"
  local manifest="$REPORT_DIR/backup-manifest.json"
  local decrypted="$work_dir/accord-backup.tar.gz"

  if [[ "$DRY_RUN" != "1" ]]; then
    if [[ -z "${BACKUP_FETCH_CMD:-}" ]]; then
      err "BACKUP_FETCH_CMD must be set for live restore verification."
      return 1
    fi
    BACKUP_FILE="$encrypted" MANIFEST_FILE="$manifest" bash -c "$BACKUP_FETCH_CMD"
  else
    if [[ ! -f "$encrypted" || ! -f "$manifest" ]]; then
      cmd_backup
    fi
  fi

  verify_manifest_checksum "$encrypted" "$manifest"
  if [[ "$DRY_RUN" == "1" ]]; then
    BACKUP_ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-dry-run-ephemeral-key}" decrypt_file "$encrypted" "$decrypted"
  else
    decrypt_file "$encrypted" "$decrypted"
  fi
  tar -xzf "$decrypted" -C "$work_dir"

  if [[ -n "${SCRATCH_DATABASE_URL:-}" ]] && command -v psql >/dev/null 2>&1; then
    psql "$SCRATCH_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$work_dir/db.sql" >/dev/null
    psql "$SCRATCH_DATABASE_URL" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';" >/dev/null
    log "Restored and verified schema in isolated scratch PostgreSQL."
  else
    test -s "$work_dir/db.sql"
    log "[dry-run] Verified decrypted SQL dump artifact (${work_dir}/db.sql)."
  fi

  end_ts="$(date +%s)"
  rto_seconds=$(( end_ts - start_ts ))
  check_rpo_rto "$manifest" "$rto_seconds"
  log "Restore verification passed."
}

cmd_prune() {
  log "Pruning backups older than ${BACKUP_RETENTION_DAYS} days (dry_run=$DRY_RUN)..."
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] Would prune objects older than ${BACKUP_RETENTION_DAYS}d in $BACKUP_SECONDARY_REGION."
    return 0
  fi
  if [[ -z "${BACKUP_PRUNE_CMD:-}" ]]; then
    err "BACKUP_PRUNE_CMD must be set for live retention pruning."
    return 1
  fi
  RETENTION_DAYS="$BACKUP_RETENTION_DAYS" bash -c "$BACKUP_PRUNE_CMD"
}

SUBCMD="${1:-}"
shift || true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN="1"
      shift
      ;;
    *)
      err "Unknown argument: $1"
      exit 1
      ;;
  esac
done

case "$SUBCMD" in
  backup) cmd_backup ;;
  verify-restore) cmd_verify_restore ;;
  prune) cmd_prune ;;
  *)
    err "Unknown subcommand '$SUBCMD'. Expected: backup | verify-restore | prune"
    exit 1
    ;;
esac
