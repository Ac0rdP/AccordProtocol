# Roles & Permissions

Accord’s RBAC layer separates **who may draft**, **who may vote**, **who may execute**, and **who only observes** — without replacing owner-weighted quorum for security-critical governance.

For the storage model, gating matrix, and migration details, see [RBAC & Access Control](../ARCHITECTURE.md#rbac--access-control) in `ARCHITECTURE.md`.

---

## The four roles

| Role | What it permits | Typical assignee |
|------|-----------------|------------------|
| **Proposer** | Call any `create_*_proposal` entrypoint (transfers, owner/weight changes, spending limits, recurring schedules, grant/revoke role) | Ops lead, finance operator, or a non-owner drafter |
| **Approver** | Call `approve` / `revoke` — **only if the address is also an owner** (weight still comes from ownership) | Owners who should vote; omit for silent co-owners |
| **Executor** | Call `execute` and `cancel_expired` | A designated owner or an automated keeper |
| **Viewer** | Marks read-oriented access for UI / policy; does **not** unlock create, approve, or execute by itself | Auditors, stakeholders who only watch the dashboard |

**Default for every owner** (`DEFAULT_OWNER_ROLES`): `Proposer` + `Approver` + `Executor`. That preserves the classic “any owner can do everything” behaviour until you intentionally narrow roles.

**Still owner-weight only (not role-gated):** `set_guardian`, `freeze` / `unfreeze`, `upgrade`, `migrate_to_rbac`, `migrate_to_weighted_governance`, `set_max_single_owner_weight_pct`. A role grant alone cannot change the multisig’s security posture.

---

## Healthy separation of duties

| Goal | Suggested pattern |
|------|-------------------|
| Operators draft, owners vote | Give ops `Proposer` only; keep `Approver` on owners |
| Automated execution | Grant `Executor` to a keeper; keep `Approver` on humans |
| Silent backup owner | Owner with weight but **without** `Approver` (cannot vote until granted) |
| Observer | `Viewer` only — connect wallet for read UI without write keys |

Never concentrate `Proposer` + sole `Approver` weight + `Executor` on one compromised laptop if you can avoid it. Roles are least-privilege tools; threshold and weights remain the fund-movement backstop.

---

## Granting a role

Role changes go through the normal proposal lifecycle (create → approve → execute):

1. An address with the **Proposer** role creates a grant proposal:

```bash
stellar contract invoke \
  --network testnet \
  --source-account PROPOSER \
  --id CONTRACT_ID \
  -- create_grant_role_proposal \
  --proposer PROPOSER \
  --target TARGET_ADDRESS \
  --role Proposer \
  --description "Grant Proposer to ops lead" \
  --deadline DEADLINE_UNIX
```

2. Owners who hold **Approver** (and are owners) approve until quorum weight is met.
3. An address with **Executor** runs `execute` on that proposal ID.
4. Confirm with:

```bash
stellar contract invoke --network testnet --id CONTRACT_ID -- get_roles --address TARGET_ADDRESS
stellar contract invoke --network testnet --id CONTRACT_ID -- has_role --address TARGET_ADDRESS --role Proposer
stellar contract invoke --network testnet --id CONTRACT_ID -- get_role_members --role Proposer
```

If the target already holds the role, expect `RoleAlreadyGranted` (code 53).

---

## Revoking a role

Same flow with `create_revoke_role_proposal` / `RevokeRole`:

1. Create the revoke proposal naming `target` and `role`.
2. Collect Approver weight to quorum.
3. Execute.
4. Re-check `get_roles` / `has_role`.

If the target no longer holds the role (state drifted), expect `RoleNotGranted` (code 54). Recreate the proposal if needed.

---

## Migrating an existing multisig

After upgrading to RBAC-capable WASM, owners co-sign `migrate_to_rbac` once. Every current owner receives `DEFAULT_OWNER_ROLES`, and `get_role_version` reports RBAC enabled. A second call is rejected and changes nothing.

Fresh deployments that grant defaults in `initialize` do not need migration.

---

## Common errors

| Code | Variant | Meaning |
|------|---------|---------|
| 52 | `MissingRole` | Caller lacks the role this entrypoint requires |
| 53 | `RoleAlreadyGranted` | Grant target already has that role |
| 54 | `RoleNotGranted` | Revoke target does not have that role |
| 55 | `InvalidRole` | Role value is not `Proposer` / `Approver` / `Executor` / `Viewer` |

Full remediation text: [CONTRACT_API — Error Reference](../CONTRACT_API.md#error-reference).

---

## Related docs

- [RBAC & Access Control](../ARCHITECTURE.md#rbac--access-control)
- [Choosing Voting Weights](weighted-governance.md)
- [Glossary](../GLOSSARY.md)
