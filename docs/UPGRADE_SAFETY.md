# Contract Upgrade Safety

Accord Protocol's `upgrade` function replaces the contract's WASM code **in place** while keeping the same contract ID and all on-chain storage (owners, threshold, proposals, approvals). That makes upgrades powerful — and uniquely risky for a multisig.

An upgrade changes **contract logic**, not just state. A malicious or buggy WASM can:

- Drain or redirect the treasury under rules owners never agreed to
- Alter who counts as an owner, how threshold works, or how proposals execute
- Affect **every** owner and **every** pending proposal at once

`upgrade` requires at least the current M-of-N **threshold** of distinct registered **owners** to co-sign (`approvers`) and supply a `new_wasm_hash`. Threshold alone is not enough protection if owners approve a hash they have not independently verified.

This guide covers how to verify a proposed WASM hash, coordinate owners before anyone signs, validate state after an upgrade, and spot red flags. For the mechanical upload and invoke steps, see [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md#upgrading-the-contract). For related trust assumptions, see [`docs/SECURITY.md`](./SECURITY.md).

---

## Verifying the WASM Hash

Never approve an upgrade based only on a hash someone else pasted into chat. Rebuild from the claimed source, compute the hash yourself, and confirm it matches the hash that will be passed to `upgrade` and that appears on-chain.

### 1. Obtain the exact source commit

Ask the proposer for:

- The Git repository URL (this project or a clearly disclosed fork)
- The **exact commit SHA** (not just a branch name)
- A short changelog of what the new WASM changes

Check out that commit locally:

```bash
git fetch origin
git checkout COMMIT_SHA
```

If you cannot get a fixed commit SHA, do not approve.

### 2. Rebuild the contract from that commit

From the repository root, with the same toolchain the project documents in [`docs/SETUP.md`](./SETUP.md):

```bash
stellar contract build
```

The artifact should be:

```
target/wasm32v1-none/release/accord.wasm
```

If the build fails, or you had to change source to make it build, stop and reject the upgrade until the proposer publishes a reproducible commit.

### 3. Compute the local WASM hash

The **WASM hash** is the SHA-256 digest of the compiled `.wasm` bytes. Compute it locally:

```bash
shasum -a 256 target/wasm32v1-none/release/accord.wasm
```

Or, if your Stellar CLI supports it:

```bash
stellar contract info hash --wasm target/wasm32v1-none/release/accord.wasm
```

You can also run `stellar contract upload` against your rebuilt WASM (testnet or the intended network). The CLI prints the WASM hash; that value must match your local SHA-256.

Save the hex hash you computed. Compare it **character-for-character** with:

1. The hash the proposer shared off-chain
2. The `new_wasm_hash` argument in the upgrade transaction you are asked to sign

If any of those three differ, do not approve.

### 4. Confirm the hash on Stellar Expert

After the new WASM has been uploaded to the network (but before or while reviewing the upgrade), open the contract on Stellar Expert and confirm the executable hash you expect:

```
https://stellar.expert/explorer/testnet/contract/CONTRACT_ID
```

For mainnet, use the mainnet explorer path instead of `testnet`. Check that:

- The **contract ID** is still your multisig's ID (upgrades do not create a new ID)
- The WASM / code hash shown for the uploaded code matches the hash you rebuilt
- After the upgrade executes, the contract instance's executable hash matches the approved `new_wasm_hash`

Viewing a hash on an explorer is useful, but it is **not** a substitute for rebuilding from source. Explorer views alone cannot prove the bytecode matches audited or intended source.

---

## Owner Communication Before Upgrading

Treat every upgrade like a change to the constitution of the multisig. Coordinate **off-chain** until every owner who will sign has verified the same commit and hash.

### What the proposer should share (before any on-chain approval)

Send all owners a single packet that includes:

| Item | Why it matters |
|------|----------------|
| Commit SHA | Lets every owner rebuild the same bits |
| Changelog / PR link | Explains behaviour changes owners are accepting |
| Exact WASM hash (hex) | Must match rebuilds and `new_wasm_hash` |
| Network (testnet / mainnet) | Prevents signing the right hash on the wrong network |
| Planned execution window | Gives everyone time to rebuild and review |
| Whether pending proposals should pause | Avoids executing under old assumptions mid-upgrade |

Do not ask owners to sign first and "verify later."

### What each owner should do before signing

1. Rebuild and compare the WASM hash (see above).
2. Read the changelog and confirm the change is intentional (bugfix, feature, audit remediation — not unexplained churn).
3. Reply in the shared channel with an explicit confirmation, for example: "Rebuilt commit `abc123…`, hash matches `def456…`, OK to upgrade."
4. Wait until at least the threshold number of owners have confirmed **the same** commit and hash.

Only after that consensus should any owner submit or co-sign the on-chain `upgrade` call listing those approvers.

### Recommended sequencing

1. Proposer publishes commit + changelog + hash.
2. Owners rebuild and confirm off-chain.
3. WASM is uploaded to the target network if not already present.
4. Threshold owners co-sign `upgrade` with the verified `new_wasm_hash`.
5. Owners run post-upgrade validation immediately (next section).

Rushing from announce → sign in minutes is a process failure, not a feature.

---

## Post-Upgrade State Validation

Run these checks **immediately** after a successful `upgrade`. Storage should be preserved, but you must prove it — do not assume success from a green transaction alone.

Replace `CONTRACT_ID` with your multisig contract ID and use the correct `--network`.

### 1. Confirm the contract ID is unchanged

The upgrade must target the existing instance. Your saved contract ID, frontend `VITE_CONTRACT_ADDRESS`, and explorer URL must still point to the same ID. If anyone asks you to switch to a "new" contract address, that is a redeploy — not a safe in-place upgrade.

### 2. Confirm the live WASM hash

On Stellar Expert (or equivalent), verify the contract's executable WASM hash equals the hash you approved. Optionally:

```bash
stellar contract info hash --id CONTRACT_ID --network testnet
```

### 3. Read back owners and threshold

```bash
stellar contract invoke \
  --network testnet \
  --id CONTRACT_ID \
  -- get_owners

stellar contract invoke \
  --network testnet \
  --id CONTRACT_ID \
  -- get_threshold
```

Confirm:

- Every expected owner address is still present
- No unexpected addresses were added
- The threshold integer matches the pre-upgrade value (unless the upgrade's documented purpose was to change governance logic — which should have been explicit in the changelog)

### 4. Confirm version (when applicable)

```bash
stellar contract invoke \
  --network testnet \
  --id CONTRACT_ID \
  -- get_version
```

If the release notes say `CONTRACT_VERSION` was bumped, confirm the returned value matches. If the notes did not claim a version bump, note any unexpected change and investigate before moving funds.

### 5. Confirm existing proposals are still readable

Pick at least one known proposal ID that existed before the upgrade:

```bash
stellar contract invoke \
  --network testnet \
  --id CONTRACT_ID \
  -- get_proposal \
  --proposal_id PROPOSAL_ID
```

Confirm the proposal fields you care about (amount, recipient, token, deadline, approval-related state) still match pre-upgrade records. Spot-check a second proposal if the multisig is active.

Optionally page recent proposals:

```bash
stellar contract invoke \
  --network testnet \
  --id CONTRACT_ID \
  -- get_proposals_paged \
  --offset 0 \
  --limit 5
```

### 6. Smoke-test the frontend

With `VITE_CONTRACT_ADDRESS` still set to the same contract ID, open the dashboard and confirm proposals load without connection errors. Do not execute large transfers until the checks above pass.

### Quick checklist

- [ ] Contract ID unchanged
- [ ] On-chain WASM hash matches the approved hash
- [ ] `get_owners` matches the pre-upgrade owner set
- [ ] `get_threshold` matches the pre-upgrade threshold
- [ ] `get_version` matches release expectations
- [ ] At least one pre-existing proposal is readable and unchanged
- [ ] Frontend still connects to the same contract ID

---

## Red Flags

Reject (or pause) an upgrade proposal if you see any of the following:

| Red flag | Why it is dangerous |
|----------|---------------------|
| No fixed source commit SHA | You cannot independently rebuild or audit what you are approving |
| WASM hash does not match your local rebuild | The on-chain code is not the source you were shown |
| Hash only shared verbally / in screenshots, never as copyable hex | Easy to mistype; hard to verify |
| Pressure to approve quickly without rebuild time | Classic social-engineering pattern against multisigs |
| "Trust me, it's the same as main" with no commit | Branches move; hashes do not lie |
| Asking owners to approve a different hash than the one discussed | Bait-and-switch |
| New contract ID presented as an "upgrade" | That is a new deployment; treasury and state do not move automatically |
| Changelog missing or contradicts the diff | You may be approving hidden behaviour |
| Only one owner reviewed source | Threshold of signatures ≠ threshold of understanding |
| Upgrade bundled with unrelated emergency fund movement | Separates review; demand upgrades and transfers as distinct decisions |

If something feels off, the correct action is to **withhold approval**. An upgrade that does not proceed is safer than an upgrade nobody can explain.

---

## Related documentation

- [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md#upgrading-the-contract) — upload WASM and invoke `upgrade`
- [`docs/SECURITY.md`](./SECURITY.md) — threat model, trust assumptions, and admin practices
- [`docs/CONTRACT_API.md`](./CONTRACT_API.md) — public contract interface reference
- [`docs/GLOSSARY.md`](./GLOSSARY.md) — WASM, owner, and M-of-N threshold terminology
