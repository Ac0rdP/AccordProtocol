#!/usr/bin/env bash
# Fixture-based tests for scripts/verify-release.sh (no network required).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY_SCRIPT="$SCRIPT_DIR/verify-release.sh"

TMP_ROOT="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

compute_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Create fixture artifact and valid checksum + offline provenance bundle.
FIXTURE_DIR="$TMP_ROOT/valid"
mkdir -p "$FIXTURE_DIR"
printf 'accord-wasm-fixture-bytes\n' > "$FIXTURE_DIR/accord.wasm"
HASH="$(compute_sha256 "$FIXTURE_DIR/accord.wasm")"
printf '%s  accord.wasm\n' "$HASH" > "$FIXTURE_DIR/SHA256SUMS.txt"

cat > "$FIXTURE_DIR/bundle.json" <<EOF
{
  "subjects": [
    {
      "name": "accord.wasm",
      "digest": { "sha256": "$HASH" }
    }
  ],
  "signerIdentity": {
    "repository": "Ac0rdP/AccordProtocol",
    "workflow": ".github/workflows/release.yml"
  }
}
EOF

echo "Test 1: Valid artifact, checksum, and offline provenance bundle should pass"
bash "$VERIFY_SCRIPT" \
  --dir "$FIXTURE_DIR" \
  --offline-bundle "$FIXTURE_DIR/bundle.json" \
  --repo "Ac0rdP/AccordProtocol" \
  --workflow ".github/workflows/release.yml"

echo "Test 2: Dry-run mode with valid checksum should pass"
bash "$VERIFY_SCRIPT" --dir "$FIXTURE_DIR" --dry-run

echo "Test 3: Wrong checksum must fail nonzero"
BAD_SUM_DIR="$TMP_ROOT/bad-checksum"
cp -R "$FIXTURE_DIR" "$BAD_SUM_DIR"
printf '0000000000000000000000000000000000000000000000000000000000000000  accord.wasm\n' > "$BAD_SUM_DIR/SHA256SUMS.txt"
if bash "$VERIFY_SCRIPT" --dir "$BAD_SUM_DIR" --offline-bundle "$BAD_SUM_DIR/bundle.json" 2>/dev/null; then
  echo "FAIL: Expected wrong checksum to fail" >&2
  exit 1
fi
echo "PASS: Wrong checksum rejected"

echo "Test 4: Wrong signer identity (repository/workflow) must fail nonzero"
if bash "$VERIFY_SCRIPT" \
  --dir "$FIXTURE_DIR" \
  --offline-bundle "$FIXTURE_DIR/bundle.json" \
  --repo "evil-fork/AccordProtocol" 2>/dev/null; then
  echo "FAIL: Expected wrong repository identity to fail" >&2
  exit 1
fi
echo "PASS: Wrong identity rejected"

echo "Test 5: Missing attestation bundle must fail nonzero"
if bash "$VERIFY_SCRIPT" \
  --dir "$FIXTURE_DIR" \
  --offline-bundle "$FIXTURE_DIR/does-not-exist.json" 2>/dev/null; then
  echo "FAIL: Expected missing attestation bundle to fail" >&2
  exit 1
fi
echo "PASS: Missing attestation rejected"

echo "All verify-release.sh fixture tests passed."
