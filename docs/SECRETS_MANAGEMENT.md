# Secrets and compliance

## Required secrets

| Service | Secret | Use |
| --- | --- | --- |
| Indexer | RPC URL/key, database URL, deployment environment credentials | Chain reads and persistence |
| Analytics API | Database URL, internal service/API signing key, upstream RPC/indexer credential | Query data and authenticate service calls |
| Relayer | Dedicated signing key, RPC URL/key, relayer authorization token | Submit only explicitly authorized transactions |
| CI/deploy | GitHub environment token, hosting/deployment token, optional RPC key | Build and deploy; never runtime data access |

Public chain addresses, contract IDs, and frontend configuration are not secrets. Private keys, bearer tokens, database credentials, and RPC credentials are secrets.

## Storage and injection

Store production values in a managed secret store (for example, the deployment platform's encrypted environment or a cloud secret manager) with least-privilege service identities. Inject them as runtime environment variables or short-lived workload identity credentials. Keep `.env` files local and untracked; commit only `.env.example` placeholders. Do not pass secrets as command-line arguments, bake them into frontend bundles, or include them in fixtures.

The browser must never receive indexer, database, relayer, or service credentials. User access tokens are short-lived and scoped; the analytics API validates them server-side.

## Rotation and exposure response

Rotate RPC/API credentials at least every 90 days and immediately after staff/offboarding, suspected exposure, provider change, or a SEV-1/SEV-2. Relayer keys require a documented owner, funding limit, and emergency pause path. Create the replacement, deploy/configure it, verify health, revoke the old value, and record the timestamp and owner without recording the secret. If exposure is suspected: revoke first, preserve redacted evidence, assess logs, notify Security/Treasury, and follow `docs/INCIDENT_RESPONSE.md`.

Logs, traces, error reports, URLs, request bodies, and CI output must redact authorization headers, private keys, seed phrases, database URLs, and query credentials. Review dependencies and generated artifacts before release.

## Repository and CI guard

The `scripts/check-secrets.sh` scan runs in CI and fails on private-key blocks, common cloud/RPC token formats, bearer assignments, or non-placeholder secret assignments. It is a defense-in-depth check, not a replacement for secret scanning and provider revocation. False positives must be fixed by using placeholders or an explicit reviewed allowlist—not by weakening the patterns.

Review this document quarterly, after an incident, and whenever a service or provider changes. Verify rotation in a tabletop exercise at least twice yearly.
