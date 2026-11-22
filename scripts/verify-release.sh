#!/usr/bin/env bash
# Verify Accord Protocol release artifacts: SHA-256 checksums and GitHub Build Provenance attestation.
#
# Usage:
#   bash scripts/verify-release.sh --dir <path> [--artifact accord.wasm] [--repo Ac0rdP/AccordProtocol]
#   bash scripts/verify-release.sh --tag v0.2.0 [--repo Ac0rdP/AccordProtocol]
#   bash scripts/verify-release.sh --dir <path> --offline-bundle <bundle.json>
#   bash scripts/verify-release.sh --dir <path> --dry-run
#
# Exit status:
#   0 - Checksum and provenance attestation verified (or dry-run checks passed).
#   1 - Missing artifact, checksum mismatch, missing/invalid attestation, or identity mismatch.
set -euo pipefail

REPO="Ac0rdP/AccordProtocol"
WORKFLOW=".github/workflows/release.yml"
ARTIFACT="accord.wasm"
CHECKSUMS_FILE="SHA256SUMS.txt"
DIR=""
TAG=""
OFFLINE_BUNDLE=""
DRY_RUN="${DRY_RUN:-0}"

usage() {
  cat <<'EOF'
Usage: verify-release.sh [OPTIONS]

Options:
  --dir <path>              Directory containing release artifacts and SHA256SUMS.txt
  --tag <vX.Y.Z>            Release tag to download via `gh release download` into a temp dir
  --repo <owner/repo>       Expected GitHub repository (default: Ac0rdP/AccordProtocol)
  --workflow <path>         Expected signer workflow path (default: .github/workflows/release.yml)
  --artifact <filename>     Artifact filename to verify (default: accord.wasm)
  --checksums <filename>    Checksums filename (default: SHA256SUMS.txt)
  --offline-bundle <path>   Verify against a local Sigstore/attestation JSON bundle (no network)
  --dry-run                 Validate artifact and checksums without calling `gh attestation verify`
  -h, --help                Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      DIR="${2:-}"
      shift 2
      ;;
    --tag)
      TAG="${2:-}"
      shift 2
      ;;
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --workflow)
      WORKFLOW="${2:-}"
      shift 2
      ;;
    --artifact)
      ARTIFACT="${2:-}"
      shift 2
      ;;
    --checksums)
      CHECKSUMS_FILE="${2:-}"
      shift 2
      ;;
    --offline-bundle)
      OFFLINE_BUNDLE="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

compute_sha256() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    echo "ERROR: Neither sha256sum nor shasum is available." >&2
    return 1
  fi
}

TMP_DIR=""
cleanup() {
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

if [[ -n "$TAG" ]]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "ERROR: GitHub CLI (gh) is required to download release tag '$TAG'." >&2
    exit 1
  fi
  TMP_DIR="$(mktemp -d)"
  DIR="$TMP_DIR"
  echo "Downloading release assets for tag '$TAG' from '$REPO'..."
  gh release download "$TAG" --repo "$REPO" --dir "$DIR"
fi

if [[ -z "$DIR" ]]; then
  echo "ERROR: Either --dir <path> or --tag <vX.Y.Z> must be specified." >&2
  exit 1
fi

ARTIFACT_PATH="$DIR/$ARTIFACT"
CHECKSUMS_PATH="$DIR/$CHECKSUMS_FILE"

if [[ ! -f "$ARTIFACT_PATH" ]]; then
  echo "ERROR: Release artifact not found: $ARTIFACT_PATH" >&2
  exit 1
fi

if [[ ! -f "$CHECKSUMS_PATH" ]]; then
  echo "ERROR: Checksums file not found: $CHECKSUMS_PATH" >&2
  exit 1
fi

EXPECTED_HASH="$(awk -v target="$ARTIFACT" '$2 == target || $2 == ("*" target) {print $1; exit}' "$CHECKSUMS_PATH")"
if [[ -z "$EXPECTED_HASH" ]]; then
  echo "ERROR: No checksum entry for '$ARTIFACT' found in $CHECKSUMS_PATH" >&2
  exit 1
fi

ACTUAL_HASH="$(compute_sha256 "$ARTIFACT_PATH")"
if [[ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]]; then
  echo "ERROR: SHA-256 checksum mismatch for '$ARTIFACT'!" >&2
  echo "  Expected: $EXPECTED_HASH" >&2
  echo "  Actual:   $ACTUAL_HASH" >&2
  exit 1
fi
echo "OK: SHA-256 checksum verified for $ARTIFACT ($ACTUAL_HASH)"

if [[ -n "$OFFLINE_BUNDLE" ]]; then
  if [[ ! -f "$OFFLINE_BUNDLE" ]]; then
    echo "ERROR: Offline attestation bundle not found: $OFFLINE_BUNDLE" >&2
    exit 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 is required to inspect offline attestation bundles." >&2
    exit 1
  fi
  python3 - "$OFFLINE_BUNDLE" "$ACTUAL_HASH" "$REPO" "$WORKFLOW" <<'PY'
import json
import sys

bundle_path, actual_hash, expected_repo, expected_workflow = sys.argv[1:5]
try:
    with open(bundle_path, encoding="utf-8") as f:
        bundle = json.load(f)
except Exception as exc:
    raise SystemExit(f"ERROR: Failed to parse attestation bundle '{bundle_path}': {exc}")

subjects = bundle.get("subjects") or []
if not any(s.get("digest", {}).get("sha256") == actual_hash for s in subjects):
    raise SystemExit(
        f"ERROR: Attestation bundle does not cover artifact SHA-256 '{actual_hash}'."
    )

identity = bundle.get("signerIdentity") or {}
repo = identity.get("repository", "")
workflow = identity.get("workflow", "")
if repo != expected_repo:
    raise SystemExit(
        f"ERROR: Attestation repository mismatch: expected '{expected_repo}', got '{repo}'."
    )
if workflow != expected_workflow:
    raise SystemExit(
        f"ERROR: Attestation workflow mismatch: expected '{expected_workflow}', got '{workflow}'."
    )

print(f"OK: Offline provenance bundle verified (repo={repo}, workflow={workflow})")
PY
  exit 0
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "[dry-run] Skipping network attestation verification (gh attestation verify)."
  echo "[dry-run] Would run: gh attestation verify \"$ARTIFACT_PATH\" --repo \"$REPO\" --signer-workflow \"$REPO/$WORKFLOW\""
  exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: GitHub CLI (gh) is required to verify build provenance attestations." >&2
  exit 1
fi

echo "Verifying GitHub build provenance attestation for '$ARTIFACT'..."
if ! gh attestation verify "$ARTIFACT_PATH" \
  --repo "$REPO" \
  --signer-workflow "$REPO/$WORKFLOW"; then
  echo "ERROR: Provenance attestation verification failed for '$ARTIFACT' (expected $REPO/$WORKFLOW)." >&2
  exit 1
fi

echo "OK: Release artifact '$ARTIFACT' verified (checksum + provenance attestation)."
