#!/usr/bin/env bash
# Verify that the committed contract test snapshots match a fresh test run.
#
# Soroban writes a snapshot whenever an Env is dropped during a test. The
# deterministic tests reproduce their snapshots exactly. Property tests use
# `non_snapshot_env()` because their random inputs would otherwise churn the
# snapshot directory on every run.
#
# Usage:
#   bash scripts/verify-snapshots.sh [test-name-filter]
#
# Exit status is 1 when any tracked snapshot is added, removed, or modified.
# Test failures are reported but do not fail this check: the regular Contract CI
# job owns them, and a failing test can still write a snapshot that needs to be
# detected. A readable status list and patch are written to
# target/snapshot-verification/ for CI artifacts.
#
# Set SNAPSHOT_VERIFY_WARN_ONLY=1 to report drift as a warning instead of
# failing. CI uses this mode so an existing stale snapshot baseline cannot block
# every pull request; the full patch is still uploaded as an artifact.
set -uo pipefail

warn_only="${SNAPSHOT_VERIFY_WARN_ONLY:-0}"
snapshot_dir="contracts/accord/test_snapshots"
report_dir="target/snapshot-verification"
mkdir -p "$report_dir"

test_status=0
echo "Running contract test suite..."
cargo test -p accord --lib --no-fail-fast "$@" || test_status=$?

status_file="$report_dir/status.txt"
patch_file="$report_dir/snapshots.patch"
: > "$status_file"

# Compare content rather than line endings: `core.autocrlf` can make Windows
# checkouts look modified even when a fresh run reproduces the committed bytes.
git diff --ignore-cr-at-eol --name-status -- "$snapshot_dir" >> "$status_file"
untracked_file="$report_dir/untracked.txt"
git ls-files --others --exclude-standard -- "$snapshot_dir" > "$untracked_file"
sed 's/^/?\t/' "$untracked_file" >> "$status_file"

git diff --ignore-cr-at-eol -- "$snapshot_dir" > "$patch_file"
while IFS= read -r snapshot; do
  [[ -n "$snapshot" ]] || continue
  git diff --no-index -- /dev/null "$snapshot" >> "$patch_file" || true
done < "$untracked_file"

if [[ -s "$status_file" ]]; then
  if [[ "$warn_only" == "1" ]]; then
    echo "::warning::Committed snapshots do not match a fresh test run (advisory)."
  else
    echo "::error::Committed snapshots do not match a fresh test run."
  fi
  echo
  echo "Changed snapshots:"
  cat "$status_file"
  echo
  git diff --ignore-cr-at-eol --stat -- "$snapshot_dir"
  echo
  echo "Full diff written to $patch_file"

  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo "## Snapshot drift detected"
      echo
      if [[ "$warn_only" == "1" ]]; then
        echo "This report is advisory: the job does not fail on snapshot drift, so"
        echo "an existing stale baseline cannot block merges. Review the patch and"
        echo "either refresh the snapshots in this PR or leave the warning for a"
        echo "follow-up cleanup."
      else
        echo "The committed snapshots in \`$snapshot_dir\` do not match a fresh run."
      fi
      echo
      echo '```'
      cat "$status_file"
      echo '```'
      echo
      echo "Download the \`contract-snapshot-verification\` artifact for the full diff."
    } >> "$GITHUB_STEP_SUMMARY"
  fi

  if [[ "$warn_only" == "1" ]]; then
    exit 0
  fi
  exit 1
fi

if [[ "$test_status" -ne 0 ]]; then
  echo "::warning::The contract test suite reported failures, but no snapshot drift was detected."
fi

echo "Snapshot verification passed: committed snapshots match a fresh test run."
exit 0
