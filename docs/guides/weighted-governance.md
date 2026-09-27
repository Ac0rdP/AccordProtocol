# Choosing Voting Weights

Weighted governance lets each Accord owner carry a different voting weight. Quorum is an absolute weight target (`threshold` / `quorum_weight`), not “M distinct people,” so how you assign weights decides who can move funds alone, who must form coalitions, and how resilient the multisig stays if one key is lost or compromised.

This guide helps teams choose **equal** versus **skewed** weights. For the on-chain data model and quorum math, see [Weighted Governance Model](../ARCHITECTURE.md#weighted-governance-model) in `ARCHITECTURE.md`.

---

## Equal weights

Give every owner the same weight (usually `1`) and set `threshold` to the classic M in M-of-N.

**Example — classical 2-of-3**

| Owner | Weight |
|-------|--------|
| Alice | 1 |
| Bob | 1 |
| Carol | 1 |

- Total weight = `3`
- Threshold = `2`
- Any two owners can approve; no single owner can act alone

**When equal weights make sense**

- Founders or partners who share custody as peers
- Committees where each seat should count the same
- Teams migrating from flat M-of-N (`migrate_to_weighted_governance` assigns weight `1` to everyone)
- You want the simplest mental model and the least centralization risk

**Trade-off:** You cannot express “ops lead has more say than a backup signer” without changing the owner set or using skewed weights.

---

## Skewed weights

Assign larger weights to owners who should carry more influence, and set `threshold` to the coalition size you want (in weight units).

**Example — lead + two backups (still needs a partner)**

| Owner | Weight | Share of total |
|-------|--------|----------------|
| Lead | 5 | ~50% |
| Backup A | 3 | ~30% |
| Backup B | 2 | ~20% |

- Total weight = `10`
- Threshold = `6` → Lead + either backup works; Lead alone (`5`) cannot; both backups (`5`) cannot

**Example — five-seat board with chair slightly heavier**

| Owner | Weight |
|-------|--------|
| Chair | 3 |
| Member A–D | 2 each |

- Total weight = `11`
- Threshold = `7` → needs broad agreement; chair alone is far from quorum

**When skewed weights make sense**

- One operator runs day-to-day proposals but must not unlock the treasury alone
- Investors or grant committees with unequal economic stake
- A backup / emergency signer should help reach quorum without matching the primary’s power

**Hard rule from the contract:** `ChangeOwnerWeight` cannot push any one owner above the configured single-owner cap (default **50%** of resulting total weight). Prefer designs where **no** owner’s weight alone meets `threshold`.

---

## Centralization risks

Concentrated weight looks like a multisig in the UI but behaves like a hot wallet on-chain:

| Risk | What goes wrong |
|------|-----------------|
| Single owner ≥ threshold | That owner can approve and execute alone — one compromised key drains the treasury |
| Near-cap whale + small allies | A small colluding set reaches quorum while others are decorative |
| Gradual weight raises | A sequence of individually-valid `ChangeOwnerWeight` proposals can still concentrate power in a coalition |
| Unbalanced `initialize` | The single-owner cap applies to later weight changes; **initial** weights are the deployer’s responsibility — review them as carefully as threshold |

**Mitigations operators should apply**

1. Keep every owner’s share **below** threshold (and ideally well under the 50% cap).
2. Review `get_owner_weights` and `get_total_weight` after every governance execution.
3. Treat weight-change proposals like key rotations: announce off-chain, rebuild consensus, then approve.
4. Prefer equal weights unless you have a clear reason to skew.

---

## Quick chooser

| Situation | Suggested starting point |
|-----------|--------------------------|
| Peer founders / equal partners | Equal weights, classic M-of-N threshold |
| One operator + backups | Skewed, threshold above the operator’s weight |
| Large committee, equal seats | Equal weights, higher M |
| Need “veto-ish” large holder without sole control | Skewed but holder weight below threshold; threshold requires at least one other owner |

After you pick numbers, confirm with:

```bash
stellar contract invoke --network testnet --id CONTRACT_ID -- get_owner_weights
stellar contract invoke --network testnet --id CONTRACT_ID -- get_total_weight
stellar contract invoke --network testnet --id CONTRACT_ID -- get_required_quorum_weight
```

The sum of owner weights must equal `get_total_weight`. If you are preparing a mainnet tag, CI also checks that invariant against the configured testnet deployment.

---

## Related docs

- [Weighted Governance Model](../ARCHITECTURE.md#weighted-governance-model)
- [Team Multisig](team-multisig.md)
- [Deployment — migrate to weighted governance](../DEPLOYMENT.md)
