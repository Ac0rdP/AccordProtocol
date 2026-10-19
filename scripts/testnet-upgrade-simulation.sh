#!/usr/bin/env bash
# Testnet upgrade simulation (#816).
#
# Deploys a legacy-shaped build to Stellar testnet, upgrades it to the current
# build, runs `migrate_to_weighted_governance`, and verifies that owners,
# weights, totals, and an in-flight proposal survive the upgrade unchanged.
#
# The legacy build is produced with the `legacy-fixture` cargo feature. That
# feature makes `initialize` omit the governance-migration flag and the
# storage-schema stamp, so the deployed contract behaves like a deployment that
# predates those migrations. The feature must never be used for production.
#
# Usage:
#   bash scripts/testnet-upgrade-simulation.sh
#
# Environment:
#   NETWORK            Stellar network name (default: testnet)
#   IDENTITY           Deployer identity name (default: ephemeral)
#   ARTIFACT_DIR       Report/artifact directory (default: target/testnet-upgrade-simulation)
#   KEEP_IDENTITIES=1  Keep the generated identities for debugging
#   SKIP_BUILD=1       Reuse existing WASM artifacts in ARTIFACT_DIR
#
# The testnet contract is intentionally left isolated: Soroban has no
# "delete contract" operation. The generated deployer keys are removed in the
# EXIT trap, and the contract holds no funds.
set -euo pipefail

NETWORK="${NETWORK:-testnet}"
IDENTITY="${IDENTITY:-accord-upgrade-sim-$$}"
ARTIFACT_DIR="${ARTIFACT_DIR:-target/testnet-upgrade-simulation}"
TMP_DIR="$(mktemp -d)"
REPORT="$ARTIFACT_DIR/report.md"
LOG="$ARTIFACT_DIR/simulation.log"
FAILURES=0

mkdir -p "$ARTIFACT_DIR"
: > "$LOG"

PYTHON="${PYTHON:-}"
if [[ -z "$PYTHON" ]]; then
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys' >/dev/null 2>&1; then
      PYTHON="$candidate"
      break
    fi
  done
fi
if [[ -z "$PYTHON" ]]; then
  echo "ERROR: python3 (or python) is required." >&2
  exit 1
fi
if ! command -v stellar >/dev/null 2>&1; then
  echo "ERROR: stellar CLI is required." >&2
  exit 1
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "ERROR: cargo is required." >&2
  exit 1
fi

log() {
  printf '%s\n' "$*" | tee -a "$LOG"
}

cleanup() {
  local status=$?
  if [[ "${KEEP_IDENTITIES:-0}" != "1" ]]; then
    for name in "${OWNER_B_ID:-}" "${OWNER_C_ID:-}" "$IDENTITY"; do
      [[ -n "$name" ]] || continue
      # `keys rm` reads a confirmation from stdin; feed it non-interactively.
      printf 'y\n' | stellar keys rm "$name" >/dev/null 2>&1 || true
    done
  fi
  rm -rf "$TMP_DIR"
  exit "$status"
}
trap cleanup EXIT

record() {
  local result="$1" label="$2"
  log "[$result] $label"
  printf '| %s | %s |\n' "$label" "$result" >> "$REPORT"
  if [[ "$result" != "PASS" ]]; then
    FAILURES=$((FAILURES + 1))
  fi
}

check_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    record PASS "$label"
  else
    record FAIL "$label (expected '$expected', got '$actual')"
  fi
}

check_true() {
  local label="$1" condition="$2"
  if [[ "$condition" == "true" ]]; then
    record PASS "$label"
  else
    record FAIL "$label (expected true, got '$condition')"
  fi
}

check_json() {
  local label="$1" json="$2" expression="$3"
  if printf '%s' "$json" | "$PYTHON" -c "import json,sys; d=json.load(sys.stdin); assert $expression" >/dev/null 2>&1; then
    record PASS "$label"
  else
    record FAIL "$label (JSON did not satisfy: $expression)"
  fi
}

check_same_set() {
  local label="$1" before="$2" after="$3"
  if "$PYTHON" -c 'import json,sys; a=json.loads(sys.argv[1]); b=json.loads(sys.argv[2]); assert len(a) == len(b) and set(a) == set(b)' "$before" "$after" >/dev/null 2>&1; then
    record PASS "$label"
  else
    record FAIL "$label (sets differ)"
  fi
}

last_line() {
  printf '%s\n' "$1" | tr -d '\r' | awk 'NF { line=$0 } END { print line }'
}

strip_scalar() {
  last_line "$1" | tr -d '"[:space:]'
}

stellar_out() {
  local out
  if ! out="$(stellar "$@" 2>"$TMP_DIR/stellar.err")"; then
    cat "$TMP_DIR/stellar.err" >&2
    log "ERROR: stellar $*"
    return 1
  fi
  printf '%s' "$out"
}

stellar_quiet() {
  stellar_out "$@" >/dev/null
}

retry() {
  local attempts=5 delay=5 n=1
  until "$@"; do
    if (( n >= attempts )); then
      return 1
    fi
    log "Retrying in ${delay}s ($n/$attempts)..."
    sleep "$delay"
    n=$((n + 1))
    delay=$((delay * 2))
  done
}

invoke() {
  stellar_out contract invoke --auto-sign \
    --network "$NETWORK" \
    --source-account "$IDENTITY" \
    --id "$CONTRACT_ID" \
    -- "$@"
}

read_value() {
  strip_scalar "$(invoke "$@")"
}

read_json() {
  invoke "$@"
}

wait_for_identity() {
  local name="$1"
  retry stellar keys fund "$name" --network "$NETWORK" >/dev/null
}

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  log "==> Building legacy fixture WASM (legacy-fixture feature)..."
  stellar contract build --package accord --features legacy-fixture
  cp target/wasm32v1-none/release/accord.wasm "$ARTIFACT_DIR/accord-legacy.wasm"

  log "==> Building current WASM..."
  stellar contract build --package accord
  cp target/wasm32v1-none/release/accord.wasm "$ARTIFACT_DIR/accord-current.wasm"
fi

LEGACY_WASM="$ARTIFACT_DIR/accord-legacy.wasm"
CURRENT_WASM="$ARTIFACT_DIR/accord-current.wasm"
[[ -f "$LEGACY_WASM" ]] || { log "ERROR: missing $LEGACY_WASM"; exit 1; }
[[ -f "$CURRENT_WASM" ]] || { log "ERROR: missing $CURRENT_WASM"; exit 1; }

LEGACY_SHA="$(sha256sum "$LEGACY_WASM" | awk '{print $1}')"
CURRENT_SHA="$(sha256sum "$CURRENT_WASM" | awk '{print $1}')"
[[ "$LEGACY_SHA" != "$CURRENT_SHA" ]] || {
  log "ERROR: legacy and current WASM artifacts are identical; the fixture feature had no effect."
  exit 1
}

CONTRACT_VERSION="$(sed -n 's/^const CONTRACT_VERSION: u32 = \([0-9][0-9]*\);/\1/p' contracts/accord/src/lib.rs | head -n1)"
STORAGE_VERSION="$(sed -n 's/^const STORAGE_SCHEMA_VERSION: u32 = \([0-9][0-9]*\);/\1/p' contracts/accord/src/lib.rs | head -n1)"
[[ -n "$CONTRACT_VERSION" && -n "$STORAGE_VERSION" ]] || {
  log "ERROR: could not read CONTRACT_VERSION / STORAGE_SCHEMA_VERSION from source."
  exit 1
}

cat > "$REPORT" <<EOF
# Testnet Upgrade Simulation (#816)

- Network: \`$NETWORK\`
- Legacy WASM SHA-256: \`$LEGACY_SHA\`
- Current WASM SHA-256: \`$CURRENT_SHA\`
- Legacy artifact: \`$LEGACY_WASM\`
- Current artifact: \`$CURRENT_WASM\`

## Checks

| Check | Result |
| --- | --- |
EOF

# ---------------------------------------------------------------------------
# Ephemeral identities
# ---------------------------------------------------------------------------
log "==> Creating ephemeral testnet identities..."
stellar keys generate "$IDENTITY" >/dev/null
wait_for_identity "$IDENTITY"
OWNER_A="$(stellar keys address "$IDENTITY")"

OWNER_B_ID="accord-upgrade-sim-b-$$"
stellar keys generate "$OWNER_B_ID" >/dev/null
OWNER_B="$(stellar keys address "$OWNER_B_ID")"
printf 'y\n' | stellar keys rm "$OWNER_B_ID" >/dev/null 2>&1 || true

OWNER_C_ID="accord-upgrade-sim-c-$$"
stellar keys generate "$OWNER_C_ID" >/dev/null
OWNER_C="$(stellar keys address "$OWNER_C_ID")"
printf 'y\n' | stellar keys rm "$OWNER_C_ID" >/dev/null 2>&1 || true

log "Deployer/owner A: $OWNER_A"
log "Owner B: $OWNER_B"
log "Owner C: $OWNER_C"

# ---------------------------------------------------------------------------
# Deploy legacy fixture and build pre-upgrade state
# ---------------------------------------------------------------------------
log "==> Deploying legacy fixture to $NETWORK..."
CONTRACT_ID="$(last_line "$(stellar_out contract deploy --network "$NETWORK" --source-account "$IDENTITY" --wasm "$LEGACY_WASM")")"
[[ "$CONTRACT_ID" == C* ]] || { log "ERROR: could not parse contract id: $CONTRACT_ID"; exit 1; }
log "Contract ID: $CONTRACT_ID"

NOW="$(date +%s)"
DEADLINE=$((NOW + 7200))
NATIVE_TOKEN="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"

printf '["%s"]\n' "$OWNER_A" > "$TMP_DIR/owners.json"
printf '[1]\n' > "$TMP_DIR/weights.json"
printf '["%s"]\n' "$OWNER_A" > "$TMP_DIR/approvers.json"

log "==> Initializing legacy contract with owner A (threshold 1)..."
stellar_quiet contract invoke --auto-sign \
  --network "$NETWORK" --source-account "$IDENTITY" --id "$CONTRACT_ID" -- \
  initialize \
  --owners-file-path "$TMP_DIR/owners.json" \
  --weights-file-path "$TMP_DIR/weights.json" \
  --threshold 1 \
  --time_lock_delay 0

add_owner() {
  local new_owner="$1" label="$2"
  local proposal_id
  proposal_id="$(strip_scalar "$(invoke create_add_owner_proposal \
    --proposer "$OWNER_A" \
    --new_owner "$new_owner" \
    --weight 1 \
    --description "testnet upgrade sim: add $label" \
    --deadline "$DEADLINE")")"
  [[ "$proposal_id" =~ ^[0-9]+$ ]] || {
    log "ERROR: could not parse add-owner proposal id: $proposal_id"
    exit 1
  }
  invoke approve --approver "$OWNER_A" --proposal_id "$proposal_id" >/dev/null
  invoke execute --executor "$OWNER_A" --proposal_id "$proposal_id" >/dev/null
  log "Added owner $label via proposal $proposal_id"
}

add_owner "$OWNER_B" "B"
add_owner "$OWNER_C" "C"

log "==> Creating an in-flight proposal before the upgrade..."
printf '[{"to":"%s","token":"%s","amount":"1"}]\n' "$OWNER_B" "$NATIVE_TOKEN" > "$TMP_DIR/transfers.json"
PROPOSAL_ID="$(strip_scalar "$(invoke create_proposal \
  --proposer "$OWNER_A" \
  --transfers-file-path "$TMP_DIR/transfers.json" \
  --description "pre-upgrade in-flight proposal" \
  --deadline "$DEADLINE" \
  --category '"Transfer"')")"
[[ "$PROPOSAL_ID" =~ ^[0-9]+$ ]] || {
  log "ERROR: could not parse in-flight proposal id: $PROPOSAL_ID"
  exit 1
}
log "In-flight proposal ID: $PROPOSAL_ID"

PRE_TOTAL_PROPOSALS="$(read_value get_total_proposals)"
PRE_OWNERS="$(read_json get_owners)"
PRE_TOTAL_WEIGHT="$(read_value get_total_weight)"
PRE_THRESHOLD="$(read_value get_threshold)"
PRE_PROPOSAL="$(read_json get_proposal --proposal_id "$PROPOSAL_ID")"
PRE_STORAGE_VERSION="$(read_value get_storage_version)"
PRE_GOVERNANCE_MIGRATED="$(read_value is_governance_migrated)"
PRE_ROLE_VERSION="$(read_value get_role_version)"
PRE_VERSION="$(read_value get_version)"

check_eq "legacy fixture starts with storage schema version 0" "0" "$PRE_STORAGE_VERSION"
check_eq "legacy fixture starts unmigrated for weighted governance" "false" "$PRE_GOVERNANCE_MIGRATED"
check_true "legacy fixture already has RBAC roles" "$([[ "$PRE_ROLE_VERSION" -gt 0 ]] && echo true || echo false)"
check_json "three owners exist before upgrade" "$PRE_OWNERS" "len(d) == 3"
check_eq "total weight before upgrade" "3" "$PRE_TOTAL_WEIGHT"
check_eq "threshold before upgrade" "1" "$PRE_THRESHOLD"
check_json "in-flight proposal is Pending with zero approvals" "$PRE_PROPOSAL" "d['status'] == 'Pending' and d['approvals'] == 0"
check_json "in-flight proposal snapshots quorum weight 1" "$PRE_PROPOSAL" "d['quorum_weight'] == 1"
check_json "in-flight proposal is a Transfer" "$PRE_PROPOSAL" "d['category'] == 'Transfer'"

# ---------------------------------------------------------------------------
# Upgrade to the current build
# ---------------------------------------------------------------------------
log "==> Uploading current WASM and upgrading in place..."
NEW_WASM_HASH="$(last_line "$(stellar_out contract upload --network "$NETWORK" --source-account "$IDENTITY" --wasm "$CURRENT_WASM")")"
[[ -n "$NEW_WASM_HASH" ]] || { log "ERROR: could not read uploaded WASM hash"; exit 1; }
log "New WASM hash: $NEW_WASM_HASH"

stellar_quiet contract invoke --auto-sign \
  --network "$NETWORK" --source-account "$IDENTITY" --id "$CONTRACT_ID" -- \
  upgrade \
  --approvers-file-path "$TMP_DIR/approvers.json" \
  --new_wasm_hash "$NEW_WASM_HASH"

POST_UPGRADE_VERSION="$(read_value get_version)"
POST_UPGRADE_OWNERS="$(read_json get_owners)"
POST_UPGRADE_TOTAL_WEIGHT="$(read_value get_total_weight)"
POST_UPGRADE_PROPOSAL="$(read_json get_proposal --proposal_id "$PROPOSAL_ID")"
POST_UPGRADE_STORAGE_VERSION="$(read_value get_storage_version)"
POST_UPGRADE_GOVERNANCE_MIGRATED="$(read_value is_governance_migrated)"

check_eq "contract version after upgrade" "$CONTRACT_VERSION" "$POST_UPGRADE_VERSION"
check_same_set "owners preserved across upgrade" "$PRE_OWNERS" "$POST_UPGRADE_OWNERS"
check_eq "total weight preserved across upgrade" "$PRE_TOTAL_WEIGHT" "$POST_UPGRADE_TOTAL_WEIGHT"
check_json "in-flight proposal preserved across upgrade" "$POST_UPGRADE_PROPOSAL" "d['status'] == 'Pending' and d['approvals'] == 0 and d['quorum_weight'] == 1"
check_eq "storage schema still legacy immediately after upgrade" "0" "$POST_UPGRADE_STORAGE_VERSION"
check_eq "governance still unmigrated immediately after upgrade" "false" "$POST_UPGRADE_GOVERNANCE_MIGRATED"

# ---------------------------------------------------------------------------
# Migration
# ---------------------------------------------------------------------------
log "==> Running migrate_to_weighted_governance..."
stellar_quiet contract invoke --auto-sign \
  --network "$NETWORK" --source-account "$IDENTITY" --id "$CONTRACT_ID" -- \
  migrate_to_weighted_governance \
  --approvers-file-path "$TMP_DIR/approvers.json"

POST_MIGRATION_OWNERS="$(read_json get_owners)"
POST_MIGRATION_WEIGHTS="$(read_json get_owner_weights)"
POST_MIGRATION_TOTAL_WEIGHT="$(read_value get_total_weight)"
POST_MIGRATION_THRESHOLD="$(read_value get_threshold)"
POST_MIGRATION_PROPOSAL="$(read_json get_proposal --proposal_id "$PROPOSAL_ID")"
POST_MIGRATION_PROGRESS="$(read_json get_proposal_approval_progress --proposal_id "$PROPOSAL_ID")"
POST_MIGRATION_STORAGE_VERSION="$(read_value get_storage_version)"
POST_MIGRATION_GOVERNANCE_MIGRATED="$(read_value is_governance_migrated)"
POST_MIGRATION_TOTAL_PROPOSALS="$(read_value get_total_proposals)"

check_eq "governance migration flag set" "true" "$POST_MIGRATION_GOVERNANCE_MIGRATED"
check_eq "migration stamps storage schema version" "$STORAGE_VERSION" "$POST_MIGRATION_STORAGE_VERSION"
check_same_set "owners preserved across migration" "$PRE_OWNERS" "$POST_MIGRATION_OWNERS"
check_eq "total weight preserved across migration" "$PRE_TOTAL_WEIGHT" "$POST_MIGRATION_TOTAL_WEIGHT"
check_json "every owner has weight 1 after migration" "$POST_MIGRATION_WEIGHTS" "len(d) == 3 and all(x['weight'] == 1 for x in d)"
check_eq "threshold preserved across migration" "$PRE_THRESHOLD" "$POST_MIGRATION_THRESHOLD"
check_eq "proposal count preserved across migration" "$PRE_TOTAL_PROPOSALS" "$POST_MIGRATION_TOTAL_PROPOSALS"
check_json "in-flight proposal preserved across migration" "$POST_MIGRATION_PROPOSAL" "d['status'] == 'Pending' and d['approvals'] == 0 and d['quorum_weight'] == 1"
check_json "approval progress still reflects the pre-upgrade snapshot" "$POST_MIGRATION_PROGRESS" "d['approval_weight'] == 0 and d['quorum_weight'] == 1 and d['total_weight'] == 3"

# ---------------------------------------------------------------------------
# Post-migration behaviour on the pre-existing proposal
# ---------------------------------------------------------------------------
log "==> Exercising the pre-existing proposal after migration..."
invoke approve --approver "$OWNER_A" --proposal_id "$PROPOSAL_ID" >/dev/null
PROPOSAL_AFTER_APPROVE="$(read_json get_proposal --proposal_id "$PROPOSAL_ID")"
check_json "pre-upgrade proposal becomes Ready after post-migration approval" "$PROPOSAL_AFTER_APPROVE" "d['status'] == 'Ready' and d['approvals'] == 1"

invoke revoke --approver "$OWNER_A" --proposal_id "$PROPOSAL_ID" >/dev/null
PROPOSAL_AFTER_REVOKE="$(read_json get_proposal --proposal_id "$PROPOSAL_ID")"
check_json "pre-upgrade proposal returns to Pending after revoke" "$PROPOSAL_AFTER_REVOKE" "d['status'] == 'Pending' and d['approvals'] == 0"

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
cat >> "$REPORT" <<EOF

## Deployment

| Field | Value |
| --- | --- |
| Contract ID | \`$CONTRACT_ID\` |
| Owner A / deployer | \`$OWNER_A\` |
| Owner B | \`$OWNER_B\` |
| Owner C | \`$OWNER_C\` |
| In-flight proposal | \`$PROPOSAL_ID\` |
| Legacy WASM SHA-256 | \`$LEGACY_SHA\` |
| Current WASM SHA-256 | \`$CURRENT_SHA\` |
| Uploaded current WASM hash | \`$NEW_WASM_HASH\` |
| Storage schema | \`$PRE_STORAGE_VERSION\` -> \`$POST_MIGRATION_STORAGE_VERSION\` |
| Governance migrated | \`$PRE_GOVERNANCE_MIGRATED\` -> \`$POST_MIGRATION_GOVERNANCE_MIGRATED\` |
| Total weight | \`$PRE_TOTAL_WEIGHT\` -> \`$POST_MIGRATION_TOTAL_WEIGHT\` |

## Cleanup

- Ephemeral deployer and owner identities are removed by the EXIT trap unless
  \`KEEP_IDENTITIES=1\`.
- The contract is intentionally left isolated on testnet. Soroban has no
  contract-delete operation; the instance holds no funds and uses a unique
  per-run ID, so it expires naturally when its storage TTL lapses.
EOF

log ""
log "Report written to $REPORT"
if [[ "$FAILURES" -ne 0 ]]; then
  log "FAILED: $FAILURES check(s) failed."
  exit 1
fi
log "PASSED: testnet deploy -> upgrade -> migrate -> verify simulation succeeded."
