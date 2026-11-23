# Treasury Policy Operator Playbook

This playbook explains how treasury operators should choose **approval thresholds**, **owner voting weights**, **rolling spending limits & windows**, and **recurring payment schedules** in Accord Protocol, with worked examples and runnable Stellar CLI commands.

---

## 1. Choosing Approval Thresholds

In Accord Protocol, `threshold` is the minimum cumulative approval weight required before a proposal transitions from `Pending` to `Ready` for execution.

### Contract Bounds
- `1 <= threshold <= total_weight` (enforced by `InvalidThreshold` `#4` and `ThresholdExceedsOwnerCount` `#50`).
- Up to `MAX_OWNERS = 20` owners per contract.

### Recommended Threshold Profiles

| Treasury Tier | Example Setup | Threshold | Rationale |
|---|---|---|---|
| **Small Operating Team** | 3 equal owners (`weight = 1` each, `total = 3`) | `2` (67%) | Tolerates 1 unavailable signer while preventing unilateral transfers. |
| **Core DAO Treasury** | 5 equal owners (`weight = 1` each, `total = 5`) | `3` (60%) | Survives 2 absent signers; standard majority quorum. |
| **High-Value Reserve** | 7 owners (`total_weight = 100`) | `67` (67%) | Supermajority required for cold-storage or protocol upgrades. |

### Worked Example: Adjusting Threshold Safely
Always verify `get_total_weight` before proposing a threshold change so you do not trigger `ThresholdExceedsOwnerCount` (`#50`) or `WouldBreakQuorum` (`#48`):

```bash
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --network testnet \
  --source "$OWNER_ALIAS" \
  -- get_total_weight
```
**Expected output:**
```text
100
```

Propose raising the threshold to `67`:
```bash
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --network testnet \
  --source "$OWNER_ALIAS" \
  -- create_change_threshold_proposal \
  --proposer "$OWNER_ADDRESS" \
  --new_threshold 67 \
  --description "Raise quorum threshold to 67/100 for mainnet reserve" \
  --deadline 1795000000
```
**Expected output:**
```text
31
```

---

## 2. Choosing Owner Voting Weights

Weighted governance lets you assign different voting power to owners (for example, founders, finance leads, and independent council members) while preventing single-signer capture.

### Contract Invariants
- **Weight bounds:** `MIN_OWNER_WEIGHT = 1` to `MAX_OWNER_WEIGHT = 100_000`.
- **Single-owner cap:** `MAX_SINGLE_OWNER_WEIGHT_PCT = 50` — no single owner may hold more than **50%** of `total_weight` (`SingleOwnerWeightCapExceeded` `#46`).
- **Quorum safety:** You cannot reduce weights if doing so would make `threshold > total_weight` (`WouldBreakQuorum` `#48`).

### Worked Example: 4-Signer Weighted Treasury (`total = 100`, `threshold = 60`)
Suppose you have 2 executive signers and 2 operations signers:
- Executive A: `35` (35% <= 50% cap)
- Executive B: `35` (35% <= 50% cap)
- Ops Lead C: `15`
- Finance Lead D: `15`
- `total_weight = 100`, `threshold = 60`

**Why this works:**
- Neither Executive A + Ops Lead C (`35 + 15 = 50 < 60`) nor Ops + Finance (`15 + 15 = 30 < 60`) can pass a proposal alone.
- Either **both executives** (`35 + 35 = 70 >= 60`) OR **one executive + both ops/finance leads** (`35 + 15 + 15 = 65 >= 60`) can reach quorum.
- If Executive A is away, Executive B + Ops + Finance can still operate without stalling.

Verify weights and cap on-chain:
```bash
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --network testnet \
  --source "$OWNER_ALIAS" \
  -- get_max_single_owner_weight_pct
```
**Expected output:**
```text
50
```

---

## 3. Choosing Spend Limits & Rolling Windows

Spending limits cap how much an owner or treasury can disburse within a rolling time window, limiting blast radius if a key is compromised.

### Contract Bounds
- Configurable window bounds: `MIN_SPENDING_WINDOW = 86_400` seconds (24 hours) to `MAX_SPENDING_WINDOW = 604_800` seconds (7 days).
- Exceeding the cap fails deterministically with `SpendingLimitExceeded` (`#31`).

### Worked Example: Daily Ops Cap vs Weekly Payroll Cap
For a treasury holding `500,000 USDC` (`7` decimals on Stellar = `10_000_000` stroops per USDC):
- Set a **24-hour (`86_400`s) rolling window** for routine Ops transfers with a `10,000 USDC` (`100_000_000_000` stroops) limit.
- Set a **7-day (`604_800`s) rolling window** for larger vendor batches with a `50,000 USDC` (`500_000_000_000` stroops) limit.

Inspect current spent amount for an owner and token:
```bash
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --network testnet \
  --source "$OWNER_ALIAS" \
  -- get_spent_tracker \
  --owner "$OWNER_ADDRESS" \
  --token "$USDC_TOKEN_ADDRESS"
```

Propose updating the spending window to 24 hours (`86400` seconds):
```bash
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --network testnet \
  --source "$OWNER_ALIAS" \
  -- create_spending_window_proposal \
  --proposer "$OWNER_ADDRESS" \
  --window_seconds 86400 \
  --description "Set 24-hour rolling spending window" \
  --deadline 1795000000
```

---

## 4. Choosing Recurring Payment Schedules

Recurring schedules automate predictable outflows (contributor payroll, grants, retainers) after a single multisig approval.

### Contract Bounds
- `MIN_INTERVAL_SECS = 60` (1 minute) to `MAX_INTERVAL_SECS = 31_536_000` (365 days).
- `MAX_ACTIVE_RECURRING = 20` active schedules per contract (`TooManyActiveRecurring` `#37`).
- `total_cap >= amount` (`InvalidCap` `#30`).

### Worked Example: 6-Month Contributor Retainer
- **Per-period amount:** `4,000 USDC` (`40_000_000_000` stroops)
- **Interval:** `2,592,000` seconds (30 days)
- **Total cap (6 periods):** `24,000 USDC` (`240_000_000_000` stroops)

1. **Create the recurring proposal:**
   ```bash
   stellar contract invoke \
     --id "$CONTRACT_ID" \
     --network testnet \
     --source "$OWNER_ALIAS" \
     -- create_recurring_proposal \
     --proposer "$OWNER_ADDRESS" \
     --recipient "$CONTRIBUTOR_ADDRESS" \
     --token "$USDC_TOKEN_ADDRESS" \
     --amount 40000000000 \
     --interval 2592000 \
     --total_cap 240000000000 \
     --description "6-month engineering retainer (4,000 USDC/mo)" \
     --deadline 1795000000
   ```
2. **Monitor active count** (stay below `20`):
   ```bash
   stellar contract invoke \
     --id "$CONTRACT_ID" \
     --network testnet \
     --source "$OWNER_ALIAS" \
     -- get_active_recurring_count
   ```
   **Expected output:**
   ```text
   1
   ```

---

## 5. Troubleshooting Policy Changes

| Symptom / Error | Cause | Remedy |
|---|---|---|
| `SingleOwnerWeightCapExceeded` (`#46`) | New weight exceeds 50% of `total_weight`. | Distribute weight across more owners or lower the target weight. |
| `WouldBreakQuorum` (`#48`) | Proposed weight/owner removal makes `threshold > total_weight`. | Lower `threshold` via `create_change_threshold_proposal` first. |
| `SpendingLimitExceeded` (`#31`) | Transfer exceeds rolling window cap. | Wait for window rollover or raise limit via `create_spending_limit_proposal`. |
| `TooManyActiveRecurring` (`#37`) | Already 20 active recurring schedules. | Cancel finished/obsolete schedules before creating new ones. |

---

## Related Documentation
- [Choosing Voting Weights](weighted-governance.md)
- [Roles & Permissions](roles-and-permissions.md)
- [Payroll with Recurring Payments](payroll-recurring.md)
- [Advanced Governance Walkthroughs](advanced-governance-walkthroughs.md)
- [Error-Code & Troubleshooting Index](../ERROR_CODES.md)
