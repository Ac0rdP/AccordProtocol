# Incident response plan

This plan applies to the Accord frontend, analytics API, indexer, relayer, CI, and deployed contracts. The incident commander owns the incident until handoff is explicit. Use the incident channel and ticket system; do not put credentials, private keys, or personal data in tickets or chat.

## Severity and triggers

| Level | Trigger | Target response |
| --- | --- | --- |
| SEV-1 critical | Active key compromise, unauthorized treasury movement, contract exploit, or broad analytics data exposure | Acknowledge in 15 minutes; page all on-call roles; contain immediately; updates every 30 minutes |
| SEV-2 high | Production outage, incorrect balances, sustained API abuse, or material user impact without confirmed loss | Acknowledge in 30 minutes; updates hourly; mitigation the same business day |
| SEV-3 moderate | Degraded feature, isolated incorrect result, or suspected issue with a workaround | Acknowledge in 1 business day; daily updates until resolved |
| SEV-4 low | Documentation, monitoring, or non-urgent defect with no user impact | Triage in the next planning cycle |

When uncertain, start at the higher severity and downgrade after evidence. Any suspected secret exposure is at least SEV-2 until scoped.

## Triage and response

1. The reporter opens an incident ticket with time, symptoms, affected service, first observed/last known good, request IDs, and a redacted impact estimate.
2. The incident commander declares severity, opens the incident channel, assigns roles, and records decisions and timestamps.
3. The technical lead confirms the signal using logs, metrics, indexer lag, API health, and chain state. Preserve evidence; do not restart or rotate blindly.
4. Contain: disable affected routes, revoke/rotate exposed credentials, pause relayer activity, freeze affected contract operations where supported, or roll back the smallest safe release.
5. The communications lead posts an internal update and, when users are affected, the approved external template below. Legal/compliance reviews disclosures for SEV-1/SEV-2.
6. The technical lead restores service, validates balances and permissions, and keeps heightened monitoring for 24 hours.
7. Close only after impact, root cause, corrective actions, owners, and follow-up dates are recorded. Publish a blameless postmortem within five business days for SEV-1/SEV-2.

## Roles, contacts, and escalation

| Role | Primary responsibility | Contact |
| --- | --- | --- |
| Incident commander | Severity, priorities, decisions, handoff | `@incident-commander` / on-call rotation |
| Technical lead | Diagnosis, containment, recovery, evidence | `@engineering-on-call` |
| Communications lead | Internal/external updates and status page | `@communications-on-call` |
| Security lead | Secrets, access, exploit assessment, disclosure | `@security-on-call` |
| Treasury/relayer owner | Pause/restart relayer and verify funds | `@treasury-on-call` |
| Compliance/legal | Regulatory and customer notification advice | `@legal-on-call` |

Escalate SEV-1 immediately to the engineering lead, security lead, treasury owner, and legal contact. If a primary does not acknowledge within the target, use the secondary in the on-call rotation and notify the incident commander. Replace handles with the maintained private on-call directory; do not commit personal phone numbers.

## Communication templates

**Internal declaration**

> `[SEV-x] Accord incident declared at [UTC]. Impact: [what/when/who]. Current hypothesis: [unknown/summary]. Containment: [action]. Incident commander: [name]. Next update: [UTC].`

**User update**

> We are investigating an issue affecting [feature/service] beginning [UTC]. Some users may see [observable impact]. Funds and credentials are [status, only if verified]. We have [contained/mitigated] the issue and will update by [UTC]. Please do not share secrets or retry transactions repeatedly.

**Resolution**

> The [service] incident from [UTC] is resolved as of [UTC]. Impact was [summary]. We [corrected/rotated/restored] [scope]. We are monitoring and will publish follow-up actions at [link/date].

Review this plan quarterly and after every SEV-1/SEV-2. Run a tabletop exercise quarterly and an on-call contact test monthly; record results and actions in the incident register.
