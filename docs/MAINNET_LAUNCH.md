# Mainnet Launch Gate

A mainnet release is blocked until [`launch/mainnet-checklist.json`](../launch/mainnet-checklist.json)
is complete and signed off. The gate is
[`scripts/check-mainnet-checklist.mjs`](../scripts/check-mainnet-checklist.mjs),
run by the `mainnet-checklist` job in [`release.yml`](../.github/workflows/release.yml),
which the `release` and `publish-sdk` jobs depend on.

## What counts as a mainnet release

Any `v*` tag **without** a pre-release suffix (`v1.0.0`). Tags such as
`v1.0.0-rc.1` only get a structure check. Pull requests that touch `launch/`
get the same structure check from `launch-checklist.yml`.

## Checklist items

Each item has an `id`, a `category` (`code`, `tests`, `operations`), a
`requirement`, one `evidence` reference, a `status` and a `signOff`:

```json
{
  "id": "C-1",
  "category": "code",
  "requirement": "…",
  "evidence": "docs/audit/REMEDIATION.md",
  "status": "done",
  "signOff": { "by": "github-handle", "date": "2026-11-01" }
}
```

- **Evidence** is a repo-relative path (checked to exist) or an `https://` link
  to something a reviewer can open: an audit report, a CI run, a drill record.
  Replace the placeholder path with the specific artifact when you mark an item done.
- **Sign-off** is the person who verified the evidence and the date. The gate
  rejects a `done` item without both, or with a future date.

## Each launch

1. Set `"release"` to the tag being cut (the gate fails if it differs, so the
   checklist is re-reviewed for every launch rather than carried over).
2. Reset every item to `pending`, then re-verify each one against current evidence.
3. Mark items `done` with evidence and sign-off, and merge through a normal PR
   so the sign-offs are reviewed.
4. Push the tag. The release jobs only run if the gate passes.
