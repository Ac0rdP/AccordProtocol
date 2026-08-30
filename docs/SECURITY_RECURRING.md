# Recurring Payments — Security Addendum

The recurring-payment feature introduces three new attack surfaces that are important for deployers and auditors to understand.

- Permissionless crank griefing: `disburse_recurring` is intentionally permissionless so any keeper can call it to trigger scheduled payouts. A malicious actor could repeatedly call the entrypoint to create on-chain traffic or artificially advance scheduling state. Mitigations: the entrypoint enforces the schedule's `interval_secs` and terminal `status` checks (Active/Cancelled/Completed) so calls outside the allowed cadence are rejected; callers cannot force extra disbursements. Keepers should implement polite backoff and indexing to avoid unnecessary retries.

- Balance-drain via many small schedules: An attacker could create many tiny schedules to collectively drain the treasury or inflate storage costs. Mitigations: the contract should enforce a configurable `MAX_ACTIVE_RECURRING` cap (deployment parameter) and validate a minimum `interval_secs` to prevent extremely high-frequency schedules. Additionally, per-owner spending limits and the existing `MAX_ACTIVE_PROPOSALS` pattern apply an economic bound on mass-creation attacks; operators should run conservative caps for public-facing deployments.

- Paused/Cancelled schedule fund-lock: Funds reserved for a paused or cancelled schedule might become temporarily inaccessible if the schedule's status is misused. Mitigations: the contract treats Cancelled and Completed schedules as terminal and rejects further disbursement attempts; scheduling state transitions are authenticated and auditable via events. Where large amounts are involved, operators should prefer shorter occurrence windows or explicit emergency-unlock governance proposals.

Key implemented mitigations in the codebase:

- Terminal status guards: `disburse_recurring` checks schedule status and rejects calls on Cancelled or Completed schedules.
- Interval enforcement: A schedule may only be disbursed when `last_disbursed_at + interval_secs <= now`.
- Active-schedule cap & interval minimum: Deployments should configure `MAX_ACTIVE_RECURRING` and a sensible minimum `interval_secs` to make mass-creation and crank-spam unprofitable.
- Spending-limit attribution: Recurring schedules still respect per-owner spending limits at creation time so a schedule cannot be used to bypass configured caps.

These mitigations are complementary to the existing threat model and do not replace careful operational controls when exposing schedule creation to non-trusted parties.
