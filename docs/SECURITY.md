# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| testnet (current) | Yes |
| mainnet | Not yet deployed — audit pending |

## Audit Status

Accord Protocol is **unaudited**. Do not deploy to mainnet with significant funds until a formal third-party audit is completed. The contract has been reviewed for common Soroban anti-patterns but has not undergone a professional security review.

Known areas that require attention before mainnet:
- Reentrancy via external token calls (currently mitigated by Soroban's single-contract-call model, but warrants formal review)
- TTL expiry edge cases under high ledger load

## Security Best Practices for Multisig Administrators

### Key Management

- Use a hardware wallet or an air-gapped signing device for each multisig owner key whenever possible.
- Do not store a private key in a shared password manager, team vault, or any system that more than one person can access.
- Treat each Stellar signing key like a root credential: if it is exposed, assume an attacker can act as that owner until the owner is removed from the multisig.
- Keep recovery material, seed phrases, and backup exports offline and separate from day-to-day operational devices.

### Threshold Sizing

- Choose an M-of-N threshold that makes a single compromised key insufficient to move funds or approve sensitive actions on its own.
- At the same time, leave enough slack for normal operations when one owner is traveling, offline, or otherwise unavailable.
- For small teams, `2-of-3` is usually a practical baseline because it resists one-key compromise while still allowing continuity if one signer is down.
- For larger teams, `3-of-5` is a common starting point because it raises the approval bar without making routine coordination unworkable.
- Review the threshold whenever the team changes size, the treasury grows, or the approval process becomes operationally brittle.

### Owner Rotation

- Replace owners through the on-chain proposal flow rather than by sharing keys or making out-of-band changes.
- First submit an `add_owner` proposal for the new signer and wait for it to pass so the threshold is still met during the transition.
- Verify the new owner can sign a test transaction before removing the departing owner.
- After the replacement signer is confirmed, submit a `remove_owner` proposal for the old owner and wait for that proposal to execute.
- If you also need to adjust quorum, use the `change_threshold` proposal flow as part of the same planned rotation.

### What to Do If a Key Is Compromised

- Immediately assume the compromised owner can approve pending or future proposals until removed.
- Use a quorum of the remaining uncompromised owners to submit and approve a `remove_owner` proposal for the exposed key as soon as possible.
- Pause or cancel any pending proposals that the compromised owner already approved, then re-evaluate them after the owner set is cleaned up.
- If the threshold no longer makes quorum possible after the compromise, raise the issue operationally first and restore a safe threshold before resuming normal use.

## Known Limitations

- A stolen owner key can still create and approve proposals up to the threshold gap before it is removed.
- There is no automatic on-chain emergency recovery; owner removal and threshold changes still require coordinated proposal approval.
- Token contracts are validated when a proposal is created, but not re-validated at execution time, so a contract upgrade between those events can change the risk profile.
- A malicious owner can deliberately fill the active proposal cap and temporarily block new proposals from being created.
- Per-owner, per-token spending limits are available via `SetSpendingLimit` proposals and are enforced when a transfer proposal is created, but they are opt-in: an owner with no configured limit for a given token remains unrestricted for it, so the threshold is still the primary access-control mechanism.

## Explicit Trust Assumptions

- Owner keys are kept secret and not shared. If that assumption fails, the multisig should be treated as compromised until the exposed owner is removed and any impacted proposals are reviewed.
- The Stellar RPC node used by the frontend returns accurate ledger state. If it lies or falls behind, the UI can show stale proposal status, incorrect balances, or misleading approval state.
- Token contracts used in proposals follow the Soroban token interface and are not upgraded to malicious code after proposal creation. If that assumption fails, execution can transfer an asset the owners no longer intended to trust.
- Owners remain available to participate in quorum when operational changes are needed. If they are not, urgent rotations or threshold changes can stall and leave the multisig in a risky intermediate state.

## Threat Model

### Attack Surfaces

The protocol's attack surface includes the following external entry points:
- **Public Contract Functions**: `create_proposal` (and variants), `approve`, `revoke`, `execute`, `cancel_expired`, and `upgrade`. These are reachable by any actor via the Stellar network.
- **Guardian / Emergency Pause**: `set_guardian`, `freeze`, and `unfreeze`. `set_guardian` assigns or replaces the guardian address and requires a set of *distinct* owners whose combined voting weight reaches the current threshold to co-sign in a single call. `freeze` can be called **only** by the currently registered guardian and immediately blocks new proposal creation and all proposal execution. `unfreeze` lifts the freeze and, like `set_guardian`, requires distinct owners whose combined weight reaches the threshold. A misconfigured or captured guardian key can therefore halt the contract (a denial-of-service pause), but on its own cannot move funds, change the owner set, or change the threshold.
- **Concurrent Governance Proposals**: Two governance proposals that each pass their own creation-time checks can be approved in parallel and executed back-to-back — for example two `RemoveOwner` proposals, or a `RemoveOwner` alongside a `ChangeThreshold`. Because each creation-time check evaluates the owner set and total weight as they stand at creation, executing both together can move the owner-count or total-weight past the point where the threshold is still reachable, risking a multisig that can no longer reach quorum.
- **Role-Based Access Control (RBAC)**: Operational roles (`Proposer`, `Approver`, `Executor`, `Viewer`) govern entrypoints, introducing distinct attack considerations: execution of `Ready` proposals by non-owner executors, role concentration on single signers, and approver role-revocation lockout risks (see [Role-Based Access Control Threat Model Addendum](#role-based-access-control-rbac-threat-model-addendum)).
- **Frontend Wallet Connection**: The boundary where the dApp interacts with browser-based wallets (Freighter). Malicious sites could attempt to intercept or spoof these calls.
- **RPC Layer Boundary**: The communication path between the frontend and a Stellar RPC node. A compromised node can feed dishonest state data to the user.

### Trust Assumptions

Accord relies on several explicit assumptions for its security properties to hold:
1. **Key Confidentiality**: Owner private keys are not compromised or shared.
2. **Honest RPC Node**: The RPC node used by the frontend and integrators returns accurate ledger state.
3. **Asset Integrity**: Token contracts passed to the multisig are non-malicious and do not contain backdoors or non-standard callback logic.
4. **Soroban Platform**: The underlying Soroban runtime correctly enforces `require_auth` and handles cryptographic verification.

### Mitigations

Specific mechanisms are in place to enforce security boundaries:
- **M-of-N Threshold Guard**: The `execute` and `upgrade` functions enforce a strict approval count, preventing single-key fund transfers or governance takeovers. Threshold alone is not enough for upgrades: owners must still verify the WASM hash and follow the operational checks in [`docs/UPGRADE_SAFETY.md`](./UPGRADE_SAFETY.md).
- **Proposal Deadlines**: The `deadline` field and `derive_status` logic ensure proposals cannot be executed indefinitely, protecting against stale approvals.
- **Active Proposal Cap**: The `MAX_ACTIVE_PROPOSALS` check in `create_proposal` prevents an attacker from exhausting contract storage.
- **Owner-Only Authentication**: Every state-changing call (`approve`, `revoke`, etc.) uses `require_owner` to ensure only the authorized set can act.
- **Weighted sensitive-action co-signing (audit conclusion)**: `set_guardian`, `unfreeze`, and `upgrade` reject duplicate addresses before summing approver weights, so a single owner cannot repeat its address to count its weight more than once. They intentionally accept the smallest *distinct* approver list whose combined weight reaches quorum; this may be one owner when that owner legitimately holds enough configured weight. This is acceptable only as an explicit weighted-governance outcome, and the default 50% `ChangeOwnerWeight` cap prevents granting a strict majority through a later weight-change proposal. **Follow-up concern:** initialization can establish a concentrated allocation, so deployers must review initial weights and quorum together; a future release could apply the cap at initialization too if that policy is required.
- **Guardian Emergency Pause**: A guardian registered through `set_guardian` (itself co-signed by owners whose combined weight meets the threshold) can call `freeze` to immediately block all new proposal creation and execution the moment a compromise or incident is detected. This bounds the damage from a detected compromise: it buys time to remove an exposed owner key or investigate before any funds move, without granting the guardian any power to transfer funds or alter the owner set or threshold. Resuming normal operation requires `unfreeze`, which again needs distinct owners whose combined weight reaches the threshold — so no single party, including the guardian, can both pause and silently resume the contract.
- **Execute-time invariant re-validation for weight changes**: Governance proposals are validated when created but executed later, so a `ChangeOwnerWeight` proposal re-checks *at execution time* that the resulting total weight would not leave any still-active (Pending/Ready) proposal un-quorumable — if any active proposal's snapshotted `quorum_weight` would exceed the new total weight, execution is rejected with `WouldBreakQuorum`. Owner-removal is guarded at creation time (a removal that would drop remaining weight below the threshold is rejected up front by `create_remove_owner_proposal` with `WouldBreakQuorum`), and threshold changes are validated against total weight at creation. Because those removal and threshold checks evaluate state at creation rather than the combined effect of several proposals executing together, operators should still sequence interacting governance proposals deliberately — approving and executing one before creating the next — so two concurrent removals (or a removal plus a threshold change) cannot combine to push the multisig below a reachable quorum.
- **Role Separation & Non-Owner Execution Invariants**: Operational roles restrict who can propose, approve, or execute. The `execute` function requires `Role::ExecuteProposal` but cannot alter stored proposal parameters, requires un-revoked quorum approval evaluated strictly by `derive_status`, respects guardian freezes, and enforces timelocks and deadlines — ensuring non-owner executors act strictly as permissionless execution cranks without custody or discretionary authority.

### Weighted Governance Threat Model Addendum

The threat model above predates weighted voting, where every owner's approval counted as exactly one vote. Weighted governance introduces a new class of risk: voting power concentrating in a single owner, or a colluding group of owners, until the multisig stops functioning as a multisig in practice even though it still looks like one on paper.

#### Whale-Owner Risk

A multisig's security rests on requiring *several* independent parties to agree before funds move or governance changes take effect. Weighted voting weakens that guarantee the moment a single owner's weight reaches the current `threshold` on its own: `approve` sums weight from whichever owners call it, and `derive_status` only compares that sum against `quorum_weight` (the threshold snapshotted at proposal creation) — nothing in that check cares whether the weight came from one owner or several. An owner whose weight is `>= threshold` can therefore approve and execute any proposal alone, turning an "M-of-N" multisig into a single point of failure in every way that matters: one compromised key is enough to move the treasury, exactly the scenario a multisig exists to prevent. This can arise either from an unbalanced initial weight distribution passed to `initialize`, or from weight-change proposals executed over time.

#### Weight-Concentration via Repeated Small Proposals

A related but distinct risk is gradual concentration through a *sequence* of individually-reasonable `ChangeOwnerWeight` proposals. Each such proposal is checked against the single-owner cap (below) only at the moment it is created and again at the moment it is executed — the check has no memory of earlier proposals and no visibility into whether the beneficiaries are acting independently or in concert. This means:
- **A single owner** cannot exceed the cap in any one step, because each `ChangeOwnerWeight` call re-derives the resulting total weight and re-checks the cap against it fresh (see Mitigations below) — there is no path for one owner to ratchet past the cap across multiple proposals, since every proposal is capped relative to the state it actually executes against.
- **A colluding group of owners**, however, can each individually raise their own weight — or raise each other's — through separate `ChangeOwnerWeight` proposals that every one of them, taken alone, satisfies the cap. Because the cap is evaluated per-owner against the total, not per-coalition, a group of colluding owners can accumulate a combined share of `TOTAL_WEIGHT` well past what any single one of them could reach unilaterally, with no individual proposal ever looking anomalous in isolation.

#### Existing Mitigations

- **Single-owner weight cap, enforced at both creation and execution**: `create_change_weight_proposal` computes the resulting total weight and rejects the proposal with `SingleOwnerWeightCapExceeded` if the target owner's new weight would exceed `MAX_SINGLE_OWNER_WEIGHT_PCT` (50% by default) of that resulting total. Because weights and owner membership can still shift between a proposal's creation and its execution, the identical check runs again inside `execute`'s `ChangeOwnerWeight` branch against the total weight as it stands at execution time, so a cap-violating outcome cannot slip through even if it would only have become a violation due to changes made after the proposal was created.
- **Zero-weight rejected in favor of explicit removal**: `ChangeOwnerWeight` validates `new_weight` against `MIN_OWNER_WEIGHT..=MAX_OWNER_WEIGHT` at both creation and execution, so it can never be used to silently zero out an owner's voting power. An owner who should no longer participate must instead go through `create_remove_owner_proposal`, which is a distinct, explicit action visible in the proposal history as a full removal rather than an easily-overlooked weight edit — and which itself checks at creation time that removal cannot drop the remaining total weight below the threshold.

#### Unmitigated Gap

The single-owner cap bounds what any *one* `ChangeOwnerWeight` proposal can do to *one* owner's share — it does not bound the combined share a coalition of owners can reach across several proposals, and it does not prevent an unbalanced set of weights from being accepted at `initialize` in the first place (initialization has no equivalent per-owner cap). Deployers and owners reviewing incoming `ChangeOwnerWeight` proposals should evaluate each one's effect on the *combined* weight of any owners who might be acting in concert, not just the cap check the contract itself performs, and should review the initial weight distribution passed to `initialize` with the same scrutiny. See "Opt-in initialization weight review" in Residual Risks below.

### Role-Based Access Control (RBAC) Threat Model Addendum

Accord introduces an operational role-based access control (RBAC) layer on top of owner-weighted governance. While owner weights govern *how much voting influence* an account possesses, operational roles define *what actions* an account is permitted to take across the proposal lifecycle.

#### RBAC Model & Trust Assumptions

The RBAC implementation in [`contracts/accord/src/lib.rs`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs) categorizes permissions into four functional roles defined in the [`Role`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L24-L30) enum:
- **`Proposer` (`Role::CreateProposal`)**: Permits drafting new proposals via any `create_*_proposal` entrypoint (transfers, owner additions/removals, threshold changes, weight adjustments, recurring payments, spending limits, and role grants/revocations).
- **`Approver` (`Role::ApproveProposal`)**: Permits voting on pending proposals via [`approve`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L2537) and revoking votes via [`revoke`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L2596).
- **`Executor` (`Role::ExecuteProposal`)**: Permits triggering execution of proposals that have reached `Ready` status via [`execute`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L2641) and cleaning up expired proposals via `cancel_expired`.
- **`Viewer`**: Reserved for read-only interface views and off-chain policy auditing; carries no transaction execution permissions.

The protocol relies on the following core trust assumptions regarding RBAC:
1. **Separation of Functional Duties**: Operational responsibilities — drafting proposals, voting, and triggering execution — can be partitioned across different entities without granting treasury custody to operational drafters or automated execution bots.
2. **Ownership as the Sole Voting Anchor**: Roles alone never grant voting power. The [`approve`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L2537) and [`revoke`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L2596) entrypoints require both [`require_role`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L932) for `Role::ApproveProposal` **and** `require_owner_and_weight`. Granting `Approver` to a non-owner address grants zero voting weight and cannot advance proposals toward quorum.
3. **High-Privilege Administrative Actions Bypass Roles**: Core security controls — [`upgrade`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L1730), `set_guardian`, `freeze`, `unfreeze`, `migrate_to_weighted_governance`, `migrate_to_rbac`, and `set_max_single_owner_weight_pct` — are **not** role-gated. They strictly enforce [`require_weighted_approvers`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L1354), requiring a quorum of distinct registered owners whose combined weight reaches `threshold`. An operational role compromise cannot directly hijack contract bytecode, change guardians, or alter thresholds.
4. **Default Backward Compatibility**: Initialization and migration (`migrate_to_rbac`) grant `DEFAULT_OWNER_ROLES` (`Proposer`, `Approver`, `Executor`) to all registered owners. This maintains legacy M-of-N multisig behavior until roles are explicitly segregated.

#### Non-Owner Executor Safety

Under Accord's RBAC model, the `Executor` role (`Role::ExecuteProposal`) can be assigned to an account that is not an owner — such as an automated keeper bot, a cron relayer, or an operational service.

**Attack Scenario:** An untrusted, compromised, or rogue non-owner executor attempts to drain funds, redirect payments, execute unauthorized proposals, or front-run multisig signers.

**Why Executing an Already-`Ready` Proposal Is Low-Risk:**
- **Immutable Proposal Payloads**: When a proposal is created via any `create_*_proposal` entrypoint, its parameters (token address, recipients, disbursement amounts, or governance changes) are serialized and committed to immutable contract storage. The [`execute`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L2641) function takes only `(executor: Address, proposal_id: u64)` and contains no mechanism for the caller to alter the proposal's contents, destination, or amounts.
- **Strict On-Chain Status Verification (`derive_status`)**: Inside [`execute`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L2641), the contract invokes [`derive_status`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L1381). Execution immediately aborts with `ContractError::ThresholdNotMet` or `ContractError::ProposalNotActive` unless the proposal evaluates strictly to `ProposalStatus::Ready`. Proposals in `Pending`, `Executed`, or `Revoked` status are rejected, and expired proposals evaluate to `ProposalStatus::Expired` and return `ContractError::ProposalExpired`.
- **Authentic Owner Quorum Prerequisite**: A proposal transitions to `Ready` status only when the cumulative voting weight contributed by registered owners holding `Role::ApproveProposal` satisfies $\text{approvals} \ge \text{quorum\_weight}$ (the snapshot threshold recorded at creation). Because non-owners cannot cast approval weight, an executor cannot fabricate approvals.
- **Dynamic Approval Revocation Window**: Authorized approvers retain the right to call [`revoke`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L2596) at any time prior to execution. If an owner detects an error or suspicious activity on a `Ready` proposal, revoking their approval immediately drops total approvals below `quorum_weight`, reverting the status back to `Pending` and causing any subsequent call to [`execute`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L2641) to fail.
- **Timelock Delay Enforcement**: If a contract timelock delay is configured (`timelock_key`), [`execute`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L2641) enforces `now >= proposal.ready_at + time_lock_delay`, guaranteeing owners a predictable review window to inspect `Ready` proposals before they can be executed.
- **Guardian Freeze Backstop**: [`execute`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L2641) checks `require_not_frozen(&env)?`. In the event of an active incident or dispute, the guardian can call `freeze` to immediately block all execution contract-wide, overriding any attempts by an executor.
- **Deterministic Crank Property**: The `Executor` role functions strictly as an unprivileged, non-custodial operational crank. It cannot initiate actions or alter outcomes; it merely finalizes transactions that have already achieved owner consensus.

#### Role Concentration Risk

**Attack Scenario:** A single address holds all three operational roles (`Proposer`, `Approver`, and `Executor`), which is the default configuration for all owners following initialization or migration.

**Risks of Role Concentration:**
- **Unilateral Proposal Lifecycle Execution**: If an address holding all three roles also controls voting weight $\ge \text{threshold}$ (a whale owner, or in low-threshold configurations such as 1-of-N), the multisig's checks and balances completely collapse. That single key can draft a malicious proposal, immediately approve it to reach quorum, and execute it within a single ledger block without review or opposition from other owners.
- **Workstation Single Point of Failure (SPOF)**: Even when no single owner possesses sufficient weight to pass quorum alone, concentrating `Proposer`, `Approver`, and `Executor` on a single developer or operator machine concentrates risk. If that machine or signing key is compromised, an attacker can draft arbitrary proposals, vote with the owner's weight, and trigger execution scripts, eliminating defense-in-depth across the lifecycle.

**Mitigations & Recommendations:**
- **Enforce Separation of Duties**: Organizations should deliberately partition roles across distinct keys:
  - Assign `Role::CreateProposal` (`Proposer`) to operational team members or automated ingestion pipelines (governed by spending limits).
  - Restrict `Role::ApproveProposal` (`Approver`) exclusively to hardware-wallet or air-gapped signing keys held by designated multisig owners.
  - Assign `Role::ExecuteProposal` (`Executor`) to automated keeper bots or non-custodial relayers that possess no proposing or voting permissions.
- **Single-Owner Weight Cap (`MAX_SINGLE_OWNER_WEIGHT_PCT`)**: The contract enforces a 50% default cap on any single owner's voting weight at both creation and execution of `ChangeOwnerWeight` proposals, preventing any single key from legitimately acquiring unilateral quorum via governance proposals.
- **Post-Migration Role Pruning**: Deployers should treat `DEFAULT_OWNER_ROLES` as an initial bootstrap state. Once dedicated proposers and execution keepers are operational, owners should submit and approve `create_revoke_role_proposal` calls to strip `Proposer` and `Executor` from owner voting keys, reducing each owner key's blast radius to voting only.

#### Role-Revocation Lockout Risk (Stranded Quorum)

**Attack Scenario:** Roles are granted and revoked via `create_grant_role_proposal` and `create_revoke_role_proposal` (executing `ProposalKind::GrantRole` and `ProposalKind::RevokeRole`). If `Role::ApproveProposal` is revoked from one or more owners such that the total voting weight of the remaining owners holding the Approver role falls below the active contract `threshold`:

$$
\sum_{\text{owner} \in \text{Approvers}} \text{weight}(\text{owner}) < \text{threshold}
$$

the multisig enters a state of **Stranded Quorum (Deadlock)**.

**Impact:**
- Because [`approve`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L2537) strictly requires `require_role(&env, &approver, Role::ApproveProposal)`, owners who have had their Approver role revoked cannot cast approvals.
- If total remaining Approver weight is less than `threshold`, no future proposal can ever accumulate enough approvals to reach `ProposalStatus::Ready`.
- In-flight `Pending` proposals may become permanently un-quorumable if their snapshotted `quorum_weight` cannot be met by remaining approvers.
- Because role restoration itself requires passing a `create_grant_role_proposal` through the standard proposal lifecycle, the multisig cannot self-heal via normal proposal execution once Approver weight drops below threshold.

**Mitigations & Quorum-Safety Guards:**
- **Operational Quorum-Safety Verification**:
  - Unlike `remove_owner` (which programmatically validates that the resulting total weight remains $\ge \text{threshold}$ and rejects proposals that would leave active proposals un-quorumable with `ContractError::WouldBreakThreshold`), role revocation proposals operate at the permission layer.
  - **Signer Invariant Check**: Prior to creating or approving any `create_revoke_role_proposal` targeting `Role::ApproveProposal`, signers must verify:
    1. The remaining Approver weight satisfies:
       $$
       \left(\sum_{\text{owner} \in \text{Approvers}} \text{weight}(\text{owner})\right) - \text{weight}(\text{target\_owner}) \ge \text{current\_threshold}
       $$
    2. Active proposals remain quorumable: Ensure no `Pending` or `Ready` proposals have `quorum_weight` exceeding the resulting Approver weight.
  - If a planned Approver revocation would drop weight below threshold, operators must first lower the threshold via a `ChangeThreshold` proposal before executing the role revocation.
- **Emergency Governance Fail-Safe (Role-Bypassing Recovery)**:
  - Critical administrative recovery entrypoints do **not** depend on `Role::ApproveProposal` or the proposal lifecycle:
    - [`upgrade`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L1730)
    - `set_guardian`
    - `unfreeze`
    - `migrate_to_rbac`
  - These entrypoints bypass `require_role` entirely and validate multi-owner authorization via [`require_weighted_approvers`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L1354) directly against the raw owner map.
  - If a multisig's proposal pipeline is deadlocked due to accidental Approver role revocation, registered owners can coordinate out-of-band to execute an emergency [`upgrade`](file:///home/dp/Documents/AccordProtocol/contracts/accord/src/lib.rs#L1730) using direct co-signatures to deploy updated logic or restore role state, ensuring contract control is never permanently lost.

### Residual Risks

The following risks are currently unmitigated by the protocol design:
- **No SOS Recovery**: If enough owner keys are lost, there is no emergency "recovery" mode; the funds remain locked if the threshold cannot be met.
- **Opt-in Spending Limits**: Per-owner, per-token spending limits exist via `SetSpendingLimit` proposals and are enforced at proposal creation (against a fixed 30-day spending window). They are not applied by default, however: an owner with no configured limit for a token can still propose any amount up to the treasury balance once the threshold is reached, so unrestricted tokens remain gated only by the approval threshold.
- **The Validation Gap**: A token contract could be upgraded to malicious code between a proposal's creation (where it is validated) and its execution.
- **Opt-in initialization weight review**: `initialize` enforces per-owner weight bounds and rejects a mismatched owners/weights length, but applies no cap on how concentrated the *initial* weight distribution may be, and no cap prevents a colluding group of owners from accumulating a combined majority share through a sequence of individually-compliant `ChangeOwnerWeight` proposals after deployment (see "Weighted Governance Threat Model Addendum" above). Both are currently the deployer's and owners' operational responsibility rather than an on-chain guarantee.
- **Role-Revocation Quorum Stranding**: While owner removals strictly enforce `WouldBreakThreshold` and `WouldBreakQuorum` at both creation and execution, revoking the `Approver` role from owners relies on operational verification that remaining Approver weight meets `threshold`. If Approver roles are revoked below `threshold`, regular proposal progression stalls until restored by owners via an emergency upgrade or role re-grant.

## Responsible Disclosure

**Do not open a public GitHub issue for a security vulnerability.**

To report a security issue:

1. Navigate to the GitHub repository's **Security** tab.
2. Click **"Report a vulnerability"** to open a private advisory.
3. Describe the issue clearly: affected function(s), reproduction steps, and potential impact.

We aim to acknowledge reports within 72 hours and publish a fix within 14 days for confirmed Critical/High issues.

## In-Scope

- `contracts/accord/src/lib.rs` — the on-chain contract
- Contract ↔ frontend integration (authentication bypass, event spoofing)
- Denial-of-service patterns that make funds permanently inaccessible

## Out-of-Scope

- Stellar protocol-level issues (report to Stellar Development Foundation)
- Frontend-only UI bugs with no on-chain consequence
- Issues in third-party libraries we depend on (report upstream)
