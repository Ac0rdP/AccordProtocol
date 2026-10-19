#!/usr/bin/env bash
set -euo pipefail

files=$(git ls-files -z | xargs -0 -r grep -Il . || true)
if [ -z "$files" ]; then exit 0; fi

if printf '%s\n' "$files" | xargs grep -nE -- '-----BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|Bearer[[:space:]]+[A-Za-z0-9._~-]{20,}'; then
  echo "Potential secret detected in tracked files" >&2
  exit 1
fi

if printf '%s\n' "$files" | xargs grep -nE -- '(^|[^A-Za-z])(SECRET|API_TOKEN|ACCESS_TOKEN|PRIVATE_KEY|RPC_KEY|DATABASE_URL)[[:space:]]*=[[:space:]]*[^$<{[:space:]]{8,}' | grep -vE '(example|placeholder|changeme|your[-_])' ; then
  echo "Potential hard-coded secret assignment detected" >&2
  exit 1
fi
