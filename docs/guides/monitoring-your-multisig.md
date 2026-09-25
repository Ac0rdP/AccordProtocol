# Monitoring Your Multisig

Once your Accord multisig is live, owners need a simple way to watch what the contract is doing — without relying only on the dashboard. This guide shows how to review on-chain event history, spot proposals that reached threshold but were never executed, and confirm the contract looks healthy after an upgrade.

You will need:

- Your **contract ID** (the same value as `VITE_CONTRACT_ADDRESS`)
- Access to a **Horizon** endpoint for your network (testnet or mainnet)
- Optionally, the **Stellar CLI** and a Soroban RPC URL for read-only contract calls

---

## Watching Events with Horizon

Accord emits on-chain events when important actions succeed. Those events are attached to the transactions that produced them. Horizon indexes those transactions so you can review recent activity even if you were offline when it happened.

### Horizon endpoints

| Network | Horizon base URL |
|---------|------------------|
| Testnet | `https://horizon-testnet.stellar.org` |
| Mainnet | `https://horizon.stellar.org` |

### List recent transactions that touched your contract

Replace `CONTRACT_ID` with your multisig address:

```bash
curl "https://horizon-testnet.stellar.org/accounts/CONTRACT_ID/transactions?order=desc&limit=20"
```

Each result is a transaction that involved your contract account. Open a single transaction for more detail:

```bash
curl "https://horizon-testnet.stellar.org/transactions/TRANSACTION_HASH"
```

For a live feed (server-sent events), append `/transactions` streaming as described in Stellar's Horizon docs, or watch the contract page on [Stellar Expert](https://stellar.expert/explorer/testnet) for a human-readable history.

### What Accord event types mean

When you inspect Soroban transaction results (Horizon transaction detail, Stellar Expert, or Soroban RPC), look for these **topic** symbols the contract actually publishes:

| Topic | When it is emitted | What to notice |
|-------|--------------------|----------------|
| `created` | A new proposal was created | New proposal ID; proposer; category; transfer details |
| `approved` | An owner approved a proposal | Approver; running approval count vs threshold |
| `revoked` | An owner withdrew an approval | Approver; remaining approval count |
| `executed` | A proposal was executed and funds moved | Executor; transfer list that left the treasury |
| `upgraded` | Owners co-signed an in-place WASM upgrade | Caller; new WASM hash |
| `guard_set` | A guardian address was registered | New guardian address |
| `frozen` | The guardian froze the contract | Guardian who froze |
| `unfrozen` | Threshold owners unfroze the contract | Approvers who co-signed |

These match the events published in the contract (`created`, `approved`, `revoked`, `executed`, `upgraded`, `guard_set`, `frozen`, `unfrozen`). If you see activity on Horizon but none of these topics, the transaction may be rent, a failed call, or unrelated contract traffic — dig into that transaction before treating it as a successful Accord action.

### Optional: filter contract events via Soroban RPC

Horizon is ideal for browsing recent transactions. To filter **only** Accord event topics, use Soroban RPC `getEvents` (same approach described in [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md)):

```bash
curl -s https://soroban-testnet.stellar.org \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "getEvents",
    "params": {
      "startLedger": START_LEDGER,
      "filters": [{
        "type": "contract",
        "contractIds": ["CONTRACT_ID"],
        "topics": [["executed"]]
      }],
      "pagination": { "limit": 50 }
    }
  }'
```

Change the topic to `created`, `approved`, `revoked`, or `upgraded` as needed. RPC nodes only retain events for a limited ledger window, so for long-term archives use an indexer or export important transactions when they happen.

---

## Detecting Missed Executions

A **missed execution** is a proposal that collected enough approvals to become **Ready**, but nobody called `execute` before the deadline. Once the deadline passes, the proposal becomes **Expired** and can no longer move funds — even if every owner had approved.

### Why this happens

- Owners approved late in the deadline window and assumed “someone else” would execute
- The executor was offline, on the wrong network, or hit a temporary RPC error
- The contract was **frozen**, blocking `execute`
- The treasury lacked balance, so `execute` failed with `TransferFailed` and was not retried in time

### How to spot one

1. **Dashboard:** Look for proposals with an **Expired** badge that previously showed a full approval bar, or that you remember were Ready.
2. **Horizon / events:** Find a `created` event and enough `approved` events to meet threshold, but **no** matching `executed` event for that proposal ID before the deadline.
3. **CLI read-back** for a suspicious ID:

```bash
stellar contract invoke \
  --network testnet \
  --id CONTRACT_ID \
  -- get_proposal \
  --proposal_id PROPOSAL_ID
```

If status is `Expired` and the approval count is at or above the proposal’s threshold, that is a missed execution.

### What to do when you find one

1. **Do not try to execute the expired proposal** — the contract will reject it.
2. Confirm with other owners whether the payment is still intended.
3. If yes, **create a new proposal** with the same recipient, token, and amount, and a fresh deadline.
4. Collect approvals again and **execute promptly** once status is Ready (assign a clear owner as executor for that window).
5. If expired proposals are clogging the active list, have an owner sweep them with the contract’s expired-proposal cleanup path when available so new proposals are not blocked by the active-proposal cap.

Operational tip: when a proposal hits Ready, agree in your owner chat who will execute and by when. Treat Ready-without-execute as an incident, not a normal idle state.

---

## Verifying Contract State After an Upgrade

An upgrade replaces the contract WASM **in place**. The contract ID stays the same, and storage (owners, threshold, proposals) should remain. Always verify — do not assume a successful transaction means the multisig is still configured the way you expect.

For a full safety process (hash rebuild, owner coordination, red flags), see [`docs/UPGRADE_SAFETY.md`](../UPGRADE_SAFETY.md) if that guide is present in your checkout; the checks below are the minimum monitoring steps.

### 1. Confirm you are still on the same contract ID

Your saved contract ID and frontend `VITE_CONTRACT_ADDRESS` must be unchanged. An “upgrade” that asks you to point at a new ID is a new deployment, not an in-place upgrade.

### 2. Confirm the WASM hash

Open the contract on Stellar Expert and check the executable / WASM hash matches the hash owners approved:

```
https://stellar.expert/explorer/testnet/contract/CONTRACT_ID
```

You should also see an `upgraded` event (Horizon transaction history or RPC) whose `new_wasm_hash` matches that value.

### 3. Read owners, threshold, and proposals

```bash
stellar contract invoke --network testnet --id CONTRACT_ID -- get_owners
stellar contract invoke --network testnet --id CONTRACT_ID -- get_threshold
stellar contract invoke --network testnet --id CONTRACT_ID -- get_total_proposals
```

Confirm:

- Owner list matches the pre-upgrade set
- Threshold is unchanged (unless the upgrade changelog explicitly changed governance behaviour)
- Total proposal count did not reset to zero

Spot-check at least one known proposal:

```bash
stellar contract invoke \
  --network testnet \
  --id CONTRACT_ID \
  -- get_proposal \
  --proposal_id PROPOSAL_ID
```

### 4. Confirm the dashboard still loads

Restart or refresh the frontend with the same contract ID. Proposals should load without connection errors. Pause large transfers until the checks above pass.

### Post-upgrade checklist

- [ ] Contract ID unchanged
- [ ] WASM hash matches the approved upgrade
- [ ] `upgraded` event visible in recent history
- [ ] Owners and threshold match expectations
- [ ] Existing proposals still readable
- [ ] Dashboard connects successfully

---

## Related guides

- [Reading the Dashboard](reading-the-dashboard.md) — proposal statuses and the approval bar
- [Troubleshooting](troubleshooting.md) — wallet and transaction errors
- [Deployment](../DEPLOYMENT.md) — upgrade mechanics and post-deploy checks
