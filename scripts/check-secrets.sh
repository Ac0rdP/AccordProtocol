#!/usr/bin/env bash
set -euo pipefail

allowlist="scripts/check-secrets.allowlist"

files=$(git ls-files -z | xargs -0 -r grep -Il . || true)
if [ -z "$files" ]; then exit 0; fi

# Remove reviewed false positives. An allowlist entry matches one exact
# "<path>|<line>" pair, so it cannot suppress the same text in another file and
# cannot be broadened into a pattern.
filter_allowlisted() {
  local hit file rest content
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    file=${hit%%:*}
    rest=${hit#*:}
    content=${rest#*:}
    if [ -f "$allowlist" ] && command grep -qxF -- "${file}|${content}" "$allowlist"; then
      continue
    fi
    printf '%s\n' "$hit"
  done
}

token_matches=$(printf '%s\n' "$files" | xargs grep -nE -- '-----BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|Bearer[[:space:]]+[A-Za-z0-9._~-]{20,}' || true)
token_matches=$(printf '%s\n' "$token_matches" | filter_allowlisted)
if [ -n "$token_matches" ]; then
  printf '%s\n' "$token_matches" >&2
  echo "Potential secret detected in tracked files" >&2
  exit 1
fi

assignment_matches=$(printf '%s\n' "$files" | xargs grep -nE -- '(^|[^A-Za-z])(SECRET|API_TOKEN|ACCESS_TOKEN|PRIVATE_KEY|RPC_KEY|DATABASE_URL)[[:space:]]*=[[:space:]]*[^$<{[:space:]]{8,}' | grep -vE '(example|placeholder|changeme|your[-_])' || true)
assignment_matches=$(printf '%s\n' "$assignment_matches" | filter_allowlisted)
if [ -n "$assignment_matches" ]; then
  printf '%s\n' "$assignment_matches" >&2
  echo "Potential hard-coded secret assignment detected" >&2
  exit 1
fi
