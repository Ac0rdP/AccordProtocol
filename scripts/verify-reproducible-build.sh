#!/usr/bin/env bash
# Verify byte-for-byte reproducible WASM builds for the Accord smart contract.
#
# This script builds the contract WASM artifact in two isolated passes and verifies
# that their SHA-256 digests are character-for-character identical across runs.
#
# Usage:
#   bash scripts/verify-reproducible-build.sh
#   DRY_RUN=1 bash scripts/verify-reproducible-build.sh
#
# Exit status:
#   0 - WASM build is byte-for-byte reproducible.
#   1 - Build failed or bytecode digests differ between passes.
set -euo pipefail

REPORT_DIR="target/reproducible-build"
mkdir -p "$REPORT_DIR"

STATUS_FILE="$REPORT_DIR/status.txt"
REPORT_FILE="$REPORT_DIR/failure-report.txt"
WASM_REL_PATH="target/wasm32v1-none/release/accord.wasm"
MAX_SIZE_KB=512

echo "=== Accord Protocol: Reproducible Contract Build Verification ==="
echo "Report directory: $REPORT_DIR"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "[dry-run] Dry run mode enabled. Validating verification environment..."
  echo "Host architecture: $(uname -m)"
  echo "OS: $(uname -s)"
  if command -v rustc >/dev/null 2>&1; then
    rustc --version
  fi
  if command -v stellar >/dev/null 2>&1; then
    stellar --version
  fi
  echo "dry_run: passed" > "$STATUS_FILE"
  echo "Reproducible build environment validated in dry-run mode."
  exit 0
fi

PASS1_DIR="$REPORT_DIR/pass1"
PASS2_DIR="$REPORT_DIR/pass2"
rm -rf "$PASS1_DIR" "$PASS2_DIR"
mkdir -p "$PASS1_DIR" "$PASS2_DIR"

echo "--> Pass 1: Building contract WASM..."
if command -v stellar >/dev/null 2>&1; then
  stellar contract build
else
  cargo build --target wasm32v1-none --release --package accord --locked
fi

if [[ ! -f "$WASM_REL_PATH" ]]; then
  echo "ERROR: Target WASM not found at $WASM_REL_PATH after Pass 1." >&2
  exit 1
fi

cp "$WASM_REL_PATH" "$PASS1_DIR/accord.wasm"

# Compute hash of Pass 1
if command -v sha256sum >/dev/null 2>&1; then
  HASH1=$(sha256sum "$PASS1_DIR/accord.wasm" | awk '{print $1}')
else
  HASH1=$(shasum -a 256 "$PASS1_DIR/accord.wasm" | awk '{print $1}')
fi
SIZE1=$(wc -c < "$PASS1_DIR/accord.wasm" | tr -d ' ')
echo "Pass 1 WASM SHA-256: $HASH1 ($SIZE1 bytes)"

# Clean release artifacts before pass 2
cargo clean -p accord --target wasm32v1-none --release || true

echo "--> Pass 2: Rebuilding contract WASM in clean environment..."
if command -v stellar >/dev/null 2>&1; then
  stellar contract build
else
  cargo build --target wasm32v1-none --release --package accord --locked
fi

if [[ ! -f "$WASM_REL_PATH" ]]; then
  echo "ERROR: Target WASM not found at $WASM_REL_PATH after Pass 2." >&2
  exit 1
fi

cp "$WASM_REL_PATH" "$PASS2_DIR/accord.wasm"

# Compute hash of Pass 2
if command -v sha256sum >/dev/null 2>&1; then
  HASH2=$(sha256sum "$PASS2_DIR/accord.wasm" | awk '{print $1}')
else
  HASH2=$(shasum -a 256 "$PASS2_DIR/accord.wasm" | awk '{print $1}')
fi
SIZE2=$(wc -c < "$PASS2_DIR/accord.wasm" | tr -d ' ')
echo "Pass 2 WASM SHA-256: $HASH2 ($SIZE2 bytes)"

# Size check
SIZE_KB=$(( SIZE1 / 1024 ))
if [[ "$SIZE_KB" -gt "$MAX_SIZE_KB" ]]; then
  echo "ERROR: WASM size (${SIZE_KB}KB) exceeds limit of ${MAX_SIZE_KB}KB." >&2
  exit 1
fi

# Compare byte-for-byte
if cmp -s "$PASS1_DIR/accord.wasm" "$PASS2_DIR/accord.wasm"; then
  echo "OK: Byte-for-byte match verified between Pass 1 and Pass 2."
  echo "reproducible: true" > "$STATUS_FILE"
  echo "wasm_hash: $HASH1" >> "$STATUS_FILE"
  echo "wasm_size_bytes: $SIZE1" >> "$STATUS_FILE"

  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo "### Contract Reproducible Build Verification"
      echo "- **Status**: Verified byte-for-byte identical"
      echo "- **WASM SHA-256**: \`$HASH1\`"
      echo "- **Binary Size**: \`$SIZE1\` bytes ($SIZE_KB KB)"
    } >> "$GITHUB_STEP_SUMMARY"
  fi
  exit 0
else
  echo "::error::Reproducible build failed! Bytecode mismatch detected between build passes." >&2
  {
    echo "Bytecode mismatch detected between Pass 1 and Pass 2:"
    echo "Pass 1 SHA-256: $HASH1 ($SIZE1 bytes)"
    echo "Pass 2 SHA-256: $HASH2 ($SIZE2 bytes)"
    if [[ -n "${GITHUB_SERVER_URL:-}" && -n "${GITHUB_REPOSITORY:-}" && -n "${GITHUB_RUN_ID:-}" ]]; then
      echo "Run Details: ${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
    fi
  } > "$REPORT_FILE"

  cat "$REPORT_FILE" >&2
  exit 1
fi
